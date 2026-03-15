import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const outdir = new URL('../dist/', import.meta.url);
const runtimeOutdir = new URL('../dist/runtime/', import.meta.url);

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
mkdirSync(runtimeOutdir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  external: ['@inquirer/prompts', 'playwright', 'sql.js'],
};

await build({
  ...shared,
  entryPoints: ['src/installer.ts'],
  outfile: 'dist/samstack.js',
  banner: { js: '#!/usr/bin/env node' },
});

await build({
  ...shared,
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/runtime/samstack-browser.js',
  banner: { js: '#!/usr/bin/env node' },
});

await build({
  ...shared,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/runtime/server.js',
});

await build({
  ...shared,
  entryPoints: ['src/find-samstack.ts'],
  outfile: 'dist/find-samstack.js',
  banner: { js: '#!/usr/bin/env node' },
});

writeFileSync('dist/.build-target', 'node\n');
writeFileSync('dist/runtime/.build-target', 'node\n');
