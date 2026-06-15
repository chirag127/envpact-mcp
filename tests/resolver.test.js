import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, listProjectEnvironments, validateVault, resolveString } from '../src/lib/resolver.js';

const v = {
  version: 2,
  shared: { OPENAI_API_KEY: 'sk-x', DB_PROD: 'pg://prod' },
  projects: {
    'my-app': {
      _default_env: 'production',
      OPENAI_API_KEY: 'shared.OPENAI_API_KEY',
      PORT: '3000',
      DATABASE_URL: { development: 'pg://dev', production: 'shared.DB_PROD' },
    },
  },
};

test('resolveProject — uses _default_env when no env passed', () => {
  const r = resolveProject(v, 'my-app');
  assert.equal(r.environment, 'production');
  assert.equal(r.resolved.DATABASE_URL, 'pg://prod');
});

test('resolveProject — explicit env overrides default', () => {
  const r = resolveProject(v, 'my-app', 'development');
  assert.equal(r.resolved.DATABASE_URL, 'pg://dev');
});

test('resolveString — shared lookup', () => {
  assert.deepEqual(resolveString('shared.A', { A: 'v' }), { value: 'v', status: 'ok' });
});

test('resolveString — encrypted passthrough', () => {
  const r = resolveString('enc:abc', {});
  assert.equal(r.status, 'encrypted');
});

test('listProjectEnvironments — collects all envs', () => {
  const envs = listProjectEnvironments(v, 'my-app');
  assert.ok(envs.includes('development'));
  assert.ok(envs.includes('production'));
});

test('validateVault — rejects bad input', () => {
  assert.throws(() => validateVault({ version: 99 }));
  assert.throws(() => validateVault(null));
});
