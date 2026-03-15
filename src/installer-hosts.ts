import * as os from 'node:os';
import * as path from 'node:path';

export type InstallScope = 'project' | 'global';
export type HostId = 'claude-code' | 'opencode' | 'cursor' | 'codex' | 'kiro' | 'agents' | 'gemini';

export interface HostDefinition {
  id: HostId;
  label: string;
  description: string;
  configDirName: string;
  supportedScopes: InstallScope[];
  supportsUserInvokable: boolean;
}

export const HOSTS: HostDefinition[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'Install skills into .opencode/skills for project or home use.',
    configDirName: '.opencode',
    supportedScopes: ['project', 'global'],
    supportsUserInvokable: true,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: 'Install skills into .claude/skills for project or home use.',
    configDirName: '.claude',
    supportedScopes: ['project', 'global'],
    supportsUserInvokable: true,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    description: 'Install project-local Agent Skills into .cursor/skills.',
    configDirName: '.cursor',
    supportedScopes: ['project'],
    supportsUserInvokable: false,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'Install skills into .codex/skills for project or home use.',
    configDirName: '.codex',
    supportedScopes: ['project', 'global'],
    supportsUserInvokable: false,
  },
  {
    id: 'kiro',
    label: 'Kiro',
    description: 'Install project-local skills into .kiro/skills.',
    configDirName: '.kiro',
    supportedScopes: ['project'],
    supportsUserInvokable: false,
  },
  {
    id: 'agents',
    label: 'GitHub Copilot / Agents',
    description: 'Install skills into .agents/skills for project or home use.',
    configDirName: '.agents',
    supportedScopes: ['project', 'global'],
    supportsUserInvokable: false,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'Install project-local skills into .gemini/skills.',
    configDirName: '.gemini',
    supportedScopes: ['project'],
    supportsUserInvokable: false,
  },
];

export interface HostInstallTarget {
  host: HostDefinition;
  scope: InstallScope;
  rootDir: string;
  skillsDir: string;
}

export function getHostDefinition(id: HostId): HostDefinition {
  const host = HOSTS.find((entry) => entry.id === id);
  if (!host) {
    throw new Error(`Unknown host: ${id}`);
  }
  return host;
}

export function resolveHostInstallTarget(host: HostDefinition, scope: InstallScope, projectDir: string): HostInstallTarget {
  if (!host.supportedScopes.includes(scope)) {
    throw new Error(`${host.label} does not support ${scope} installs.`);
  }

  const rootDir = scope === 'project'
    ? path.resolve(projectDir)
    : os.homedir();

  return {
    host,
    scope,
    rootDir,
    skillsDir: path.join(rootDir, host.configDirName, 'skills'),
  };
}

export function installTargetLabel(target: HostInstallTarget): string {
  return `${target.host.label} (${target.scope}) → ${target.skillsDir}`;
}
