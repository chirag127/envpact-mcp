/**
 * envpact-mcp tools — central registry. Each tool maps the JSON
 * schemas in SHARED_SPEC.md §7 to a handler function.
 *
 * v3: list_environments is GONE. The `environment` parameter is
 * removed from every tool. Three new tools are added:
 *   - pull_secret  (per-key vault → .env)
 *   - push_secret  (per-key .env → vault)
 *   - sync_status  (per-key state report)
 */
import { generateEnvHandler } from './generate-env.js';
import { listProjectsHandler } from './list-projects.js';
import { listSharedHandler } from './list-shared.js';
import { addSecretHandler } from './add-secret.js';
import { addSharedSecretHandler } from './add-shared-secret.js';
import { rotateSecretHandler } from './rotate-secret.js';
import { syncGithubHandler } from './sync-github.js';
import { pullSecretHandler } from './pull-secret.js';
import { pushSecretHandler } from './push-secret.js';
import { syncStatusHandler } from './sync-status.js';

// Validation regexes — first line of defence for MCP input. The vault
// layer applies a structural assertSafeKey check as the second layer
// (see src/lib/vault.js).
export const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function registerTools(server, z) {
  server.registerTool(
    'generate_env',
    {
      title: 'Generate .env file',
      description:
        'Generate a .env file for the current project by resolving secrets from the envpact vault. ' +
        'Reads .env.example, resolves shared.KEY references, and writes .env atomically. ' +
        'Auto-detects project from git remote when project_name is omitted.',
      inputSchema: {
        project_name: z
          .string()
          .regex(PROJECT_NAME_REGEX)
          .optional()
          .describe('Project name override. Auto-detected from git remote if omitted.'),
        working_directory: z.string().optional().describe(
          'Path to project directory containing .env.example. Defaults to cwd.'
        ),
        output_path: z.string().optional().default('.env').describe(
          'Output path for the .env file relative to working_directory.'
        ),
      },
    },
    generateEnvHandler
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects in the vault',
      description: 'List all projects configured in the envpact secrets vault.',
      inputSchema: {},
    },
    listProjectsHandler
  );

  server.registerTool(
    'list_shared',
    {
      title: 'List shared secret names',
      description:
        'List all shared secret names. Values are NEVER returned for security — only names.',
      inputSchema: {},
    },
    listSharedHandler
  );

  server.registerTool(
    'add_secret',
    {
      title: 'Add or update a project secret',
      description:
        'Add or update a project-specific secret. Use "shared.KEY_NAME" as the value to reference a shared secret. ' +
        'v3: there is no environment parameter — the vault is single-environment per project.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX),
        key: z
          .string()
          .regex(ENV_KEY_REGEX)
          .describe('Environment variable name (e.g. OPENAI_API_KEY)'),
        value: z.string().describe('Value, or "shared.KEY_NAME" reference'),
      },
    },
    addSecretHandler
  );

  server.registerTool(
    'add_shared_secret',
    {
      title: 'Add or update a shared secret',
      description:
        'Add or update a shared secret. Shared secrets can be referenced by any project using "shared.KEY_NAME" syntax.',
      inputSchema: {
        key: z.string().regex(ENV_KEY_REGEX),
        value: z.string(),
      },
    },
    addSharedSecretHandler
  );

  server.registerTool(
    'rotate_secret',
    {
      title: 'Rotate a shared secret',
      description:
        'Rotate a shared secret. Updates the value and returns the list of affected projects. ' +
        'Optionally hints to sync to GitHub Actions afterward.',
      inputSchema: {
        key: z.string().regex(ENV_KEY_REGEX).describe('Shared secret name'),
        new_value: z.string(),
        sync_github: z.boolean().optional().default(false),
      },
    },
    rotateSecretHandler
  );

  server.registerTool(
    'sync_github',
    {
      title: 'Sync resolved secrets to GitHub Actions',
      description:
        'Sync all resolved secrets for a project to GitHub Actions repository secrets via the gh CLI.',
      inputSchema: {
        project_name: z.string().regex(PROJECT_NAME_REGEX).optional(),
        repo_slug: z
          .string()
          .optional()
          .describe('Override repo slug (owner/repo). Otherwise auto-detected from cwd remote.'),
      },
    },
    syncGithubHandler
  );

  server.registerTool(
    'pull_secret',
    {
      title: 'Pull a single key from the vault into .env',
      description:
        'Pull one key from the vault into the project\'s local .env file. Per-key sync with conflict ' +
        'detection: refuses (isError=true) if the local value has been edited since the last sync ' +
        '(LOCAL_NEWER) or if both vault and local diverged (BOTH_DIVERGED). Re-run with force=true to ' +
        'override. Updates .env.example.lock. NEVER returns the secret value — only status and timestamp.',
      inputSchema: {
        project_name: z
          .string()
          .regex(PROJECT_NAME_REGEX)
          .optional()
          .describe('Project name override. Auto-detected from git remote if omitted.'),
        key: z.string().regex(ENV_KEY_REGEX).describe('Environment variable name'),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe('Override LOCAL_NEWER / BOTH_DIVERGED refusal.'),
        working_directory: z
          .string()
          .optional()
          .describe('Path to project directory. Defaults to cwd.'),
      },
    },
    pullSecretHandler
  );

  server.registerTool(
    'push_secret',
    {
      title: 'Push a single key from .env into the vault',
      description:
        'Push one key from the project\'s local .env (or a caller-supplied value) into the vault. ' +
        'Per-key sync with conflict detection: refuses (isError=true) if the vault advanced since the ' +
        'last sync (VAULT_NEWER) or both diverged (BOTH_DIVERGED). Re-run with force=true to override. ' +
        'Updates .env.example.lock. NEVER echoes the value back.',
      inputSchema: {
        project_name: z
          .string()
          .regex(PROJECT_NAME_REGEX)
          .optional()
          .describe('Project name override. Auto-detected from git remote if omitted.'),
        key: z.string().regex(ENV_KEY_REGEX).describe('Environment variable name'),
        value: z
          .string()
          .optional()
          .describe(
            'Value to push. If omitted, the value is read from the local .env file.'
          ),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe('Override VAULT_NEWER / BOTH_DIVERGED refusal.'),
        working_directory: z
          .string()
          .optional()
          .describe('Path to project directory. Defaults to cwd.'),
      },
    },
    pushSecretHandler
  );

  server.registerTool(
    'sync_status',
    {
      title: 'Per-key sync status',
      description:
        'Walk .env.example keys and report per-key sync status: synced / local_newer / vault_newer / ' +
        'both_diverged / local_only / vault_only. Read-only — never writes anything. NEVER returns ' +
        'secret values, only statuses and timestamps.',
      inputSchema: {
        project_name: z
          .string()
          .regex(PROJECT_NAME_REGEX)
          .optional()
          .describe('Project name override. Auto-detected from git remote if omitted.'),
        working_directory: z
          .string()
          .optional()
          .describe('Path to project directory. Defaults to cwd.'),
      },
    },
    syncStatusHandler
  );
}
