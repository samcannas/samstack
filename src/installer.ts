import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkbox, confirm, select } from '@inquirer/prompts';
import { getModuleDir, isMainModule } from './platform';
import { HOSTS, getHostDefinition, installTargetLabel, resolveHostInstallTarget, type HostId, type HostInstallTarget, type InstallScope } from './installer-hosts';
import { MODULES, getModuleDefinition, normalizeModuleId, type ModuleId, type ModuleInput, type ModuleInstallContext } from './installer-modules';
import { ensureBrowserRuntimeInstalled } from './installer-runtime';

interface ParsedArgs {
  command: 'install' | 'browser' | 'help';
  browserArgs: string[];
  hosts: HostId[];
  modules: ModuleInput[];
  scope?: InstallScope;
  yes: boolean;
  projectDir: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageRoot = path.resolve(getModuleDir(import.meta.url), '..');

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
  const targets = hosts.length > 0
    ? await resolveTargets(hosts, args.scope, projectRoot, args.yes)
    : [];

  if (targets.length === 0) {
    throw new Error('No install targets selected.');
  }

  const modules = normalizeModuleIds(args.modules.length > 0 ? args.modules : await promptForModules());
  if (modules.length === 0) {
    throw new Error('No SamStack modules selected.');
  }

  if (!args.yes) {
    const proceed = await confirm({
      message: `Install ${modules.join(', ')} into ${targets.map((target) => installTargetLabel(target)).join(' | ')}?`,
      default: true,
    });
    if (!proceed) {
      console.log('Cancelled.');
      return;
    }
  }

  const runtime = modules.some((moduleId) => getModuleDefinition(moduleId).dependsOnRuntime)
    ? await ensureBrowserRuntimeInstalled(packageRoot)
    : null;

  const context: ModuleInstallContext | null = runtime ? { runtime } : null;
  const summary: string[] = [];

  for (const target of targets) {
    await fsp.mkdir(target.skillsDir, { recursive: true });
    for (const moduleId of modules) {
      const moduleDef = getModuleDefinition(moduleId);
      if (moduleDef.dependsOnRuntime && !context) {
        throw new Error(`Module ${moduleId} requires the SamStack browser runtime.`);
      }
      const skill = moduleDef.createSkill(target.host, context!);
      const skillDir = path.join(target.skillsDir, skill.relativeDir);
      await fsp.mkdir(skillDir, { recursive: true });
      await fsp.writeFile(path.join(skillDir, skill.fileName), skill.content + '\n', 'utf-8');
      summary.push(`${target.host.label} (${target.scope}): ${moduleDef.label}`);
    }
  }

  await writeInstallManifest(projectRoot, targets, modules, runtime?.version ?? 'none');

  console.log('');
  console.log('SamStack installed successfully.');
  if (runtime) {
    console.log(`- Browser runtime: ${runtime.browserEntryPath}`);
  }
  for (const line of summary) {
    console.log(`- ${line}`);
  }
  console.log('');
  console.log('Next steps:');
  console.log('- Restart or reload your AI harness if it caches skills.');
  console.log('- Call `/samstack-web-debug` in harnesses that support user-invokable skills.');
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'install',
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
  if (args[0] === 'install') {
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
  npx samstack install --host opencode,codex,gemini --module web-debug --scope project
  npx samstack browser goto https://example.com

Options:
  --host, --hosts       Comma-separated hosts: opencode, claude-code, cursor, codex, kiro, agents, gemini
  --module, --modules   Comma-separated modules: web-debug
  --scope               project | global
  --project-dir         Override the project root used for project installs
  --yes, -y             Skip confirmation prompts

Commands:
  install               Run the interactive installer (default)
  browser               Run the embedded browser CLI directly
  help                  Show this help text`);
}

async function promptForHosts(): Promise<HostId[]> {
  const selected = await checkbox({
    message: 'Which AI harnesses should SamStack install into?',
    choices: HOSTS.map((host) => ({
      name: `${host.label} — ${host.description}`,
      value: host.id,
      checked: host.id === 'opencode' || host.id === 'claude-code' || host.id === 'codex' || host.id === 'gemini',
    })),
  });
  return selected as HostId[];
}

async function promptForModules(): Promise<ModuleId[]> {
  const selected = await checkbox({
    message: 'Which SamStack modules do you want to install?',
    choices: MODULES.map((module) => ({
      name: `${module.label} — ${module.description}`,
      value: module.id,
      checked: true,
    })),
  });
  return selected as ModuleId[];
}

function normalizeModuleIds(modules: ModuleInput[]): ModuleId[] {
  return [...new Set(modules.map((moduleId) => normalizeModuleId(moduleId)))];
}

async function resolveTargets(hostIds: HostId[], preferredScope: InstallScope | undefined, projectDir: string, assumeDefaults: boolean): Promise<HostInstallTarget[]> {
  const targets: HostInstallTarget[] = [];
  for (const hostId of hostIds) {
    const host = getHostDefinition(hostId);
    let scope = preferredScope;
    if (!scope || !host.supportedScopes.includes(scope)) {
      if (assumeDefaults || host.supportedScopes.length === 1) {
        scope = host.supportedScopes[0];
      } else {
        scope = await select({
          message: `Install ${host.label} project-local or globally?`,
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

function runEmbeddedBrowser(args: string[]) {
  const runtimeEntry = path.join(getModuleDir(import.meta.url), 'runtime', 'samstack-browser.js');
  const result = spawnSync(process.execPath, [runtimeEntry, ...args], {
    stdio: 'inherit',
    shell: false,
  });

  process.exit(result.status ?? 1);
}

async function writeInstallManifest(projectDir: string, targets: HostInstallTarget[], modules: ModuleId[], runtimeVersion: string) {
  const manifestDir = path.join(projectDir, '.samstack');
  const manifestPath = path.join(manifestDir, 'installer-manifest.json');
  await fsp.mkdir(manifestDir, { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify({
    installedAt: new Date().toISOString(),
    runtimeVersion,
    targets: targets.map((target) => ({
      host: target.host.id,
      scope: target.scope,
      skillsDir: target.skillsDir,
    })),
    modules,
  }, null, 2) + '\n', 'utf-8');
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
