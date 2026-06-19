# AGENTS.md — envpact-mcp

## Project Context

`envpact-mcp` is the MCP (Model Context Protocol) server for the
envpact ecosystem. It exposes the user's local vault
(`~/.envpact/secrets/`) over stdio so AI coding agents can resolve,
inspect, and mutate secrets.

The canonical spec lives at
`_build/specs/SHARED_SPEC.md` (v3 schema as of 2026-06-19).

## Architecture

- **Vault**: v3 schema — flat, single-environment per project,
  per-key `{value, _modified_at}` entries. v1/v2 vaults
  auto-upgrade in memory on first read (see SHARED_SPEC §1.4).
  The same `~/.envpact/secrets/secrets.json` that envpact-cli
  uses. The MCP server pulls before reads and pushes after
  writes.
- **Resolver**: ESM port of envpact-cli's `lib/resolver.js`,
  bit-for-bit identical semantics. Drops the `environment`
  parameter (gone in v3).
- **Per-key sync**: `src/lib/sync.js` implements pull/push/status
  with `.env.example.lock` as the per-key state sidecar. Conflict
  states: `local_newer`, `vault_newer`, `both_diverged`,
  `local_only`, `vault_only`, `synced`.
- **Transport**: stdio MCP (primary). Optional Cloudflare Worker
  variant in `worker/` for remote Streamable HTTP.

## Key Files

- `src/index.js` — server bootstrap (McpServer + StdioServerTransport).
- `src/tools/index.js` — tool registry (registers 10 tools with Zod schemas).
- `src/tools/<tool>.js` — one handler per tool.
- `src/lib/resolver.js` — v3 resolution algorithm (mirrors CLI).
- `src/lib/vault.js` — load/save/pull/push, in-memory v1/v2 → v3 upgrade.
- `src/lib/sync.js` — per-key pull/push pipeline + status classifier.
- `src/lib/envwriter.js` — `.env` file generation, `parseEnvFileToMap`,
  `upsertEnvKey` for per-key writes.
- `src/lib/github.js` — `gh secret set` integration.
- `worker/` — Cloudflare Worker for remote MCP (optional).

## Conventions

- ESM throughout (`"type": "module"`).
- Only one runtime dep beyond `@modelcontextprotocol/sdk`: `zod`.
- Each tool returns `{ content: [{type:'text',text}], structuredContent }`.
- On error, return `{ isError: true, content: [{type:'text',text:'error: ...'}] }`.
- Conflict refusals also use `isError: true` plus a structured
  payload carrying the status state — agents use that to decide
  whether to retry with `force: true`.
- Atomic writes via `.tmp + rename`.
- Cross-platform paths (`path.join`, `path.resolve`).
- Never include secret values in tool responses.

## Testing

```bash
pnpm test
```

Tests cover:
- The v3 resolver (mirror of CLI tests) — happy paths, missing
  project, encrypted passthrough, invalid entry shapes,
  v1/v2 → v3 auto-upgrade.
- The sync engine — six status states, conflict refusal, force
  override.
- The new pull/push/status tools end-to-end against a fixture
  vault, with explicit no-value-leak assertions on the response
  payloads.
- Live MCP handshake (spawns the actual server, sends
  initialize + tools/list, asserts all 10 tools register).

## Adding a New Tool

1. Create `src/tools/my-tool.js` with `export async function myToolHandler(args) { ... }`.
2. Register it in `src/tools/index.js` via `server.registerTool(...)`.
3. Add a smoke test in `tests/handshake.test.js`.
4. Update README's tool table.

## Security Rules

- NEVER include secret values in tool responses (status, masked
  indicators, and timestamps only).
- ALWAYS pull the vault before reads (so resolved values are fresh).
- ALWAYS push after writes (auto-commit, signed-off).
- Validate vault schema on every load.
- Mask values in `list_shared` responses.
- Conflict refusal default ON for `pull_secret`/`push_secret` —
  callers must explicitly opt in to overwrite via `force: true`.
