import { loadVault, saveVault, setProjectSecret, commitAndPushVault, nowIso } from '../lib/vault.js';

export async function addSecretHandler({ project_name, key, value }) {
  try {
    const vault = loadVault();
    const modifiedAt = nowIso();
    setProjectSecret(vault, project_name, key, value, modifiedAt);
    saveVault(vault);
    const r = commitAndPushVault(`envpact-mcp: set ${project_name}.${key}`);
    return {
      content: [
        {
          type: 'text',
          text:
            `Set ${project_name}.${key}` +
            (r.pushed ? ' — pushed to vault.' : ' — committed locally; push failed or no changes.'),
        },
      ],
      structuredContent: {
        project: project_name,
        key,
        modified_at: modifiedAt,
        pushed: r.pushed,
        ok: true,
      },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
