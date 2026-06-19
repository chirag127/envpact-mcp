/**
 * envpact-mcp sync — per-key pull/push pipeline + sync status
 * classifier. Mirrors envpact-cli/lib/sync.js (when it lands) but
 * lives here for the MCP build to be self-sufficient.
 *
 * Lock file format (.env.example.lock) per SHARED_SPEC §1.3:
 *
 *   {
 *     "version": 1,
 *     "keys": {
 *       "OPENAI_API_KEY": {
 *         "vault_modified_at": "ISO-8601",
 *         "synced_at": "ISO-8601"
 *       }
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  loadVault,
  saveVault,
  pullVault,
  commitAndPushVault,
  setProjectSecret,
  ensureProjectExists,
  nowIso,
  entryValue,
  entryModifiedAt,
} from './vault.js';
import { resolveString } from './resolver.js';
import { writeAtomic, parseEnvFileToMap, upsertEnvKey } from './envwriter.js';

export const LOCK_FILENAME = '.env.example.lock';
export const LOCK_VERSION = 1;

// ── Lock file helpers ──────────────────────────────────────────

export function lockPath(workingDir) {
  return path.join(workingDir, LOCK_FILENAME);
}

export function loadLock(workingDir) {
  const file = lockPath(workingDir);
  if (!fs.existsSync(file)) return { version: LOCK_VERSION, keys: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { version: LOCK_VERSION, keys: {} };
    }
    if (!parsed.keys || typeof parsed.keys !== 'object') parsed.keys = {};
    parsed.version = LOCK_VERSION;
    return parsed;
  } catch (_e) {
    return { version: LOCK_VERSION, keys: {} };
  }
}

export function saveLock(workingDir, lock) {
  const file = lockPath(workingDir);
  const out = {
    version: LOCK_VERSION,
    keys: lock.keys || {},
  };
  writeAtomic(file, JSON.stringify(out, null, 2) + '\n');
}

export function setLockEntry(lock, key, vaultModifiedAt) {
  if (!lock.keys) lock.keys = {};
  lock.keys[key] = {
    vault_modified_at: vaultModifiedAt,
    synced_at: nowIso(),
  };
}

// ── Vault entry helpers ────────────────────────────────────────

/**
 * Read a project's entry for `key`. Returns the entry object as-is
 * (or null/undefined). The caller is expected to have called
 * loadVault and to handle missing project / missing key.
 */
export function getProjectEntry(vault, projectName, key) {
  const project = (vault.projects || {})[projectName];
  if (!project) return null;
  return Object.prototype.hasOwnProperty.call(project, key) ? project[key] : null;
}

/**
 * Resolve an entry's value. Returns
 *   { resolved: string | null, status: 'ok'|'unresolved'|'invalid'|'encrypted'|'missing' }
 *
 * `missing` is used when the entry itself is absent.
 */
export function resolveEntry(vault, entry) {
  if (entry === null || entry === undefined) {
    return { resolved: null, status: 'missing' };
  }
  const raw = entryValue(entry);
  if (raw === null) return { resolved: null, status: 'invalid' };
  const r = resolveString(raw, vault.shared || {});
  return { resolved: r.value, status: r.status };
}

// ── Status classification ──────────────────────────────────────

/**
 * Compute the sync status for one key without modifying anything.
 *
 * Inputs:
 *   - vault: parsed v3 vault
 *   - projectName: string
 *   - key: string
 *   - localValue: string | undefined (from .env)
 *   - lockEntry: {vault_modified_at, synced_at} | undefined (from .env.example.lock)
 *
 * Returns:
 *   {
 *     status: 'synced' | 'local_newer' | 'vault_newer' | 'both_diverged'
 *           | 'local_only' | 'vault_only' | 'invalid' | 'unresolved' | 'encrypted',
 *     vault_modified_at: string | null,
 *     lock_modified_at: string | null,
 *     resolved_in_vault: string | null,   // resolver output (NOT returned to MCP callers)
 *   }
 */
