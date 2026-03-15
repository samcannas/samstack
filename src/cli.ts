/**
 * samstack CLI — thin wrapper that talks to the persistent server
 *
 * Flow:
 *   1. Read .samstack/samstack.json for port + token
 *   2. If missing or stale PID → start server in background
 *   3. Health check + version mismatch detection
 *   4. Send command via HTTP POST
 *   5. Print response to stdout (or stderr for errors)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';
import {
  COMMAND_NAME,
  IS_WINDOWS,
  SERVER_LOG_NAME,
  SERVER_SCRIPT_ENV_VAR,
  STATE_ENV_VAR,
  forceTerminateProcess,
  getLocalUrl,
  getModuleDir,
  getTempDir,
  isMainModule,
  readStdinText,
  sleep,
  softTerminateProcess,
} from './platform';

const config = resolveConfig();
const MAX_START_WAIT = 8000; // 8 seconds to start
const SERVER_LOG_PATH = path.join(config.stateDir, SERVER_LOG_NAME);

export function resolveServerScript(
  env: Record<string, string | undefined> = process.env,
  metaDir: string = getModuleDir(import.meta.url),
  execPath: string = process.execPath
): string {
  if (env[SERVER_SCRIPT_ENV_VAR]) {
    return env[SERVER_SCRIPT_ENV_VAR]!;
  }

  // Dev mode: cli.ts runs directly from src/
  if (path.isAbsolute(metaDir) && !metaDir.includes('$bunfs')) {
    const devCandidates = [
      path.resolve(metaDir, 'server.js'),
      path.resolve(metaDir, 'server.ts'),
      path.resolve(metaDir, '..', 'dist', 'server.js'),
    ];
    for (const candidate of devCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Built JS: prefer adjacent dist/server.js
  if (execPath) {
    const candidates = [
      path.resolve(path.dirname(execPath), 'server.js'),
      path.resolve(path.dirname(execPath), '..', 'dist', 'server.js'),
      path.resolve(path.dirname(execPath), '..', 'src', 'server.ts'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    `Cannot find server runtime. Set ${SERVER_SCRIPT_ENV_VAR} or run from the ${COMMAND_NAME} source tree.`
  );
}

const SERVER_SCRIPT = resolveServerScript();

function getServerCommand(): { command: string; args: string[] } {
  if (SERVER_SCRIPT.endsWith('.ts')) {
    return {
      command: process.execPath,
      args: ['--import', 'tsx', SERVER_SCRIPT],
    };
  }

  return {
    command: process.execPath,
    args: [SERVER_SCRIPT],
  };
}

interface ServerState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  serverPath: string;
  binaryVersion?: string;
}

// ─── State File ────────────────────────────────────────────────
function readState(): ServerState | null {
  try {
    const data = fs.readFileSync(config.stateFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Process Management ─────────────────────────────────────────
async function killServer(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;

  softTerminateProcess(pid);

  // Wait up to 2s for graceful shutdown
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(100);
  }

  // Force kill if still alive
  if (isProcessAlive(pid)) {
    forceTerminateProcess(pid);
  }
}

/**
 * Clean up legacy temp state files from before project-local state.
 */
function cleanupLegacyState(): void {
  const tempDir = getTempDir();
  try {
    const files = fs.readdirSync(tempDir).filter((file) =>
      /^(browse|teststack|samstack)-server.*\.json$/i.test(file)
    );
    for (const file of files) {
      const fullPath = path.join(tempDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (data.pid && isProcessAlive(data.pid)) {
          softTerminateProcess(data.pid);
        }
        fs.unlinkSync(fullPath);
      } catch {
        // Best effort — skip files we can't parse or clean up
      }
    }
    // Clean up legacy log files too
    const logFiles = fs.readdirSync(tempDir).filter((file) =>
      /^(browse|teststack|samstack)-(console|network|dialog)/i.test(file)
    );
    for (const file of logFiles) {
      try { fs.unlinkSync(path.join(tempDir, file)); } catch {}
    }
  } catch {
    // Temp directory read failed — skip legacy cleanup
  }
}

// ─── Server Lifecycle ──────────────────────────────────────────
async function startServer(): Promise<ServerState> {
  ensureStateDir(config);

  // Clean up stale state file
  try { fs.unlinkSync(config.stateFile); } catch {}
  try { fs.unlinkSync(SERVER_LOG_PATH); } catch {}

  // Start server as detached background process
  const serverCommand = getServerCommand();
  const proc = startBackgroundServerProcess(serverCommand.command, serverCommand.args);

  // Don't hold the CLI open
  proc.unref();

  // Wait for state file to appear
  const start = Date.now();
  while (Date.now() - start < MAX_START_WAIT) {
    const state = readState();
    if (state && isProcessAlive(state.pid)) {
      return state;
    }
    await sleep(100);
  }

  const serverLogTail = readServerLogTail();
  if (serverLogTail) {
    throw new Error(`Server failed to start:\n${serverLogTail}`);
  }
  throw new Error(`Server failed to start within ${MAX_START_WAIT / 1000}s`);
}

function startBackgroundServerProcess(command: string, args: string[]) {
  if (IS_WINDOWS) {
    return startHiddenWindowsProcess(command, args);
  }

  return spawn(command, args, {
    stdio: 'ignore',
    env: { ...process.env, [STATE_ENV_VAR]: config.stateFile },
    detached: true,
    windowsHide: true,
  });
}

