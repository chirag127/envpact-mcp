# envpact-mcp — documentation

> MCP server for envpact. Plug into Claude Desktop, Claude Code,
> Cursor, Windsurf, Cline, Goose — any agent that speaks the
> Model Context Protocol. The agent gets 8 tools for reading and
> updating *your* secrets vault.

## Install

Add this to your agent's MCP config. For Claude Desktop:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "envpact": {
      "command": "npx",
      "args": ["-y", "envpact-mcp"]
    }
  }
}
```

For Cursor / Windsurf / Cline / Goose — same shape, their respective
config files (consult the agent's docs for the exact path).

## Tools

The server exposes 8 tools:

| Tool | Use case |
| :--- | :--- |
| `generate_env` | Resolve a project's `.env.example` against the vault and return / write the materialised `.env` |
| `list_projects` | Enumerate every project in the user's vault |
| `list_shared` | Enumerate every shared key in the vault |
| `list_environments` | List the environments defined for a project |
| `add_secret` | Add or update a project-scoped secret |
| `add_shared_secret` | Add or update a shared secret |
| `rotate_secret` | Rotate a shared secret across every referencing project |
| `sync_github` | Push the user's vault repo so changes survive across machines |

Every tool runs against the user's local vault checkout
(`~/.envpact/secrets/`). The MCP server does not embed any credentials
of its own.

## Auth model

> **The MCP server reads YOUR vault. It cannot read anyone else's.**

`envpact-mcp` reads `~/.envpact/secrets/` on the host where it runs.
That directory is a clone of `<your-username>/envpact-secrets`, set
up the first time you run `envpact-cli --init`. The MCP server never
authenticates — git authentication for the vault repo is handled by
`gh` / git's credential helpers, owned by the user account that runs
the agent.

So if Claude Code is running as you, `envpact-mcp` reads your vault.
If a different user runs it, it reads theirs. There is no
configuration that would point one user's MCP server at another
user's vault — and no envpact-side server that could either.

## Configuration

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `vaultPath` (config schema) | `~/.envpact/secrets` | Override vault checkout path |
| `ENVPACT_VAULT_PATH` (env) | same | Same, via env var |

`smithery.yaml` declares this config schema so Smithery installs the
server with the right shape.

## Quick test

You can speak MCP at this server directly with stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' | npx -y envpact-mcp
```

Should print a JSON response with `serverInfo.name === "envpact"`.

## See also

- [Umbrella docs](https://chirag127.github.io/envpact/) — project overview, security model
- [envpact-cli](https://github.com/chirag127/envpact-cli) — sets up the vault `envpact-mcp` reads
