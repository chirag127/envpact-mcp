import {
  loadVault,
  saveVault,
  setSharedSecret,
  findReferencingProjects,
  commitAndPushVault,
} from '../lib/vault.js';

export async function rotateSecretHandler({ key, new_value, sync_github = false }) {
  try {
    const vault = loadVault();
    if (!vault.shared || !(key in vault.shared)) {
      throw new Error(`Shared secret not found: ${key}`);
    }
    const refs = findReferencingProjects(vault, key);
    setSharedSecret(vault, key, new_value);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: rotate shared.${key}`);

    let syncSummary = '';
    if (sync_github) {
      // Note: sync_github here would require iterating over each
      // referencing project's GitHub repo. We expose this as a
      // separate tool call (sync_github) so the caller controls
      // which projects get pushed.
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
            refs
              .map(
                (rf) =>
                  `  - ${rf.project}.${rf.key}${
                    rf.environment ? ' (' + rf.environment + ')' : ''
                  }`
              )
              .join('\n') +
            syncSummary,
        },
      ],
      structuredContent: { key, references: refs, pushed: r.pushed },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
