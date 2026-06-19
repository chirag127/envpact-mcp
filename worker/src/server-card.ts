/**
 * Smithery static server card per
 *   https://smithery.ai/docs/build/publish#server-scanning
 *
 * Served at /.well-known/mcp/server-card.json so Smithery can
 * publish us via URL without scanning past the auth wall (each
 * caller needs their own GitHub PAT, so anonymous tool/resource
 * enumeration via MCP would fail).
 *
 * v3 (0.3.0): list_environments removed; pull_secret, push_secret,
 * sync_status added; the `environment` parameter is gone.
 *
 * v3.1 (0.4.0, additive UX): generate_global_env added (11th tool).
 * pull/push conflict structuredContent now carries vault_modified_at_ist,
 * local_modified_at_ist, and recommended_side hints.
 */

export const SERVER_CARD = {
  name: 'chirag127/envpact-mcp',
  title: 'envpact — centralized secrets for solo devs',
  description: "Resolve secrets from your private Git-backed vault into project .env files, AI agent edition. v3.1 schema with per-key timestamps, UTC + IST dual-render conflict prompts, and a global ~/.envpact/.env mirror. 11 tools: generate_env, list_projects, list_shared, add_secret, add_shared_secret, rotate_secret, sync_github, pull_secret, push_secret, sync_status, generate_global_env.",
  version: '0.4.0',
  websiteUrl: 'https://envpact.oriz.in',
  repositoryUrl: 'https://github.com/chirag127/envpact-mcp',
  serverInfo: {
    name: 'envpact',
    version: '0.4.0',
  },
  authentication: {
    required: true,
    schemes: ['bearer', 'oauth2'],
    description:
      'Bring your own GitHub PAT with `repo` scope. Smithery presents an OAuth-style ' +
      'collection UI for URL-published servers; the token is forwarded as ' +
      '`Authorization: Bearer <pat>` on every MCP request.',
  },
  tools: [
    {
      name: 'generate_env',
      description:
        'Resolve a project\'s secrets and return the .env content as text. ' +
        'Worker variant returns text instead of writing to disk (no filesystem).',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string', description: 'Project name (lower-case, dot/dash/underscore allowed).' },
        },
        required: ['project_name'],
      },
    },
    {
      name: 'list_projects',
      description: 'List all projects in the vault.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_shared',
      description: 'List all shared secret names. Values are NEVER returned.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'add_secret',
      description: 'Add or update a project secret. Use "shared.KEY" as value to reference a shared.',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['project_name', 'key', 'value'],
      },
    },
    {
      name: 'add_shared_secret',
      description: 'Add or update a shared secret.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' } },
        required: ['key', 'value'],
      },
    },
    {
      name: 'rotate_secret',
      description: 'Rotate a shared secret. Returns affected projects. Refuses encrypted (enc:*) values.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' }, new_value: { type: 'string' } },
        required: ['key', 'new_value'],
      },
    },
    {
      name: 'sync_github',
      description: 'Stub in the Worker variant — points at envpact-cli/envpact-action.',
      inputSchema: {
        type: 'object',
        properties: { project_name: { type: 'string' } },
      },
    },
    {
      name: 'pull_secret',
      description:
        'Resolve one key from the vault. Worker variant returns the value as the response text body ' +
        '(caller writes it to disk). Conflict gating uses optional `expected_modified_at`. v3.1: ' +
        'conflict refusals carry both UTC and IST timestamps + a `recommended_side` hint.',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string' },
          key: { type: 'string' },
          expected_modified_at: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['project_name', 'key'],
      },
    },
    {
      name: 'push_secret',
      description:
        'Push one key into the vault. Worker REQUIRES `value` (no .env to read from). Conflict gating ' +
        'uses optional `expected_modified_at`. v3.1: conflict refusals carry UTC + IST timestamps ' +
        'and a `recommended_side` hint.',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string' },
          key: { type: 'string' },
          value: { type: 'string' },
          expected_modified_at: { type: 'string' },
          force: { type: 'boolean' },
        },
        required: ['project_name', 'key', 'value'],
      },
    },
    {
      name: 'sync_status',
      description:
        'Per-key sync status from the vault\'s perspective. Optionally fetches a project repo\'s ' +
        '.env.example via Contents API to enumerate required keys. v3.1: each key entry carries ' +
        'vault_modified_at and lock_modified_at in BOTH UTC and IST.',
      inputSchema: {
        type: 'object',
        properties: {
          project_name: { type: 'string' },
          env_example_repo: { type: 'string' },
          env_example_path: { type: 'string' },
        },
        required: ['project_name'],
      },
    },
    {
      name: 'generate_global_env',
      description:
        'Render the vault\'s shared.* entries as a global .env body and return it as text. The Worker ' +
        'has no filesystem; the caller writes the returned text to ~/.envpact/.env (mode 0600). Optional ' +
        '`example_text` parameter is treated as a byte-faithful template per SHARED_SPEC §5.1.',
      inputSchema: {
        type: 'object',
        properties: {
          example_text: {
            type: 'string',
            description:
              'Byte-faithful .env.example.global template. If omitted, the Worker emits an alphabetical KEY= list of every shared.* key.',
          },
        },
      },
    },
  ],
  resources: [],
  prompts: [],
} as const;
