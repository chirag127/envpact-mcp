# AGENTS.md — envpact-mcp

## Project Context

`envpact-mcp` is the MCP (Model Context Protocol) server for the
envpact ecosystem. It exposes the user's local vault
(`~/.envpact/secrets/`) over stdio so AI coding agents can resolve,
inspect, and mutate secrets.

## Architecture

- **Transport**: stdio MCP (primary). Optional Cloudflare Worker
  variant in `worker/` for remote SSE/HTTP.
- **Vault**: same `~/.envpact/secrets/secrets.json` that envpact-cli
  uses. The MCP server pulls before reads and pushes after writes.
- **Resolver**: ESM port of envpact-cli's `lib/resolver.js`,
  bit-for-bit identical semantics.

## Key Files

- `src/index.js` — server bootstrap (McpServer + StdioServerTransport).
- `src/tools/index.js` — tool registry (registers 8 tools with Zod schemas).
- `src/tools/<tool>.js` — one handler per tool.
- `src/lib/resolver.js` — resolution algorithm (mirrors CLI).
- `src/lib/vault.js` — load/save/pull/push.
- `src/lib/envwriter.js` — `.env` file generation.
- `src/lib/github.js` — `gh secret set` integration.
- `worker/` — Cloudflare Worker for remote MCP (optional).

## Conventions

- ESM throughout (`"type": "module"`).
- Only one runtime dep beyond `@modelcontextprotocol/sdk`: `zod` (peer dep of SDK).
- Each tool returns `{ content: [{type:'text',text}], structuredContent }`.
- On error, return `{ isError: true, content: [{type:'text',text:'error: ...'}] }`.
- Never include secret values in tool responses.

## Testing

```bash
npm test
```

Tests cover:
- The resolver (mirror of CLI tests).
- Live MCP handshake (spawns the actual server, sends initialize +
  tools/list, asserts all 8 tools register).

## Adding a New Tool

1. Create `src/tools/my-tool.js` with `export async function myToolHandler(args) { ... }`.
2. Register it in `src/tools/index.js` via `server.registerTool(...)`.
3. Add a smoke test in `tests/handshake.test.js`.
4. Update README's tool table.

## Security Rules

- NEVER include secret values in tool responses.
- ALWAYS pull the vault before reads (so resolved values are fresh).
- ALWAYS push after writes (auto-commit, signed-off).
- Validate vault schema on every load.
- Mask values in `list_shared` responses.
