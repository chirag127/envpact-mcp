import { loadVault, pullVault } from '../lib/vault.js';
import { listProjectEnvironments } from '../lib/resolver.js';

export async function listEnvironmentsHandler({ project_name }) {
  try {
    pullVault();
    const vault = loadVault();
    const envs = listProjectEnvironments(vault, project_name);
    return {
      content: [
        {
          type: 'text',
          text: envs.length
            ? `Environments for ${project_name}: ${envs.join(', ')}`
            : `(no environments configured for ${project_name})`,
        },
      ],
      structuredContent: { project: project_name, environments: envs },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
