/**
 * envpact resolver — Worker port for v3 schema (flat, single
 * environment, per-key `_modified_at` timestamps). Bit-for-bit
 * identical semantics to envpact-mcp/src/lib/resolver.js. See
 * SHARED_SPEC §1.2.
 *
 * No filesystem, no Node-only APIs — runs anywhere with fetch().
 */

export const SHARED_PREFIX = 'shared.';
export const ENC_PREFIX = 'enc:';

export interface VaultEntry {
  value: string;
  _modified_at: string;
  [extra: string]: unknown;
}

export interface Vault {
  $schema?: string;
  version: 1 | 2 | 3;
  shared?: Record<string, VaultEntry | unknown>;
  projects?: Record<string, Record<string, VaultEntry | unknown>>;
  metadata?: Record<string, string>;
}

export interface ResolveResult {
  resolved: Record<string, string>;
  unresolved: string[];
  invalid: string[];
  encrypted: string[];
  missing: boolean;
}

export function entryValue(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const v = (entry as { value?: unknown }).value;
  return typeof v === 'string' ? v : null;
}

export function entryModifiedAt(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const m = (entry as { _modified_at?: unknown })._modified_at;
  return typeof m === 'string' ? m : null;
}

export function validateVault(v: unknown): asserts v is Vault {
  if (!v || typeof v !== 'object') throw new Error('Vault must be a JSON object');
  const vault = v as Vault;
  if (vault.version !== 3) {
    throw new Error(
      `Unsupported vault version: ${vault.version}. Expected 3 (run vault-client.ts auto-upgrade first).`
    );
  }
  if (vault.shared && typeof vault.shared !== 'object') throw new Error('vault.shared must be an object');
  if (vault.projects && typeof vault.projects !== 'object') throw new Error('vault.projects must be an object');
}

export function resolveString(
  raw: unknown,
  shared: Record<string, unknown> | undefined
): { value: string | null; status: 'ok' | 'unresolved' | 'invalid' | 'encrypted' } {
  if (typeof raw !== 'string') return { value: null, status: 'invalid' };
  if (raw.startsWith(ENC_PREFIX)) return { value: raw, status: 'encrypted' };
  if (raw.startsWith(SHARED_PREFIX)) {
    const k = raw.slice(SHARED_PREFIX.length);
    if (!k) return { value: null, status: 'invalid' };
    if (!shared || !(k in shared)) return { value: null, status: 'unresolved' };
    const sharedVal = entryValue(shared[k]);
    if (sharedVal === null) return { value: null, status: 'invalid' };
    if (sharedVal.startsWith(SHARED_PREFIX)) return { value: null, status: 'invalid' };
    return sharedVal.startsWith(ENC_PREFIX)
      ? { value: sharedVal, status: 'encrypted' }
      : { value: sharedVal, status: 'ok' };
  }
  return { value: raw, status: 'ok' };
}

export function resolveProject(vault: Vault, projectName: string): ResolveResult {
  validateVault(vault);
  const project = (vault.projects || {})[projectName];
  if (!project) {
    return { resolved: {}, unresolved: [], invalid: [], encrypted: [], missing: true };
  }
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];
  const invalid: string[] = [];
  const encrypted: string[] = [];
  const shared = vault.shared || {};

  for (const [key, entry] of Object.entries(project)) {
    if (key.startsWith('_')) continue;
    const raw = entryValue(entry);
    if (raw === null) { invalid.push(key); continue; }
    const r = resolveString(raw, shared);
    if (r.status === 'ok' && r.value !== null) resolved[key] = r.value;
    else if (r.status === 'encrypted' && r.value !== null) { resolved[key] = r.value; encrypted.push(key); }
    else if (r.status === 'unresolved') unresolved.push(key);
    else invalid.push(key);
  }

  return { resolved, unresolved, invalid, encrypted, missing: false };
}
