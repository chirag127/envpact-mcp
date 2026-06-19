import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SECRETS_FILE, SECRETS_DIR, SCHEMA_URL, VAULT_SCHEMA_VERSION } from './config.js';
import { validateVault, entryValue, entryModifiedAt } from './resolver.js';

/**
 * Now-as-ISO helper. Centralised so tests can stub if needed.
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * In-memory upgrade of a v1 or v2 vault to v3 per SHARED_SPEC §1.4.
 * Pure: returns a NEW object; does not mutate the input.
 *
 * - v1: flat (no shared / no projects sub-objects). Treat each
 *   top-level non-metadata field as a project entry whose values
 *   are bare strings.
 * - v2: per-environment objects with `_default_env`.
 *
 * Lossy by design — flattens all per-environment branches into a
 * single value picked via priority order (default → production →
 * first non-empty). Drops `_default_env` and any other `_*` keys.
 */
export function upgradeVault(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (parsed.version === 3) return parsed;
  if (parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(
      `Unsupported vault version: ${parsed.version}. Expected 1, 2, or 3.`
    );
  }

  // Loud warning per spec §1.4. Goes to stderr so it never
  // contaminates the MCP stdout transport.
  process.stderr.write(
    `envpact: upgrading vault from v${parsed.version} → v3. ` +
      `Per-environment values will be flattened. Backup at ` +
      `pre-v3-migration branch (if you didn't make one, abort now).\n`
  );

  const fallbackTs =
    (parsed.metadata && typeof parsed.metadata.updated_at === 'string'
      ? parsed.metadata.updated_at
      : null) || nowIso();

  const next = {
    $schema: SCHEMA_URL,
    version: 3,
    shared: {},
    projects: {},
    metadata: { ...(parsed.metadata || {}) },
  };
  next.metadata.updated_at = fallbackTs;

  // Shared entries.
  for (const [k, raw] of Object.entries(parsed.shared || {})) {
    if (typeof raw === 'string') {
      next.shared[k] = { value: raw, _modified_at: fallbackTs };
    } else if (raw && typeof raw === 'object' && typeof raw.value === 'string') {
      // Already an entry-shape (defensive). Keep it.
      next.shared[k] = {
        value: raw.value,
        _modified_at:
          typeof raw._modified_at === 'string' ? raw._modified_at : fallbackTs,
      };
    }
  }

  // Project entries.
  for (const [pname, proj] of Object.entries(parsed.projects || {})) {
    if (!proj || typeof proj !== 'object') continue;
    const out = {};
    for (const [key, raw] of Object.entries(proj)) {
      if (key.startsWith('_')) continue;
      if (typeof raw === 'string') {
        out[key] = { value: raw, _modified_at: fallbackTs };
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        // v2 per-env object OR pre-existing v3 entry.
        if (typeof raw.value === 'string' && !('default' in raw) && !('production' in raw)) {
          // Looks like a v3 entry already.
          out[key] = {
            value: raw.value,
            _modified_at:
              typeof raw._modified_at === 'string' ? raw._modified_at : fallbackTs,
          };
        } else {
          // v2 per-environment: pick default → production → first.
          let picked = null;
          if (typeof raw.default === 'string' && raw.default !== '') picked = raw.default;
          else if (typeof raw.production === 'string' && raw.production !== '') picked = raw.production;
          else {
            for (const v of Object.values(raw)) {
              if (typeof v === 'string' && v !== '') { picked = v; break; }
            }
          }
          if (picked !== null) out[key] = { value: picked, _modified_at: fallbackTs };
        }
      }
    }
    next.projects[pname] = out;
  }

  return next;
}

/**
 * Load the vault. Auto-upgrades v1/v2 → v3 in memory only — does
 * NOT rewrite the file on disk (per spec §1.4: reads are
 * idempotent; writes flush the upgrade).
 */
export function loadVault(filePath = SECRETS_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `envpact vault not initialised. Run \`npx envpact-cli --init auto\` first.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const upgraded = parsed.version === 3 ? parsed : upgradeVault(parsed);
  validateVault(upgraded);
  return upgraded;
}

export function saveVault(vault, filePath = SECRETS_FILE) {
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = nowIso();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || VAULT_SCHEMA_VERSION;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Second-layer defence for arbitrary names that get used as object
 * keys inside the vault JSON. The MCP input schemas in
 * src/tools/index.js are the first layer; this catches anything
 * that bypasses them (programmatic callers, future tools, malformed
 * inputs).
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

/**
 * Write a project secret as a v3 entry object. `modifiedAt` is
 * optional — defaults to now(). The `environment` parameter is
 * gone in v3.
 */
export function setProjectSecret(vault, projectName, key, value, modifiedAt) {
  assertSafeKey(projectName, 'project name');
  assertSafeKey(key, 'secret key');
  ensureProjectExists(vault, projectName);
  const project = vault.projects[projectName];
  defineSafeProperty(project, key, {
    value,
    _modified_at: modifiedAt || nowIso(),
  });
}

export function setSharedSecret(vault, key, value, modifiedAt) {
  assertSafeKey(key, 'shared secret key');
  if (!vault.shared) vault.shared = {};
  defineSafeProperty(vault.shared, key, {
    value,
    _modified_at: modifiedAt || nowIso(),
  });
}

export function findReferencingProjects(vault, sharedKey) {
  const refs = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, entry] of Object.entries(proj)) {
      if (k.startsWith('_')) continue;
      const v = entryValue(entry);
      if (v === ref) refs.push({ project: pname, key: k });
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

// Re-export for downstream consumers (tools, sync, etc.)
export { entryValue, entryModifiedAt };
