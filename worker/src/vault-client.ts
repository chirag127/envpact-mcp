/**
 * GitHub Contents API client for the Worker.
 *
 * The Worker has no filesystem, so we read & write secrets.json
 * through the GitHub Contents API using a per-request PAT supplied
 * by the caller. This token is scoped to the user's
 * envpact-secrets repo and is what makes the Worker multi-tenant
 * — every connected client owns their own vault.
 *
 * Token sources, in order of preference:
 *   1. The connecting user's session config (`config.githubToken`)
 *      passed by Smithery / mcp client registration.
 *   2. The `Authorization: Bearer <pat>` header on the request.
 *   3. None — the Worker refuses to operate.
 */

import type { Vault } from './resolver';
import { validateVault } from './resolver';

const GITHUB_API = 'https://api.github.com';
const SCHEMA_URL = 'https://envpact.oriz.in/schema/v2.json';

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

export class VaultClient {
  constructor(
    private readonly token: string,
    private readonly userAgent = 'envpact-mcp-worker/0.1.0'
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

  /**
   * Resolve the authenticated user's login. Used for namespace
   * defaulting when the client doesn't pass {owner: …}.
   */
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
    // Decode base64 → utf-8 for arbitrary unicode (avoids deprecated unescape).
    const bytes = Uint8Array.from(atob(body.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8').decode(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) {
      throw new Error(`secrets.json is not valid JSON: ${(e as Error).message}`);
    }
    // Auto-upgrade v1 → v2 in memory (we do NOT write back unless mutated).
    const obj = parsed as Vault;
    if (obj.version === 1) {
      obj.version = 2;
      obj.$schema = SCHEMA_URL;
    }
    validateVault(obj);
    return { vault: obj, sha: body.sha, owner, repo };
  }

  async putVault(
    snapshot: VaultSnapshot,
    nextVault: Vault,
    message: string
  ): Promise<{ sha: string }> {
    nextVault.metadata = nextVault.metadata || {};
    nextVault.metadata.updated_at = new Date().toISOString();
    nextVault.$schema = nextVault.$schema || SCHEMA_URL;
    nextVault.version = nextVault.version || 2;

    // Encode JSON → base64 via UTF-8 bytes (no `unescape`, no surrogate split).
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
