# envpact-mcp — Cloudflare Worker (remote)

The remote variant of `envpact-mcp`, hosted at
**https://mcp.envpact.oriz.in/mcp**.

## Why a remote Worker?

The local stdio server (`npx envpact-mcp`) is the canonical way
to run envpact for a single dev with `~/.envpact/secrets/`
checked out locally. The Worker serves three additional cases:

1. **AI agents that prefer remote MCP** — Claude Desktop, ChatGPT
   Desktop, and Cursor can all connect to a `url:` MCP server
   without any local install.
2. **Smithery distribution** — Smithery's URL-publish flow needs
   a public HTTPS endpoint with Streamable HTTP. This Worker
   satisfies that, and serves a static server-card at
   `/.well-known/mcp/server-card.json` so Smithery can index us
   without scanning past auth.
3. **Multi-device** — your phone, a Codespaces dev container, or
   a CI job can all hit the same Worker; no local clone needed.

## How auth works

The Worker is **stateless** — it has no stored credentials of
its own. Each connecting client supplies its own GitHub PAT
(`repo` scope on `{user}/envpact-secrets`). The Worker uses
that token to fetch & PUT `secrets.json` via the GitHub
Contents API.

You provide the token via either:

- **`Authorization: Bearer <pat>`** header on every MCP request
  (manual config), or
- **`X-Smithery-Config` base64 JSON header** (automatic when
  installed via Smithery — Smithery's UI collects the PAT once
  and forwards it).

The Worker never logs the token. The audit-mandated
`assert_vault_is_private` check still runs — the `--init` audit
fix flows through here too: a public `envpact-secrets` repo is
refused.

## Usage

### From an MCP client (Claude Desktop, Cursor, etc.)

```json
{
  "mcpServers": {
    "envpact": {
      "url": "https://mcp.envpact.oriz.in/mcp",
      "headers": { "Authorization": "Bearer ghp_yourtoken" }
    }
  }
}
```

### Via Smithery

1. Install at https://smithery.ai/server/envpact (after publish).
2. Smithery's UI prompts for your GitHub PAT once.
3. The token is forwarded in `X-Smithery-Config` on each MCP
   request. Smithery never persists it server-side.

## Tools

All 8 stdio tools are present, with two behavioural deviations
documented:

| Tool | Stdio behaviour | Worker behaviour |
| --- | --- | --- |
| `generate_env` | Writes `.env` to disk | Returns the .env body as text (no FS) |
| `list_projects` | Reads local clone | Reads via Contents API |
| `list_shared` | Reads local clone | Reads via Contents API |
| `list_environments` | Local | Same |
| `add_secret` | Mutates local + push | PUT via Contents API |
| `add_shared_secret` | Mutates local + push | PUT via Contents API |
| `rotate_secret` | Local + push; refuses encrypted | Same; also refuses encrypted (no decrypt path) |
| `sync_github` | Spawns `gh secret set` | **Stub**: not implemented (would need libsodium for sealed-box). Use `envpact-cli` or `envpact-action`. |

## Local development

```bash
cd worker
npm install --ignore-scripts
npm run dev          # http://localhost:8787 — try /healthz
```

Then point an MCP Inspector at `http://localhost:8787/mcp` with
your PAT in the Authorization header.

## Deployment

GitHub Actions (`.github/workflows/deploy-worker.yml`) deploys
on every push to `main` that touches `worker/`. Required repo
secrets:

- `CLOUDFLARE_API_TOKEN` — needs **Workers Scripts: Edit** +
  optionally **Workers Routes: Edit** for the custom domain.
- `CLOUDFLARE_ACCOUNT_ID`

Manual deploy from your terminal:

```bash
cd worker
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npm run deploy
```

### Custom domain (mcp.envpact.oriz.in)

The `wrangler.jsonc` declares `mcp.envpact.oriz.in` as a custom
domain. Cloudflare provisions the cert and CNAME automatically
when the domain's zone is on your account. If
`mcp.envpact.oriz.in` doesn't propagate after the first deploy,
the workflow's smoke test will surface a warning — re-run after
DNS settles (~60s typical).

The `workers.dev` URL (`envpact-mcp.<your-subdomain>.workers.dev`)
is also active as a fallback.

## Architecture

```
┌─ MCP client (Claude Desktop, Cursor, …) ───────────────────────┐
│   Authorization: Bearer ghp_…                                  │
│   POST /mcp { jsonrpc: 2.0, method: tools/call, params: … }    │
└──────────────────────┬─────────────────────────────────────────┘
                       │ Streamable HTTP
┌──────────────────────▼──────── Cloudflare Worker ──────────────┐
│  WebStandardStreamableHTTPServerTransport (stateless)           │
│  ↓                                                              │
│  buildServer(config, request) → fresh McpServer per request     │
│  ↓                                                              │
│  tool handlers → VaultClient(token) → api.github.com            │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼─────── api.github.com ──────────────────┐
│  GET  /repos/{u}/envpact-secrets        ← privacy assertion    │
│  GET  /repos/{u}/envpact-secrets/contents/secrets.json         │
│  PUT  /repos/{u}/envpact-secrets/contents/secrets.json         │
└────────────────────────────────────────────────────────────────┘
```

## Limits

- **CPU**: each MCP tool call typically uses < 50 ms of Worker
  CPU. Workers' free tier covers 100 k requests/day; paid plan
  is $5/mo for 10 M.
- **No state**: stateless mode. Resumability via `EventStore` is
  not configured. If a client disconnects mid-stream, it must
  re-issue the request.
- **Vault size**: GitHub Contents API caps at 1 MB raw file
  size. Vaults beyond that need the Git Data API path — tracked
  for v0.2.

## Security

- The Worker stores **no secrets**. Compromising the Worker
  yields no vault access.
- All tokens flow through ephemeral request scope only.
- Tool responses NEVER include secret values (`list_shared`
  returns names only; `generate_env` returns resolved `.env` to
  the caller who already has the auth token).
- Privacy gate: refuses to read or write a non-private vault
  repo (audit fix #1, ported from envpact-cli).
- All input keys validated against the same regexes as the
  stdio server (`PROJECT_NAME_REGEX`, `ENV_KEY_REGEX`,
  `ENVIRONMENT_REGEX`) plus the `assertSafeKey` second-layer
  defence against prototype-pollution names.

## License

MIT — see [../LICENSE](../LICENSE).
