/**
 * envpact-mcp resolver — v3 schema (flat, single-environment,
 * per-key timestamped). ESM port. Bit-for-bit identical to
 * envpact-cli/lib/resolver.js (v3). See SHARED_SPEC §1.2.
 */

export const SHARED_PREFIX = 'shared.';
export const ENC_PREFIX = 'enc:';

/**
 * Validate a v3 vault. v1/v2 are NOT accepted here — call
 * upgradeVault first (vault.js does this in loadVault).
 */
export function validateVault(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (vault.version !== 3) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 3 (run vault.js auto-upgrade first).`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') {
    throw new Error('vault.shared must be an object');
  }
  if (vault.projects && typeof vault.projects !== 'object') {
    throw new Error('vault.projects must be an object');
  }
}

/**
 * Pull the string `value` out of a v3 entry object, or return null
 * if the entry is malformed (not an object, missing `value`, or
 * `value` is not a string).
 */
export function entryValue(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.value !== 'string') return null;
  return entry.value;
}

/**
 * Resolve a single string value (already extracted from an entry):
 * follow shared.* references one level, pass enc:* through.
 */
export function resolveString(rawValue, shared) {
  if (typeof rawValue !== 'string') {
    return { value: null, status: 'invalid' };
  }
  if (rawValue.startsWith(ENC_PREFIX)) {
    return { value: rawValue, status: 'encrypted' };
  }
  if (rawValue.startsWith(SHARED_PREFIX)) {
    const sharedKey = rawValue.slice(SHARED_PREFIX.length);
    if (!sharedKey) return { value: null, status: 'invalid' };
    if (!shared || !(sharedKey in shared)) {
      return { value: null, status: 'unresolved' };
    }
    const sharedEntry = shared[sharedKey];
    const sharedVal = entryValue(sharedEntry);
    if (sharedVal === null) return { value: null, status: 'invalid' };
    // No recursion: a shared entry whose value is itself a
    // shared.* reference is malformed.
    if (sharedVal.startsWith(SHARED_PREFIX)) {
      return { value: null, status: 'invalid' };
    }
    if (sharedVal.startsWith(ENC_PREFIX)) {
      return { value: sharedVal, status: 'encrypted' };
    }
    return { value: sharedVal, status: 'ok' };
  }
  return { value: rawValue, status: 'ok' };
}

/**
 * Resolve a project's keys. Returns { resolved, unresolved,
 * invalid, encrypted, missing }. v3 has no environment concept.
 */
export function resolveProject(vault, projectName) {
  validateVault(vault);
  const project = (vault.projects || {})[projectName];
  if (!project) {
    return {
      resolved: {},
      unresolved: [],
      invalid: [],
      encrypted: [],
      missing: true,
    };
  }

  const resolved = {};
  const unresolved = [];
  const invalid = [];
  const encrypted = [];
  const shared = vault.shared || {};

  for (const [key, entry] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    const raw = entryValue(entry);
    if (raw === null) {
      invalid.push(key);
      continue;
    }
    const r = resolveString(raw, shared);
    if (r.status === 'ok') resolved[key] = r.value;
    else if (r.status === 'encrypted') {
      resolved[key] = r.value;
      encrypted.push(key);
    } else if (r.status === 'unresolved') unresolved.push(key);
    else invalid.push(key);
  }

  return { resolved, unresolved, invalid, encrypted, missing: false };
}

/**
 * Pull the per-key `_modified_at` timestamp out of an entry.
 * Returns null if the entry is malformed or missing the field.
 */
export function entryModifiedAt(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return typeof entry._modified_at === 'string' ? entry._modified_at : null;
}
