/**
 * envpact-mcp-worker — Cloudflare Worker remote MCP server.
 *
 * Serves MCP over Streamable HTTP at /mcp, plus a static
 * Smithery server-card at /.well-known/mcp/server-card.json so
 * Smithery can publish us via URL without scanning past the auth
 * wall.
 *
 * Architecture:
 *   - Stateless. createMcpHandler() — no Durable Objects, no
 *     per-session state in v0.1.0. Every tool call independently
 *     fetches the vault via the GitHub Contents API using the
 *     caller's token.
 *   - Multi-tenant. Each connecting user supplies their own
 *     GitHub PAT via session config (Smithery's OAuth UI for
 *     URL-published servers handles the token-collection flow,
 *     or callers can pass `Authorization: Bearer <pat>`).
 *   - Per-request auth means there is no stored secret in the
 *     Worker. If the Worker is compromised, no vault is exposed.
 *
 * The 8 tools mirror the local stdio server bit-for-bit:
 *   generate_env, list_projects, list_shared, list_environments,
 *   add_secret, add_shared_secret, rotate_secret, sync_github
 *
 * Deviations from the stdio server (documented):
 *   - generate_env returns the resolved .env content as a text
 *     resource (the Worker has no filesystem to write to).
 *   - sync_github is unimplemented in this build (would require
 *     either bundling libsodium for sealed-box encryption of repo
 *     secrets, or an outbound call to gh's REST API with the
 *     same restriction). Returns an isError pointer at envpact-cli.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import {
  PROJECT_NAME_REGEX,
  ENV_KEY_REGEX,
  ENVIRONMENT_REGEX,
  assertSafeKey,
} from './validation';
import {
  resolveProject,
  listProjectEnvironments,
  ENC_PREFIX,
  type Vault,
} from './resolver';
import { VaultClient } from './vault-client';
import { SERVER_CARD } from './server-card';

// Per-request configuration (set via session config or header).
interface SessionConfig {
  githubToken?: string;
  vaultOwner?: string;
  vaultRepo?: string;
}

// Cloudflare Workers env binding (no required vars in v0.1.0).
type Env = Record<string, never>;

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────────────
// MCP server factory — fresh server per request keeps it stateless
// ───────────────────────────────────────────────────────────────

function buildServer(config: SessionConfig | undefined, request?: Request) {
  const server = new McpServer(
    { name: 'envpact', version: '0.1.0', websiteUrl: 'https://envpact.oriz.in' },
    {
      capabilities: { tools: {} },
      instructions:
        'envpact MCP — manage secrets in your private GitHub vault. NEVER ECHO SECRET VALUES; ' +
        'list_shared masks them. Tools: generate_env, list_projects, list_shared, list_environments, ' +
        'add_secret, add_shared_secret, rotate_secret. Reference shared values via shared.KEY syntax; ' +
        'per-env values are nested objects keyed by environment name.',
    }
  );

  server.registerTool(
    'generate_env',
    {
      title: 'Resolve secrets to a .env body',
      description:
        'Resolve a project\'s secrets and return the .env content as text. The Worker variant ' +
        'cannot write to disk; the caller writes the returned text wherever it wants.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        environment: z.string().regex(ENVIRONMENT_REGEX).optional(),
      },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const result = resolveProject(snap.vault, args.project_name, args.environment);
        if (result.encrypted.length > 0) {
          return err(
            `Cannot materialise: ${result.encrypted.length} key(s) are encrypted (${result.encrypted.join(', ')}). ` +
              `The Worker has no decryption path. Use envpact-cli on a host with the age identity.`,
            { project: args.project_name, environment: result.environment, encrypted: result.encrypted }
          );
        }
        const lines = [
          `# Generated by envpact-mcp-worker on ${new Date().toISOString()}`,
          `# project: ${args.project_name}`,
          `# environment: ${result.environment}`,
          '',
        ];
        for (const [k, v] of Object.entries(result.resolved)) {
          const needsQuote = /[\s#"'\\]/.test(v) || v === '';
          lines.push(`${k}=${needsQuote ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v}`);
        }
        return ok(lines.join('\n') + '\n', {
          project: args.project_name,
          environment: result.environment,
          resolved_count: Object.keys(result.resolved).length,
          unresolved: result.unresolved,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

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
          environments: listProjectEnvironments(snap.vault, p),
        }));
        return ok(
          projects.length
            ? `${projects.length} project(s):\n` +
                summary.map((s) => `  ${s.name}  (${s.key_count} keys, envs: ${s.environments.join('/') || 'none'})`).join('\n')
            : '(no projects yet)',
          { projects: summary }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

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
          .map(([name, value]) => ({
            name,
            encrypted: typeof value === 'string' && value.startsWith(ENC_PREFIX),
          }))
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

  server.registerTool(
    'list_environments',
    {
      title: 'List environments for a project',
      description: 'List the environments configured for a project.',
      inputSchema: { project_name: z.string().regex(PROJECT_NAME_REGEX) },
    },
    async (args) => {
      try {
        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const envs = listProjectEnvironments(snap.vault, args.project_name);
        return ok(
          envs.length ? `Environments for ${args.project_name}: ${envs.join(', ')}` : `(none)`,
          { project: args.project_name, environments: envs }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    'add_secret',
    {
      title: 'Add or update a project secret',
      description: 'Add/update a project secret. Use shared.KEY for shared references.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        key: z.string().regex(ENV_KEY_REGEX),
        value: z.string(),
        environment: z.string().regex(ENVIRONMENT_REGEX).optional(),
      },
    },
    async (args) => {
      try {
        assertSafeKey(args.project_name, 'project name');
        assertSafeKey(args.key, 'secret key');
        if (args.environment) assertSafeKey(args.environment, 'environment');

        const c = getClient(config, request);
        const owner = await getOwner(c, config);
        const snap = await c.getVault({ owner, repo: config?.vaultRepo });
        const next: Vault = JSON.parse(JSON.stringify(snap.vault));
        next.projects = next.projects || {};
        if (!Object.prototype.hasOwnProperty.call(next.projects, args.project_name)) {
          Object.defineProperty(next.projects, args.project_name, {
            value: {}, writable: true, enumerable: true, configurable: true,
          });
        }
        const project = next.projects[args.project_name];
        if (args.environment) {
          const existing = (project as Record<string, unknown>)[args.key];
          if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
            (project as Record<string, unknown>)[args.key] = {};
          }
          ((project as Record<string, Record<string, string>>)[args.key])[args.environment] = args.value;
        } else {
          (project as Record<string, unknown>)[args.key] = args.value;
        }
        await c.putVault(snap, next, `envpact-mcp-worker: set ${args.project_name}.${args.key}`);
        return ok(`Set ${args.project_name}.${args.key}${args.environment ? ` (${args.environment})` : ''}`,
          { project: args.project_name, key: args.key, environment: args.environment });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

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
        const next: Vault = JSON.parse(JSON.stringify(snap.vault));
        next.shared = next.shared || {};
        Object.defineProperty(next.shared, args.key, {
          value: args.value, writable: true, enumerable: true, configurable: true,
        });
        await c.putVault(snap, next, `envpact-mcp-worker: set shared.${args.key}`);
        return ok(`Set shared.${args.key}`, { key: args.key });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

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
        const existing = snap.vault.shared[args.key];
        if (typeof existing === 'string' && existing.startsWith(ENC_PREFIX)) {
          return err(
            `shared.${args.key} is encrypted. The Worker cannot decrypt or re-encrypt; ` +
              `rotate via envpact-cli on a host with the age identity.`,
            { key: args.key, encrypted: true }
          );
        }
        // Find references for the response payload
        const refs: { project: string; key: string; environment?: string }[] = [];
        const ref = `shared.${args.key}`;
        for (const [pname, proj] of Object.entries(snap.vault.projects || {})) {
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
        const next: Vault = JSON.parse(JSON.stringify(snap.vault));
        (next.shared as Record<string, string>)[args.key] = args.new_value;
        await c.putVault(snap, next, `envpact-mcp-worker: rotate shared.${args.key}`);
        return ok(
          `Rotated shared.${args.key}. ${refs.length} reference(s) affected:\n` +
            refs.map((r) => `  - ${r.project}.${r.key}${r.environment ? ` (${r.environment})` : ''}`).join('\n'),
          { key: args.key, references: refs }
        );
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  server.registerTool(
    'sync_github',
    {
      title: 'Sync resolved secrets to GitHub Actions (unimplemented in Worker)',
      description:
        'Not implemented in the Worker variant — would require libsodium sealed-box encryption ' +
        'of each repo secret. Use envpact-cli or envpact-action.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX).optional(),
        environment: z.string().regex(ENVIRONMENT_REGEX).optional(),
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

  return server;
}

// ───────────────────────────────────────────────────────────────
// Worker fetch handler
// ───────────────────────────────────────────────────────────────

/**
 * Handle a single MCP HTTP request. Stateless: a fresh
 * McpServer + transport are spun up per request. The session
 * config (githubToken, vaultOwner, vaultRepo) is parsed once and
 * captured by every tool handler closure.
 */
async function handleMcp(request: Request): Promise<Response> {
  // Parse session config from the X-Smithery-Config header (JSON,
  // base64-encoded — Smithery's standard for URL-published servers).
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
    // Stateless mode — no sessionIdGenerator means each request
    // is independent. Workers' execution model fits this exactly.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Best-effort cleanup; Workers will tear down anyway after fetch returns.
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
<h1>🔒 envpact MCP — remote</h1>
<p>This is the Cloudflare Worker variant of <a href="https://github.com/chirag127/envpact-mcp">envpact-mcp</a>. The MCP endpoint is at <code>/mcp</code>.</p>
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Smithery static server card — bypasses auth-walled scanning.
    if (url.pathname === '/.well-known/mcp/server-card.json') {
      return new Response(JSON.stringify(SERVER_CARD, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      });
    }

    // Friendly homepage at / so visitors aren't confused.
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(HOMEPAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Healthcheck.
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'Content-Type': 'text/plain' } });
    }

    // Everything under /mcp goes to the MCP handler.
    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      return handleMcp(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};