export function getKeyStatus(vault, projectName, key, localValue, lockEntry) {
  const entry = getProjectEntry(vault, projectName, key);
  const r = resolveEntry(vault, entry);
  const vaultModifiedAt = entry ? entryModifiedAt(entry) : null;
  const lockModifiedAt = lockEntry?.vault_modified_at || null;

  // Vault-side issues short-circuit to dedicated statuses so the
  // caller can tell the difference from a true diff.
  if (r.status === 'invalid') {
    return { status: 'invalid', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: null };
  }
  if (r.status === 'unresolved') {
    return { status: 'unresolved', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: null };
  }
  if (r.status === 'encrypted') {
    return { status: 'encrypted', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
  }

  const inVault = r.status === 'ok' && r.resolved !== null;
  const inLocal = typeof localValue === 'string';

  if (!inVault && !inLocal) {
    return { status: 'vault_only', vault_modified_at: null, lock_modified_at: lockModifiedAt, resolved_in_vault: null }; // unreachable but defensive
  }
  if (!inVault && inLocal) {
    return { status: 'local_only', vault_modified_at: null, lock_modified_at: lockModifiedAt, resolved_in_vault: null };
  }
  if (inVault && !inLocal) {
    return { status: 'vault_only', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
  }

  // Both present. The classification axes are:
  //   localMatchesVault — does .env hold the current vault value?
  //   vaultUnchanged    — has the vault's _modified_at advanced
  //                       past what the lock recorded?
  //
  // Truth table:
  //   matches & unchanged   → synced
  //   !matches & unchanged  → local_newer  (user edited .env)
  //   matches & changed     → synced (value already what vault holds; bump lock)
  //   !matches & changed    → vault_newer  (vault advanced, .env still on the prior baseline value)
  //                           OR both_diverged if there is no lock baseline at all
  const localMatchesVault = localValue === r.resolved;
  const vaultUnchanged =
    lockModifiedAt !== null && lockModifiedAt === vaultModifiedAt;

  if (localMatchesVault && vaultUnchanged) {
    return { status: 'synced', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
  }
  if (!localMatchesVault && vaultUnchanged) {
    return { status: 'local_newer', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
  }
  if (localMatchesVault && !vaultUnchanged) {
    return { status: 'synced', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
  }
  // !localMatchesVault && !vaultUnchanged
  if (lockModifiedAt === null) {
    // Untracked key with diverged values — caller must opt in.
    return { status: 'both_diverged', vault_modified_at: vaultModifiedAt, lock_modified_at: null, resolved_in_vault: r.resolved };
  }
  // Vault advanced AND local does not match new vault. We can't
  // tell from a timestamp-only lock whether local also moved — by
  // convention, if the local value is itself unequal to the vault
  // value but the lock baseline is older, treat as vault_newer
  // (the safer-to-pull side). Callers wanting strict
  // both_diverged semantics can pass force=true to either side.
  return { status: 'vault_newer', vault_modified_at: vaultModifiedAt, lock_modified_at: lockModifiedAt, resolved_in_vault: r.resolved };
}

// ── Pull / Push ────────────────────────────────────────────────

/**
 * Pull a single key from the vault into the project's .env. Per
 * SHARED_SPEC §1.3.
 *
 * Inputs:
 *   - workingDir: project directory containing .env
 *   - envPath: absolute path to .env (defaults to workingDir/.env)
 *   - projectName, key: target
 *   - force: boolean — override LOCAL_NEWER / BOTH_DIVERGED refusal
 *
 * Returns:
 *   On success:        { ok: true,  status, key, modified_at }
 *   On conflict:       { ok: false, status: 'local_newer'|'both_diverged', vault_modified_at, lock_modified_at }
 *   On vault problem:  { ok: false, status: 'key_not_in_vault'|'invalid'|'unresolved'|'encrypted', ... }
 *
 * NEVER returns the resolved value itself; values stay on disk.
 */
export function pullKey({ workingDir, envPath, projectName, key, force = false }) {
  const env = envPath || path.join(workingDir, '.env');

  pullVault();
  const vault = loadVault();
  const entry = getProjectEntry(vault, projectName, key);
  if (!entry) {
    return { ok: false, status: 'key_not_in_vault', key };
  }
  const r = resolveEntry(vault, entry);
  if (r.status === 'invalid' || r.status === 'unresolved' || r.status === 'encrypted') {
    return { ok: false, status: r.status, key };
  }

  const lock = loadLock(workingDir);
  const localMap = parseEnvFileToMap(env);
  const localValue = key in localMap ? localMap[key] : undefined;
  const status = getKeyStatus(vault, projectName, key, localValue, lock.keys[key]);

  if (!force && (status.status === 'local_newer' || status.status === 'both_diverged')) {
    return {
      ok: false,
      status: status.status,
      key,
      vault_modified_at: status.vault_modified_at,
      lock_modified_at: status.lock_modified_at,
    };
  }

  // Apply.
  upsertEnvKey(env, key, r.resolved);
  setLockEntry(lock, key, status.vault_modified_at);
  saveLock(workingDir, lock);

  return {
    ok: true,
    status: 'pulled',
    key,
    modified_at: status.vault_modified_at,
  };
}

/**
 * Push a single key from the project's .env (or a caller-supplied
 * value) into the vault. Per SHARED_SPEC §1.3.
 *
 * Inputs:
 *   - workingDir, envPath: as for pullKey
 *   - projectName, key
 *   - value: optional — when provided, used as the new value
 *     instead of reading .env. Lets the MCP push_secret tool
 *     accept a value directly (preferred for the Worker variant
 *     too).
 *   - force: boolean — override VAULT_NEWER refusal
 *
 * Returns the same shape as pullKey, plus `pushed: boolean` from
 * the git push attempt.
 */
export function pushKey({ workingDir, envPath, projectName, key, value, force = false }) {
  const env = envPath || path.join(workingDir, '.env');

  pullVault();
  const vault = loadVault();

  let localValue;
  if (typeof value === 'string') {
    localValue = value;
  } else {
    const localMap = parseEnvFileToMap(env);
    if (!(key in localMap)) {
      return { ok: false, status: 'key_not_in_local', key };
    }
    localValue = localMap[key];
  }

  const lock = loadLock(workingDir);
  const status = getKeyStatus(vault, projectName, key, localValue, lock.keys[key]);

  // Conflict check: vault advanced past the baseline.
  if (!force && (status.status === 'vault_newer' || status.status === 'both_diverged')) {
    return {
      ok: false,
      status: status.status,
      key,
      vault_modified_at: status.vault_modified_at,
      lock_modified_at: status.lock_modified_at,
    };
  }

  // Apply.
  ensureProjectExists(vault, projectName);
  const newModifiedAt = nowIso();
  setProjectSecret(vault, projectName, key, localValue, newModifiedAt);
  saveVault(vault);
  const r = commitAndPushVault(`envpact-mcp: push ${projectName}.${key}`);

  setLockEntry(lock, key, newModifiedAt);
  saveLock(workingDir, lock);

  return {
    ok: true,
    status: 'pushed',
    key,
    modified_at: newModifiedAt,
    pushed: r.pushed,
  };
}

/**
 * Compute per-key sync status across an entire .env.example. Used
 * by the sync_status MCP tool. Reads the vault, the local .env,
 * and the lock — never writes anything.
 *
 * Returns: [{ name, status, vault_modified_at, lock_modified_at }, …]
 */
export function statusReport({ workingDir, envPath, examplePath, projectName, exampleKeys }) {
  const env = envPath || path.join(workingDir, '.env');
  pullVault();
  const vault = loadVault();
  const localMap = parseEnvFileToMap(env);
  const lock = loadLock(workingDir);

  const keys = exampleKeys && exampleKeys.length
    ? exampleKeys
    : Array.from(new Set([
        ...Object.keys(localMap),
        ...Object.keys((vault.projects || {})[projectName] || {}).filter((k) => !k.startsWith('_')),
      ])).sort();

  const out = [];
  for (const key of keys) {
    const localValue = key in localMap ? localMap[key] : undefined;
    const s = getKeyStatus(vault, projectName, key, localValue, lock.keys[key]);
    out.push({
      name: key,
      status: s.status,
      vault_modified_at: s.vault_modified_at,
      lock_modified_at: s.lock_modified_at,
    });
  }
  return out;
}
