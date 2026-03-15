/**
 * samstack server — persistent Chromium daemon
 *
 * Architecture:
 *   Node HTTP server on localhost → routes commands to Playwright
 *   Console/network/dialog buffers: CircularBuffer in-memory + async disk flush
 *   Chromium crash → server EXITS with clear error (CLI auto-restarts)
 *   Auto-shutdown after SAMSTACK_IDLE_TIMEOUT (default 30 min)
 *
 * State:
 *   State file: <project-root>/.samstack/samstack.json (set via SAMSTACK_STATE_FILE env)
 *   Log files:  <project-root>/.samstack/samstack-{console,network,dialog}.log
 *   Port:       defaults to 5435, falls back to random 10000-60000 if busy (or SAMSTACK_PORT env for override)
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from './browser-manager';
import { handleReadCommand } from './read-commands';
import { handleWriteCommand } from './write-commands';
import { handleMetaCommand } from './meta-commands';
import { handleCookiePickerRoute } from './cookie-picker-routes';
import { COMMAND_DESCRIPTIONS, READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS } from './commands';
import { SNAPSHOT_FLAGS } from './snapshot';
import { resolveConfig, ensureStateDir, readVersionHash } from './config';
import {
  COMMAND_NAME,
  IDLE_TIMEOUT_ENV_VAR,
  LOCALHOST,
  PORT_ENV_VAR,
  SERVER_LOG_NAME,
  getLocalUrl,
  writePrivateFile,
  isMainModule,
} from './platform';
import { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry } from './buffers';

export { consoleBuffer, networkBuffer, dialogBuffer, addConsoleEntry, addNetworkEntry, addDialogEntry, type LogEntry, type NetworkEntry, type DialogEntry };
export { READ_COMMANDS, WRITE_COMMANDS, META_COMMANDS };

const config = resolveConfig();
ensureStateDir(config);

const AUTH_TOKEN = crypto.randomUUID();
const EXPLICIT_PORT = process.env[PORT_ENV_VAR] ? parseInt(process.env[PORT_ENV_VAR]!, 10) : 0;
const DEFAULT_PORT = 5435;
const IDLE_TIMEOUT_MS = parseInt(process.env[IDLE_TIMEOUT_ENV_VAR] || '1800000', 10);

const CONSOLE_LOG_PATH = config.consoleLog;
const NETWORK_LOG_PATH = config.networkLog;
const DIALOG_LOG_PATH = config.dialogLog;
const SERVER_LOG_PATH = path.join(config.stateDir, SERVER_LOG_NAME);

let lastConsoleFlushed = 0;
let lastNetworkFlushed = 0;
let lastDialogFlushed = 0;
let flushInProgress = false;
let lastActivity = Date.now();
let isShuttingDown = false;
let httpServer: HttpServer | null = null;

const browserManager = new BrowserManager();

function validateAuth(req: Request): boolean {
  const header = req.headers.get('authorization');
  return header === `Bearer ${AUTH_TOKEN}`;
}

function generateHelpText(): string {
  const groups = new Map<string, string[]>();
  for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
    const display = meta.usage || cmd;
    const list = groups.get(meta.category) || [];
    list.push(display);
    groups.set(meta.category, list);
  }

  const categoryOrder = [
    'Navigation', 'Reading', 'Interaction', 'Inspection',
    'Visual', 'Snapshot', 'Meta', 'Tabs', 'Server',
  ];

  const lines = [`${COMMAND_NAME} — headless browser for AI agents`, '', 'Commands:'];
  for (const cat of categoryOrder) {
    const cmds = groups.get(cat);
    if (!cmds) continue;
    lines.push(`  ${(cat + ':').padEnd(15)}${cmds.join(', ')}`);
  }

  lines.push('', 'Snapshot flags:');
  const flagPairs: string[] = [];
  for (const flag of SNAPSHOT_FLAGS) {
    const label = flag.valueHint ? `${flag.short} ${flag.valueHint}` : flag.short;
    flagPairs.push(`${label}  ${flag.long}`);
  }
  for (let i = 0; i < flagPairs.length; i += 2) {
    const left = flagPairs[i].padEnd(28);
    const right = flagPairs[i + 1] || '';
    lines.push(`  ${left}${right}`);
  }

  return lines.join('\n');
}

async function flushBuffers() {
  if (flushInProgress) return;
  flushInProgress = true;

  try {
    const newConsoleCount = consoleBuffer.totalAdded - lastConsoleFlushed;
    if (newConsoleCount > 0) {
      const entries = consoleBuffer.last(Math.min(newConsoleCount, consoleBuffer.length));
      const lines = entries.map((e) => `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.text}`).join('\n') + '\n';
      await fsp.appendFile(CONSOLE_LOG_PATH, lines, 'utf-8');
      lastConsoleFlushed = consoleBuffer.totalAdded;
    }

    const newNetworkCount = networkBuffer.totalAdded - lastNetworkFlushed;
    if (newNetworkCount > 0) {
      const entries = networkBuffer.last(Math.min(newNetworkCount, networkBuffer.length));
      const lines = entries.map((e) => `[${new Date(e.timestamp).toISOString()}] ${e.method} ${e.url} → ${e.status || 'pending'} (${e.duration || '?'}ms, ${e.size || '?'}B)`).join('\n') + '\n';
      await fsp.appendFile(NETWORK_LOG_PATH, lines, 'utf-8');
      lastNetworkFlushed = networkBuffer.totalAdded;
    }

    const newDialogCount = dialogBuffer.totalAdded - lastDialogFlushed;
    if (newDialogCount > 0) {
      const entries = dialogBuffer.last(Math.min(newDialogCount, dialogBuffer.length));
      const lines = entries.map((e) => `[${new Date(e.timestamp).toISOString()}] [${e.type}] "${e.message}" → ${e.action}${e.response ? ` "${e.response}"` : ''}`).join('\n') + '\n';
      await fsp.appendFile(DIALOG_LOG_PATH, lines, 'utf-8');
      lastDialogFlushed = dialogBuffer.totalAdded;
    }
  } catch {
    // Flush failures are non-fatal.
  } finally {
    flushInProgress = false;
  }
}

async function appendServerLog(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fsp.appendFile(SERVER_LOG_PATH, line, 'utf-8');
  } catch {
    // Best effort.
  }
}

const flushInterval = setInterval(flushBuffers, 1000);

function resetIdleTimer() {
  lastActivity = Date.now();
}

const idleCheckInterval = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    console.log(`[${COMMAND_NAME}] Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down`);
    void shutdown();
  }
}, 60_000);

async function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.listen(port, LOCALHOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPort(): Promise<number> {
  if (EXPLICIT_PORT) {
    if (await canBindPort(EXPLICIT_PORT)) return EXPLICIT_PORT;
    throw new Error(`[${COMMAND_NAME}] Port ${EXPLICIT_PORT} (from ${PORT_ENV_VAR}) is in use`);
  }

  if (await canBindPort(DEFAULT_PORT)) return DEFAULT_PORT;

  const MIN_PORT = 10000;
  const MAX_PORT = 60000;
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT));
    if (await canBindPort(port)) return port;
  }

  throw new Error(`[${COMMAND_NAME}] No available port after ${MAX_RETRIES} attempts in range ${MIN_PORT}-${MAX_PORT}`);
}

function wrapError(err: any): string {
  const msg = err.message || String(err);
  if (err.name === 'TimeoutError' || msg.includes('Timeout') || msg.includes('timeout')) {
    if (msg.includes('locator.click') || msg.includes('locator.fill') || msg.includes('locator.hover')) {
      return `Element not found or not interactable within timeout. Check your selector or run 'snapshot' for fresh refs.`;
    }
    if (msg.includes('page.goto') || msg.includes('Navigation')) {
      return `Page navigation timed out. The URL may be unreachable or the page may be loading slowly.`;
    }
    return `Operation timed out: ${msg.split('\n')[0]}`;
  }
  if (msg.includes('resolved to') && msg.includes('elements')) {
    return `Selector matched multiple elements. Be more specific or use @refs from 'snapshot'.`;
  }
  return msg;
}

async function handleCommand(body: any): Promise<Response> {
  const { command, args = [] } = body;

  if (!command) {
    return new Response(JSON.stringify({ error: 'Missing "command" field' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let result: string;
    let shouldShutdown = false;

    if (READ_COMMANDS.has(command)) {
      result = await handleReadCommand(command, args, browserManager);
    } else if (WRITE_COMMANDS.has(command)) {
      result = await handleWriteCommand(command, args, browserManager);
    } else if (META_COMMANDS.has(command)) {
      result = await handleMetaCommand(command, args, browserManager, shutdown);
      shouldShutdown = command === 'stop' || command === 'restart';
    } else if (command === 'help') {
      return new Response(generateHelpText(), {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    } else {
      return new Response(JSON.stringify({
        error: `Unknown command: ${command}`,
        hint: `Available commands: ${[...READ_COMMANDS, ...WRITE_COMMANDS, ...META_COMMANDS].sort().join(', ')}`,
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const response = new Response(result, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });

    if (shouldShutdown) {
      setTimeout(() => {
        if (command === 'restart') {
          console.log(`[${COMMAND_NAME}] Restart requested. Exiting for CLI to restart.`);
          void appendServerLog('Restart requested. Exiting for CLI to restart.');
        }
        void shutdown();
      }, 10);
    }

    return response;
  } catch (err: any) {
    return new Response(JSON.stringify({ error: wrapError(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function readIncomingBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req: IncomingMessage, body: Buffer, port: number): Promise<Request> {
  const url = getLocalUrl(port, req.url || '/');
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method || 'GET',
    headers: req.headers as HeadersInit,
  };

  if (body.length > 0) {
    init.body = new Uint8Array(body);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse, port: number, startTime: number): Promise<void> {
  resetIdleTimer();

  const body = await readIncomingBody(req);
  const webReq = await toWebRequest(req, body, port);
  const url = new URL(webReq.url);

  let response: Response;

  if (url.pathname.startsWith('/cookie-picker')) {
    response = await handleCookiePickerRoute(url, webReq, browserManager);
    await sendWebResponse(res, response);
    return;
  }

  if (url.pathname === '/health') {
    const healthy = await browserManager.isHealthy();
    response = new Response(JSON.stringify({
      status: healthy ? 'healthy' : 'unhealthy',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      tabs: browserManager.getTabCount(),
      currentUrl: browserManager.getCurrentUrl(),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await sendWebResponse(res, response);
    return;
  }

  if (!validateAuth(webReq)) {
    response = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
    await sendWebResponse(res, response);
    return;
  }

  if (url.pathname === '/command' && webReq.method === 'POST') {
    const commandBody = await webReq.json();
    response = await handleCommand(commandBody);
    await sendWebResponse(res, response);
    return;
  }

  response = new Response('Not found', { status: 404 });
  await sendWebResponse(res, response);
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[${COMMAND_NAME}] Shutting down...`);
  clearInterval(flushInterval);
  clearInterval(idleCheckInterval);
  await flushBuffers();

  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }

  await browserManager.close();

  try { fs.unlinkSync(config.stateFile); } catch {}

  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('uncaughtException', (err) => {
  void appendServerLog(`Uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  void appendServerLog(`Unhandled rejection: ${String(reason)}`);
});

async function start() {
  try { fs.unlinkSync(CONSOLE_LOG_PATH); } catch {}
  try { fs.unlinkSync(NETWORK_LOG_PATH); } catch {}
  try { fs.unlinkSync(DIALOG_LOG_PATH); } catch {}
  try { fs.unlinkSync(SERVER_LOG_PATH); } catch {}

  const port = await findPort();
  await browserManager.launch();

  const startTime = Date.now();
  httpServer = createHttpServer((req, res) => {
    void handleHttpRequest(req, res, port, startTime).catch(async (err: any) => {
      console.error(`[${COMMAND_NAME}] Request error: ${err.message || err}`);
      if (!res.headersSent) {
        await sendWebResponse(res, new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.listen(port, LOCALHOST, () => resolve());
  });

  const state = {
    pid: process.pid,
    port,
    token: AUTH_TOKEN,
    startedAt: new Date().toISOString(),
    serverPath: fileURLToPath(import.meta.url),
    binaryVersion: readVersionHash() || undefined,
  };

  const tmpFile = config.stateFile + '.tmp';
  writePrivateFile(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, config.stateFile);

  browserManager.serverPort = port;
  await appendServerLog(`Server running on ${getLocalUrl(port)} (PID: ${process.pid})`);
  await appendServerLog(`State file: ${config.stateFile}`);
  await appendServerLog(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
  console.log(`[${COMMAND_NAME}] Server running on ${getLocalUrl(port)} (PID: ${process.pid})`);
  console.log(`[${COMMAND_NAME}] State file: ${config.stateFile}`);
  console.log(`[${COMMAND_NAME}] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);
}

if (isMainModule(import.meta.url)) {
  start().catch((err) => {
    void appendServerLog(`Failed to start: ${err.stack || err.message}`);
    console.error(`[${COMMAND_NAME}] Failed to start: ${err.message}`);
    process.exit(1);
  });
}