function startHiddenWindowsProcess(command: string, args: string[]) {
  const launcherPath = path.join(config.stateDir, 'launch-hidden.vbs');
  const cmdLine = buildHiddenWindowsCommand(command, args);
  const vbs = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run ${toVbsString(cmdLine)}, 0, False`,
  ].join('\r\n');

  fs.writeFileSync(launcherPath, vbs, 'utf-8');

  return spawn('wscript.exe', [launcherPath], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
}

function buildHiddenWindowsCommand(command: string, args: string[]): string {
  const fullCommand = [command, ...args].map(quoteForCmd).join(' ');
  return `cmd.exe /c "set \"${STATE_ENV_VAR}=${escapeCmdValue(config.stateFile)}\" && cd /d ${quoteForCmd(process.cwd())} && ${fullCommand}"`;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function escapeCmdValue(value: string): string {
  return value.replace(/[\^&|<>]/g, '^$&');
}

function toVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function readServerLogTail(): string {
  try {
    const text = fs.readFileSync(SERVER_LOG_PATH, 'utf-8').trim();
    if (!text) return '';
    const lines = text.split(/\r?\n/);
    return lines.slice(-20).join('\n');
  } catch {
    return '';
  }
}

async function ensureServer(): Promise<ServerState> {
  const state = readState();

  if (state && isProcessAlive(state.pid)) {
      // Check for binary version mismatch (auto-restart on update)
      const currentVersion = readVersionHash();
      if (currentVersion && state.binaryVersion && currentVersion !== state.binaryVersion) {
      console.error(`[${COMMAND_NAME}] Binary updated, restarting server...`);
      await killServer(state.pid);
      return startServer();
    }

    // Server appears alive — do a health check
    try {
      const resp = await fetch(getLocalUrl(state.port, '/health'), {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const health = await resp.json() as any;
        if (health.status === 'healthy') {
          return state;
        }
      }
    } catch {
      // Health check failed — server is dead or unhealthy
    }
  }

  // Need to (re)start
  console.error(`[${COMMAND_NAME}] Starting server...`);
  return startServer();
}

// ─── Command Dispatch ──────────────────────────────────────────
async function sendCommand(state: ServerState, command: string, args: string[], retries = 0): Promise<void> {
  const body = JSON.stringify({ command, args });

  try {
    const resp = await fetch(getLocalUrl(state.port, '/command'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (resp.status === 401) {
      // Token mismatch — server may have restarted
      console.error(`[${COMMAND_NAME}] Auth failed — server may have restarted. Retrying...`);
      const newState = readState();
      if (newState && newState.token !== state.token) {
        return sendCommand(newState, command, args);
      }
      throw new Error('Authentication failed');
    }

    const text = await resp.text();

    if (resp.ok) {
      process.stdout.write(text);
      if (!text.endsWith('\n')) process.stdout.write('\n');
    } else {
      // Try to parse as JSON error
      try {
        const err = JSON.parse(text);
        console.error(err.error || text);
        if (err.hint) console.error(err.hint);
      } catch {
        console.error(text);
      }
      process.exit(1);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.error(`[${COMMAND_NAME}] Command timed out after 30s`);
      process.exit(1);
    }
    // Connection error — server may have crashed
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('fetch failed')) {
      if (retries >= 1) throw new Error(`[${COMMAND_NAME}] Server crashed twice in a row — aborting`);
      console.error(`[${COMMAND_NAME}] Server connection lost. Restarting...`);
      const newState = await startServer();
      return sendCommand(newState, command, args, retries + 1);
    }
    throw err;
  }
}

// ─── Main ──────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`${COMMAND_NAME} — Fast headless browser for AI coding agents

Usage: ${COMMAND_NAME} <command> [args...]

Navigation:     goto <url> | back | forward | reload | url
Content:        text | html [sel] | links | forms | accessibility
Interaction:    click <sel> | fill <sel> <val> | select <sel> <val>
                hover <sel> | type <text> | press <key>
                scroll [sel] | wait <sel|--networkidle|--load> | viewport <WxH>
                upload <sel> <file1> [file2...]
                cookie-import <json-file>
                cookie-import-browser [browser] [--domain <d>]
Inspection:     js <expr> | eval <file> | css <sel> <prop> | attrs <sel>
                console [--clear|--errors] | network [--clear] | dialog [--clear]
                cookies | storage [set <k> <v>] | perf
                is <prop> <sel> (visible|hidden|enabled|disabled|checked|editable|focused)
Visual:         screenshot [--viewport] [--clip x,y,w,h] [@ref|sel] [path]
                pdf [path] | responsive [prefix]
Snapshot:       snapshot [-i] [-c] [-d N] [-s sel] [-D] [-a] [-o path] [-C]
                -D/--diff: diff against previous snapshot
                -a/--annotate: annotated screenshot with ref labels
                -C/--cursor-interactive: find non-ARIA clickable elements
Compare:        diff <url1> <url2>
Multi-step:     chain (reads JSON from stdin)
Tabs:           tabs | tab <id> | newtab [url] | closetab [id]
Server:         status | cookie <n>=<v> | header <n>:<v>
                useragent <str> | stop | restart
Dialogs:        dialog-accept [text] | dialog-dismiss

Refs:           After 'snapshot', use @e1, @e2... as selectors:
                click @e3 | fill @e4 "value" | hover @e1
                @c refs from -C: click @c1`);
    process.exit(0);
  }

  // One-time cleanup of legacy temp state files
  cleanupLegacyState();

  const command = args[0];
  const commandArgs = args.slice(1);

  // Special case: chain reads from stdin
  if (command === 'chain' && commandArgs.length === 0) {
    const stdin = await readStdinText();
    commandArgs.push(stdin.trim());
  }

  const state = await ensureServer();
  await sendCommand(state, command, commandArgs);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`[${COMMAND_NAME}] ${err.message}`);
    process.exit(1);
  });
}
