import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Sandbox HOME so the live envpact vault is not touched.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-mcp-sync-'));
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const TS_OLD = '2026-06-19T10:00:00.000Z';
const TS_NEW = '2026-06-19T11:00:00.000Z';

const {
  getKeyStatus,
  loadLock,
  saveLock,
  setLockEntry,
  statusReport,
} = await import('../src/lib/sync.js');

function vault({ projVal = 'sk-old', projTs = TS_OLD } = {}) {
  return {
    version: 3,
    shared: {},
    projects: {
      'my-app': {
        OPENAI_API_KEY: { value: projVal, _modified_at: projTs },
      },
    },
    metadata: { updated_at: projTs },
  };
}

test('getKeyStatus — synced (everything matches)', () => {
  const v = vault();
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-old', {
    vault_modified_at: TS_OLD,
    synced_at: TS_OLD,
  });
  assert.equal(s.status, 'synced');
});

test('getKeyStatus — local_newer (user edited .env, vault unchanged)', () => {
  const v = vault();
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-edited', {
    vault_modified_at: TS_OLD,
    synced_at: TS_OLD,
  });
  assert.equal(s.status, 'local_newer');
});

test('getKeyStatus — vault_newer (vault advanced, .env unchanged)', () => {
  const v = vault({ projVal: 'sk-new', projTs: TS_NEW });
  // local still holds the value the user previously synced
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-old', {
    vault_modified_at: TS_OLD,
    synced_at: TS_OLD,
  });
  assert.equal(s.status, 'vault_newer');
});

test('getKeyStatus — both_diverged surfaces when no lock baseline', () => {
  const v = vault({ projVal: 'sk-new', projTs: TS_NEW });
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-edited', undefined);
  // Without a lock entry we can't tell whether local was previously
  // synced — treat as both_diverged so the caller has to opt in.
  assert.equal(s.status, 'both_diverged');
});

test('getKeyStatus — local_only (key missing from vault)', () => {
  const v = { version: 3, shared: {}, projects: { 'my-app': {} } };
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-x', undefined);
  assert.equal(s.status, 'local_only');
});

test('getKeyStatus — vault_only (key missing from .env)', () => {
  const v = vault();
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', undefined, undefined);
  assert.equal(s.status, 'vault_only');
});

test('getKeyStatus — never-tracked key with diverged values is both_diverged', () => {
  const v = vault();
  const s = getKeyStatus(v, 'my-app', 'OPENAI_API_KEY', 'sk-edited', undefined);
  // No lock baseline + values disagree → both_diverged so caller
  // must opt in via force.
  assert.equal(s.status, 'both_diverged');
});

test('lock load/save round-trip', () => {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'proj-'));
  let lock = loadLock(dir);
  assert.deepEqual(lock.keys, {});
  setLockEntry(lock, 'A', TS_OLD);
  saveLock(dir, lock);
  lock = loadLock(dir);
  assert.equal(lock.keys.A.vault_modified_at, TS_OLD);
  assert.ok(lock.keys.A.synced_at);
});

// ── Pull/Push integration via filesystem-mocked vault ──────────

import {
  SECRETS_DIR,
  SECRETS_FILE,
} from '../src/lib/config.js';
import { saveVault } from '../src/lib/vault.js';
import { pullKey, pushKey } from '../src/lib/sync.js';

function writeVault(v) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  // Init a git repo so commitAndPushVault doesn't blow up the test
  // — we DON'T require it to actually push, we just exercise the
  // happy-path code where status is empty.
  saveVault(v, SECRETS_FILE);
}

function makeProj(envContent) {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'proj-'));
  if (envContent !== undefined) {
    fs.writeFileSync(path.join(dir, '.env'), envContent);
  }
  return dir;
}

