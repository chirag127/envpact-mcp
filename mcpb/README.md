# envpact-mcp — MCPB bundle

This directory contains the source for the **envpact-mcp** MCPB
bundle (`.mcpb`) — a self-contained desktop extension for Claude
Desktop and other MCPB-compatible AI clients.

## Why MCPB?

The npm package (`npx -y envpact-mcp`) requires a global Node
install. The `.mcpb` bundle ships an esbuild-bundled server with
all dependencies inlined, so users without Node — or who simply
prefer drag-and-drop installs — can still use envpact.

## Layout

```
mcpb/
├── manifest.json      ← MCPB v0.4 manifest (validated against the schema)
├── icon.png           ← 128×128 RGBA padlock icon
├── package.json       ← copy of the parent so runtime version probe works
└── server/
    └── index.js       ← esbuild bundle of src/index.js (ESM, all deps inlined)
```

## Build

```bash
npm run build:mcpb
# → dist/envpact-mcp.mcpb
```

The script (`scripts/build-mcpb.js`):

1. Syncs `manifest.json` `.version` with the parent `package.json` so they
   stay in lock-step.
2. Copies `package.json` into `mcpb/` so `src/index.js`'s runtime version
   probe (`readFileSync(__dirname/../package.json)`) resolves inside the
   bundle.
3. Runs `esbuild src/index.js --bundle --platform=node --format=esm --outfile=mcpb/server/index.js`
   to produce a single ESM file with `@modelcontextprotocol/sdk` + `zod`
   inlined.
4. Runs `mcpb validate` to enforce the v0.4 schema.
5. Runs `mcpb pack ./mcpb dist/envpact-mcp.mcpb`.

Bundle size as of v0.2.0: **165 KB packed / 832 KB unpacked**.

## Install

### Claude Desktop (drag-and-drop)

Download `envpact-mcp.mcpb` from the
[latest release](https://github.com/chirag127/envpact-mcp/releases/latest)
and drag it onto Claude Desktop's window. The first launch prompts
for two optional config values:

| Config | Default | Description |
|---|---|---|
| `vault_path` | `~/.envpact/secrets` | Local vault clone — leave default unless you've set up the vault elsewhere via `envpact-cli --init`. |
| `default_project` | (empty) | Override project name auto-detection. Most users leave empty. |

### Smithery (local-stdio publish)

```bash
smithery mcp publish ./dist/envpact-mcp.mcpb -n chirag127/envpact-mcp
```

This makes the bundle distributable via the Smithery marketplace
without requiring the URL-published Cloudflare Worker variant.

### Manual install for other MCPB hosts

Any MCPB v0.4-compatible host: drag-drop the `.mcpb` or import it
through the host's UI.

## Releases

`.github/workflows/build-mcpb.yml` runs on:

- **Tag push (`v*.*.*`)** — builds the bundle, attaches it to the
  GitHub Release as a downloadable asset, syncs the manifest
  version with the tag.
- **PR / `workflow_dispatch`** — builds + verifies via unpack
  round-trip + MCP handshake smoke test, uploads as a workflow
  artifact (no release attachment).

## Security caveats

Per the
[Anthropic build-mcpb skill](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/mcp-server-dev/skills/build-mcpb/SKILL.md):

> MCPB has **no sandbox**. The server runs with full user
> privileges. Path validation, allowlists, and least-privilege
> spawn are entirely the server's responsibility.

envpact-mcp's existing security posture applies inside the
bundle:

- Vault privacy assertion (audit fix #1) refuses to read or write
  a non-private `envpact-secrets` repo.
- Input validation regexes (audit fix #4) block prototype-pollution
  keys, path-traversal segments, and oversized identifiers.
- Path-containment check on `output_path` (audit fix #5) refuses
  any resolved output that escapes `working_directory`.
- Encrypted-value refusal (audit fix #6) means the bundle never
  writes `enc:*` ciphertext to a `.env`.

The MCPB host (Claude Desktop) does NOT add any extra sandbox on
top — these in-server protections are the only defence.

## Why a `package.json` copy?

`src/index.js` reads `../package.json` at startup to report its
version in `serverInfo`. Inside the .mcpb, the bundled server
lives at `server/index.js` — `..` from there points at the bundle
root, where we copy `package.json` at build time. This avoids
patching the source code or hardcoding a version into the bundle.

## License

MIT — see [../LICENSE](../LICENSE).
