#!/usr/bin/env node
/**
 * scripts/build-mcpb.js — produce dist/envpact-mcp.mcpb
 *
 * Steps:
 *   1. Bundle src/index.js (ESM, all deps inlined) → mcpb/server/index.js
 *   2. Copy package.json into mcpb/ so the runtime version probe works
 *   3. mcpb pack ./mcpb dist/envpact-mcp.mcpb
 *
 * Usage:
 *   node scripts/build-mcpb.js
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const ESBUILD = join(ROOT, 'node_modules/esbuild/bin/esbuild');
const MCPB_CLI = join(ROOT, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js');
const MCPB_DIR = join(ROOT, 'mcpb');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'envpact-mcp.mcpb');

function step(label, fn) {
  process.stdout.write(`→ ${label} … `);
  const t = Date.now();
  fn();
  process.stdout.write(`done (${Date.now() - t}ms)\n`);
}

mkdirSync(DIST, { recursive: true });
mkdirSync(join(MCPB_DIR, 'server'), { recursive: true });

// 1. Sync the manifest version with package.json — keeps them in lock-step
//    so we never ship a .mcpb whose manifest disagrees with the npm package.
step('sync manifest version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifestPath = join(MCPB_DIR, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
});

// 2. Copy package.json next to the bundled server so the runtime version
//    probe (`readFileSync(path.join(__dirname, '..', 'package.json'))` in
//    src/index.js) resolves correctly inside the .mcpb.
step('copy package.json into mcpb/', () => {
  copyFileSync(join(ROOT, 'package.json'), join(MCPB_DIR, 'package.json'));
});

// 3. Bundle the server.
step('bundle src/index.js → mcpb/server/index.js', () => {
  execFileSync('node', [
    ESBUILD,
    'src/index.js',
    '--bundle',
    '--platform=node',
    '--target=node18',
    '--format=esm',
    '--outfile=mcpb/server/index.js',
    '--external:node:*',
    '--legal-comments=none',
    '--minify-whitespace',
    '--log-level=warning',
  ], { cwd: ROOT, stdio: 'inherit' });
});

// 4. Validate manifest before packing.
step('validate manifest', () => {
  execFileSync('node', [MCPB_CLI, 'validate', join(MCPB_DIR, 'manifest.json')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
});

// 5. Pack.
step('pack .mcpb', () => {
  execFileSync('node', [MCPB_CLI, 'pack', MCPB_DIR, OUT], {
    cwd: ROOT,
    stdio: 'inherit',
  });
});

// 6. Print info.
console.log('\n=== bundle info ===');
execFileSync('node', [MCPB_CLI, 'info', OUT], { cwd: ROOT, stdio: 'inherit' });

console.log(`\n✓ ${OUT}`);
