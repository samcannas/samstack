import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { getModuleDir, isMainModule } from './platform';
import {
  HOSTS,
  getHostDefinition,
  installTargetLabel,
  resolveHostInstallTarget,
  type HostId,
  type HostInstallTarget,
  type InstallScope,
} from './installer-hosts';
import {
  getModuleDefinition,
  loadModules,
  type ModuleId,
  type ModuleInput,
  type ModuleInstallContext,
  type SkillFile,
} from './installer-modules';
import { ensureBrowserRuntimeInstalled, getBrowserRuntimeStatus, type BrowserRuntimeStatus } from './installer-runtime';
import {
  computeChecksum,
  findInstalledTargetRecord,
  removeModulesFromManifest,
  safeReadText,
  writeTargetManifest,
  type InstalledModuleRecord,
} from './installer-state';

type Command = 'menu' | 'install' | 'update' | 'uninstall' | 'status' | 'browser' | 'help';
type InstallState = 'missing' | 'installed' | 'outdated';

interface ParsedArgs {
  command: Command;
  browserArgs: string[];
  hosts: HostId[];
  modules: ModuleInput[];
  scope?: InstallScope;
  yes: boolean;
  projectDir: string;
}

interface PreparedModuleInstall {
  target: HostInstallTarget;
  moduleId: ModuleId;
  moduleLabel: string;
  skill: SkillFile;
  checksum: string;
  filePath: string;
}

interface ModuleStatus extends PreparedModuleInstall {
  state: InstallState;
  reason: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageRoot = path.resolve(getModuleDir(import.meta.url), '..');
  const availableModules = loadModules(packageRoot);

  if (args.command === 'help') {
    printHelp();
    return;
  }

  if (args.command === 'browser') {
    runEmbeddedBrowser(args.browserArgs);
    return;
  }

  const projectRoot = path.resolve(args.projectDir || process.cwd());
  const hosts = args.hosts.length > 0 ? args.hosts : await promptForHosts();
  if (hosts.length === 0) {
    throw new Error('No install targets selected.');
  }

  const targets = await resolveTargets(hosts, args.scope, projectRoot, args.yes);
  const modules = normalizeModuleIds(args.modules.length > 0 ? args.modules : await promptForModules(availableModules), availableModules);
  if (modules.length === 0) {
    throw new Error('No SamStack modules selected.');
  }

  const runtimeStatus = getBrowserRuntimeStatus(packageRoot);
  const prepared = prepareModuleInstalls(packageRoot, targets, modules, runtimeStatus);
  const statuses = await getModuleStatuses(prepared, runtimeStatus);

