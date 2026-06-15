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
        'envpact MCP server — manage centralized secrets stored in your private GitHub vault. ' +
        'Use generate_env to write a .env for the current project, list_projects/list_shared to ' +
        'inspect the vault, add_secret/add_shared_secret to mutate it, rotate_secret to rotate a ' +
        'shared key, and sync_github to push secrets to GitHub Actions. ' +
        'Vault values referencing other vault entries use a "shared.KEY" syntax. ' +
        'Per-environment values are nested objects with "development"/"staging"/"production" keys. ' +
        'Never echo secret values back; use list_shared (which masks values) for inventory.',
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
