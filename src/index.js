#!/usr/bin/env node
/**
 * envpact-mcp — MCP server for envpact.
 *
 * Brings centralized secret management to AI coding agents like
 * Cursor, Windsurf, Claude Code, Cline, and Goose via the Model
 * Context Protocol.
 *
 * Talks to the user's local envpact vault (~/.envpact/secrets/) —
 * the same vault used by envpact-cli, envpact (Python), and
 * envpact-vscode.
 *
 * https://github.com/chirag127/envpact-mcp
 *
 * Copyright (c) 2026 Chirag Singhal — MIT License
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerTools } from './tools/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pkg = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

async function main() {
  const server = new McpServer(
    {
      name: 'envpact',
      version: pkg.version,
      websiteUrl: 'https://envpact.oriz.in',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'envpact MCP server — manage centralized secrets stored in your private GitHub vault (v3 schema). ' +
        'The vault is flat and single-environment per project; per-key timestamps power conflict detection. ' +
        'Tools: generate_env writes a project .env from the vault; list_projects/list_shared inspect the vault; ' +
        'add_secret/add_shared_secret mutate it; rotate_secret rotates a shared key; sync_github pushes to GitHub Actions; ' +
        'pull_secret/push_secret do per-key sync between .env and vault with conflict refusal (override with force=true); ' +
        'sync_status reports per-key state (synced/local_newer/vault_newer/both_diverged/local_only/vault_only). ' +
        'Vault values referencing other vault entries use the "shared.KEY" syntax. ' +
        'NEVER echo secret values back; list_shared masks values.',
    }
  );

  registerTools(server, z);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`envpact-mcp v${pkg.version} ready (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`envpact-mcp fatal: ${err.message}\n`);
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
