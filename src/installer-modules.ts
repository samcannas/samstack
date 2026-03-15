import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostDefinition } from './installer-hosts';

export type ModuleId = string;
export type ModuleInput = string;

export interface InstalledRuntime {
  runtimeDir: string;
  browserEntryPath: string;
  version: string;
}

export interface SkillFile {
  relativeDir: string;
  fileName: string;
  content: string;
}

export interface ModuleInstallContext {
  runtime: InstalledRuntime;
}

interface ToolModuleManifest {
  id: string;
  label: string;
  description: string;
  dependsOnRuntime?: boolean;
  skillId: string;
  skillName: string;
  skillDescription: string;
}

export interface StackModule {
  id: ModuleId;
  label: string;
  description: string;
  dependsOnRuntime: boolean;
  skillId: string;
  skillName: string;
  skillDescription: string;
  templateBody: string;
  createSkill(host: HostDefinition, context: ModuleInstallContext): SkillFile;
}

export function loadModules(packageRoot: string): StackModule[] {
  const toolsDir = path.join(packageRoot, 'tools');
  const skillRoot = path.join(packageRoot, 'skills');

  if (!fs.existsSync(toolsDir)) {
    throw new Error(`Missing tools directory: ${toolsDir}`);
  }
  if (!fs.existsSync(skillRoot)) {
    throw new Error(`Missing skills directory: ${skillRoot}`);
  }

  const modules: StackModule[] = [];
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(toolsDir, entry.name, 'module.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ToolModuleManifest;
    const skillPath = path.join(skillRoot, manifest.skillId, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Missing skill template for module '${manifest.id}' at ${skillPath}`);
    }

    const templateBody = fs.readFileSync(skillPath, 'utf-8').trimEnd();
    modules.push(createModule(manifest, templateBody));
  }

  modules.sort((left, right) => left.id.localeCompare(right.id));
  return modules;
}

export function getModuleDefinition(packageRoot: string, id: ModuleInput): StackModule {
  const entry = loadModules(packageRoot).find((module) => module.id === id.trim());
  if (!entry) {
    throw new Error(`Unknown SamStack module: ${id}`);
  }
  return entry;
}

function createModule(manifest: ToolModuleManifest, templateBody: string): StackModule {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    dependsOnRuntime: manifest.dependsOnRuntime !== false,
    skillId: manifest.skillId,
    skillName: manifest.skillName,
    skillDescription: manifest.skillDescription,
    templateBody,
    createSkill(host, context) {
      return {
        relativeDir: manifest.skillName,
        fileName: 'SKILL.md',
        content: `${generateFrontmatter(host, manifest.skillName, manifest.skillDescription)}\n\n${renderTemplate(templateBody, context)}`,
      };
    },
  };
}

function renderTemplate(template: string, context: ModuleInstallContext): string {
  const replacements: Record<string, string> = {
    SAMSTACK_INVOCATION: runtimeInvocation(context.runtime),
  };

  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = replacements[key];
    if (value == null) {
      throw new Error(`Unknown template placeholder: ${key}`);
    }
    return value;
  });
}

function runtimeInvocation(runtime: InstalledRuntime): string {
  return `node "${runtime.browserEntryPath}"`;
}

function generateFrontmatter(host: HostDefinition, name: string, description: string): string {
  const lines = ['---', `name: ${name}`, `description: ${description}`];
  if (host.supportsUserInvokable) {
    lines.push('user-invokable: true');
  }
  lines.push('---');
  return lines.join('\n');
}
