import { loadVault, pullVault } from '../lib/vault.js';
import { listProjectEnvironments } from '../lib/resolver.js';

export async function listProjectsHandler() {
  try {
    pullVault();
    const vault = loadVault();
    const projects = Object.keys(vault.projects || {}).sort();
    const summary = projects.map((p) => {
      const envs = listProjectEnvironments(vault, p);
      const keyCount = Object.keys(vault.projects[p]).filter((k) => !k.startsWith('_')).length;
      return { name: p, key_count: keyCount, environments: envs };
    });
    return {
      content: [
        {
          type: 'text',
          text: projects.length
            ? `${projects.length} project(s):\n` +
              summary
                .map((s) => `  ${s.name}  (${s.key_count} keys, envs: ${s.environments.join('/') || 'none'})`)
                .join('\n')
            : '(no projects yet)',
        },
      ],
      structuredContent: { projects: summary },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
