import { loadVault, saveVault, setProjectSecret, commitAndPushVault } from '../lib/vault.js';

export async function addSecretHandler({ project_name, key, value, environment }) {
  try {
    const vault = loadVault();
    setProjectSecret(vault, project_name, key, value, environment);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: set ${project_name}.${key}`);
    return {
      content: [
        {
          type: 'text',
          text:
            `Set ${project_name}.${key}${environment ? ' (' + environment + ')' : ''}` +
            (r.pushed ? ' — pushed to vault.' : ' — committed locally; push failed or no changes.'),
        },
      ],
      structuredContent: { project: project_name, key, environment, pushed: r.pushed },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
