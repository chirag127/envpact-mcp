import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-mcp-tools-'));
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const { pullSecretHandler } = await import('../src/tools/pull-secret.js');
const { pushSecretHandler } = await import('../src/tools/push-secret.js');
const { syncStatusHandler } = await import('../src/tools/sync-status.js');
const { SECRETS_DIR, SECRETS_FILE } = await import('../src/lib/config.js');
const { saveVault } = await import('../src/lib/vault.js');
const { loadLock, setLockEntry, saveLock } = await import('../src/lib/sync.js');

const TS_OLD = '2026-06-19T10:00:00.000Z';
const TS_NEW = '2026-06-19T11:00:00.000Z';

function writeVault(v) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  saveVault(v, SECRETS_FILE);
}

function makeProj({ env, example } = {}) {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'p-'));
  if (env !== undefined) fs.writeFileSync(path.join(dir, '.env'), env);
  if (example !== undefined) fs.writeFileSync(path.join(dir, '.env.example'), example);
  return dir;
}

test('pull_secret — happy path returns status only, no value', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { OPENAI_API_KEY: { value: 'sk-fresh', _modified_at: TS_NEW } } },
    metadata: { updated_at: TS_NEW },
  });
  const dir = makeProj({ env: 'OPENAI_API_KEY=sk-old\n' });
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);

  const res = await pullSecretHandler({
    project_name: 'my-app',
    key: 'OPENAI_API_KEY',
    working_directory: dir,
  });
  assert.notEqual(res.isError, true);
  // No value exposure. Only mask + status + ts.
  const sc = res.structuredContent;
  assert.equal(sc.key, 'OPENAI_API_KEY');
  assert.equal(sc.status, 'pulled');
  assert.equal(sc.pulled_value_masked, '****');
  assert.ok(sc.modified_at);
  assert.equal(JSON.stringify(res).includes('sk-fresh'), false, 'no plaintext value in response');
});

test('pull_secret — refuses LOCAL_NEWER without force, surfaces conflict', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { K: { value: 'old', _modified_at: TS_OLD } } },
    metadata: { updated_at: TS_OLD },
  });
  const dir = makeProj({ env: 'K=user-edit\n' });
  const lock = loadLock(dir);
  setLockEntry(lock, 'K', TS_OLD);
  saveLock(dir, lock);

  const res = await pullSecretHandler({
    project_name: 'my-app',
    key: 'K',
    working_directory: dir,
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.status, 'local_newer');
  assert.match(res.content[0].text, /force=true/);
  // No values leaked.
  assert.equal(JSON.stringify(res).includes('user-edit'), false);
});

test('pull_secret — force=true overrides the refusal', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { K: { value: 'old', _modified_at: TS_OLD } } },
    metadata: { updated_at: TS_OLD },
  });
  const dir = makeProj({ env: 'K=user-edit\n' });
  const lock = loadLock(dir);
  setLockEntry(lock, 'K', TS_OLD);
  saveLock(dir, lock);

  const res = await pullSecretHandler({
    project_name: 'my-app',
    key: 'K',
    working_directory: dir,
    force: true,
  });
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.status, 'pulled');
});

test('push_secret — happy path with explicit value', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': {} },
    metadata: { updated_at: TS_OLD },
  });
  const dir = makeProj({ env: '' });
  const res = await pushSecretHandler({
    project_name: 'my-app',
    key: 'NEW_KEY',
    value: 'sk-pushed',
    working_directory: dir,
  });
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent.status, 'pushed');
  // Verify vault was actually updated.
  const v = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  assert.equal(v.projects['my-app'].NEW_KEY.value, 'sk-pushed');
  // Make sure the response did not echo the plaintext.
  assert.equal(JSON.stringify(res.structuredContent).includes('sk-pushed'), false);
});

test('push_secret — KEY_NOT_IN_LOCAL when no value provided and no .env entry', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': {} },
    metadata: { updated_at: TS_OLD },
  });
  const dir = makeProj({ env: '' });
  const res = await pushSecretHandler({
    project_name: 'my-app',
    key: 'MISSING',
    working_directory: dir,
  });
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.status, 'key_not_in_local');
});

test('sync_status — returns per-key statuses, no values', async () => {
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { OPENAI_API_KEY: { value: 'sk-secret', _modified_at: TS_OLD } } },
    metadata: { updated_at: TS_OLD },
  });
  const dir = makeProj({
    env: 'OPENAI_API_KEY=sk-secret\nLOCAL_ONLY=local\n',
    example: 'OPENAI_API_KEY=\nLOCAL_ONLY=\n',
  });
  const lock = loadLock(dir);
  setLockEntry(lock, 'OPENAI_API_KEY', TS_OLD);
  saveLock(dir, lock);

  const res = await syncStatusHandler({
    project_name: 'my-app',
    working_directory: dir,
  });
  assert.notEqual(res.isError, true);
  const keys = res.structuredContent.keys;
  const byName = Object.fromEntries(keys.map((k) => [k.name, k.status]));
  assert.equal(byName.OPENAI_API_KEY, 'synced');
  assert.equal(byName.LOCAL_ONLY, 'local_only');
  // No values exposed.
  assert.equal(JSON.stringify(res).includes('sk-secret'), false);
  assert.equal(JSON.stringify(res).includes('local'), true /* status name "local_only" allowed */);
  // But the literal local-only value 'local' for the key should not appear distinct from status text.
  // Strict check: the LOCAL_ONLY entry should not carry a `value` field.
  for (const k of keys) {
    assert.equal('value' in k, false, `key ${k.name} leaked a value field`);
  }
});
