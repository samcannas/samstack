import type { HostDefinition } from './installer-hosts';

export type ModuleId = 'web-debug';
export type ModuleInput = ModuleId | 'visual-debug';

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

export interface StackModule {
  id: ModuleId;
  label: string;
  description: string;
  dependsOnRuntime: boolean;
  createSkill(host: HostDefinition, context: ModuleInstallContext): SkillFile;
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

function webDebugBody(invocation: string): string {
  return [
    'Use SamStack to inspect, interact with, and visually debug websites through a persistent Playwright browser runtime.',
    '',
    'Core workflow:',
    `1. Open the page with \`${invocation} goto <url>\``,
    `2. Inspect structure with \`${invocation} snapshot -i\` or \`${invocation} text\``,
    '3. Use refs like `@e1` from `snapshot -i` for `click`, `fill`, `hover`, `wait`, and `upload`',
    `4. Use \`${invocation} console\`, \`${invocation} network\`, and \`${invocation} cookies\` to debug runtime behavior`,
    `5. Use \`${invocation} screenshot\`, \`${invocation} snapshot -a\`, and \`${invocation} responsive\` for visual QA`,
    `6. Finish with \`${invocation} stop\` so the server shuts down cleanly`,
    '',
    'Common commands:',
    `- \`${invocation} goto https://example.com\``,
    `- \`${invocation} snapshot -i\``,
    `- \`${invocation} click @e3\``,
    `- \`${invocation} fill @e4 \"hello@example.com\"\``,
    `- \`${invocation} text\``,
    `- \`${invocation} screenshot\``,
    `- \`${invocation} snapshot -a\``,
    `- \`${invocation} responsive\``,
    `- \`${invocation} console --errors\``,
    `- \`${invocation} network\``,
    '',
    'Use this skill whenever you need autonomous browser analysis, evidence gathering, or visual debugging instead of raw HTML-only inspection.',
  ].join('\n');
}

export const MODULES: StackModule[] = [
  {
    id: 'web-debug',
    label: 'Web Debug',
    description: 'Installs the browser runtime and a host skill for browsing, interaction, screenshots, responsive checks, and evidence gathering.',
    dependsOnRuntime: true,
    createSkill(host, context) {
      const name = 'samstack-web-debug';
      return {
        relativeDir: name,
        fileName: 'SKILL.md',
        content: `${generateFrontmatter(host, name, 'Inspect, interact with, and visually debug websites using the SamStack Playwright runtime.')}\n\n${webDebugBody(runtimeInvocation(context.runtime))}`,
      };
    },
  },
];

export function normalizeModuleId(id: ModuleInput): ModuleId {
  return id === 'visual-debug' ? 'web-debug' : id;
}

export function getModuleDefinition(id: ModuleInput): StackModule {
  const normalized = normalizeModuleId(id);
  const entry = MODULES.find((module) => module.id === normalized);
  if (!entry) {
    throw new Error(`Unknown SamStack module: ${id}`);
  }
  return entry;
}
