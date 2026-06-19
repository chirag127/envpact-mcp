/**
 * push_secret tool — pushes a single key from the project's local
 * .env (or a caller-supplied value) into the vault. Refuses
 * (isError=true) on VAULT_NEWER / BOTH_DIVERGED unless force=true.
 *
 * NEVER echoes the value back. Only status, modified_at,
 * pushed flag.
 *
 * v3.1 (additive): conflict refusals carry both UTC + IST
 * timestamps for the vault and local sides per SHARED_SPEC §1.5,
 * plus a `recommended_side` hint set to whichever side is newer.
 */

import path from 'node:path';
import { pushKey } from '../lib/sync.js';
import { detectProjectFromGit } from '../lib/vault.js';
import { formatTimestamp, newerSide } from '../lib/timestamps.js';

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(message, structured) {
  const out = { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
  if (structured) out.structuredContent = structured;
  return out;
}

function safeIst(iso) {
  if (!iso) return null;
  try { return formatTimestamp(iso).ist; } catch (_e) { return null; }
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
      const vaultIst = safeIst(r.vault_modified_at);
      const localIst = safeIst(r.lock_modified_at);
      const recommended =
        newerSide(r.vault_modified_at, r.lock_modified_at) === 'a'
          ? 'vault'
          : 'local';
      const lines = [];
      if (conflict) {
        lines.push(
          `Refused to push ${project}.${key}: status=${r.status}. ` +
            `Re-run with force=true to overwrite the vault value.`
        );
        if (r.vault_modified_at || r.lock_modified_at) {
          lines.push('');
          if (r.vault_modified_at) {
            lines.push(`  Vault:  ${r.vault_modified_at}`);
            if (vaultIst) lines.push(`          → ${vaultIst}${recommended === 'vault' ? '   (Recommended — newer)' : ''}`);
          }
          if (r.lock_modified_at) {
            lines.push(`  Local:  ${r.lock_modified_at}`);
            if (localIst) lines.push(`          → ${localIst}${recommended === 'local' ? '   (Recommended — newer)' : ''}`);
          }
        }
      } else {
        lines.push(`Cannot push ${project}.${key}: ${r.status}.`);
      }
      return err(lines.join('\n'), {
        project,
        key: r.key,
        status: r.status,
        vault_modified_at: r.vault_modified_at || null,
        vault_modified_at_ist: vaultIst,
        local_modified_at: r.lock_modified_at || null,
        local_modified_at_ist: localIst,
        lock_modified_at: r.lock_modified_at || null,
        recommended_side: conflict ? recommended : null,
      });
    }

    const ist = safeIst(r.modified_at);
    return ok(
      `Pushed ${project}.${key} (modified_at=${r.modified_at}${ist ? ` / ${ist}` : ''})${r.pushed ? ' — vault pushed.' : ' — committed locally.'}${force ? ' [force]' : ''}`,
      {
        project,
        key: r.key,
        status: r.status,
        modified_at: r.modified_at,
        modified_at_ist: ist,
        pushed: r.pushed,
      }
    );
  } catch (e) {
    return err(e.message);
  }
}
