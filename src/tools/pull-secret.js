/**
 * pull_secret tool — pulls a single key from the vault into the
 * project's local .env, using the per-key sync pipeline. Refuses
 * (isError=true) on LOCAL_NEWER / BOTH_DIVERGED unless force=true.
 *
 * NEVER returns the resolved value. Only status, modified_at, and
 * a masked indicator.
 *
 * v3.1 (additive): conflict refusals carry both UTC + IST
 * timestamps for the vault and local sides per SHARED_SPEC §1.5,
 * plus a `recommended_side` hint set to whichever timestamp is
 * newer.
 */

import path from 'node:path';
import { pullKey } from '../lib/sync.js';
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
      const vaultIst = safeIst(r.vault_modified_at);
      const localIst = safeIst(r.lock_modified_at);
      const recommended =
        newerSide(r.vault_modified_at, r.lock_modified_at) === 'a'
          ? 'vault'
          : 'local';
      const lines = [];
      if (conflict) {
        lines.push(
          `Refused to pull ${project}.${key}: status=${r.status}. ` +
            `Re-run with force=true to overwrite the local value.`
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
        lines.push(`Cannot pull ${project}.${key}: ${r.status}.`);
      }
      return err(lines.join('\n'), {
        project,
        key: r.key,
        status: r.status,
        vault_modified_at: r.vault_modified_at || null,
        vault_modified_at_ist: vaultIst,
        local_modified_at: r.lock_modified_at || null,
        local_modified_at_ist: localIst,
        // legacy alias kept for back-compat with 0.3.x agents.
        lock_modified_at: r.lock_modified_at || null,
        recommended_side: conflict ? recommended : null,
      });
    }

    const ist = safeIst(r.modified_at);
    return ok(
      `Pulled ${project}.${key} (modified_at=${r.modified_at}${ist ? ` / ${ist}` : ''})${force ? ' [force]' : ''}.`,
      {
        project,
        key: r.key,
        status: r.status,
        modified_at: r.modified_at,
        modified_at_ist: ist,
        pulled_value_masked: '****',
      }
    );
  } catch (e) {
    return err(e.message);
  }
}
