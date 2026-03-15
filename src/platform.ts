import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';

export const COMMAND_NAME = 'samstack';
export const STATE_DIR_NAME = '.samstack';
export const STATE_FILE_NAME = 'samstack.json';
export const CONSOLE_LOG_NAME = 'samstack-console.log';
export const NETWORK_LOG_NAME = 'samstack-network.log';
export const DIALOG_LOG_NAME = 'samstack-dialog.log';
export const SERVER_LOG_NAME = 'samstack-server.log';
export const FIND_BINARY_NAME = 'find-samstack';
export const LOCALHOST = '127.0.0.1';

export const STATE_ENV_VAR = 'SAMSTACK_STATE_FILE';
export const SERVER_SCRIPT_ENV_VAR = 'SAMSTACK_SERVER_SCRIPT';
export const PORT_ENV_VAR = 'SAMSTACK_PORT';
export const IDLE_TIMEOUT_ENV_VAR = 'SAMSTACK_IDLE_TIMEOUT';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

export function getModuleDir(metaUrl: string): string {
  return path.dirname(fileURLToPath(metaUrl));
}

export function withExecutableExtension(name: string): string {
  return IS_WINDOWS ? `${name}.exe` : name;
}

export function getTempDir(): string {
  return os.tmpdir();
}

export function getDefaultArtifactPath(fileName: string): string {
  return path.join(getTempDir(), fileName);
}

export function getSafeRoots(extraRoots: string[] = []): string[] {
  const roots = [getTempDir(), process.cwd(), ...extraRoots].map((root) => path.resolve(root));
  return [...new Set(roots)];
}

export function isPathWithin(basePath: string, targetPath: string): boolean {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function ensurePathWithinRoots(filePath: string, roots: string[] = getSafeRoots()): string {
  const resolved = path.resolve(filePath);
  if (!roots.some((root) => isPathWithin(root, resolved))) {
    throw new Error(`Path must be within: ${roots.join(', ')}`);
  }
  return resolved;
}

export function writePrivateFile(filePath: string, contents: string): void {
  if (IS_WINDOWS) {
    fs.writeFileSync(filePath, contents);
    return;
  }
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

export function getLocalUrl(port: number, pathname = ''): string {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return pathname ? `http://${LOCALHOST}:${port}${normalizedPath}` : `http://${LOCALHOST}:${port}`;
}

export function openUrl(url: string): void {
  const command = IS_WINDOWS
    ? ['explorer.exe', url]
    : IS_MACOS
      ? ['open', url]
      : ['xdg-open', url];

  try {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Best effort.
  }
}

export function softTerminateProcess(pid: number): void {
  if (IS_WINDOWS) {
    try { process.kill(pid); } catch {}
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

export function forceTerminateProcess(pid: number): void {
  if (IS_WINDOWS) {
    try { process.kill(pid); } catch {}
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 2000 });
    } catch {}
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

export function getHomeLocalAppData(): string {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

export function getHomeRoamingAppData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

export function makeTempCopyPath(prefix: string, extension = ''): string {
  const dir = fs.mkdtempSync(path.join(getTempDir(), `${prefix}-`));
  return path.join(dir, `${cryptoSafeRandomId()}${extension}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function isMainModule(metaUrl: string): boolean {
  const modulePath = fileURLToPath(metaUrl);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  return entry === path.resolve(modulePath);
}

function cryptoSafeRandomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
