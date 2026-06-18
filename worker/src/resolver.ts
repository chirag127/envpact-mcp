/**
 * envpact resolver — Worker port. Bit-for-bit identical semantics
 * to envpact-cli/lib/resolver.js. See SHARED_SPEC §1.
 *
 * No filesystem, no Node-only APIs — runs anywhere with fetch().
 */

export const SHARED_PREFIX = 'shared.';
export const ENC_PREFIX = 'enc:';

export interface Vault {
  $schema?: string;
  version: 1 | 2;
  shared?: Record<string, string>;
  projects?: Record<string, ProjectEntry>;
  metadata?: Record<string, string>;
}

export type ProjectEntry = Record<
  string,
  string | Record<string, string>
> & { _default_env?: string };

export interface ResolveResult {
  resolved: Record<string, string>;
  unresolved: string[];
  invalid: string[];
  encrypted: string[];
  environment: string;
  missing: boolean;
}

export function validateVault(v: unknown): asserts v is Vault {
  if (!v || typeof v !== 'object') throw new Error('Vault must be a JSON object');
  const vault = v as Vault;
  if (vault.version !== 2 && vault.version !== 1) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 1 or 2.`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') throw new Error('vault.shared must be an object');
  if (vault.projects && typeof vault.projects !== 'object') throw new Error('vault.projects must be an object');
}

export function resolveString(
  raw: unknown,
  shared: Record<string, string> | undefined
): { value: string | null; status: 'ok' | 'unresolved' | 'invalid' | 'encrypted' } {
  if (typeof raw !== 'string') return { value: null, status: 'invalid' };
  if (raw.startsWith(ENC_PREFIX)) return { value: raw, status: 'encrypted' };
  if (raw.startsWith(SHARED_PREFIX)) {
    const k = raw.slice(SHARED_PREFIX.length);
    if (!k) return { value: null, status: 'invalid' };
    if (!shared || !(k in shared)) return { value: null, status: 'unresolved' };
    const v = shared[k];
    if (typeof v !== 'string') return { value: null, status: 'invalid' };
    return v.startsWith(ENC_PREFIX)
      ? { value: v, status: 'encrypted' }
      : { value: v, status: 'ok' };
  }
  return { value: raw, status: 'ok' };
}

export function resolveProject(
  vault: Vault,
  projectName: string,
  environment?: string
): ResolveResult {
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
  const effEnv = environment || project._default_env || 'default';
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  const invalid: string[] = [];
  const encrypted: string[] = [];
  const shared = vault.shared || {};

  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    let candidate: unknown;
    if (typeof raw === 'string') candidate = raw;
    else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, string>;
      if (effEnv in obj) candidate = obj[effEnv];
      else if ('default' in obj) candidate = obj.default;
      else { unresolved.push(key); continue; }
    } else { invalid.push(key); continue; }
    const r = resolveString(candidate, shared);
    if (r.status === 'ok' && r.value !== null) resolved[key] = r.value;
    else if (r.status === 'encrypted' && r.value !== null) { resolved[key] = r.value; encrypted.push(key); }
    else if (r.status === 'unresolved') unresolved.push(key);
    else invalid.push(key);
  }

  return { resolved, unresolved, invalid, encrypted, environment: effEnv, missing: false };
}

export function listProjectEnvironments(vault: Vault, projectName: string): string[] {
  const project = (vault.projects || {})[projectName];
  if (!project) return [];
  const envs = new Set<string>();
  let hasFlat = false;
  for (const [key, raw] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const e of Object.keys(raw as object)) envs.add(e);
    } else if (typeof raw === 'string') hasFlat = true;
  }
  if (hasFlat) envs.add('default');
  if (project._default_env) envs.add(project._default_env);
  return Array.from(envs).sort();
}
