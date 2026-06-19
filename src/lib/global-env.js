/**
 * envpact-mcp global vault `.env` helper (v3.1, SHARED_SPEC §1.6 +
 * §5.1). Mirrors every shared.* entry from the vault into a single
 * file at `~/.envpact/.env`, regenerated from a byte-faithful
 * template at `~/.envpact/.env.example.global`.
 *
 * The vault stays the source of truth. The global `.env` is
 * generated, never push back. Edits go through the vault layer
 * (`add_shared_secret`, CLI `--add-shared`, etc.).
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { writeAtomic } from './envwriter.js';
import { entryValue } from './resolver.js';

const ENC_PREFIX = 'enc:';

export const GLOBAL_EXAMPLE_FILE = path.join(CONFIG_DIR, '.env.example.global');
export const GLOBAL_ENV_FILE = path.join(CONFIG_DIR, '.env');

/**
 * Mirror of envwriter.formatValue — kept local so this module is
 * self-contained and the byte-faithful semantics in §5/§5.1 are
 * obvious from one read.
 */
function needsQuoting(value) {
  if (value === '') return true;
  if (/[\s#"'\\]/.test(value)) return true;
  if (/^\s/.test(value) || /\s$/.test(value)) return true;
  if (value.includes('\n') || value.includes('\r')) return true;
  return false;
}

function escape(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function formatValue(value) {
  if (typeof value !== 'string') value = String(value);
  return needsQuoting(value) ? `"${escape(value)}"` : value;
}

/**
 * Ensure `~/.envpact/.env.example.global` exists. If absent, create
 * it by listing every `shared.*` key in the vault, alphabetical, no
 * comments. Returns `true` if it had to create the file, `false` if
 * it was already there.
 */
export function ensureGlobalExample(vault, examplePath = GLOBAL_EXAMPLE_FILE) {
  if (fs.existsSync(examplePath)) return false;
  const dir = path.dirname(examplePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sharedKeys = Object.keys(vault.shared || {})
    .filter((k) => !k.startsWith('_'))
    .sort();
  const lines = sharedKeys.map((k) => `${k}=`);
  // Trailing newline so the example is POSIX-friendly. No comments
  // on auto-generated examples — users add their own when curating.
  const text = lines.length ? lines.join('\n') + '\n' : '';
  writeAtomic(examplePath, text);
  return true;
}

/**
 * Walk an .env.example.global byte-by-byte and emit the matching
 * .env body. Returns `{ body, resolved, encrypted, notInVault }`.
 *
 *   - body: the rendered file contents (sans header — caller adds
 *     it because the header timestamp differs per call).
 *   - resolved: count of KEY=VALUE lines actually written.
 *   - encrypted: array of keys whose value was `enc:*` and is
 *     therefore emitted as a comment instead.
 *   - notInVault: array of keys present in the example but missing
 *     from `vault.shared`.
 */
export function renderGlobalBody(vault, exampleText) {
  const shared = vault.shared || {};
  const outLines = [];
  const encrypted = [];
  const notInVault = [];
  let resolved = 0;

  for (const raw of exampleText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    // Blank line — copy verbatim. We keep raw (which may carry
    // trailing whitespace) so the file is byte-faithful.
    if (trimmed === '') {
      outLines.push(raw);
      continue;
    }
    // Comment line — copy verbatim, INCLUDING leading whitespace.
    if (trimmed.startsWith('#')) {
      outLines.push(raw);
      continue;
    }
    // Assignment line.
    const eq = raw.indexOf('=');
    if (eq < 0) {
      // Malformed — preserve as-is so the user notices.
      outLines.push(raw);
      continue;
    }
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      outLines.push(raw);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(shared, key)) {
      outLines.push(`# ${key}: not in vault`);
      notInVault.push(key);
      continue;
    }
    const v = entryValue(shared[key]);
    if (v === null) {
      outLines.push(`# ${key}: malformed entry`);
      notInVault.push(key);
      continue;
    }
    if (v.startsWith(ENC_PREFIX)) {
      outLines.push(`# ${key}: encrypted — decrypt-via-cli`);
      encrypted.push(key);
      continue;
    }
    outLines.push(`${key}=${formatValue(v)}`);
    resolved += 1;
  }

  // Preserve trailing newline of the example.
  const trailingNl = /\n$/.test(exampleText);
  let body = outLines.join('\n');
  if (trailingNl && !body.endsWith('\n')) body += '\n';
  return { body, resolved, encrypted, notInVault };
}

/**
 * Generate `~/.envpact/.env` from `~/.envpact/.env.example.global`
 * per SHARED_SPEC §5.1.
 *
 * If the example file is absent, it is created first via
 * `ensureGlobalExample`. The output `.env` is written atomically
 * with mode 0600 (best-effort on Windows).
 *
 * Returns:
 *   {
 *     output_path: '<abs path>',
 *     resolved_count: N,
 *     encrypted: [...],
 *     not_in_vault: [...],
 *     generated_global_example: true|false,
 *   }
 */
export function generateGlobalEnv(vault, opts = {}) {
  const examplePath = opts.examplePath
    ? path.resolve(opts.examplePath)
    : GLOBAL_EXAMPLE_FILE;
  const outputPath = opts.outputPath
    ? path.resolve(opts.outputPath)
    : GLOBAL_ENV_FILE;

  const generated = ensureGlobalExample(vault, examplePath);

  const exampleText = fs.readFileSync(examplePath, 'utf8');
  const { body, resolved, encrypted, notInVault } = renderGlobalBody(
    vault,
    exampleText
  );

  const header =
    `# Generated by envpact-mcp (global) on ${new Date().toISOString()}\n` +
    `# DO NOT COMMIT — managed by envpact\n`;
  // Insert a single blank line between header and body unless the
  // example already starts with one — keeps the rendered file
  // close to byte-faithful while still self-labelling.
  const sep = body.startsWith('\n') || body === '' ? '' : '\n';
  const text = header + sep + body;

  writeAtomic(outputPath, text);
  // Best-effort 0600 — writeAtomic already requests 0600 on the
  // tmp file, but the rename target may have an older mode if it
  // existed previously. chmod is a no-op on Windows.
  try { fs.chmodSync(outputPath, 0o600); } catch (_e) { /* windows */ }

  return {
    output_path: outputPath,
    resolved_count: resolved,
    encrypted,
    not_in_vault: notInVault,
    generated_global_example: generated,
  };
}
