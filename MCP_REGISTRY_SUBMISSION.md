# MCP registry submissions for envpact-mcp

This file is the canonical text/JSON for every MCP-registry submission.
None of these registries have a `publish` CLI; each requires a one-time
human action on a website or a PR. After v0.2.0 lands on npm, work
through this list in order.

---

## 1. Smithery — https://smithery.ai

**Action:** sign in at smithery.ai with GitHub, click **Add Server**,
paste `chirag127/envpact-mcp`. Smithery reads the `smithery.yaml` file
already committed to the repo and creates the listing automatically.

**Estimated time:** 2 minutes.

**Post-listing:** add the Smithery badge to the umbrella README:

```markdown
[![smithery badge](https://smithery.ai/badge/envpact)](https://smithery.ai/server/envpact)
```

---

## 2. modelcontextprotocol/servers — official README

**Repo:** https://github.com/modelcontextprotocol/servers
**Action:** open a PR adding `envpact-mcp` to the
**Community Servers** section of `README.md`.

**Suggested PR title:**
> Add envpact-mcp — centralized Git-backed secrets manager

**Suggested README entry (paste under Community Servers, alphabetical):**

```markdown
- **[envpact](https://github.com/chirag127/envpact-mcp)** — Centralized
  secrets manager for AI agents. Resolves secrets from a private
  Git-backed vault into project-scoped `.env` maps; share keys across
  100+ projects via `shared.KEY` references; rotate once, every
  project picks up the change next run.
```

**Suggested PR body:**

```markdown
## What

Adds [`envpact-mcp`](https://github.com/chirag127/envpact-mcp), an
MCP server that gives AI coding agents (Cursor, Windsurf, Claude Code,
Cline, Goose) access to a developer's centralized secrets vault.

## Why

Solo developers maintaining many public GitHub repos run into a
recurring problem: the same `OPENAI_API_KEY` shows up in 40 different
projects, public repos can't have plaintext `.env` files, and
manually rotating secrets across every project is impractical.

envpact stores all secrets in a single private GitHub repo
(`{user}/envpact-secrets`) keyed by project name. The MCP server
exposes 8 tools — `generate_env`, `list_projects`, `list_shared`,
`add_secret`, `add_shared_secret`, `rotate_secret`, `sync_github`,
`list_environments` — so an AI agent can materialize a `.env` for
the project it's working on without the user having to copy-paste
keys.

## Install

```jsonc
{
  "mcpServers": {
    "envpact": {
      "command": "npx",
      "args": ["-y", "envpact-mcp"]
    }
  }
}
```

## Tested with

- Claude Desktop
- Claude Code
- Cursor
- Windsurf
- Cline
- Goose

## License

MIT.
```

---

## 3. glama.ai — https://glama.ai/mcp/servers

**Action:** glama auto-indexes from npm + the
modelcontextprotocol/servers list. After (1) and (2) land, the listing
should appear within ~24h. If it doesn't, file an issue at
https://github.com/punkpeye/awesome-mcp-servers asking for inclusion.

**Estimated time:** 0 minutes (passive); 5 minutes if a manual nudge
is needed.

---

## 4. mcp.so — https://mcp.so

**Action:** mcp.so accepts submissions via a Google Form linked from
their footer ("Submit"). Fill in:

| Field | Value |
| :--- | :--- |
| Server name | envpact |
| GitHub URL | https://github.com/chirag127/envpact-mcp |
| Description | Centralized secrets manager for AI agents. Resolves secrets from a private Git-backed vault into project-scoped `.env` maps. Share keys across 100+ projects via `shared.KEY` references. |
| Category | Productivity / Developer Tools |
| Install command | `npx -y envpact-mcp` |

**Estimated time:** 3 minutes.

---

## 5. punkpeye/awesome-mcp-servers (community list)

**Repo:** https://github.com/punkpeye/awesome-mcp-servers
**Action:** PR adding to the **Developer Tools** or **File Systems**
section.

**Suggested entry:**

```markdown
- [envpact-mcp](https://github.com/chirag127/envpact-mcp) — Centralized
  secrets manager. Reads/writes a private Git-backed vault; resolves
  `shared.KEY` references; rotates secrets across many projects at once.
```

**Estimated time:** 5 minutes.

---

## 6. PulseMCP — https://www.pulsemcp.com

**Action:** sign in with GitHub, click **Submit a server**, paste the
GitHub URL. Auto-indexed.

**Estimated time:** 2 minutes.

---

## After all submissions land

Add badges to umbrella `README.md`:

```markdown
[![Smithery](https://smithery.ai/badge/envpact)](https://smithery.ai/server/envpact)
[![Glama](https://glama.ai/mcp/servers/envpact/badge)](https://glama.ai/mcp/servers/envpact)
[![mcp.so](https://img.shields.io/badge/mcp.so-listed-purple)](https://mcp.so/server/envpact)
```

---

## Maintenance

Every minor version bump (e.g. v0.2.0 → v0.3.0):

- Smithery: re-indexes automatically from npm; nothing to do.
- modelcontextprotocol/servers README: open a PR only if the
  description changed materially.
- glama / mcp.so: refresh on their own from npm metadata.
- punkpeye/awesome-mcp-servers: only refresh on major version bumps.
