/**
 * Shared config for samstack CLI + server.
 *
 * Resolution:
 *   1. SAMSTACK_STATE_FILE env → derive stateDir from parent
 *   2. git rev-parse --show-toplevel → projectDir/.samstack/
 *   3. process.cwd() fallback (non-git environments)
 *
 * The CLI computes the config and passes SAMSTACK_STATE_FILE to the
 * spawned server. The server derives all paths from that env var.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'node:child_process';
import {
  COMMAND_NAME,
  CONSOLE_LOG_NAME,
  DIALOG_LOG_NAME,
  NETWORK_LOG_NAME,
  SERVER_LOG_NAME,
  STATE_DIR_NAME,
  STATE_ENV_VAR,
  STATE_FILE_NAME,
} from './platform';

export interface BrowseConfig {
  projectDir: string;
  stateDir: string;
  stateFile: string;
  consoleLog: string;
  networkLog: string;
  dialogLog: string;
}

/**
 * Detect the git repository root, or null if not in a repo / git unavailable.
 */
export function getGitRoot(): string | null {
  try {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    });
    if (proc.status !== 0) return null;
    return proc.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve all samstack config paths.
 *
 * If SAMSTACK_STATE_FILE is set (e.g. by CLI when spawning server, or by
 * tests for isolation), all paths are derived from it. Otherwise, the
 * project root is detected via git or cwd.
 */
export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
): BrowseConfig {
  let stateFile: string;
  let stateDir: string;
  let projectDir: string;

  if (env[STATE_ENV_VAR]) {
    stateFile = env[STATE_ENV_VAR]!;
    stateDir = path.dirname(stateFile);
    projectDir = path.dirname(stateDir); // parent of .samstack/
  } else {
    projectDir = getGitRoot() || process.cwd();
    stateDir = path.join(projectDir, STATE_DIR_NAME);
    stateFile = path.join(stateDir, STATE_FILE_NAME);
  }

  return {
    projectDir,
    stateDir,
    stateFile,
    consoleLog: path.join(stateDir, CONSOLE_LOG_NAME),
    networkLog: path.join(stateDir, NETWORK_LOG_NAME),
    dialogLog: path.join(stateDir, DIALOG_LOG_NAME),
  };
}

/**
 * Create the .samstack/ state directory if it doesn't exist.
 * Throws with a clear message on permission errors.
 */
export function ensureStateDir(config: BrowseConfig): void {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
  } catch (err: any) {
    if (err.code === 'EACCES') {
      throw new Error(`Cannot create state directory ${config.stateDir}: permission denied`);
    }
    if (err.code === 'ENOTDIR') {
      throw new Error(`Cannot create state directory ${config.stateDir}: a file exists at that path`);
    }
    throw err;
  }

  // Ensure .samstack/ is in the project's .gitignore
  const gitignorePath = path.join(config.projectDir, '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const escapedStateDir = STATE_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!content.match(new RegExp(`^${escapedStateDir}/?$`, 'm'))) {
      const separator = content.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignorePath, `${separator}${STATE_DIR_NAME}/\n`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      // Write warning to server log (visible even in daemon mode)
      const logPath = path.join(config.stateDir, SERVER_LOG_NAME);
      try {
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] Warning: could not update .gitignore at ${gitignorePath}: ${err.message}\n`);
      } catch {
        // stateDir write failed too — nothing more we can do
      }
    }
    // ENOENT (no .gitignore) — skip silently
  }
}

/**
 * Derive a slug from the git remote origin URL (owner-repo format).
 * Falls back to the directory basename if no remote is configured.
 */
export function getRemoteSlug(): string {
  try {
    const proc = spawnSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    });
    if (proc.status !== 0) throw new Error('no remote');
    const url = proc.stdout.trim();
    // SSH:   git@github.com:owner/repo.git → owner-repo
    // HTTPS: https://github.com/owner/repo.git → owner-repo
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}-${match[2]}`;
    throw new Error('unparseable');
  } catch {
    const root = getGitRoot();
    return path.basename(root || process.cwd());
  }
}

/**
 * Read the binary version (git SHA) from dist/.version.
 * Returns null if the file doesn't exist or can't be read.
 */
export function readVersionHash(execPath: string = process.argv[1] || process.execPath): string | null {
  try {
    const versionFile = path.resolve(path.dirname(execPath), '.version');
    return fs.readFileSync(versionFile, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
