# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-06-15

### Added

- Initial release of `envpact-mcp`.
- Stdio MCP server exposing 8 tools: `generate_env`, `list_projects`,
  `list_shared`, `list_environments`, `add_secret`,
  `add_shared_secret`, `rotate_secret`, `sync_github`.
- Vault schema v2 with per-environment values + `shared.KEY` references.
- Auto-pull / auto-push of vault state on every tool call.
- Compatible with Claude Desktop, Claude Code, Cursor, Windsurf, Cline,
  Goose, and any MCP 2025-06-18 protocol client.
- Optional Cloudflare Worker variant for remote SSE/HTTP transport.

[0.1.0]: https://github.com/chirag127/envpact-mcp/releases/tag/v0.1.0
