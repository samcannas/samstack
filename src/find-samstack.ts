/**
 * find-samstack — locate the samstack binary.
 *
 * Built to dist/find-samstack.js.
 * Outputs the absolute path to the samstack entrypoint on stdout, or exits 1 if not found.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'node:child_process';

// ─── Binary Discovery ───────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (proc.status !== 0) return null;
    return proc.stdout.trim();
  } catch {
    return null;
  }
}

export function locateBinary(): string | null {
  const root = getGitRoot();
  const home = homedir();
  const entryName = 'samstack.js';

  // Workspace-local takes priority (for development)
  if (root) {
    const local = join(root, '.claude', 'skills', 'samstack', 'dist', entryName);
    if (existsSync(local)) return local;
  }

  // Global fallback
  const global = join(home, '.claude', 'skills', 'samstack', 'dist', entryName);
  if (existsSync(global)) return global;

  return null;
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const bin = locateBinary();
  if (!bin) {
    process.stderr.write('ERROR: samstack binary not found. Run: npm run build in the samstack directory.\n');
    process.exit(1);
  }

  console.log(bin);
}

main();