  switch (args.command) {
    case 'status': {
      printStatusReport(statuses, runtimeStatus);
      return;
    }
    case 'install': {
      const installable = statuses.filter((entry) => entry.state === 'missing');
      if (!args.yes && installable.length > 0) {
        const proceed = await confirm({
          message: `Install ${installable.length} missing item(s)?`,
          default: true,
        });
        if (!proceed) return;
      }
      await applyInstall(packageRoot, installable);
      return;
    }
    case 'update': {
      const updatable = statuses.filter((entry) => entry.state === 'outdated');
      if (!args.yes && updatable.length > 0) {
        const proceed = await confirm({
          message: `Update ${updatable.length} outdated item(s)?`,
          default: true,
        });
        if (!proceed) return;
      }
      await applyInstall(packageRoot, updatable);
      return;
    }
    case 'uninstall': {
      const removable = statuses.filter((entry) => entry.state !== 'missing');
      if (!args.yes && removable.length > 0) {
        const proceed = await confirm({
          message: `Uninstall ${removable.length} installed item(s)?`,
          default: false,
        });
        if (!proceed) return;
      }
      await applyUninstall(removable);
      return;
    }
    case 'menu':
    default: {
      printStatusReport(statuses, runtimeStatus);
      await runInteractiveMenu(packageRoot, statuses, runtimeStatus);
      return;
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'menu',
    browserArgs: [],
    hosts: [],
    modules: [],
    yes: false,
    projectDir: process.cwd(),
  };

  const args = [...argv];
  if (args[0] === 'browser') {
    parsed.command = 'browser';
    parsed.browserArgs = args.slice(1);
    return parsed;
  }

  if (args[0] && ['install', 'update', 'uninstall', 'status', 'help'].includes(args[0])) {
    parsed.command = args[0] as Command;
    args.shift();
  }

  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    parsed.command = 'help';
    return parsed;
  }

  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const next = args[index + 1];
    if ((token === '--host' || token === '--hosts') && next) {
      parsed.hosts = next.split(',').map((value) => value.trim()).filter(Boolean) as HostId[];
      index++;
      continue;
    }
    if ((token === '--module' || token === '--modules') && next) {
      parsed.modules = next.split(',').map((value) => value.trim()).filter(Boolean) as ModuleInput[];
      index++;
      continue;
    }
    if (token === '--scope' && next) {
      parsed.scope = next as InstallScope;
      index++;
      continue;
    }
    if (token === '--project-dir' && next) {
      parsed.projectDir = next;
      index++;
      continue;
    }
    if (token === '--yes' || token === '-y') {
      parsed.yes = true;
      continue;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`samstack installer

Usage:
  npx samstack
  npx samstack status --host opencode,claude-code
  npx samstack install --host opencode,codex,gemini --module web-debug --scope project
  npx samstack update --host opencode --module web-debug
  npx samstack uninstall --host opencode --module web-debug
  npx samstack browser goto https://example.com

Options:
  --host, --hosts       Comma-separated hosts: opencode, claude-code, cursor, codex, kiro, agents, gemini
  --module, --modules   Comma-separated modules: web-debug
  --scope               project | global
  --project-dir         Override the project root used for project installs
  --yes, -y             Skip confirmation prompts

Commands:
  status                Show installed, outdated, and missing items
  install               Install missing items
  update                Update outdated items
  uninstall             Remove installed items
  browser               Run the embedded browser CLI directly
  help                  Show this help text`);
}

async function promptForHosts(): Promise<HostId[]> {
  const selected = await checkbox({
    message: 'Which AI harnesses should SamStack inspect?',
    choices: HOSTS.map((host) => ({
      name: `${host.label} — ${host.description}`,
      value: host.id,
      checked: host.id === 'opencode' || host.id === 'claude-code' || host.id === 'codex' || host.id === 'gemini',
    })),
  });
  return selected as HostId[];
}

async function promptForModules(availableModules: { id: string; label: string; description: string }[]): Promise<ModuleId[]> {
  const selected = await checkbox({
    message: 'Which SamStack modules do you want to manage?',
    choices: availableModules.map((module) => ({
      name: `${module.label} — ${module.description}`,
      value: module.id,
      checked: true,
    })),
  });
  return selected as ModuleId[];
}

function normalizeModuleIds(modules: ModuleInput[], availableModules: { id: string }[]): ModuleId[] {
  const normalized = [...new Set(modules.map((moduleId) => moduleId.trim()).filter(Boolean))];
  const unknown = normalized.filter((moduleId) => !availableModules.some((entry) => entry.id === moduleId));
  if (unknown.length > 0) {
    throw new Error(`Unknown SamStack module(s): ${unknown.join(', ')}`);
  }
  return normalized;
}

async function resolveTargets(
  hostIds: HostId[],
  preferredScope: InstallScope | undefined,
  projectDir: string,
  assumeDefaults: boolean,
): Promise<HostInstallTarget[]> {
  const targets: HostInstallTarget[] = [];
  for (const hostId of hostIds) {
    const host = getHostDefinition(hostId);
    let scope = preferredScope;
    if (!scope || !host.supportedScopes.includes(scope)) {
      if (assumeDefaults || host.supportedScopes.length === 1) {
        scope = host.supportedScopes[0];
      } else {
        scope = await select({
          message: `Inspect ${host.label} project-local or globally?`,
          choices: host.supportedScopes.map((entry) => ({
            name: entry === 'project' ? `Project (${projectDir})` : `Global (${path.join(requireHomeDir(), host.configDirName)})`,
            value: entry,
          })),
        }) as InstallScope;
      }
    }
    targets.push(resolveHostInstallTarget(host, scope, projectDir));
  }
  return targets;
}

function requireHomeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || path.dirname(process.cwd());
}

function prepareModuleInstalls(
  packageRoot: string,
  targets: HostInstallTarget[],
  modules: ModuleId[],
  runtimeStatus: BrowserRuntimeStatus,
): PreparedModuleInstall[] {
  const context: ModuleInstallContext = {
    runtime: {
      runtimeDir: runtimeStatus.runtimeDir,
      browserEntryPath: runtimeStatus.browserEntryPath,
      version: runtimeStatus.expectedVersion,
    },
  };

  return targets.flatMap((target) =>
    modules.map((moduleId) => {
      const moduleDef = getModuleDefinition(packageRoot, moduleId);
      const skill = moduleDef.createSkill(target.host, context);
      return {
        target,
        moduleId,
        moduleLabel: moduleDef.label,
        skill,
        checksum: computeChecksum(skill.content + '\n'),
        filePath: path.join(target.skillsDir, skill.relativeDir, skill.fileName),
      } satisfies PreparedModuleInstall;
    })
  );
}

async function getModuleStatuses(
  prepared: PreparedModuleInstall[],
  runtimeStatus: BrowserRuntimeStatus,
): Promise<ModuleStatus[]> {
  const statuses: ModuleStatus[] = [];

  for (const entry of prepared) {
    const installedRecord = findInstalledTargetRecord(entry.target.rootDir, entry.target)
      ?.modules.find((module) => module.moduleId === entry.moduleId) ?? null;
    const installedContent = await safeReadText(entry.filePath);

    if (installedContent == null) {
      statuses.push({
        ...entry,
        state: 'missing',
        reason: installedRecord ? 'Manifest exists but installed file is missing.' : 'Not installed.',
      });
      continue;
    }

    const installedChecksum = computeChecksum(installedContent);
    if (installedChecksum !== entry.checksum) {
      statuses.push({
        ...entry,
        state: 'outdated',
        reason: 'Installed file differs from the current SamStack version.',
      });
      continue;
    }

    if (!runtimeStatus.upToDate) {
      statuses.push({
        ...entry,
        state: 'outdated',
        reason: runtimeStatus.installed ? 'Browser runtime is outdated.' : 'Browser runtime is not installed.',
      });
      continue;
    }

    statuses.push({
      ...entry,
      state: 'installed',
      reason: 'Installed and up to date.',
    });
  }

  return statuses;
}

function printStatusReport(statuses: ModuleStatus[], runtimeStatus: BrowserRuntimeStatus): void {
  const runtimeLabel = runtimeStatus.upToDate
    ? `up to date (${runtimeStatus.expectedVersion})`
    : runtimeStatus.installed
      ? `outdated (${runtimeStatus.installedVersion ?? 'unknown'} -> ${runtimeStatus.expectedVersion})`
      : 'not installed';

  console.log('');
  console.log(`Browser runtime: ${runtimeLabel}`);
  console.log('');
  for (const entry of statuses) {
    console.log(`- ${entry.target.host.label} (${entry.target.scope}) / ${entry.moduleId}: ${entry.state} - ${entry.reason}`);
  }
}

async function runInteractiveMenu(
  packageRoot: string,
  statuses: ModuleStatus[],
  runtimeStatus: BrowserRuntimeStatus,
): Promise<void> {
  const missingCount = statuses.filter((entry) => entry.state === 'missing').length;
  const outdatedCount = statuses.filter((entry) => entry.state === 'outdated').length;
  const installedCount = statuses.filter((entry) => entry.state !== 'missing').length;
  const syncCount = missingCount + outdatedCount;

  const choices = [] as { name: string; value: string }[];
  if (syncCount > 0) choices.push({ name: `Install or update all needed (${syncCount})`, value: 'sync' });
  if (missingCount > 0) choices.push({ name: `Install missing (${missingCount})`, value: 'install' });
  if (outdatedCount > 0) choices.push({ name: `Update outdated (${outdatedCount})`, value: 'update' });
  if (installedCount > 0) choices.push({ name: `Uninstall installed (${installedCount})`, value: 'uninstall' });
  choices.push({ name: 'Exit', value: 'exit' });

  const action = await select({
    message: 'Choose an action',
    choices,
  });

  if (action === 'exit') return;
  if (action === 'sync') {
    await applyInstall(packageRoot, statuses.filter((entry) => entry.state !== 'installed'));
    return;
  }
  if (action === 'install') {
    await applyInstall(packageRoot, statuses.filter((entry) => entry.state === 'missing'));
    return;
  }
  if (action === 'update') {
    await applyInstall(packageRoot, statuses.filter((entry) => entry.state === 'outdated'));
    return;
  }
  if (action === 'uninstall') {
    await applyUninstall(statuses.filter((entry) => entry.state !== 'missing'));
    return;
  }
}

