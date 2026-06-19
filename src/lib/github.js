import { execFileSync, spawnSync } from 'node:child_process';

export function ghAuthOk() {
  const r = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  return r.status === 0;
}

export function setSecret(repoSlug, key, value) {
  if (!ghAuthOk()) throw new Error('gh CLI not authenticated. Run: gh auth login');
  const args = ['secret', 'set', key, '--body', value];
  if (repoSlug) args.push('--repo', repoSlug);
  execFileSync('gh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export function syncResolved(repoSlug, resolved) {
  let count = 0;
  const errors = [];
  for (const [key, value] of Object.entries(resolved)) {
    try {
      setSecret(repoSlug, key, value);
      count++;
    } catch (e) {
      errors.push({ key, error: String(e.message) });
    }
  }
  return { count, errors };
}