test('pullKey — happy path writes value and updates lock', () => {
  writeVault(vault({ projVal: 'sk-fresh', projTs: TS_NEW }));
  const dir = makeProj('OPENAI_API_KEY=sk-old\n');
  // Seed the lock so this is a clean vault_newer scenario, not
  // both_diverged.
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);
  const r = pullKey({ workingDir: dir, projectName: 'my-app', key: 'OPENAI_API_KEY' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pulled');
  const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(written, /OPENAI_API_KEY=sk-fresh/);
});

test('pullKey — refuses LOCAL_NEWER without force', () => {
  writeVault(vault({ projVal: 'sk-old', projTs: TS_OLD }));
  const dir = makeProj('OPENAI_API_KEY=sk-edited\n');
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);
  const r = pullKey({ workingDir: dir, projectName: 'my-app', key: 'OPENAI_API_KEY' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'local_newer');
  // .env must not have been overwritten.
  const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(written, /OPENAI_API_KEY=sk-edited/);
});

test('pullKey — force overrides LOCAL_NEWER', () => {
  writeVault(vault({ projVal: 'sk-old', projTs: TS_OLD }));
  const dir = makeProj('OPENAI_API_KEY=sk-edited\n');
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);
  const r = pullKey({ workingDir: dir, projectName: 'my-app', key: 'OPENAI_API_KEY', force: true });
  assert.equal(r.ok, true);
  const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(written, /OPENAI_API_KEY=sk-old/);
});

test('pullKey — KEY_NOT_IN_VAULT', () => {
  writeVault({ version: 3, shared: {}, projects: { 'my-app': {} } });
  const dir = makeProj('');
  const r = pullKey({ workingDir: dir, projectName: 'my-app', key: 'NEVER' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'key_not_in_vault');
});

test('pushKey — happy path with caller-supplied value', () => {
  writeVault({ version: 3, shared: {}, projects: { 'my-app': {} } });
  const dir = makeProj('');
  const r = pushKey({
    workingDir: dir,
    projectName: 'my-app',
    key: 'OPENAI_API_KEY',
    value: 'sk-pushed',
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pushed');
  // Vault file should now have the new entry.
  const v = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  assert.equal(v.projects['my-app'].OPENAI_API_KEY.value, 'sk-pushed');
  assert.ok(v.projects['my-app'].OPENAI_API_KEY._modified_at);
});

test('pushKey — refuses VAULT_NEWER without force', () => {
  // Vault advanced since last sync (TS_NEW > TS_OLD baseline) AND
  // the user wants to push a different value.
  writeVault(vault({ projVal: 'sk-vault', projTs: TS_NEW }));
  const dir = makeProj('OPENAI_API_KEY=sk-different\n');
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);

  const r = pushKey({
    workingDir: dir,
    projectName: 'my-app',
    key: 'OPENAI_API_KEY',
    value: 'sk-different',
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'vault_newer');
});

test('pushKey — force=true overrides VAULT_NEWER', () => {
  writeVault(vault({ projVal: 'sk-vault', projTs: TS_NEW }));
  const dir = makeProj('OPENAI_API_KEY=sk-different\n');
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);

  const r = pushKey({
    workingDir: dir,
    projectName: 'my-app',
    key: 'OPENAI_API_KEY',
    value: 'sk-different',
    force: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'pushed');
});

test('pushKey — KEY_NOT_IN_LOCAL when no value and no .env entry', () => {
  writeVault({ version: 3, shared: {}, projects: { 'my-app': {} } });
  const dir = makeProj('');
  const r = pushKey({ workingDir: dir, projectName: 'my-app', key: 'NEVER' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'key_not_in_local');
});

test('statusReport — multi-key snapshot', () => {
  writeVault(vault({ projVal: 'sk-fresh', projTs: TS_NEW }));
  const dir = makeProj('OPENAI_API_KEY=sk-old\nLOCAL=v\n');
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);
  const report = statusReport({
    workingDir: dir,
    projectName: 'my-app',
    exampleKeys: ['OPENAI_API_KEY', 'LOCAL'],
  });
  assert.equal(report.length, 2);
  const byName = Object.fromEntries(report.map((r) => [r.name, r.status]));
  assert.equal(byName.OPENAI_API_KEY, 'vault_newer');
  assert.equal(byName.LOCAL, 'local_only');
});
