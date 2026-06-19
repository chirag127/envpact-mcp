import { loadVault, saveVault, setSharedSecret, commitAndPushVault, nowIso } from '../lib/vault.js';

export async function addSharedSecretHandler({ key, value }) {
  try {
    const vault = loadVault();
    const modifiedAt = nowIso();
    setSharedSecret(vault, key, value, modifiedAt);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: set shared.${key}`);
    return {
      content: [
        {
          type: 'text',
          text: `Set shared.${key}` + (r.pushed ? ' — pushed.' : ' — committed locally.'),
        },
      ],
      structuredContent: { key, modified_at: modifiedAt, pushed: r.pushed, ok: true },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
