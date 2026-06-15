import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SECRETS_FILE, SECRETS_DIR, SCHEMA_URL, VAULT_SCHEMA_VERSION } from './config.js';
import { validateVault } from './resolver.js';

export function loadVault(filePath = SECRETS_FILE) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `envpact vault not initialised. Run \`npx envpact-cli --init auto\` first.`
    );
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version === 1) {
    parsed.version = VAULT_SCHEMA_VERSION;
    parsed.$schema = SCHEMA_URL;
  }
  validateVault(parsed);
  return parsed;
}

export function saveVault(vault, filePath = SECRETS_FILE) {
  vault.metadata = vault.metadata || {};
  vault.metadata.updated_at = new Date().toISOString();
  vault.$schema = vault.$schema || SCHEMA_URL;
  vault.version = vault.version || VAULT_SCHEMA_VERSION;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export function ensureProjectExists(vault, projectName) {
  if (!vault.projects) vault.projects = {};
  if (!vault.projects[projectName]) vault.projects[projectName] = {};
}

export function setProjectSecret(vault, projectName, key, value, environment) {
  ensureProjectExists(vault, projectName);
  const project = vault.projects[projectName];
  if (environment) {
    if (typeof project[key] !== 'object' || project[key] === null || Array.isArray(project[key])) {
      project[key] = {};
    }
    project[key][environment] = value;
  } else {
    project[key] = value;
  }
}

export function setSharedSecret(vault, key, value) {
  if (!vault.shared) vault.shared = {};
  vault.shared[key] = value;
}

export function findReferencingProjects(vault, sharedKey) {
  const refs = [];
  const ref = `shared.${sharedKey}`;
  for (const [pname, proj] of Object.entries(vault.projects || {})) {
    for (const [k, v] of Object.entries(proj)) {
      if (k.startsWith('_')) continue;
      if (typeof v === 'string' && v === ref) refs.push({ project: pname, key: k });
      else if (v && typeof v === 'object') {
        for (const [env, ev] of Object.entries(v)) {
          if (typeof ev === 'string' && ev === ref) refs.push({ project: pname, key: k, environment: env });
        }
      }
    }
  }
  return refs;
}

export function pullVault() {
  if (!fs.existsSync(SECRETS_DIR)) return { ok: false, reason: 'not-cloned' };
  try {
    execFileSync('git', ['-C', SECRETS_DIR, 'pull', '--ff-only', '--quiet'], { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e.message) };
  }
}

export function commitAndPushVault(message) {
  try {
    const status = execFileSync('git', ['-C', SECRETS_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (!status) return { committed: false, pushed: false };
    execFileSync('git', ['-C', SECRETS_DIR, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', [
      '-C', SECRETS_DIR,
      '-c', 'user.name=envpact-mcp',
      '-c', 'user.email=envpact@local',
      'commit', '-m', message, '-s',
    ], { stdio: 'ignore' });
    execFileSync('git', ['-C', SECRETS_DIR, 'push', '--quiet'], { stdio: 'ignore' });
    return { committed: true, pushed: true };
  } catch (e) {
    return { committed: false, pushed: false, error: String(e.message) };
  }
}

export function detectProjectFromGit(cwd) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return m[2].toLowerCase();
  } catch (_e) { /* fallthrough */ }
  return path.basename(cwd).toLowerCase();
}
