/**
 * sync_status tool — walk .env.example keys, return per-key sync
 * status. NEVER returns values. Read-only.
 */

import path from 'node:path';
import { statusReport } from '../lib/sync.js';
import { detectProjectFromGit } from '../lib/vault.js';
import { parseEnvExample } from '../lib/envwriter.js';

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(message) {
  return { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
}

export async function syncStatusHandler(args) {
  try {
    const cwd = path.resolve(args.working_directory || process.cwd());
    const project = (args.project_name || detectProjectFromGit(cwd)).toLowerCase();
    const examplePath = path.join(cwd, '.env.example');
    const exampleKeys = parseEnvExample(examplePath);

    const keys = statusReport({
      workingDir: cwd,
      projectName: project,
      exampleKeys,
    });

    const summary = {};
    for (const k of keys) {
      summary[k.status] = (summary[k.status] || 0) + 1;
    }

    const lines = [
      `Sync status for ${project} (${keys.length} key(s)):`,
      ...keys.map(
        (k) => `  ${k.status.padEnd(14)} ${k.name}`
      ),
    ];
    if (Object.keys(summary).length) {
      lines.push('', 'Summary: ' + Object.entries(summary).map(([s, n]) => `${s}=${n}`).join(', '));
    }

    return ok(lines.join('\n'), { project, keys, summary });
  } catch (e) {
    return err(e.message);
  }
}
