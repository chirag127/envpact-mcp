import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Redirect envpact's HOME-derived paths to a temp directory BEFORE
// importing anything that pulls config.js. Node's --test runner
// imports test files top-to-bottom, so this assignment lands first.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'envpact-mcp-test-'));
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const { generateEnvHandler } = await import('../src/tools/generate-env.js');
const { SECRETS_DIR, SECRETS_FILE } = await import('../src/lib/config.js');

assert.ok(
  SECRETS_FILE.startsWith(TEST_HOME),
  `Test isolation broken — SECRETS_FILE=${SECRETS_FILE} did not honour TEST_HOME=${TEST_HOME}`
);

const TS = '2026-06-19T10:00:00.000Z';

function entry(value) {
  return { value, _modified_at: TS };
}

function writeVault(vault) {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(vault, null, 2));
}

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(TEST_HOME, 'proj-'));
  fs.writeFileSync(path.join(dir, '.env.example'), 'OPENAI_API_KEY=\nDB_URL=\n');
  return dir;
}

test('generateEnv rejects relative output_path that escapes working_directory', async () => {
  const dir = makeProjectDir();
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { OPENAI_API_KEY: entry('sk-x'), DB_URL: entry('pg://x') } },
  });
  const res = await generateEnvHandler({
    project_name: 'my-app',
    working_directory: dir,
    output_path: '../../etc/passwd',
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must resolve inside working_directory/);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('generateEnv rejects absolute output_path outside working_directory', async () => {
  const dir = makeProjectDir();
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { OPENAI_API_KEY: entry('sk-x') } },
  });
  const escape = process.platform === 'win32' ? 'C:/Windows/Temp/evil.env' : '/tmp/evil-envpact.env';
  const res = await generateEnvHandler({
    project_name: 'my-app',
    working_directory: dir,
    output_path: escape,
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must resolve inside working_directory/);
  assert.equal(fs.existsSync(escape), false);
});

test('generateEnv refuses to write when any resolved key is encrypted', async () => {
  const dir = makeProjectDir();
  writeVault({
    version: 3,
    shared: { OPENAI_API_KEY: entry('enc:dummy-ciphertext') },
    projects: {
      'my-app': {
        OPENAI_API_KEY: entry('shared.OPENAI_API_KEY'),
        DB_URL: entry('pg://x'),
      },
    },
  });
  const res = await generateEnvHandler({
    project_name: 'my-app',
    working_directory: dir,
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /encrypted/);
  assert.match(res.content[0].text, /OPENAI_API_KEY/);
  assert.match(res.content[0].text, /envpact-cli/);
  assert.deepEqual(res.structuredContent.encrypted, ['OPENAI_API_KEY']);
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
});

test('generateEnv writes successfully when no encrypted keys are present', async () => {
  const dir = makeProjectDir();
  writeVault({
    version: 3,
    shared: {},
    projects: { 'my-app': { OPENAI_API_KEY: entry('sk-plaintext'), DB_URL: entry('pg://x') } },
  });
  const res = await generateEnvHandler({
    project_name: 'my-app',
    working_directory: dir,
    output_path: '.env',
  });
  assert.notEqual(res.isError, true);
  const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(written, /OPENAI_API_KEY=sk-plaintext/);
});

test('generateEnv auto-upgrades v2 vault on read', async () => {
  const dir = makeProjectDir();
  writeVault({
    version: 2,
    shared: {},
    projects: {
      'my-app': {
        _default_env: 'production',
        OPENAI_API_KEY: { production: 'sk-prod', development: 'sk-dev' },
        DB_URL: 'pg://x',
      },
    },
    metadata: { updated_at: TS },
  });
  const res = await generateEnvHandler({
    project_name: 'my-app',
    working_directory: dir,
  });
  assert.notEqual(res.isError, true);
  // Default → production winner.
  const written = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.match(written, /OPENAI_API_KEY=sk-prod/);
  assert.match(written, /DB_URL=pg:\/\/x/);
});
