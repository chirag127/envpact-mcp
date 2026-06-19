/**
 * GitHub Contents API client for the Worker.
 *
 * The Worker has no filesystem, so we read & write secrets.json
 * through the GitHub Contents API using a per-request PAT supplied
 * by the caller. This token is scoped to the user's
 * envpact-secrets repo and is what makes the Worker multi-tenant.
 *
 * v3: vaults are read with auto-upgrade in memory; only writes
 * persist v3 back to the repo (per SHARED_SPEC §1.4 — reads are
 * idempotent).
 */

import type { Vault } from './resolver';
import { validateVault } from './resolver';

const GITHUB_API = 'https://api.github.com';
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v3.json';

export interface VaultLocator {
  owner: string;
  repo?: string; // default: envpact-secrets
}

export interface VaultSnapshot {
  vault: Vault;
  sha: string; // current blob sha — required when committing
  owner: string;
  repo: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * In-memory upgrade of v1/v2 → v3 (per SHARED_SPEC §1.4).
 * Pure: returns a NEW object.
 */
export function upgradeVault(parsed: unknown): Vault {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Vault must be a JSON object');
  }
  const obj = parsed as Vault;
  if (obj.version === 3) return obj;
  if (obj.version !== 1 && obj.version !== 2) {
    throw new Error(`Unsupported vault version: ${obj.version}. Expected 1, 2, or 3.`);
  }

  const fallback =
    (obj.metadata && typeof obj.metadata.updated_at === 'string'
      ? obj.metadata.updated_at
      : null) || nowIso();

  const next: Vault = {
    $schema: SCHEMA_URL,
    version: 3,
    shared: {},
    projects: {},
    metadata: { ...(obj.metadata || {}) },
  };
  (next.metadata as Record<string, string>).updated_at = fallback;

  for (const [k, raw] of Object.entries(obj.shared || {})) {
    if (typeof raw === 'string') {
      (next.shared as Record<string, unknown>)[k] = { value: raw, _modified_at: fallback };
    } else if (raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string') {
      const r = raw as { value: string; _modified_at?: string };
      (next.shared as Record<string, unknown>)[k] = {
        value: r.value,
        _modified_at: typeof r._modified_at === 'string' ? r._modified_at : fallback,
      };
    }
  }

  for (const [pname, proj] of Object.entries(obj.projects || {})) {
    if (!proj || typeof proj !== 'object') continue;
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(proj as Record<string, unknown>)) {
      if (key.startsWith('_')) continue;
      if (typeof raw === 'string') {
        out[key] = { value: raw, _modified_at: fallback };
      } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const r = raw as Record<string, unknown>;
        if (typeof r.value === 'string' && !('default' in r) && !('production' in r)) {
          out[key] = {
            value: r.value,
            _modified_at: typeof r._modified_at === 'string' ? (r._modified_at as string) : fallback,
          };
        } else {
          let picked: string | null = null;
          if (typeof r.default === 'string' && r.default !== '') picked = r.default as string;
          else if (typeof r.production === 'string' && r.production !== '') picked = r.production as string;
          else {
            for (const v of Object.values(r)) {
              if (typeof v === 'string' && v !== '') { picked = v; break; }
            }
          }
          if (picked !== null) out[key] = { value: picked, _modified_at: fallback };
        }
      }
    }
    (next.projects as Record<string, unknown>)[pname] = out;
  }

  return next;
}

