/**
 * envpact-mcp tools — central registry. Each tool maps the JSON
 * schemas in SHARED_SPEC.md §7 to a handler function.
 */
import { generateEnvHandler } from './generate-env.js';
import { listProjectsHandler } from './list-projects.js';
import { listSharedHandler } from './list-shared.js';
import { listEnvironmentsHandler } from './list-environments.js';
import { addSecretHandler } from './add-secret.js';
import { addSharedSecretHandler } from './add-shared-secret.js';
import { rotateSecretHandler } from './rotate-secret.js';
import { syncGithubHandler } from './sync-github.js';

export function registerTools(server, z) {
  server.registerTool(
    'generate_env',
    {
      title: 'Generate .env file',
      description:
        'Generate a .env file for the current project by resolving secrets from the envpact vault. ' +
        'Reads .env.example, resolves shared.KEY references and per-environment objects, and writes .env atomically. ' +
        'Auto-detects project from git remote.',
      inputSchema: {
        project_name: z.string().optional().describe(
          'Project name override. Auto-detected from git remote if omitted.'
        ),
        environment: z
          .enum(['development', 'staging', 'production', 'default'])
          .optional()
          .describe(
            "Environment to resolve. Defaults to project._default_env or 'default'."
          ),
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
    'list_environments',
    {
      title: 'List environments for a project',
      description:
        'List all environments configured for a specific project (e.g., development/staging/production).',
      inputSchema: {
        project_name: z.string().describe('Project name'),
      },
    },
    listEnvironmentsHandler
  );

  server.registerTool(
    'add_secret',
    {
      title: 'Add or update a project secret',
      description:
        'Add or update a project-specific secret. Use "shared.KEY_NAME" as the value to reference a shared secret. ' +
        'Pass an environment to scope the secret to that environment only.',
      inputSchema: {
        project_name: z.string(),
        key: z.string().describe('Environment variable name (e.g. OPENAI_API_KEY)'),
        value: z.string().describe('Value, or "shared.KEY_NAME" reference'),
        environment: z
          .string()
          .optional()
          .describe(
            'Optional. If set, the secret is stored as part of a per-environment object.'
          ),
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
        key: z.string(),
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
        'Optionally syncs the new value to GitHub Actions for all of them.',
      inputSchema: {
        key: z.string().describe('Shared secret name'),
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
        project_name: z.string().optional(),
        environment: z.string().optional(),
        repo_slug: z
          .string()
          .optional()
          .describe('Override repo slug (owner/repo). Otherwise auto-detected from cwd remote.'),
      },
    },
    syncGithubHandler
  );
}
