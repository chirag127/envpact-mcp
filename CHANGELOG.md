# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-06-16

### Security

- **AUDIT #4** — Added Zod regex constraints on every tool input that
  accepts a user-supplied identifier. `PROJECT_NAME_REGEX`,
  `ENV_KEY_REGEX`, and `ENVIRONMENT_REGEX` are exported from
  `src/tools/index.js` and applied to `generate_env`,
  `list_environments`, `add_secret`, `add_shared_secret`,
  `rotate_secret`, and `sync_github`. Defence in depth: the vault
  layer (`src/lib/vault.js`) adds `assertSafeKey` which rejects
  `__proto__`, `constructor`, `prototype`, empty strings,
  path-separator characters, and `..` segments; all writes now go
  through `Object.defineProperty` so a future bypass of `assertSafeKey`
  still cannot trigger `__proto__` setter side effects.
- **AUDIT #5** — `generate_env` now resolves `working_directory` and
  `output_path` via `path.resolve` and rejects when `path.relative`
  yields `''`, starts with `..`, or is absolute. Closes a path-traversal
  vector where a prompt-injected agent could overwrite `~/.bashrc`,
  `~/.ssh/...`, etc.

### Changed (BREAKING but correct)

- **AUDIT #6** — `generate_env` now refuses to write `.env` when the
  resolver flags any keys as encrypted (`enc:*`). The MCP server has
  no decryption path, and previously passed ciphertext through to disk.
  The tool now returns an `isError: true` response with
  `structuredContent.encrypted` listing the offending keys, pointing
  callers at `envpact-cli`.

### Added

- `tests/validation.test.js` — exercises the new regexes and
  `assertSafeKey`, asserting `__proto__`, `..`, backslash, and
  overlong names are rejected. Also asserts `Object.prototype` stays
  clean after a `__proto__`-shaped write attempt.
- `tests/generate-env.test.js` — covers `../../etc/passwd`, an
  absolute Windows path, and an `enc:dummy` vault entry. Asserts no
  `.env` is written in any of these cases, plus a happy-path success.

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
