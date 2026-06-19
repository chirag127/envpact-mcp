import { execFileSync } from 'node:child_process';
import { loadVault, pullVault, detectProjectFromGit } from '../lib/vault.js';
import { resolveProject } from '../lib/resolver.js';
import { syncResolved } from '../lib/github.js';

function detectRepoSlug(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
    }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch (_e) { /* none */ }
  return null;
}

export async function syncGithubHandler({ project_name, repo_slug }) {
  try {
    const cwd = process.cwd();
    const project = (project_name || detectProjectFromGit(cwd)).toLowerCase();
    const slug = repo_slug || detectRepoSlug(cwd);
    if (!slug) {
      throw new Error(
        'Could not auto-detect repo slug. Pass repo_slug explicitly or run from inside a git repo.'
      );
    }
    pullVault();
    const vault = loadVault();
    const result = resolveProject(vault, project);
    if (Object.keys(result.resolved).length === 0) {
      throw new Error(`No resolved secrets for project ${project}.`);
    }
    const { count, errors } = syncResolved(slug, result.resolved);
    return {
      content: [
        {
          type: 'text',
          text:
            `Synced ${count}/${Object.keys(result.resolved).length} secrets to ${slug}` +
            (errors.length ? `\nErrors: ${errors.map((e) => e.key).join(', ')}` : ''),
        },
      ],
      structuredContent: { repo_slug: slug, project, count, errors },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
