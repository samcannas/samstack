import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { HostId, HostInstallTarget, InstallScope } from './installer-hosts';
import type { ModuleId } from './installer-modules';

export interface InstalledModuleFileRecord {
  relativePath: string;
  checksum: string;
}

export interface InstalledModuleRecord {
  moduleId: ModuleId;
  relativeDir: string;
  files: InstalledModuleFileRecord[];
  installedAt: string;
}

export interface InstalledTargetRecord {
  host: HostId;
  scope: InstallScope;
  skillsDir: string;
  modules: InstalledModuleRecord[];
}

export interface InstallManifest {
  updatedAt: string;
  runtimeVersion: string;
  targets: InstalledTargetRecord[];
}

export function computeChecksum(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function getInstallerManifestPath(rootDir: string): string {
  return path.join(rootDir, '.samstack', 'installer-manifest.json');
}

export function readInstallManifest(rootDir: string): InstallManifest | null {
  const manifestPath = getInstallerManifestPath(rootDir);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstallManifest;
  } catch {
    return null;
  }
}

export async function writeTargetManifest(
  rootDir: string,
  runtimeVersion: string,
  target: HostInstallTarget,
  modules: InstalledModuleRecord[],
): Promise<void> {
  const manifest = readInstallManifest(rootDir) ?? {
    updatedAt: new Date().toISOString(),
    runtimeVersion,
    targets: [],
  } satisfies InstallManifest;

  manifest.updatedAt = new Date().toISOString();
  manifest.runtimeVersion = runtimeVersion;

  const existingIndex = manifest.targets.findIndex((entry) =>
    entry.host === target.host.id && entry.scope === target.scope && entry.skillsDir === target.skillsDir,
  );

  const targetRecord: InstalledTargetRecord = {
    host: target.host.id,
    scope: target.scope,
    skillsDir: target.skillsDir,
    modules,
  };

  if (existingIndex >= 0) {
    manifest.targets[existingIndex] = targetRecord;
  } else {
    manifest.targets.push(targetRecord);
  }

  await writeManifest(rootDir, manifest);
}

export async function removeModulesFromManifest(
  rootDir: string,
  target: HostInstallTarget,
  moduleIds: ModuleId[],
): Promise<void> {
  const manifest = readInstallManifest(rootDir);
  if (!manifest) return;

  const existingIndex = manifest.targets.findIndex((entry) =>
    entry.host === target.host.id && entry.scope === target.scope && entry.skillsDir === target.skillsDir,
  );
  if (existingIndex < 0) return;

  manifest.targets[existingIndex].modules = manifest.targets[existingIndex].modules.filter(
    (entry) => !moduleIds.includes(entry.moduleId),
  );

  if (manifest.targets[existingIndex].modules.length === 0) {
    manifest.targets.splice(existingIndex, 1);
  }

  manifest.updatedAt = new Date().toISOString();
  await writeManifest(rootDir, manifest);
}

export function findInstalledTargetRecord(rootDir: string, target: HostInstallTarget): InstalledTargetRecord | null {
  const manifest = readInstallManifest(rootDir);
  if (!manifest) return null;
  return (
    manifest.targets.find(
      (entry) => entry.host === target.host.id && entry.scope === target.scope && entry.skillsDir === target.skillsDir,
    ) ?? null
  );
}

export async function safeReadText(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function writeManifest(rootDir: string, manifest: InstallManifest): Promise<void> {
  const manifestPath = getInstallerManifestPath(rootDir);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}
