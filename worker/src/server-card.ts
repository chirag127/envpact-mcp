/**
 * Smithery static server card per
 *   https://smithery.ai/docs/build/publish#server-scanning
 *
 * Served at /.well-known/mcp/server-card.json so Smithery can
 * publish us via URL without scanning past the auth wall (each
 * caller needs their own GitHub PAT, so anonymous tool/resource
 * enumeration via MCP would fail).
 *
 * The shape follows MCP types from @modelcontextprotocol/sdk.
 * SEP-1649 covers the proposal.
 */

export const SERVER_CARD = {
  serverInfo: {
    name: 'envpact',
    version: '0.1.0',
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
          environment: { type: 'string', description: 'Environment to resolve (development/staging/production).' },
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
      name: 'list_environments',
      description: 'List environments configured for a project.',
      inputSchema: {
        type: 'object',
        properties: { project_name: { type: 'string' } },
        required: ['project_name'],
      },
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
          environment: { type: 'string' },
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
        properties: { project_name: { type: 'string' }, environment: { type: 'string' } },
      },
    },
  ],
  resources: [],
  prompts: [],
} as const;
