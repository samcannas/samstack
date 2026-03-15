import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import initSqlJs from 'sql.js';
import {
  IS_MACOS,
  IS_WINDOWS,
  getHomeLocalAppData,
  getTempDir,
} from './platform';

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>;
type SqliteDatabase = InstanceType<SqlJsModule['Database']>;

export interface BrowserInfo {
  name: string;
  aliases: string[];
  darwin?: {
    dataDir: string;
    keychainService: string;
  };
  win32?: {
    dataDir: string;
  };
}

export interface DomainEntry {
  domain: string;
  count: number;
}

export interface ImportResult {
  cookies: PlaywrightCookie[];
  count: number;
  failed: number;
  domainCounts: Record<string, number>;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export class CookieImportError extends Error {
  constructor(
    message: string,
    public code: string,
    public action?: 'retry',
  ) {
    super(message);
    this.name = 'CookieImportError';
  }
}

const BROWSER_REGISTRY: BrowserInfo[] = [
  {
    name: 'Comet',
    aliases: ['comet', 'perplexity'],
    darwin: { dataDir: 'Comet', keychainService: 'Comet Safe Storage' },
  },
  {
    name: 'Chrome',
    aliases: ['chrome', 'google-chrome'],
    darwin: { dataDir: 'Google/Chrome', keychainService: 'Chrome Safe Storage' },
    win32: { dataDir: 'Google/Chrome/User Data' },
  },
  {
    name: 'Arc',
    aliases: ['arc'],
    darwin: { dataDir: 'Arc/User Data', keychainService: 'Arc Safe Storage' },
  },
  {
    name: 'Brave',
    aliases: ['brave'],
    darwin: { dataDir: 'BraveSoftware/Brave-Browser', keychainService: 'Brave Safe Storage' },
    win32: { dataDir: 'BraveSoftware/Brave-Browser/User Data' },
  },
  {
    name: 'Edge',
    aliases: ['edge'],
    darwin: { dataDir: 'Microsoft Edge', keychainService: 'Microsoft Edge Safe Storage' },
    win32: { dataDir: 'Microsoft/Edge/User Data' },
  },
];

const keyCache = new Map<string, Buffer>();
let sqlJsPromise: Promise<SqlJsModule> | null = null;

export function findInstalledBrowsers(): BrowserInfo[] {
  return BROWSER_REGISTRY.filter((browser) => {
    try {
      return fs.existsSync(getLocalStatePath(browser));
    } catch {
      return false;
    }
  });
}

export async function listDomains(browserName: string, profile = 'Default'): Promise<{ domains: DomainEntry[]; browser: string }> {
  const browser = resolveBrowser(browserName);
  const dbPath = getCookieDbPath(browser, profile);
  const db = await openDb(dbPath, browser.name);
  try {
    const now = chromiumNow();
    const rows = queryAll(
      db,
      `SELECT host_key AS domain, COUNT(*) AS count
       FROM cookies
       WHERE has_expires = 0 OR expires_utc > ?
       GROUP BY host_key
       ORDER BY count DESC`,
      [now.toString()],
    ) as unknown as DomainEntry[];
    return { domains: rows, browser: browser.name };
  } finally {
    db.close();
  }
}

export async function importCookies(
  browserName: string,
  domains: string[],
  profile = 'Default',
): Promise<ImportResult> {
  if (domains.length === 0) return { cookies: [], count: 0, failed: 0, domainCounts: {} };

  const browser = resolveBrowser(browserName);
  const secret = await getDecryptionKey(browser);
  const dbPath = getCookieDbPath(browser, profile);
  const db = await openDb(dbPath, browser.name);

  try {
    const now = chromiumNow();
    const placeholders = domains.map(() => '?').join(',');
    const rows = queryAll(
      db,
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, has_expires, samesite
       FROM cookies
       WHERE host_key IN (${placeholders})
         AND (has_expires = 0 OR expires_utc > ?)
       ORDER BY host_key, name`,
      [...domains, now.toString()],
    ) as unknown as RawCookie[];

    const cookies: PlaywrightCookie[] = [];
    let failed = 0;
    const domainCounts: Record<string, number> = {};

    for (const row of rows) {
      try {
        const value = await decryptCookieValue(row, secret);
        const cookie = toPlaywrightCookie(row, value);
        cookies.push(cookie);
        domainCounts[row.host_key] = (domainCounts[row.host_key] || 0) + 1;
      } catch {
        failed++;
      }
    }

    return { cookies, count: cookies.length, failed, domainCounts };
  } finally {
    db.close();
  }
}

function resolveBrowser(nameOrAlias: string): BrowserInfo {
  const needle = nameOrAlias.toLowerCase().trim();
  const found = BROWSER_REGISTRY.find((browser) =>
    browser.aliases.includes(needle) || browser.name.toLowerCase() === needle
  );
  if (!found) {
    const supported = supportedAliasesForCurrentPlatform().join(', ');
    throw new CookieImportError(
      `Unknown browser '${nameOrAlias}'. Supported: ${supported}`,
      'unknown_browser',
    );
  }
  ensurePlatformSupport(found);
  return found;
}

function supportedAliasesForCurrentPlatform(): string[] {
  return BROWSER_REGISTRY
    .filter((browser) => hasPlatformConfig(browser))
    .flatMap((browser) => browser.aliases);
}

function ensurePlatformSupport(browser: BrowserInfo): void {
  if (hasPlatformConfig(browser)) return;
  throw new CookieImportError(
    `${browser.name} cookie import is not supported on ${process.platform}`,
    'unsupported_platform',
  );
}

function hasPlatformConfig(browser: BrowserInfo): boolean {
  return (IS_MACOS && !!browser.darwin) || (IS_WINDOWS && !!browser.win32);
}

function validateProfile(profile: string): void {
  if (/[/\\]|\.\./.test(profile) || /[\x00-\x1f]/.test(profile)) {
    throw new CookieImportError(`Invalid profile name: '${profile}'`, 'bad_request');
  }
}

function getBrowserRoot(browser: BrowserInfo): string {
  if (IS_MACOS && browser.darwin) {
    return path.join(os.homedir(), 'Library', 'Application Support', browser.darwin.dataDir);
  }
  if (IS_WINDOWS && browser.win32) {
    return path.join(getHomeLocalAppData(), browser.win32.dataDir);
  }
  throw new CookieImportError(
    `${browser.name} cookie import is not supported on ${process.platform}`,
    'unsupported_platform',
  );
}

function getLocalStatePath(browser: BrowserInfo): string {
  return path.join(getBrowserRoot(browser), 'Local State');
}

function getCookieDbPath(browser: BrowserInfo, profile: string): string {
  validateProfile(profile);
  const root = getBrowserRoot(browser);
  const candidates = IS_WINDOWS
    ? [
        path.join(root, profile, 'Network', 'Cookies'),
        path.join(root, profile, 'Cookies'),
      ]
    : [path.join(root, profile, 'Cookies')];

  const dbPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!dbPath) {
    throw new CookieImportError(
      `${browser.name} is not installed or has no cookie database for profile '${profile}'`,
      'not_installed',
    );
  }
  return dbPath;
}

async function openDb(dbPath: string, browserName: string): Promise<SqliteDatabase> {
  try {
    return await openDbFromFile(dbPath);
  } catch (err: any) {
    return await openDbFromCopy(dbPath, browserName, err);
  }
}

async function openDbFromCopy(dbPath: string, browserName: string, originalError?: unknown): Promise<SqliteDatabase> {
  const tempDir = fs.mkdtempSync(path.join(getTempDir(), 'samstack-cookies-'));
  const tmpPath = path.join(tempDir, `${browserName.toLowerCase()}-${crypto.randomUUID()}.db`);

  try {
    fs.copyFileSync(dbPath, tmpPath);
    const db = await openDbFromFile(tmpPath);
    const origClose = db.close.bind(db);
    db.close = () => {
      origClose();
      cleanupDbCopy(tmpPath);
    };
    return db;
  } catch (err) {
    cleanupDbCopy(tmpPath);
    if (String((err as Error)?.message ?? '').toLowerCase().includes('malformed')) {
      throw new CookieImportError(`Cookie database for ${browserName} is corrupt`, 'db_corrupt');
    }
    throw new CookieImportError(
      `Cookie database could not be read (${browserName} may be running or the database may be locked). Try closing ${browserName} first.${originalError ? ` ${String((originalError as Error).message ?? originalError)}` : ''}`,
      'db_locked',
      'retry',
    );
  }
}

async function getSqlJs(): Promise<SqlJsModule> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return await sqlJsPromise;
}

async function openDbFromFile(filePath: string): Promise<SqliteDatabase> {
  const SQL = await getSqlJs();
  const buffer = fs.readFileSync(filePath);
  return new SQL.Database(new Uint8Array(buffer));
}

function queryAll(db: SqliteDatabase, sql: string, params: any[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql);
  try {
    if (params.length > 0) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as Record<string, unknown>);
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function cleanupDbCopy(tmpPath: string): void {
  try { fs.unlinkSync(tmpPath); } catch {}
  try { fs.unlinkSync(tmpPath + '-wal'); } catch {}
  try { fs.unlinkSync(tmpPath + '-shm'); } catch {}
  try { fs.rmdirSync(path.dirname(tmpPath)); } catch {}
}

async function getDecryptionKey(browser: BrowserInfo): Promise<Buffer> {
  const cacheKey = `${process.platform}:${browser.name}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const key = IS_MACOS
    ? await getDarwinKey(browser)
    : IS_WINDOWS
      ? await getWindowsKey(browser)
      : unsupportedPlatform(browser.name);

  keyCache.set(cacheKey, key);
  return key;
}

async function getDarwinKey(browser: BrowserInfo): Promise<Buffer> {
  const service = browser.darwin?.keychainService;
  if (!service) return unsupportedPlatform(browser.name);

  const password = await getKeychainPassword(service);
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

async function getWindowsKey(browser: BrowserInfo): Promise<Buffer> {
  const localStatePath = getLocalStatePath(browser);
  if (!fs.existsSync(localStatePath)) {
    throw new CookieImportError(
      `${browser.name} is not installed (missing Local State at ${localStatePath})`,
      'not_installed',
    );
  }

  let localState: any;
  try {
    localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
  } catch {
    throw new CookieImportError(`Could not read Local State for ${browser.name}`, 'bad_local_state');
  }

  const encryptedKeyBase64 = localState.os_crypt?.encrypted_key;
  if (!encryptedKeyBase64) {
    throw new CookieImportError(`Local State for ${browser.name} does not contain os_crypt.encrypted_key`, 'bad_local_state');
  }

  const encryptedKeyWithPrefix = Buffer.from(encryptedKeyBase64, 'base64');
  const dpapiPrefix = Buffer.from('DPAPI');
  if (!encryptedKeyWithPrefix.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) {
    throw new CookieImportError(`Unsupported encrypted key format in ${browser.name} Local State`, 'bad_local_state');
  }

  const encryptedKey = encryptedKeyWithPrefix.subarray(dpapiPrefix.length);
  return await windowsDpapiUnprotect(encryptedKey, `${browser.name} master key`);
}

function unsupportedPlatform(browserName: string): never {
  throw new CookieImportError(
    `${browserName} cookie import is not supported on ${process.platform}`,
    'unsupported_platform',
  );
}

async function getKeychainPassword(service: string): Promise<string> {
  const proc = spawn('security', ['find-generic-password', '-s', service, '-w'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new CookieImportError(
        `macOS is waiting for Keychain permission. Look for a dialog asking to allow access to "${service}".`,
        'keychain_timeout',
        'retry',
      ));
    }, 10_000),
  );

  try {
    const exitCode = await Promise.race([once(proc, 'close').then(([code]) => code ?? 0), timeout]);
    const stdout = await readChildStream(proc.stdout);
    const stderr = await readChildStream(proc.stderr);

    if (exitCode !== 0) {
      const errText = stderr.trim().toLowerCase();
      if (errText.includes('user canceled') || errText.includes('denied') || errText.includes('interaction not allowed')) {
        throw new CookieImportError(
          `Keychain access denied. Click "Allow" in the macOS dialog for "${service}".`,
          'keychain_denied',
          'retry',
        );
      }
      if (errText.includes('could not be found') || errText.includes('not found')) {
        throw new CookieImportError(
          `No Keychain entry for "${service}". Is this a Chromium-based browser?`,
          'keychain_not_found',
        );
      }
      throw new CookieImportError(`Could not read Keychain: ${stderr.trim()}`, 'keychain_error', 'retry');
    }

    return stdout.trim();
  } catch (err) {
    if (err instanceof CookieImportError) throw err;
    throw new CookieImportError(`Could not read Keychain: ${(err as Error).message}`, 'keychain_error', 'retry');
  }
}

async function windowsDpapiUnprotect(encryptedBytes: Buffer, label: string): Promise<Buffer> {
  const script = [
    `$bytes=[Convert]::FromBase64String('${encryptedBytes.toString('base64')}')`,
    '$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,$scope)',
    '[Console]::Out.Write([Convert]::ToBase64String($plain))',
  ].join(';');

  const output = await runPowerShell(script, label);
  return Buffer.from(output, 'base64');
}

async function runPowerShell(script: string, label: string): Promise<string> {
  const candidates = ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
  let lastError = 'PowerShell not available';

  for (const command of candidates) {
    try {
      const proc = spawn(
        command,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );

      const exitCode = await once(proc, 'close').then(([code]) => code ?? 0);
      const stdout = await readChildStream(proc.stdout);
      const stderr = await readChildStream(proc.stderr);
      if (exitCode === 0) return stdout.trim();
      lastError = stderr.trim() || `${command} exited with ${exitCode}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  throw new CookieImportError(`Could not decrypt ${label} with Windows DPAPI: ${lastError}`, 'dpapi_error', 'retry');
}

interface RawCookie {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer | Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  has_expires: number;
  samesite: number;
}

async function readChildStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function decryptCookieValue(row: RawCookie, key: Buffer): Promise<string> {
  if (row.value && row.value.length > 0) return row.value;

  const encrypted = Buffer.from(row.encrypted_value);
  if (encrypted.length === 0) return '';

  if (IS_MACOS) {
    return decryptDarwinCookieValue(encrypted, key);
  }
  if (IS_WINDOWS) {
    return await decryptWindowsCookieValue(encrypted, key);
  }

  return unsupportedPlatform('cookie import');
}

function decryptDarwinCookieValue(encrypted: Buffer, key: Buffer): string {
  const prefix = encrypted.subarray(0, 3).toString('utf-8');
  if (prefix !== 'v10') {
    throw new Error(`Unknown encryption prefix: ${prefix}`);
  }

  const ciphertext = encrypted.subarray(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintext.length <= 32) return '';
  return plaintext.subarray(32).toString('utf-8');
}

async function decryptWindowsCookieValue(encrypted: Buffer, key: Buffer): Promise<string> {
  const prefix = encrypted.subarray(0, 3).toString('utf-8');
  if (/^v\d\d$/.test(prefix) && encrypted.length > 3 + 12 + 16) {
    const nonce = encrypted.subarray(3, 15);
    const ciphertextAndTag = encrypted.subarray(15);
    const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
    const authTag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  const plaintext = await windowsDpapiUnprotect(encrypted, 'cookie');
  return plaintext.toString('utf-8');
}

function toPlaywrightCookie(row: RawCookie, value: string): PlaywrightCookie {
  return {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    expires: chromiumEpochToUnix(row.expires_utc, row.has_expires),
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    sameSite: mapSameSite(row.samesite),
  };
}

const CHROMIUM_EPOCH_OFFSET = 11644473600000000n;

function chromiumNow(): bigint {
  return BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET;
}

function chromiumEpochToUnix(epoch: number | bigint, hasExpires: number): number {
  if (hasExpires === 0 || epoch === 0 || epoch === 0n) return -1;
  const epochBig = BigInt(epoch);
  const unixMicro = epochBig - CHROMIUM_EPOCH_OFFSET;
  return Number(unixMicro / 1000000n);
}

function mapSameSite(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None';
    case 1: return 'Lax';
    case 2: return 'Strict';
    default: return 'Lax';
  }
}