export class VaultClient {
  constructor(
    private readonly token: string,
    private readonly userAgent = 'envpact-mcp-worker/0.3.0'
  ) {
    if (!token) throw new Error('GitHub token required');
  }

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      ...extra,
    };
  }

  async whoAmI(): Promise<string> {
    const r = await fetch(`${GITHUB_API}/user`, { headers: this.headers() });
    if (!r.ok) throw new Error(`GitHub /user failed: ${r.status} ${r.statusText}`);
    const body = (await r.json()) as { login?: string };
    if (!body.login) throw new Error('GitHub /user response missing login');
    return body.login;
  }

  /**
   * Privacy gate. The audit (#1) requires that the vault repo MUST
   * be private. We reject any vault read/write against a public
   * repo with a structured error.
   */
  async assertVaultIsPrivate(loc: VaultLocator): Promise<{ owner: string; repo: string }> {
    const repo = loc.repo || 'envpact-secrets';
    const r = await fetch(
      `${GITHUB_API}/repos/${encodeURIComponent(loc.owner)}/${encodeURIComponent(repo)}`,
      { headers: this.headers() }
    );
    if (r.status === 404) {
      throw new Error(
        `Vault repo ${loc.owner}/${repo} not found. Run \`npx envpact-cli --init auto\` to bootstrap one, or check that your token has access.`
      );
    }
    if (!r.ok) throw new Error(`GitHub /repos failed: ${r.status} ${r.statusText}`);
    const body = (await r.json()) as { private?: boolean; visibility?: string };
    if (body.private !== true) {
      throw new Error(
        `SECURITY: ${loc.owner}/${repo} is ${body.visibility ?? 'PUBLIC'}. ` +
          `Refusing to read or write a non-private vault. ` +
          `Make it private at https://github.com/${loc.owner}/${repo}/settings, ` +
          `or use a different repo via the {owner, repo} config.`
      );
    }
    return { owner: loc.owner, repo };
  }

  async getVault(loc: VaultLocator): Promise<VaultSnapshot> {
    const { owner, repo } = await this.assertVaultIsPrivate(loc);
    const r = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/secrets.json`,
      { headers: this.headers() }
    );
    if (r.status === 404) {
      throw new Error(
        `secrets.json not found in ${owner}/${repo}. Run \`npx envpact-cli --init auto\` to seed one.`
      );
    }
    if (!r.ok) throw new Error(`GitHub Contents API failed: ${r.status} ${r.statusText}`);
    const body = (await r.json()) as { sha: string; content: string; encoding: string };
    if (body.encoding !== 'base64') {
      throw new Error(`Unexpected Contents API encoding: ${body.encoding}`);
    }
    const bytes = Uint8Array.from(atob(body.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      throw new Error(`secrets.json is not valid JSON: ${(e as Error).message}`);
    }
    // Auto-upgrade v1/v2 → v3 in memory. We do NOT write back unless mutated.
    const upgraded = upgradeVault(parsed);
    validateVault(upgraded);
    return { vault: upgraded, sha: body.sha, owner, repo };
  }

  /**
   * Fetch one file from the repo (used by pull_secret to read
   * .env.example contents). Returns the decoded text or null on
   * 404. Path is repo-relative.
   */
  async getRepoFile(slug: string, repoPath: string): Promise<string | null> {
    const [owner, repo] = slug.split('/');
    if (!owner || !repo) throw new Error(`Invalid repo slug: ${slug}`);
    const r = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(repoPath)}`,
      { headers: this.headers() }
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub Contents API ${slug}/${repoPath} failed: ${r.status}`);
    const body = (await r.json()) as { content?: string; encoding?: string };
    if (!body.content || body.encoding !== 'base64') return null;
    const bytes = Uint8Array.from(atob(body.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  }

  async putVault(
    snapshot: VaultSnapshot,
    nextVault: Vault,
    message: string
  ): Promise<{ sha: string }> {
    nextVault.metadata = nextVault.metadata || {};
    (nextVault.metadata as Record<string, string>).updated_at = nowIso();
    nextVault.$schema = nextVault.$schema || SCHEMA_URL;
    nextVault.version = (nextVault.version || 3) as 3;

    const text = JSON.stringify(nextVault, null, 2) + '\n';
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const content = btoa(bin);

    const body = {
      message,
      content,
      sha: snapshot.sha,
      committer: { name: 'envpact-mcp-worker', email: 'envpact@local' },
    };
    const r = await fetch(
      `${GITHUB_API}/repos/${snapshot.owner}/${snapshot.repo}/contents/secrets.json`,
      {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      }
    );
    if (r.status === 409) {
      throw new Error(
        `Conflict: someone else updated the vault since you read it. Re-fetch via list_projects or generate_env and retry.`
      );
    }
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`PUT secrets.json failed: ${r.status} ${errText.slice(0, 200)}`);
    }
    const out = (await r.json()) as { content: { sha: string } };
    return { sha: out.content.sha };
  }
}
