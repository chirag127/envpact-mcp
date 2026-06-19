/**
 * push_secret tool — pushes a single key from the project's local
 * .env (or a caller-supplied value) into the vault. Refuses
 * (isError=true) on VAULT_NEWER / BOTH_DIVERGED unless force=true.
 *
 * NEVER echoes the value back. Only status, modified_at,
 * pushed flag.
 */

import path from 'node:path';
import { pushKey } from '../lib/sync.js';
import { detectProjectFromGit } from '../lib/vault.js';

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(message, structured) {
  const out = { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
  if (structured) out.structuredContent = structured;
  return out;
}

export async function pushSecretHandler(args) {
  try {
    const cwd = path.resolve(args.working_directory || process.cwd());
    const project = (args.project_name || detectProjectFromGit(cwd)).toLowerCase();
    const key = args.key;
    const value = args.value; // may be undefined → read from .env
    const force = !!args.force;

    const r = pushKey({
      workingDir: cwd,
      projectName: project,
      key,
      value,
      force,
    });

    if (!r.ok) {
      const conflict =
        r.status === 'vault_newer' || r.status === 'both_diverged';
      const message = conflict
        ? `Refused to push ${project}.${key}: status=${r.status}. Re-run with force=true to overwrite the vault value.`
        : `Cannot push ${project}.${key}: ${r.status}.`;
      return err(message, {
        project,
        key: r.key,
        status: r.status,
        vault_modified_at: r.vault_modified_at,
        lock_modified_at: r.lock_modified_at,
      });
    }

    return ok(
      `Pushed ${project}.${key} (modified_at=${r.modified_at})${r.pushed ? ' — vault pushed.' : ' — committed locally.'}${force ? ' [force]' : ''}`,
      {
        project,
        key: r.key,
        status: r.status,
        modified_at: r.modified_at,
        pushed: r.pushed,
      }
    );
  } catch (e) {
    return err(e.message);
  }
}
