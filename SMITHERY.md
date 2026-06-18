# Publishing envpact-mcp to Smithery

This document covers Smithery URL-based publishing for the
remote variant of envpact-mcp at https://mcp.envpact.oriz.in/mcp.

## Pre-requisites (already done)

✓ Cloudflare Worker deployed at `mcp.envpact.oriz.in/mcp`
  (Streamable HTTP transport via `WebStandardStreamableHTTPServerTransport`).
✓ Static server card served at
  `mcp.envpact.oriz.in/.well-known/mcp/server-card.json` —
  bypasses Smithery's automatic scan, which would otherwise fail
  because every tool requires a per-user GitHub PAT.
✓ The Worker returns `401 Unauthorized` (not 403) for
  authenticated tool calls without a token, per
  https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
  so Smithery can detect the OAuth path correctly.

## Publishing

### Option A — Web UI (easiest)

1. Go to https://smithery.ai/new
2. Enter URL: `https://mcp.envpact.oriz.in/mcp`
3. Smithery reads `.well-known/mcp/server-card.json` to skip the
   auth wall and registers the 8 tools.
4. On the publish form:
   - **Qualified name**: `chirag127/envpact-mcp`
   - **Display name**: envpact
   - **Description** (auto-filled from server-card)
5. Submit. The listing appears at
   `https://smithery.ai/server/chirag127/envpact-mcp`.

### Option B — CLI

```bash
npx -y @smithery/cli mcp publish "https://mcp.envpact.oriz.in/mcp" \
  -n chirag127/envpact-mcp \
  --config-schema '{
    "type": "object",
    "properties": {
      "githubToken": {
        "type": "string",
        "description": "GitHub PAT with repo scope on your envpact-secrets repo. Smithery forwards this as Authorization: Bearer <token> on every MCP request.",
        "x-from": "user-input"
      },
      "vaultOwner": {
        "type": "string",
        "description": "GitHub username that owns the envpact-secrets repo. Defaults to the authenticated user."
      },
      "vaultRepo": {
        "type": "string",
        "default": "envpact-secrets",
        "description": "Vault repository name (default: envpact-secrets)."
      }
    },
    "required": ["githubToken"]
  }'
```

### Option C — Programmatic API

```bash
curl -X PUT \
  "https://server.smithery.ai/servers/chirag127%2Fenvpact-mcp/releases" \
  -H "Authorization: Bearer $SMITHERY_API_KEY" \
  -F payload='{"type":"external","url":"https://mcp.envpact.oriz.in/mcp"}'
```

## Verifying publication

After publish:

```bash
curl https://server.smithery.ai/servers/chirag127/envpact-mcp \
  | jq '.qualifiedName, .latestVersion, .tools | length'
```

Expected: 8 tools listed, latest version `0.1.0`.

## End-user installation via Smithery

Once published, users install via:

```bash
npx -y @smithery/cli install @chirag127/envpact-mcp \
  --client claude
```

Smithery's UI prompts the user for their GitHub PAT once and
forwards it via `X-Smithery-Config` (base64 JSON) on every MCP
request to the Worker.

## Troubleshooting

### 403 during scan

If Smithery's bot is being blocked by Cloudflare's Bot Fight Mode
on the `oriz.in` zone:

```
Security > WAF > Custom Rules → Add rule:
  Expression:  (http.user_agent contains "SmitheryBot")
  Action:      Skip → Super Bot Fight Mode
```

(Or, on a free Cloudflare plan: **Security > Bots > Bot Fight
Mode** → toggle off, accepting that this disables bot protection
for all traffic.)

The `.well-known/mcp/server-card.json` route is unauthenticated
and shouldn't trigger any auth-related blocks, but Bot Fight
Mode is User-Agent-based and can still match.

### 401 vs 403 mismatch

Smithery uses 401 (per RFC 9728) to detect OAuth support. Our
Worker correctly returns 401 for unauthenticated tool calls; the
homepage and server-card return 200 unauthenticated. If you see
403s, double-check no Cloudflare WAF rule is rewriting the
status code.

## Alternative: Local stdio via MCPB bundle

For users who prefer a local stdio install without Smithery
hosting overhead, a `.mcpb` bundle can be built from
`envpact-mcp` and published separately:

```bash
# Build the .mcpb (TODO: add an mcpb-pack script to envpact-mcp)
npx @modelcontextprotocol/mcpb pack

# Publish
npx -y @smithery/cli mcp publish ./envpact-mcp.mcpb -n chirag127/envpact-mcp
```

This is **deferred to v0.2.0** — the URL-based remote publish
covers the same install UX with less maintenance burden (no
bundle artifact to keep in sync with each release).

## Spec references

- Smithery publish guide:
  https://smithery.ai/docs/build/publish
- Static Server Card (SEP-1649):
  https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1649
- Streamable HTTP transport:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Client ID Metadata Documents (the auth flow Smithery uses):
  https://modelcontextprotocol.io/specification/draft/basic/authorization#client-id-metadata-documents
