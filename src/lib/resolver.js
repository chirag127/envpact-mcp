/**
 * envpact-mcp resolver — ESM port of envpact-cli's resolver.
 * Bit-for-bit identical semantics. See SHARED_SPEC.md §1.
 */

export const SHARED_PREFIX = 'shared.';
export const ENC_PREFIX = 'enc:';

export function validateVault(vault) {
  if (!vault || typeof vault !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  if (vault.version !== 2 && vault.version !== 1) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 1 or 2.`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') {
    throw new Error('vault.shared must be an object');
  }
  if (vault.projects && typeof vault.projects !== 'object') {
    throw new Error('vault.projects must be an object');
  }
}

export function resolveString(rawValue, shared) {
  if (typeof rawValue !== 'string') {
    return { value: null, status: 'invalid' };
  }
  if (rawValue.startsWith(ENC_PREFIX)) {
    return { value: rawValue, status: 'encrypted' };
  }
  if (rawValue.startsWith(SHARED_PREFIX)) {
    const sharedKey = rawValue.slice(SHARED_PREFIX.length);
    if (!shared || !(sharedKey in shared)) {
      return { value: null, status: 'unresolved' };
    }
    const sharedVal = shared[sharedKey];
    if (typeof sharedVal !== 'string') {
      return { value: null, status: 'invalid' };
    }
    if (sharedVal.startsWith(ENC_PREFIX)) {
      return { value: sharedVal, status: 'encrypted' };
    }
    return { value: sharedVal, status: 'ok' };
  }
  return { value: rawValue, status: 'ok' };
}

export function resolveProject(vault, projectName, environment) {
  validateVault(vault);
  const project = (vault.projects || {})[projectName];
  if (!project) {
    return {
      resolved: {},
      unresolved: [],
      invalid: [],
      encrypted: [],
      environment: environment || 'default',
      missing: true,
    };
  }
  const effectiveEnv =
    environment || project._default_env || 'default';

  const resolved = {};
  const unresolved = [];
  const invalid = [];
  const encrypted = [];
  const shared = vault.shared || {};

  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    let candidate;
    if (typeof raw === 'string') {
      candidate = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      if (effectiveEnv in raw) candidate = raw[effectiveEnv];
      else if ('default' in raw) candidate = raw.default;
      else {
        unresolved.push(key);
        continue;
      }
    } else {
      invalid.push(key);
      continue;
    }
    const r = resolveString(candidate, shared);
    if (r.status === 'ok') resolved[key] = r.value;
    else if (r.status === 'encrypted') {
      resolved[key] = r.value;
      encrypted.push(key);
    } else if (r.status === 'unresolved') unresolved.push(key);
    else invalid.push(key);
  }

  return { resolved, unresolved, invalid, encrypted, environment: effectiveEnv, missing: false };
}

export function listProjectEnvironments(vault, projectName) {
  const project = (vault.projects || {})[projectName];
  if (!project) return [];
  const envs = new Set();
  let hasFlat = false;
  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const e of Object.keys(raw)) envs.add(e);
    } else if (typeof raw === 'string') hasFlat = true;
  }
  if (hasFlat) envs.add('default');
  if (project._default_env) envs.add(project._default_env);
  return Array.from(envs).sort();
}