async function applyInstall(packageRoot: string, statuses: ModuleStatus[]): Promise<void> {
  if (statuses.length === 0) {
    console.log('Nothing to install or update.');
    return;
  }

  const runtime = await ensureBrowserRuntimeInstalled(packageRoot);
  const byTarget = new Map<string, ModuleStatus[]>();
  for (const entry of statuses) {
    const key = `${entry.target.rootDir}:${entry.target.host.id}:${entry.target.scope}`;
    const list = byTarget.get(key) || [];
    list.push(entry);
    byTarget.set(key, list);
  }

  const summary: string[] = [];
  for (const entries of byTarget.values()) {
    const target = entries[0].target;
    await fsp.mkdir(target.skillsDir, { recursive: true });

    for (const entry of entries) {
      const skillDir = path.join(target.skillsDir, entry.skill.relativeDir);
      await fsp.mkdir(skillDir, { recursive: true });
      await fsp.writeFile(path.join(skillDir, entry.skill.fileName), entry.skill.content + '\n', 'utf-8');
      summary.push(`${entry.target.host.label} (${entry.target.scope}): ${entry.moduleLabel}`);
    }

    const currentRecord = findInstalledTargetRecord(target.rootDir, target);
    const currentModules = new Map<ModuleId, InstalledModuleRecord>();
    for (const module of currentRecord?.modules ?? []) {
      currentModules.set(module.moduleId, module);
    }
    for (const entry of entries) {
      currentModules.set(entry.moduleId, {
        moduleId: entry.moduleId,
        relativeDir: entry.skill.relativeDir,
        fileName: entry.skill.fileName,
        checksum: entry.checksum,
        installedAt: new Date().toISOString(),
      });
    }

    await writeTargetManifest(target.rootDir, runtime.version, target, [...currentModules.values()]);
  }

  console.log('');
  console.log('SamStack changes applied.');
  console.log(`- Browser runtime: ${runtime.browserEntryPath}`);
  for (const line of summary) {
    console.log(`- ${line}`);
  }
}

async function applyUninstall(statuses: ModuleStatus[]): Promise<void> {
  if (statuses.length === 0) {
    console.log('Nothing to uninstall.');
    return;
  }

  const byTarget = new Map<string, ModuleStatus[]>();
  for (const entry of statuses) {
    const key = `${entry.target.rootDir}:${entry.target.host.id}:${entry.target.scope}`;
    const list = byTarget.get(key) || [];
    list.push(entry);
    byTarget.set(key, list);
  }

  const summary: string[] = [];
  for (const entries of byTarget.values()) {
    const target = entries[0].target;
    for (const entry of entries) {
      await fsp.rm(path.join(target.skillsDir, entry.skill.relativeDir), { recursive: true, force: true });
      summary.push(`${entry.target.host.label} (${entry.target.scope}): ${entry.moduleLabel}`);
    }
    await removeModulesFromManifest(target.rootDir, target, entries.map((entry) => entry.moduleId));
  }

  console.log('');
  console.log('SamStack items uninstalled.');
  for (const line of summary) {
    console.log(`- ${line}`);
  }
  console.log('- Shared browser runtime was left in place at ~/.samstack/runtime/browser.');
}

function runEmbeddedBrowser(args: string[]) {
  const runtimeEntry = path.join(getModuleDir(import.meta.url), 'runtime', 'samstack-browser.js');
  const result = spawnSync(process.execPath, [runtimeEntry, ...args], {
    stdio: 'inherit',
    shell: false,
  });

  process.exit(result.status ?? 1);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
