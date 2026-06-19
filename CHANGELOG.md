# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] - 2026-06-19

### Changed (BREAKING)

- **Schema v3 (flat, single-environment, per-key timestamped)** —
  see [SHARED_SPEC.md §1](https://github.com/chirag127/envpact/blob/main/_build/specs/SHARED_SPEC.md).
  Every entry in `shared.*` and `projects.<name>.*` is now an
  `{value, _modified_at}` object instead of a bare string or
  per-environment object. v1 / v2 vaults auto-upgrade in memory on
  first read with a stderr warning; the upgrade is only flushed
  when the consumer mutates the vault. The upgrade is lossy:
  per-environment branches are flattened to a single value picked
  by `default → production → first non-empty`.
- **`environment` parameter removed** from `generate_env`,
  `add_secret`, and `sync_github`. v3 is single-environment per
  project; users wanting multi-env isolation use multiple project
  names (e.g. `my-app-prod` / `my-app-dev`).
- **`list_environments` tool removed.** No environments any more.
- `add_secret`, `add_shared_secret`, `rotate_secret` responses now
  include `modified_at` in `structuredContent`.

### Added

- **`pull_secret(project_name?, key, force?, working_directory?)`** —
  pulls one key from the vault into the project's local `.env`
  (atomic). Per-key conflict detection via `.env.example.lock`
  sidecar: refuses with `isError=true` when local edits conflict
  (`local_newer` / `both_diverged`). `force=true` overrides.
  NEVER returns the secret value — only `status`, `modified_at`,
  and `pulled_value_masked: "****"`.
- **`push_secret(project_name?, key, value?, force?, working_directory?)`** —
  pushes one key from the project's local `.env` (or a
  caller-supplied `value`) into the vault. Refuses on
  `vault_newer` / `both_diverged` unless `force=true`. NEVER
  echoes the value.
- **`sync_status(project_name?, working_directory?)`** —
  walks `.env.example` keys and reports per-key status: `synced`,
  `local_newer`, `vault_newer`, `both_diverged`, `local_only`,
  `vault_only`. Read-only; never returns values.
- `src/lib/sync.js` — per-key sync engine (`getKeyStatus`,
  `pullKey`, `pushKey`, lock load/save).
- `src/lib/envwriter.js` — `parseEnvFileToMap()` and
  `upsertEnvKey()` for the per-key path; preserves comment lines
  and ordering when replacing one key.
- `tests/sync.test.js` — covers all six status states, pullKey /
  pushKey happy paths, conflict refusal, force override.
- `tests/pull-push-secret.test.js` — end-to-end coverage of the
  three new tools, asserts no plaintext values appear in the
  response payloads.

### Worker variant

- `worker/` ported to v3 with the new tool surface. Worker
  pull_secret returns the resolved value as the response *text
  body* (no .env to write); push_secret REQUIRES an explicit
  `value` parameter. Conflict gating uses an optional
  `expected_modified_at` parameter as the lock baseline.
- Worker bumped to 0.3.0; `wrangler deploy --dry-run` bundles
  cleanly at ~1210 KiB / 204 KiB gzipped.

### Tool count

- 0.2.0 had 8 tools. 0.3.0 has **10**: `generate_env`,
  `list_projects`, `list_shared`, `add_secret`,
  `add_shared_secret`, `rotate_secret`, `sync_github`,
  `pull_secret`, `push_secret`, `sync_status`.

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

[0.3.0]: https://github.com/chirag127/envpact-mcp/releases/tag/v0.3.0
[0.2.0]: https://github.com/chirag127/envpact-mcp/releases/tag/v0.2.0
[0.1.0]: https://github.com/chirag127/envpact-mcp/releases/tag/v0.1.0
