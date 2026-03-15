import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostDefinition, HostId } from './installer-hosts';

export type ModuleId = string;
export type ModuleInput = string;

export interface InstalledRuntime {
  runtimeDir: string;
  browserEntryPath: string;
  version: string;
}

export interface SkillArtifact {
  relativePath: string;
  content: string;
}

export interface SkillBundle {
  relativeDir: string;
  artifacts: SkillArtifact[];
}

export interface ModuleInstallContext {
  runtime: InstalledRuntime;
  commandNames: string[];
  skillNameById: Record<string, string>;
}

interface ToolModuleManifest {
  id: string;
  label: string;
  description: string;
  dependsOnRuntime?: boolean;
  skillId: string;
  skillName: string;
  skillDescription: string;
  userInvokable?: boolean;
  args?: Array<{ name: string; description?: string; required?: boolean }>;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  source?: string;
}

export interface StackModule {
  id: ModuleId;
  label: string;
  description: string;
  dependsOnRuntime: boolean;
  skillId: string;
  skillName: string;
  skillDescription: string;
  userInvokable: boolean;
  args: Array<{ name: string; description?: string; required?: boolean }>;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
  source?: string;
  templateBody: string;
  referenceTemplates: SkillArtifact[];
  createSkillBundle(host: HostDefinition, context: ModuleInstallContext): SkillBundle;
}

type FrontmatterMap = Record<string, unknown>;

const PROVIDER_PLACEHOLDERS: Record<HostId, { model: string; configFile: string; askInstruction: string }> = {
  'claude-code': {
    model: 'Claude',
    configFile: 'CLAUDE.md',
    askInstruction: 'STOP and call the AskUserQuestionTool to clarify.',
  },
  cursor: {
    model: 'the model',
    configFile: '.cursorrules',
    askInstruction: 'ask the user directly to clarify what you cannot infer.',
  },
  gemini: {
    model: 'Gemini',
    configFile: 'GEMINI.md',
    askInstruction: 'ask the user directly to clarify what you cannot infer.',
  },
  codex: {
    model: 'GPT',
    configFile: 'AGENTS.md',
    askInstruction: 'ask the user directly to clarify what you cannot infer.',
  },
  agents: {
    model: 'the model',
    configFile: '.github/copilot-instructions.md',
    askInstruction: 'ask the user directly to clarify what you cannot infer.',
  },
  kiro: {
    model: 'Claude',
    configFile: '.kiro/settings.json',
    askInstruction: 'ask the user directly to clarify what you cannot infer.',
  },
  opencode: {
    model: 'Claude',
    configFile: 'AGENTS.md',
    askInstruction: 'STOP and call the `question` tool to clarify.',
  },
};

