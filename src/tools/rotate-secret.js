import {
  loadVault,
  saveVault,
  setSharedSecret,
  findReferencingProjects,
  commitAndPushVault,
  nowIso,
} from '../lib/vault.js';

export async function rotateSecretHandler({ key, new_value, sync_github = false }) {
  try {
    const vault = loadVault();
    if (!vault.shared || !(key in vault.shared)) {
      throw new Error(`Shared secret not found: ${key}`);
    }
    const refs = findReferencingProjects(vault, key);
    const modifiedAt = nowIso();
    setSharedSecret(vault, key, new_value, modifiedAt);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: rotate shared.${key}`);

    let syncSummary = '';
    if (sync_github) {
      // sync_github needs a per-project repo slug + push, so we
      // expose that as a separate tool. The caller iterates.
      syncSummary =
        ' Call sync_github for each affected project to push the new value to GitHub Actions.';
    }

    return {
      content: [
        {
          type: 'text',
          text:
            `Rotated shared.${key}.` +
            (r.pushed ? ' Vault pushed.' : ' Vault commit local only.') +
            ` ${refs.length} reference(s) affected:\n` +
            refs.map((rf) => `  - ${rf.project}.${rf.key}`).join('\n') +
            syncSummary,
        },
      ],
      structuredContent: {
        key,
        references: refs,
        pushed: r.pushed,
        modified_at: modifiedAt,
      },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
