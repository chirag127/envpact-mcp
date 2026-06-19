/**
 * envpact-mcp-worker — Cloudflare Worker remote MCP server (v3).
 *
 * Serves MCP over Streamable HTTP at /mcp, plus a static
 * Smithery server-card at /.well-known/mcp/server-card.json so
 * Smithery can publish us via URL without scanning past the auth
 * wall.
 *
 * Architecture (unchanged from 0.1.0): stateless, multi-tenant,
 * no Durable Objects, no per-session state. Every tool call
 * independently fetches the vault via the GitHub Contents API
 * using the caller's token.
 *
 * v3 tool surface (11 tools total):
 *   generate_env, list_projects, list_shared, add_secret,
 *   add_shared_secret, rotate_secret, sync_github,
 *   pull_secret, push_secret, sync_status, generate_global_env
 *
 * Worker-specific deviations from the stdio variant (documented
 * in each tool's description):
 *   - generate_env returns the resolved .env content as text
 *     (the Worker has no filesystem to write to).
 *   - generate_global_env (v3.1) returns the resolved
 *     ~/.envpact/.env body as text, since the Worker has no
 *     filesystem to mode-0600. The caller writes it to disk
 *     locally. Same template format as the stdio variant.
 *   - pull_secret reads .env.example via the GitHub Contents API
 *     of the *target* project repo (slug supplied or auto-detected
 *     from session config), and returns the resolved value as text
 *     because there is no local .env to write to. The conflict
 *     gate degrades to "vault-only" — no local lock to compare
 *     against.
 *   - push_secret REQUIRES a `value` parameter (no .env to read
 *     from). The conflict gate uses the supplied
 *     `expected_modified_at` parameter as the lock baseline; if
 *     the vault's _modified_at differs and force is not set, the
 *     push is refused.
 *   - sync_status accepts either an explicit list of keys or an
 *     `env_example_repo`/`env_example_path` pair pointing at a
 *     project repo. Status states reachable: synced, vault_only,
 *     local_only (when caller supplied a key list). vault_newer/
 *     local_newer/both_diverged require local state which the
 *     Worker can't see.
 *   - sync_github is unimplemented (would require libsodium
 *     sealed-box encryption). Returns isError pointing at
 *     envpact-cli/envpact-action.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import {
  PROJECT_NAME_REGEX,
  ENV_KEY_REGEX,
  assertSafeKey,
} from './validation';
import {
  resolveProject,
  ENC_PREFIX,
  entryValue,
  entryModifiedAt,
  resolveString,
  type Vault,
} from './resolver';
import { VaultClient } from './vault-client';
import { SERVER_CARD } from './server-card';

interface SessionConfig {
  githubToken?: string;
  vaultOwner?: string;
  vaultRepo?: string;
}

type Env = Record<string, never>;

function ok(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function err(message: string, structured?: Record<string, unknown>) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `error: ${message}` }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function getClient(config: SessionConfig | undefined, request?: Request): VaultClient {
  let token = config?.githubToken;
  if (!token && request) {
    const auth = request.headers.get('authorization') || '';
    const m = /^bearer\s+(.+)$/i.exec(auth);
    if (m) token = m[1];
  }
  if (!token) {
    throw new Error(
      'No GitHub token. Provide one via session config (githubToken) or `Authorization: Bearer <pat>`. ' +
        'The token needs `repo` scope on your envpact-secrets repo.'
    );
  }
  return new VaultClient(token);
}

async function getOwner(client: VaultClient, config: SessionConfig | undefined): Promise<string> {
  return config?.vaultOwner || (await client.whoAmI());
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Timestamp helper (v3.1, SHARED_SPEC §1.5) ──────────────────
//
// IST is computed without depending on the host TZ — Asia/Kolkata
// is UTC+05:30 with no DST. Mirror of envpact-mcp/src/lib/timestamps.js.
function formatTimestamp(iso: string): { utc: string; ist: string | null } {
  if (typeof iso !== 'string' || iso === '') {
    return { utc: '', ist: null };
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { utc: iso, ist: null };
  const istEpoch = d.getTime() + (5 * 60 + 30) * 60 * 1000;
  const ist = new Date(istEpoch);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mi = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return { utc: iso, ist: `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} IST` };
}

function safeIst(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return formatTimestamp(iso).ist;
}

function newerSide(a: string | null | undefined, b: string | null | undefined): 'a' | 'b' | 'tie' {
  const parse = (s: string | null | undefined): number | null => {
    if (!s) return null;
    const t = new Date(s).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const ta = parse(a);
  const tb = parse(b);
  if (ta === null && tb === null) return 'tie';
  if (ta === null) return 'b';
  if (tb === null) return 'a';
  if (ta > tb) return 'a';
  if (tb > ta) return 'b';
  return 'tie';
}

// ── Light .env.example parser (no fs) ──────────────────────────
function parseEnvExampleKeys(text: string | null): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

function buildServer(config: SessionConfig | undefined, request?: Request) {
  const server = new McpServer(
    { name: 'envpact', version: '0.4.0', websiteUrl: 'https://envpact.oriz.in' },
    {
      capabilities: { tools: {} },
      instructions:
        'envpact MCP — manage secrets in your private GitHub vault (v3 schema, flat single-environment with ' +
        'per-key timestamps; v3.1 UX additions render timestamps in BOTH UTC + IST and add a global vault .env). ' +
        'NEVER ECHO SECRET VALUES; list_shared masks them. Tools: generate_env, list_projects, list_shared, ' +
        'add_secret, add_shared_secret, rotate_secret, sync_github, pull_secret, push_secret, sync_status, ' +
        'generate_global_env. Reference shared values via shared.KEY syntax.',
    }
  );

  // ── generate_env ─────────────────────────────────────────────
  server.registerTool(
    'generate_env',
    {
      title: 'Resolve secrets to a .env body',
      description:
        'Resolve a project\'s secrets and return the .env content as text. The Worker variant ' +
        'cannot write to disk; the caller writes the returned text wherever it wants.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
      },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const result = resolveProject(snap.vault, args.project_name);
        if (result.encrypted.length > 0) {
          return err(
            `Cannot materialise: ${result.encrypted.length} key(s) are encrypted (${result.encrypted.join(', ')}). ` +
              `The Worker has no decryption path. Use envpact-cli on a host with the age identity.`,
            { project: args.project_name, encrypted: result.encrypted }
          );
        }
        const lines = [
          `# Generated by envpact-mcp-worker on ${new Date().toISOString()}`,
          `# project: ${args.project_name}`,
          '',
        ];
        for (const [k, v] of Object.entries(result.resolved)) {
          const needsQuote = /[\s#"'\\]/.test(v) || v === '';
          lines.push(`${k}=${needsQuote ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v}`);
        }
        return ok(lines.join('\n') + '\n', {
          project: args.project_name,
          resolved_count: Object.keys(result.resolved).length,
          unresolved: result.unresolved,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── list_projects ────────────────────────────────────────────
  server.registerTool(
    'list_projects',
    { title: 'List projects in the vault', description: 'List all projects.', inputSchema: {} },
    async () => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const projects = Object.keys(snap.vault.projects || {}).sort();
        const summary = projects.map((p) => ({
          name: p,
          key_count: Object.keys((snap.vault.projects || {})[p] || {}).filter((k) => !k.startsWith('_')).length,
        }));
        return ok(
          projects.length
            ? `${projects.length} project(s):\n` +
                summary.map((s) => `  ${s.name}  (${s.key_count} keys)`).join('\n')
            : '(no projects yet)',
          { projects: summary }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── list_shared ──────────────────────────────────────────────
  server.registerTool(
    'list_shared',
    {
      title: 'List shared secret names',
      description: 'List all shared secret names. Values are NEVER returned.',
      inputSchema: {},
    },
    async () => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const items = Object.entries(snap.vault.shared || {})
          .map(([name, entry]) => {
            const v = entryValue(entry);
            return {
              name,
              encrypted: typeof v === 'string' && v.startsWith(ENC_PREFIX),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));
        return ok(
          items.length
            ? `${items.length} shared secret(s) (values masked):\n` +
                items.map((i) => `  ${i.name}  ${i.encrypted ? '(encrypted)' : '(plain)'}`).join('\n')
            : '(no shared secrets yet)',
          { shared: items }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── add_secret (v3: no environment) ──────────────────────────
  server.registerTool(
    'add_secret',
    {
      title: 'Add or update a project secret',
      description:
        'Add/update a project secret. Use shared.KEY for shared references. v3: single environment per project.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        key: z.string().regex(ENV_KEY_REGEX),
        value: z.string(),
      },
    },
    async (args) => {
      try {
        assertSafeKey(args.project_name, 'project name');
        assertSafeKey(args.key, 'secret key');
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const next = JSON.parse(JSON.stringify(snap.vault)) as Vault;
        next.projects = next.projects || {};
        if (!Object.prototype.hasOwnProperty.call(next.projects, args.project_name)) {
          Object.defineProperty(next.projects, args.project_name, {
            value: {}, writable: true, enumerable: true, configurable: true,
          });
        }
        const project = next.projects[args.project_name] as Record<string, unknown>;
        const modifiedAt = nowIso();
        Object.defineProperty(project, args.key, {
          value: { value: args.value, _modified_at: modifiedAt },
          writable: true, enumerable: true, configurable: true,
        });
        await c.putVault(snap, next, `envpact-mcp-worker: set ${args.project_name}.${args.key}`);
        return ok(`Set ${args.project_name}.${args.key}`, {
          project: args.project_name, key: args.key, modified_at: modifiedAt, ok: true,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── add_shared_secret ────────────────────────────────────────
  server.registerTool(
    'add_shared_secret',
    {
      title: 'Add or update a shared secret',
      description: 'Add/update a shared secret. Refusable from project values via shared.KEY.',
      inputSchema: { key: z.string().regex(ENV_KEY_REGEX), value: z.string() },
    },
    async (args) => {
      try {
        assertSafeKey(args.key, 'shared key');
        if (args.value.startsWith('shared.')) {
          return err('Refusing to set a shared secret whose value is itself a shared.* reference (would create an alias chain).');
        }
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const next = JSON.parse(JSON.stringify(snap.vault)) as Vault;
        next.shared = next.shared || {};
        const modifiedAt = nowIso();
        Object.defineProperty(next.shared, args.key, {
          value: { value: args.value, _modified_at: modifiedAt },
          writable: true, enumerable: true, configurable: true,
        });
        await c.putVault(snap, next, `envpact-mcp-worker: set shared.${args.key}`);
        return ok(`Set shared.${args.key}`, { key: args.key, modified_at: modifiedAt, ok: true });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── rotate_secret ────────────────────────────────────────────
  server.registerTool(
    'rotate_secret',
    {
      title: 'Rotate a shared secret',
      description: 'Rotate a shared secret. Returns affected projects.',
      inputSchema: {
        key: z.string().regex(ENV_KEY_REGEX),
        new_value: z.string(),
      },
    },
    async (args) => {
      try {
        assertSafeKey(args.key, 'shared key');
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        if (!snap.vault.shared || !(args.key in snap.vault.shared)) {
          return err(`Shared secret not found: ${args.key}`);
        }
        const existingVal = entryValue((snap.vault.shared as Record<string, unknown>)[args.key]);
        if (typeof existingVal === 'string' && existingVal.startsWith(ENC_PREFIX)) {
          return err(
            `shared.${args.key} is encrypted. The Worker cannot decrypt or re-encrypt; ` +
              `rotate via envpact-cli on a host with the age identity.`,
            { key: args.key, encrypted: true }
          );
        }
        const refs: { project: string; key: string }[] = [];
        const ref = `shared.${args.key}`;
        for (const [pname, proj] of Object.entries(snap.vault.projects || {})) {
          for (const [k, entry] of Object.entries(proj as Record<string, unknown>)) {
            if (k.startsWith('_')) continue;
            const v = entryValue(entry);
            if (v === ref) refs.push({ project: pname, key: k });
          }
        }
        const next = JSON.parse(JSON.stringify(snap.vault)) as Vault;
        const modifiedAt = nowIso();
        (next.shared as Record<string, unknown>)[args.key] = { value: args.new_value, _modified_at: modifiedAt };
        await c.putVault(snap, next, `envpact-mcp-worker: rotate shared.${args.key}`);
        return ok(
          `Rotated shared.${args.key}. ${refs.length} reference(s) affected:\n` +
            refs.map((r) => `  - ${r.project}.${r.key}`).join('\n'),
          { key: args.key, references: refs, modified_at: modifiedAt }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── sync_github (unimplemented) ──────────────────────────────
  server.registerTool(
    'sync_github',
    {
      title: 'Sync resolved secrets to GitHub Actions (unimplemented in Worker)',
      description:
        'Not implemented in the Worker variant — would require libsodium sealed-box encryption ' +
        'of each repo secret. Use envpact-cli or envpact-action.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX).optional(),
      },
    },
    async () => {
      return err(
        'sync_github is not available in the Worker. ' +
          'Run `envpact --github` from envpact-cli, or use the chirag127/envpact-action GitHub Action ' +
          'with sync-github-secrets: true.'
      );
    }
  );

  // ── pull_secret (worker variant returns text) ───────────────
  server.registerTool(
    'pull_secret',
    {
      title: 'Pull a single key from the vault (Worker variant returns the value as text)',
      description:
        'Resolve one key from the vault. Worker has no .env to write to; the resolved value is returned ' +
        'as the response TEXT BODY (not in structuredContent — and the caller is responsible for writing ' +
        'it to disk). Conflict gating in the Worker is best-effort: if `expected_modified_at` is supplied ' +
        'and differs from the vault\'s `_modified_at`, the call returns isError unless force=true.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        key: z.string().regex(ENV_KEY_REGEX),
        expected_modified_at: z
          .string()
          .optional()
          .describe('The modified_at this caller last saw. If it disagrees with the vault, the call refuses unless force=true.'),
        force: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const project = (snap.vault.projects || {})[args.project_name];
        if (!project) return err(`project not in vault: ${args.project_name}`, { status: 'key_not_in_vault' });
        const entry = (project as Record<string, unknown>)[args.key];
        if (!entry) return err(`key not in vault: ${args.project_name}.${args.key}`, { status: 'key_not_in_vault' });
        const raw = entryValue(entry);
        if (raw === null) return err(`vault entry is malformed: ${args.key}`, { status: 'invalid' });
        const r = resolveString(raw, snap.vault.shared);
        if (r.status === 'unresolved') return err(`unresolved shared.* reference for ${args.key}`, { status: 'unresolved' });
        if (r.status === 'invalid') return err(`invalid value for ${args.key}`, { status: 'invalid' });
        if (r.status === 'encrypted') return err(`encrypted value for ${args.key}; the Worker cannot decrypt`, { status: 'encrypted' });
        const vaultModifiedAt = entryModifiedAt(entry);
        if (
          !args.force &&
          args.expected_modified_at &&
          vaultModifiedAt &&
          args.expected_modified_at !== vaultModifiedAt
        ) {
          const vaultIst = safeIst(vaultModifiedAt);
          const localIst = safeIst(args.expected_modified_at);
          const recommended =
            newerSide(vaultModifiedAt, args.expected_modified_at) === 'a'
              ? 'vault'
              : 'local';
          const lines = [
            `Refused to pull ${args.project_name}.${args.key}: vault advanced since expected_modified_at=${args.expected_modified_at}.`,
            '',
          ];
          if (vaultModifiedAt) {
            lines.push(`  Vault:  ${vaultModifiedAt}`);
            if (vaultIst) lines.push(`          → ${vaultIst}${recommended === 'vault' ? '   (Recommended — newer)' : ''}`);
          }
          if (args.expected_modified_at) {
            lines.push(`  Local:  ${args.expected_modified_at}`);
            if (localIst) lines.push(`          → ${localIst}${recommended === 'local' ? '   (Recommended — newer)' : ''}`);
          }
          return err(lines.join('\n'), {
            status: 'vault_newer',
            vault_modified_at: vaultModifiedAt,
            vault_modified_at_ist: vaultIst,
            local_modified_at: args.expected_modified_at,
            local_modified_at_ist: localIst,
            lock_modified_at: args.expected_modified_at,
            recommended_side: recommended,
          });
        }
        // Note: the resolved value is returned as the text body so
        // the caller can write it. structuredContent omits the value.
        return ok(r.value as string, {
          project: args.project_name,
          key: args.key,
          status: 'pulled',
          modified_at: vaultModifiedAt,
          modified_at_ist: safeIst(vaultModifiedAt),
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── push_secret (worker variant requires explicit value) ────
  server.registerTool(
    'push_secret',
    {
      title: 'Push a single key into the vault (Worker variant requires `value`)',
      description:
        'Push one key into the vault. The Worker has no .env to read from, so `value` is REQUIRED. ' +
        'Conflict gating: if `expected_modified_at` is supplied and disagrees with the current vault ' +
        '_modified_at, the push is refused unless force=true. NEVER echoes the value back.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        key: z.string().regex(ENV_KEY_REGEX),
        value: z.string(),
        expected_modified_at: z.string().optional(),
        force: z.boolean().optional().default(false),
      },
    },
    async (args) => {
      try {
        assertSafeKey(args.project_name, 'project name');
        assertSafeKey(args.key, 'secret key');
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const existing = (snap.vault.projects || {})[args.project_name]?.[args.key];
        const vaultModifiedAt = existing ? entryModifiedAt(existing) : null;
        if (
          !args.force &&
          args.expected_modified_at &&
          vaultModifiedAt &&
          args.expected_modified_at !== vaultModifiedAt
        ) {
          const vaultIst = safeIst(vaultModifiedAt);
          const localIst = safeIst(args.expected_modified_at);
          const recommended =
            newerSide(vaultModifiedAt, args.expected_modified_at) === 'a'
              ? 'vault'
              : 'local';
          const lines = [
            `Refused to push ${args.project_name}.${args.key}: vault advanced since expected_modified_at=${args.expected_modified_at}.`,
            '',
          ];
          if (vaultModifiedAt) {
            lines.push(`  Vault:  ${vaultModifiedAt}`);
            if (vaultIst) lines.push(`          → ${vaultIst}${recommended === 'vault' ? '   (Recommended — newer)' : ''}`);
          }
          if (args.expected_modified_at) {
            lines.push(`  Local:  ${args.expected_modified_at}`);
            if (localIst) lines.push(`          → ${localIst}${recommended === 'local' ? '   (Recommended — newer)' : ''}`);
          }
          return err(lines.join('\n'), {
            status: 'vault_newer',
            vault_modified_at: vaultModifiedAt,
            vault_modified_at_ist: vaultIst,
            local_modified_at: args.expected_modified_at,
            local_modified_at_ist: localIst,
            lock_modified_at: args.expected_modified_at,
            recommended_side: recommended,
          });
        }
        const next = JSON.parse(JSON.stringify(snap.vault)) as Vault;
        next.projects = next.projects || {};
        if (!Object.prototype.hasOwnProperty.call(next.projects, args.project_name)) {
          Object.defineProperty(next.projects, args.project_name, {
            value: {}, writable: true, enumerable: true, configurable: true,
          });
        }
        const proj = next.projects[args.project_name] as Record<string, unknown>;
        const modifiedAt = nowIso();
        Object.defineProperty(proj, args.key, {
          value: { value: args.value, _modified_at: modifiedAt },
          writable: true, enumerable: true, configurable: true,
        });
        await c.putVault(snap, next, `envpact-mcp-worker: push ${args.project_name}.${args.key}`);
        return ok(`Pushed ${args.project_name}.${args.key}`, {
          project: args.project_name,
          key: args.key,
          status: 'pushed',
          modified_at: modifiedAt,
          modified_at_ist: safeIst(modifiedAt),
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── sync_status ──────────────────────────────────────────────
  server.registerTool(
    'sync_status',
    {
      title: 'Per-key sync status (Worker variant — vault side only)',
      description:
        'Report per-key sync status from the vault\'s perspective. Without local state the Worker can ' +
        'only flag vault_only / synced (when the caller supplies a key list and confirms the values match) ' +
        'or no-op for missing keys. If `env_example_repo` is supplied, the Worker fetches its .env.example ' +
        'via Contents API to enumerate the required keys.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        env_example_repo: z
          .string()
          .optional()
          .describe('owner/repo slug of the project repo whose .env.example should be read.'),
        env_example_path: z
          .string()
          .optional()
          .default('.env.example'),
      },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const project = (snap.vault.projects || {})[args.project_name] || {};

        let exampleKeys: string[] = [];
        if (args.env_example_repo) {
          const text = await c.getRepoFile(args.env_example_repo, args.env_example_path || '.env.example');
          exampleKeys = parseEnvExampleKeys(text);
        }
        const allKeys = Array.from(
          new Set([...exampleKeys, ...Object.keys(project).filter((k) => !k.startsWith('_'))])
        ).sort();
        const keys = allKeys.map((name) => {
          const entry = (project as Record<string, unknown>)[name];
          if (!entry) {
            return {
              name,
              status: 'local_only' as const,
              vault_modified_at: null,
              vault_modified_at_ist: null,
              lock_modified_at: null,
              lock_modified_at_ist: null,
            };
          }
          const mt = entryModifiedAt(entry);
          return {
            name,
            status: 'vault_only' as const,
            vault_modified_at: mt,
            vault_modified_at_ist: safeIst(mt),
            lock_modified_at: null,
            lock_modified_at_ist: null,
          };
        });
        return ok(
          `Sync status for ${args.project_name} (${keys.length} key(s); Worker can only see vault side):\n` +
            keys.map((k) => `  ${k.status.padEnd(14)} ${k.name}`).join('\n'),
          { project: args.project_name, keys }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ── generate_global_env (v3.1, Worker variant returns text) ─
  server.registerTool(
    'generate_global_env',
    {
      title: 'Render the vault\'s shared.* entries as a global .env body (Worker returns text)',
      description:
        'Render every shared.* entry in the vault into a global .env body and return it as the response ' +
        'TEXT BODY. The Worker has no filesystem so it cannot write ~/.envpact/.env directly — the caller ' +
        'is responsible for persisting the returned text with mode 0600. If `example_text` is supplied it ' +
        'is treated as a byte-faithful template (per SHARED_SPEC §5.1); otherwise an alphabetical KEY= list ' +
        'of every shared.* key is generated. NEVER returns the structuredContent values inline — only the ' +
        'rendered text body and counts.',
      inputSchema: {
        example_text: z
          .string()
          .optional()
          .describe(
            'Optional byte-faithful .env.example.global template. If omitted, the Worker emits an alphabetical KEY= list of every shared.* key in the vault.'
          ),
      },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const shared = (snap.vault.shared || {}) as Record<string, unknown>;

        let exampleText: string;
        let generatedExample = false;
        if (typeof args.example_text === 'string' && args.example_text.length > 0) {
          exampleText = args.example_text;
          if (!exampleText.endsWith('\n')) exampleText += '\n';
        } else {
          const keys = Object.keys(shared).filter((k) => !k.startsWith('_')).sort();
          exampleText = keys.length ? keys.map((k) => `${k}=`).join('\n') + '\n' : '';
          generatedExample = true;
        }

        const ENC = 'enc:';
        const needsQuote = (v: string) =>
          v === '' || /[\s#"'\\]/.test(v) || /^\s|\s$/.test(v) || /[\n\r]/.test(v);
        const escape = (v: string) =>
          v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
        const fmt = (v: string) => (needsQuote(v) ? `"${escape(v)}"` : v);

        const outLines: string[] = [];
        const encrypted: string[] = [];
        const notInVault: string[] = [];
        let resolved = 0;

        for (const raw of exampleText.split(/\r?\n/)) {
          const trimmed = raw.trim();
          if (trimmed === '') { outLines.push(raw); continue; }
          if (trimmed.startsWith('#')) { outLines.push(raw); continue; }
          const eq = raw.indexOf('=');
          if (eq < 0) { outLines.push(raw); continue; }
          const key = raw.slice(0, eq).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { outLines.push(raw); continue; }
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
          if (v.startsWith(ENC)) {
            outLines.push(`# ${key}: encrypted — decrypt-via-cli`);
            encrypted.push(key);
            continue;
          }
          outLines.push(`${key}=${fmt(v)}`);
          resolved += 1;
        }

        const trailingNl = /\n$/.test(exampleText);
        let body = outLines.join('\n');
        if (trailingNl && !body.endsWith('\n')) body += '\n';

        const header =
          `# Generated by envpact-mcp-worker (global) on ${nowIso()}\n` +
          `# DO NOT COMMIT — managed by envpact\n`;
        const sep = body.startsWith('\n') || body === '' ? '' : '\n';
        const text = header + sep + body;

        return ok(text, {
          resolved_count: resolved,
          encrypted,
          not_in_vault: notInVault,
          generated_global_example: generatedExample,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  return server;
}

async function handleMcp(request: Request): Promise<Response> {
  let config: SessionConfig | undefined;
  const cfgHeader = request.headers.get('x-smithery-config');
  if (cfgHeader) {
    try {
      const json = atob(cfgHeader);
      const parsed = JSON.parse(json) as SessionConfig;
      if (parsed && typeof parsed === 'object') config = parsed;
    } catch {
      return new Response('Invalid X-Smithery-Config header (expect base64 JSON)', { status: 400 });
    }
  }

  const server = buildServer(config, request);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  }
}

const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>envpact MCP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; line-height: 1.55; color: #1f2328; }
  code { background: #f6f8fa; padding: .15em .35em; border-radius: 4px; font-size: .95em; }
  pre { background: #f6f8fa; padding: 1rem; border-radius: 6px; overflow: auto; }
  h1 { font-size: 1.6rem; }
  a { color: #0969da; }
</style>
<h1>🔒 envpact MCP — remote (v3.1)</h1>
<p>This is the Cloudflare Worker variant of <a href="https://github.com/chirag127/envpact-mcp">envpact-mcp</a>. The MCP endpoint is at <code>/mcp</code>. v3.1 ships per-key timestamps with UTC + IST dual-render conflict prompts and a global <code>~/.envpact/.env</code> mirror — 11 tools total including <code>generate_global_env</code>.</p>
<h2>Configure your AI agent</h2>
<pre>{
  "mcpServers": {
    "envpact": {
      "url": "https://mcp.envpact.oriz.in/mcp",
      "headers": { "Authorization": "Bearer YOUR_GITHUB_PAT" }
    }
  }
}</pre>
<p>The PAT needs <code>repo</code> scope on your <code>envpact-secrets</code> repo. Or install via Smithery for an OAuth UI.</p>
<p><a href="/.well-known/mcp/server-card.json">Static server card</a> · <a href="https://smithery.ai/server/envpact">Smithery listing</a> · <a href="https://envpact.oriz.in">Documentation</a></p>
`;

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/.well-known/mcp/server-card.json') {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HOMEPAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return handleMcp(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