export function loadModules(packageRoot: string): StackModule[] {
  const toolsDir = path.join(packageRoot, 'tools');
  const skillsDir = path.join(packageRoot, 'skills');

  if (!fs.existsSync(toolsDir)) throw new Error(`Missing tools directory: ${toolsDir}`);
  if (!fs.existsSync(skillsDir)) throw new Error(`Missing skills directory: ${skillsDir}`);

  const modules: StackModule[] = [];
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(toolsDir, entry.name, 'module.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ToolModuleManifest;
    const skillDir = path.join(skillsDir, manifest.skillId);
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Missing skill template for module '${manifest.id}' at ${skillPath}`);
    }

    const templateBody = fs.readFileSync(skillPath, 'utf-8').trimEnd();
    const referenceTemplates = readReferenceTemplates(skillDir);
    modules.push(createModule(manifest, templateBody, referenceTemplates));
  }

  modules.sort((left, right) => left.id.localeCompare(right.id));
  return modules;
}

export function getModuleDefinition(packageRoot: string, id: ModuleInput): StackModule {
  const normalized = id.trim();
  const entry = loadModules(packageRoot).find((module) => module.id === normalized);
  if (!entry) throw new Error(`Unknown SamStack module: ${id}`);
  return entry;
}

function createModule(
  manifest: ToolModuleManifest,
  templateBody: string,
  referenceTemplates: SkillArtifact[],
): StackModule {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    dependsOnRuntime: manifest.dependsOnRuntime === true,
    skillId: manifest.skillId,
    skillName: manifest.skillName,
    skillDescription: manifest.skillDescription,
    userInvokable: manifest.userInvokable === true,
    args: manifest.args ?? [],
    license: manifest.license,
    compatibility: manifest.compatibility,
    metadata: manifest.metadata,
    allowedTools: manifest.allowedTools,
    source: manifest.source,
    templateBody,
    referenceTemplates,
    createSkillBundle(host, context) {
      const frontmatter = buildFrontmatter(manifest, host);
      const body = renderTemplate(templateBody, host.id, context, manifest);
      const artifacts: SkillArtifact[] = [
        {
          relativePath: 'SKILL.md',
          content: `${generateYamlFrontmatter(frontmatter)}\n\n${body}`,
        },
        ...referenceTemplates.map((artifact) => ({
          relativePath: artifact.relativePath,
          content: renderTemplate(artifact.content, host.id, context, manifest),
        })),
      ];

      return {
        relativeDir: manifest.skillName,
        artifacts,
      };
    },
  };
}

function readReferenceTemplates(skillDir: string): SkillArtifact[] {
  const artifacts: SkillArtifact[] = [];
  walkSkillDir(skillDir, skillDir, artifacts);
  return artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function walkSkillDir(currentDir: string, rootDir: string, artifacts: SkillArtifact[]): void {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkSkillDir(fullPath, rootDir, artifacts);
      continue;
    }
    if (relativePath === 'SKILL.md') continue;
    artifacts.push({
      relativePath,
      content: fs.readFileSync(fullPath, 'utf-8').trimEnd(),
    });
  }
}

function renderTemplate(
  template: string,
  hostId: HostId,
  context: ModuleInstallContext,
  manifest: ToolModuleManifest,
): string {
  const placeholders = PROVIDER_PLACEHOLDERS[hostId] ?? PROVIDER_PLACEHOLDERS.cursor;
  const commandList = context.commandNames.filter((name) => name !== 'teach-impeccable').map((name) => `/${name}`).join(', ');

  let output = template
    .replace(/\{\{SAMSTACK_INVOCATION\}\}/g, `node "${context.runtime.browserEntryPath}"`)
    .replace(/\{\{model\}\}/g, placeholders.model)
    .replace(/\{\{config_file\}\}/g, placeholders.configFile)
    .replace(/\{\{ask_instruction\}\}/g, placeholders.askInstruction)
    .replace(/\{\{available_commands\}\}/g, commandList);

  output = prefixSkillReferences(output, context.skillNameById);

  if (hostId === 'gemini' && manifest.userInvokable) {
    output = output.replace(/\{\{[^}]+\}\}/g, '{{args}}');
  } else if (hostId === 'codex' && manifest.userInvokable) {
    output = output.replace(/\{\{([^}]+)\}\}/g, (_, argName: string) => `$${argName.toUpperCase()}`);
  }

  return output;
}

function prefixSkillReferences(content: string, skillNameById: Record<string, string>): string {
  let result = content;
  const entries = Object.entries(skillNameById).sort((a, b) => b[0].length - a[0].length);

  for (const [id, prefixed] of entries) {
    const slashPattern = new RegExp(`/${escapeRegex(id)}(?=[^a-zA-Z0-9_-]|$)`, 'g');
    result = result.replace(slashPattern, `/${prefixed}`);

    const skillPhrasePattern = new RegExp(`the ${escapeRegex(id)} skill`, 'gi');
    result = result.replace(skillPhrasePattern, `the ${prefixed} skill`);
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFrontmatter(manifest: ToolModuleManifest, host: HostDefinition): FrontmatterMap {
  const frontmatter: FrontmatterMap = {
    name: manifest.skillName,
    description: manifest.skillDescription,
  };

  switch (host.id) {
    case 'claude-code':
    case 'opencode': {
      if (manifest.userInvokable) frontmatter['user-invokable'] = true;
      if (manifest.args && manifest.args.length > 0) frontmatter.args = manifest.args;
      if (manifest.license) frontmatter.license = manifest.license;
      if (manifest.compatibility) frontmatter.compatibility = manifest.compatibility;
      if (manifest.metadata) frontmatter.metadata = manifest.metadata;
      if (manifest.allowedTools && manifest.allowedTools.length > 0) frontmatter['allowed-tools'] = manifest.allowedTools;
      break;
    }
    case 'cursor': {
      if (manifest.license) frontmatter.license = manifest.license;
      break;
    }
    case 'gemini': {
      break;
    }
    case 'codex':
    case 'agents': {
      if (host.id === 'agents' && manifest.userInvokable) frontmatter['user-invokable'] = true;
      const hint = buildArgumentHint(manifest.args ?? []);
      if (hint) frontmatter['argument-hint'] = hint;
      if (host.id === 'codex' && manifest.license) frontmatter.license = manifest.license;
      break;
    }
    case 'kiro': {
      if (manifest.license) frontmatter.license = manifest.license;
      if (manifest.compatibility) frontmatter.compatibility = manifest.compatibility;
      if (manifest.metadata) frontmatter.metadata = manifest.metadata;
      break;
    }
    default:
      break;
  }

  return frontmatter;
}

function buildArgumentHint(args: Array<{ name: string; required?: boolean }>): string {
  if (args.length === 0) return '';
  return args.map((arg) => (arg.required ? `<${arg.name}>` : `[${arg.name.toUpperCase()}=<value>]`)).join(' ');
}

function generateYamlFrontmatter(data: FrontmatterMap): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    appendYaml(lines, key, value, 0);
  }
  lines.push('---');
  return lines.join('\n');
}

function appendYaml(lines: string[], key: string, value: unknown, indent: number): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    lines.push(`${pad}${key}:`);
    for (const item of value) {
      if (typeof item === 'object' && item !== null) {
        const entries = Object.entries(item as Record<string, unknown>);
        if (entries.length === 0) {
          lines.push(`${pad}  - {}`);
          continue;
        }
        const [firstKey, firstValue] = entries[0];
        lines.push(`${pad}  - ${firstKey}: ${yamlScalar(firstValue)}`);
        for (const [childKey, childValue] of entries.slice(1)) {
          lines.push(`${pad}    ${childKey}: ${yamlScalar(childValue)}`);
        }
      } else {
        lines.push(`${pad}  - ${yamlScalar(item)}`);
      }
    }
    return;
  }

  if (typeof value === 'object' && value !== null) {
    lines.push(`${pad}${key}:`);
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      appendYaml(lines, childKey, childValue, indent + 2);
    }
    return;
  }

  lines.push(`${pad}${key}: ${yamlScalar(value)}`);
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value ?? '');
  if (text === '' || /[:#\n]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}
