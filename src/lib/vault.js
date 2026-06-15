import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SECRETS_FILE, SECRETS_DIR, SCHEMA_URL, VAULT_SCHEMA_VERSION } from './config.js';
import { validateVault } from './resolver.js';

export function loadVault(filePath = SECRETS_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `envpact vault not initialised. Run \`npx envpact-cli --init auto\` first.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version === 1) {
    parsed.version = VAULT_SCHEMA_VERSION;
    parsed.$schema = SCHEMA_URL;
  }
  validateVault(parsed);
  return parsed;
}

export function saveVault(vault, filePath = SECRETS_FILE) {
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || VAULT_SCHEMA_VERSION;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Second-layer defence for arbitrary names that get used as object keys
 * inside the vault JSON. The MCP input schemas in src/tools/index.js
 * are the first layer; this catches anything that bypasses them
 * (programmatic callers, future tools, malformed inputs).
 *
 * Throws on prototype-poisoning names, empty strings, and path-like
 * fragments that have no business in an env-key/project-name slot.
 */
export function assertSafeKey(name, kind = 'key') {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Invalid ${kind}: must be a non-empty string`);
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error(`Invalid ${kind}: reserved name "${name}"`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid ${kind}: must not contain path separators`);
  }
  // Reject ".." anywhere as a literal substring or as a dot-separated
  // segment. Path separators are already rejected above so we only
  // need to guard the literal pair.
  if (name === '.' || name === '..' || name.split('.').some((s) => s === '..')) {
    throw new Error(`Invalid ${kind}: must not contain ".." segments`);
  }
}

// Internal helper. Uses Object.defineProperty so even if assertSafeKey is
// somehow bypassed, writing the literal key "__proto__" lays down an own
// data property instead of triggering the prototype setter.
function defineSafeProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function ensureProjectExists(vault, projectName) {
  assertSafeKey(projectName, 'project name');
  if (!vault.projects) vault.projects = {};
  if (!Object.prototype.hasOwnProperty.call(vault.projects, projectName)) {
    defineSafeProperty(vault.projects, projectName, {});
  }
}

export function setProjectSecret(vault, projectName, key, value, environment) {
  assertSafeKey(projectName, 'project name');
  assertSafeKey(key, 'secret key');
  if (environment !== undefined && environment !== null) {
    assertSafeKey(environment, 'environment');
  }
  ensureProjectExists(vault, projectName);
  const project = vault.projects[projectName];
  if (environment) {
    const existing = Object.prototype.hasOwnProperty.call(project, key)
      ? project[key]
      : undefined;
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      defineSafeProperty(project, key, {});
    }
    defineSafeProperty(project[key], environment, value);
  } else {
    defineSafeProperty(project, key, value);
  }
}

export function setSharedSecret(vault, key, value) {
  assertSafeKey(key, 'shared secret key');
  if (!vault.shared) vault.shared = {};
  defineSafeProperty(vault.shared, key, value);
}

export function findReferencingProjects(vault, sharedKey) {
  const refs = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, v] of Object.entries(proj)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' && v === ref) refs.push({ project: pname, key: k });
      else if (v && typeof v === 'object') {
        for (const [env, ev] of Object.entries(v)) {
          if (typeof ev === 'string' && ev === ref) refs.push({ project: pname, key: k, environment: env });
        }
      }
    }
  }
  return refs;
}

export function pullVault() {
  if (!fs.existsSync(SECRETS_DIR)) return { ok: false, reason: 'not-cloned' };
  try {
    execFileSync('git', ['-C', SECRETS_DIR, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message) };
  }
}

export function commitAndPushVault(message) {
  try {
    const status = execFileSync('git', ['-C', SECRETS_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!status) return { committed: false, pushed: false };
    execFileSync('git', ['-C', SECRETS_DIR, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', SECRETS_DIR,
      '-c', 'user.name=envpact-mcp',
      '-c', 'user.email=envpact@local',
      'commit', '-m', message, '-s',
    ], { stdio: 'ignore' });
    execFileSync('git', ['-C', SECRETS_DIR, 'push', '--quiet'], { stdio: 'ignore' });
    return { committed: true, pushed: true };
  } catch (e) {
    return { committed: false, pushed: false, error: String(e.message) };
  }
}

export function detectProjectFromGit(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return m[2].toLowerCase();
  } catch (_e) { /* fallthrough */ }
  return path.basename(cwd).toLowerCase();
}
