import { loadVault, saveVault, setSharedSecret, commitAndPushVault } from '../lib/vault.js';

export async function addSharedSecretHandler({ key, value }) {
  try {
    const vault = loadVault();
    setSharedSecret(vault, key, value);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: set shared.${key}`);
    return {
      content: [
        {
          type: 'text',
          text: `Set shared.${key}` + (r.pushed ? ' — pushed.' : ' — committed locally.'),
        },
      ],
      structuredContent: { key, pushed: r.pushed },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
