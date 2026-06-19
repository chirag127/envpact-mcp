import { loadVault, pullVault } from '../lib/vault.js';

export async function listProjectsHandler() {
  try {
    pullVault();
    const vault = loadVault();
    const projects = Object.keys(vault.projects || {}).sort();
    const summary = projects.map((p) => {
      const keyCount = Object.keys(vault.projects[p]).filter((k) => !k.startsWith('_')).length;
      return { name: p, key_count: keyCount };
    });
    return {
      content: [
        {
          type: 'text',
          text: projects.length
            ? `${projects.length} project(s):\n` +
              summary.map((s) => `  ${s.name}  (${s.key_count} keys)`).join('\n')
            : '(no projects yet)',
        },
      ],
      structuredContent: { projects: summary },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
