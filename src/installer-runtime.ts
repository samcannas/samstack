import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { InstalledRuntime } from './installer-modules';

interface RuntimePackageInfo {
  version: string;
  dependencies: Record<string, string>;
}

export interface BrowserRuntimeStatus {
  installed: boolean;
  upToDate: boolean;
  expectedVersion: string;
  installedVersion: string | null;
  runtimeDir: string;
  browserEntryPath: string;
}

export async function ensureBrowserRuntimeInstalled(packageRoot: string): Promise<InstalledRuntime> {
  const runtimePackage = readRuntimePackageInfo(packageRoot);
  const { installRoot, runtimeEntry, serverEntry, manifestPath } = getRuntimePaths();

  await fsp.mkdir(installRoot, { recursive: true });

  const expectedManifest = {
    version: runtimePackage.version,
    dependencies: runtimePackage.dependencies,
  };

  const currentManifest = readJsonFile(manifestPath);
  const requiresInstall = !fs.existsSync(runtimeEntry)
    || !fs.existsSync(serverEntry)
    || JSON.stringify(currentManifest) !== JSON.stringify(expectedManifest)
    || !fs.existsSync(path.join(installRoot, 'node_modules'));

  if (requiresInstall) {
    copyRuntimeArtifacts(packageRoot, installRoot);
    writeRuntimePackageJson(installRoot, runtimePackage);
    await fsp.writeFile(manifestPath, JSON.stringify(expectedManifest, null, 2) + '\n', 'utf-8');
    runNpmInstall(installRoot);
    runPlaywrightInstall(installRoot);
  }

  return {
    runtimeDir: installRoot,
    browserEntryPath: runtimeEntry,
    version: runtimePackage.version,
  };
}

export function getBrowserRuntimeStatus(packageRoot: string): BrowserRuntimeStatus {
  const runtimePackage = readRuntimePackageInfo(packageRoot);
  const { installRoot, runtimeEntry, serverEntry, manifestPath } = getRuntimePaths();
  const expectedManifest = {
    version: runtimePackage.version,
    dependencies: runtimePackage.dependencies,
  };
  const currentManifest = readJsonFile(manifestPath) as { version?: string; dependencies?: Record<string, string> } | null;
  const installed = fs.existsSync(runtimeEntry) && fs.existsSync(serverEntry) && fs.existsSync(path.join(installRoot, 'node_modules'));
  const upToDate = installed && JSON.stringify(currentManifest) === JSON.stringify(expectedManifest);

  return {
    installed,
    upToDate,
    expectedVersion: runtimePackage.version,
    installedVersion: currentManifest?.version ?? null,
    runtimeDir: installRoot,
    browserEntryPath: runtimeEntry,
  };
}

function readRuntimePackageInfo(packageRoot: string): RuntimePackageInfo {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
    version: string;
    dependencies: Record<string, string>;
  };

  return {
    version: pkg.version,
    dependencies: {
      playwright: pkg.dependencies.playwright,
      diff: pkg.dependencies.diff,
      'sql.js': pkg.dependencies['sql.js'],
    },
  };
}

function getRuntimePaths() {
  const installRoot = path.join(os.homedir(), '.samstack', 'runtime', 'browser');
  return {
    installRoot,
    runtimeEntry: path.join(installRoot, 'samstack-browser.js'),
    serverEntry: path.join(installRoot, 'server.js'),
    manifestPath: path.join(installRoot, 'manifest.json'),
  };
}

function copyRuntimeArtifacts(packageRoot: string, installRoot: string): void {
  const runtimeDist = path.join(packageRoot, 'dist', 'runtime');
  const files = [
    'samstack-browser.js',
    'samstack-browser.js.map',
    'server.js',
    'server.js.map',
    '.build-target',
  ];

  for (const fileName of files) {
    const sourcePath = path.join(runtimeDist, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.join(installRoot, fileName));
    }
  }
}

function writeRuntimePackageJson(installRoot: string, runtimePackage: RuntimePackageInfo): void {
  const runtimePkg = {
    name: 'samstack-browser-runtime',
    private: true,
    version: runtimePackage.version,
    type: 'module',
    dependencies: runtimePackage.dependencies,
  };

  fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n', 'utf-8');
}

function runNpmInstall(runtimeDir: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm install --omit=dev --no-fund --no-audit'], {
        cwd: runtimeDir,
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      })
    : spawnSync('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], {
        cwd: runtimeDir,
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      });

  if (result.status !== 0) {
    throw new Error(`Failed to install SamStack runtime dependencies.${result.error ? ` ${result.error.message}` : ''}`);
  }
}

function runPlaywrightInstall(runtimeDir: string): void {
  const cliPath = path.join(runtimeDir, 'node_modules', 'playwright', 'cli.js');
  const result = spawnSync(process.execPath, [cliPath, 'install', 'chromium'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error('Failed to install Playwright Chromium for SamStack.');
  }
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}
