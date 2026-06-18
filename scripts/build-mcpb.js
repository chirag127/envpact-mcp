#!/usr/bin/env node
/**
 * scripts/build-mcpb.js — produce dist/envpact-mcp.mcpb
 *
 * Smithery quirk: their server-side Zod validator requires
 *   tools[].inputSchema for every tool. The MCPB v0.4 manifest
 *   schema FORBIDS inputSchema inside tools[] (additionalProperties:
 *   false). The two specs are incompatible. We thread the needle:
 *
 *   - The CHECKED-IN mcpb/manifest.json has the lean MCPB-compliant
 *     shape (tools_generated: true, no tools[]) — passes mcpb validate.
 *   - At build time, we copy mcpb/ into a staging dir, splice the live
 *     tools/list response into the staged manifest (with full
 *     inputSchemas), then pack from staging. The packed .mcpb has the
 *     rich tools[] Smithery wants.
 *
 * Steps:
 *   1. Sync manifest version with package.json
 *   2. Copy package.json into mcpb/ for runtime version probe
 *   3. esbuild src/index.js → mcpb/server/index.js
 *   4. mcpb validate (against the strict v0.4 shape)
 *   5. Stage mcpb/ → .mcpb-staging/, run the bundled server, splice
 *      live tools/list into the staging manifest
 *   6. mcpb pack .mcpb-staging dist/envpact-mcp.mcpb
 *
 * Usage:
 *   node scripts/build-mcpb.js
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const ESBUILD = join(ROOT, 'node_modules/esbuild/bin/esbuild');
const MCPB_CLI = join(ROOT, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js');
const MCPB_DIR = join(ROOT, 'mcpb');
const SERVER_BUNDLE = join(MCPB_DIR, 'server', 'index.js');
const MANIFEST_PATH = join(MCPB_DIR, 'manifest.json');
const STAGE = join(ROOT, '.mcpb-staging');
const STAGE_MANIFEST = join(STAGE, 'manifest.json');
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, 'envpact-mcp.mcpb');

function step(label, fn) {
  process.stdout.write(`→ ${label} … `);
  const t = Date.now();
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.then(() => {
      process.stdout.write(`done (${Date.now() - t}ms)\n`);
    });
  }
  process.stdout.write(`done (${Date.now() - t}ms)\n`);
  return undefined;
}

mkdirSync(DIST, { recursive: true });
mkdirSync(join(MCPB_DIR, 'server'), { recursive: true });

step('sync manifest version', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (manifest.version !== pkg.version) {
    manifest.version = pkg.version;
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  }
});

step('copy package.json into mcpb/', () => {
  copyFileSync(join(ROOT, 'package.json'), join(MCPB_DIR, 'package.json'));
});

step('bundle src/index.js → mcpb/server/index.js', () => {
  execFileSync(
    'node',
    [
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
    ],
    { cwd: ROOT, stdio: 'inherit' }
  );
});

// Validate the lean manifest as it sits in git — strict MCPB v0.4.
step('validate manifest (lean / MCPB v0.4)', () => {
  execFileSync('node', [MCPB_CLI, 'validate', MANIFEST_PATH], {
    cwd: ROOT,
    stdio: 'inherit',
  });
});

// Stage mcpb/ verbatim, then enrich the staged manifest with rich
// tools[] (incl. inputSchema) extracted from the live server.
step('stage mcpb/ → .mcpb-staging/', () => {
  rmSync(STAGE, { recursive: true, force: true });
  cpSync(MCPB_DIR, STAGE, { recursive: true });
});

async function spliceLiveToolsIntoStagedManifest() {
  const child = spawn('node', [SERVER_BUNDLE], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', () => {
    /* discard banner */
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'build-mcpb', version: '0.0.1' },
    },
  });
  await new Promise((r) => setTimeout(r, 250));
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((r) => setTimeout(r, 100));
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await new Promise((r) => setTimeout(r, 800));
  child.kill();

  let tools;
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line);
      if (m.id === 2 && m.result && Array.isArray(m.result.tools)) {
        tools = m.result.tools;
      }
    } catch {
      /* not JSON */
    }
  }
  if (!tools || tools.length === 0) {
    throw new Error(
      'spliceLiveToolsIntoStagedManifest: server returned no tools/list response'
    );
  }

  const enriched = tools.map((t) => {
    const out = { name: t.name };
    if (t.title) out.title = t.title;
    if (t.description) out.description = t.description;
    if (t.inputSchema) {
      const { $schema: _drop, ...rest } = t.inputSchema;
      out.inputSchema = rest;
    }
    return out;
  });

  const manifest = JSON.parse(readFileSync(STAGE_MANIFEST, 'utf8'));
  manifest.tools = enriched;
  manifest.tools_generated = false;
  writeFileSync(STAGE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  return enriched.length;
}

process.stdout.write('→ splice live tools/list into staged manifest … ');
const t0 = Date.now();
const toolCount = await spliceLiveToolsIntoStagedManifest();
process.stdout.write(`${toolCount} tools (${Date.now() - t0}ms)\n`);

await step('pack .mcpb (fflate zipSync — bypasses re-validation)', async () => {
  // mcpb pack re-runs the strict v0.4 schema check, which rejects
  // tools[].inputSchema. We pack with fflate directly using max
  // compression — same algorithm mcpb pack itself uses internally.
  const fflate = await import('fflate');
  const { readdirSync, statSync } = await import('node:fs');

  function walk(dir, base = '') {
    const out = {};
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        Object.assign(out, walk(full, rel));
      } else if (entry.isFile()) {
        out[rel] = readFileSync(full);
      }
    }
    return out;
  }

  const files = walk(STAGE);
  // Compression level 9 = mcpb pack's default
  const zipped = fflate.zipSync(files, { level: 9 });
  writeFileSync(OUT, zipped);
});

// Clean up staging — keep the committed mcpb/ pristine.
step('clean .mcpb-staging/', () => {
  rmSync(STAGE, { recursive: true, force: true });
});

console.log('\n=== bundle info ===');
execFileSync('node', [MCPB_CLI, 'info', OUT], {
  cwd: ROOT,
  stdio: 'inherit',
});

console.log(`\n✓ ${OUT}`);


