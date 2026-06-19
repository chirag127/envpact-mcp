/**
 * pull_secret tool — pulls a single key from the vault into the
 * project's local .env, using the per-key sync pipeline. Refuses
 * (isError=true) on LOCAL_NEWER / BOTH_DIVERGED unless force=true.
 *
 * NEVER returns the resolved value. Only status, modified_at, and
 * a masked indicator.
 */

import path from 'node:path';
import { pullKey } from '../lib/sync.js';
import { detectProjectFromGit } from '../lib/vault.js';

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(message, structured) {
  const out = { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
  if (structured) out.structuredContent = structured;
  return out;
}

export async function pullSecretHandler(args) {
  try {
    const cwd = path.resolve(args.working_directory || process.cwd());
    const project = (args.project_name || detectProjectFromGit(cwd)).toLowerCase();
    const key = args.key;
    const force = !!args.force;

    const r = pullKey({ workingDir: cwd, projectName: project, key, force });

    if (!r.ok) {
      const conflict =
        r.status === 'local_newer' || r.status === 'both_diverged';
      const message = conflict
        ? `Refused to pull ${project}.${key}: status=${r.status}. Re-run with force=true to overwrite the local value.`
        : `Cannot pull ${project}.${key}: ${r.status}.`;
      return err(message, {
        project,
        key: r.key,
        status: r.status,
        vault_modified_at: r.vault_modified_at,
        lock_modified_at: r.lock_modified_at,
      });
    }

    return ok(
      `Pulled ${project}.${key} (modified_at=${r.modified_at})${force ? ' [force]' : ''}.`,
      {
        project,
        key: r.key,
        status: r.status,
        modified_at: r.modified_at,
        pulled_value_masked: '****',
      }
    );
  } catch (e) {
    return err(e.message);
  }
}
