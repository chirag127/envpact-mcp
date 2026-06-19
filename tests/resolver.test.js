import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProject,
  validateVault,
  resolveString,
  entryValue,
  entryModifiedAt,
} from '../src/lib/resolver.js';
import { upgradeVault } from '../src/lib/vault.js';

const TS = '2026-06-19T10:00:00.000Z';

const v3 = {
  version: 3,
  shared: {
    OPENAI_API_KEY: { value: 'sk-x', _modified_at: TS },
    DB_PROD: { value: 'pg://prod', _modified_at: TS },
    BAD: { value: 'shared.OPENAI_API_KEY', _modified_at: TS }, // chained → invalid
    NESTED: { value: 'enc:abc', _modified_at: TS },
  },
  projects: {
    'my-app': {
      OPENAI_API_KEY: { value: 'shared.OPENAI_API_KEY', _modified_at: TS },
      PORT: { value: '3000', _modified_at: TS },
      DATABASE_URL: { value: 'shared.DB_PROD', _modified_at: TS },
      ENC_KEY: { value: 'enc:ciphertext', _modified_at: TS },
      MISSING_SHARED: { value: 'shared.NOT_THERE', _modified_at: TS },
      CHAINED: { value: 'shared.BAD', _modified_at: TS },
      ALIAS_TO_ENC: { value: 'shared.NESTED', _modified_at: TS },
      MALFORMED_STRING: 'just-a-string', // bad shape — not an entry object
      MALFORMED_NULL: null,
    },
  },
};

test('resolveProject — happy paths', () => {
  const r = resolveProject(v3, 'my-app');
  assert.equal(r.missing, false);
  assert.equal(r.resolved.OPENAI_API_KEY, 'sk-x');
  assert.equal(r.resolved.PORT, '3000');
  assert.equal(r.resolved.DATABASE_URL, 'pg://prod');
});

test('resolveProject — encrypted entries are passed through with status', () => {
  const r = resolveProject(v3, 'my-app');
  assert.ok(r.encrypted.includes('ENC_KEY'));
  assert.ok(r.encrypted.includes('ALIAS_TO_ENC'));
  assert.equal(r.resolved.ENC_KEY, 'enc:ciphertext');
});

test('resolveProject — unresolved shared.* and chained shared.shared.* are flagged', () => {
  const r = resolveProject(v3, 'my-app');
  assert.ok(r.unresolved.includes('MISSING_SHARED'));
  assert.ok(r.invalid.includes('CHAINED'));
});

test('resolveProject — non-entry-object values are invalid', () => {
  const r = resolveProject(v3, 'my-app');
  assert.ok(r.invalid.includes('MALFORMED_STRING'));
  assert.ok(r.invalid.includes('MALFORMED_NULL'));
});

test('resolveProject — missing project returns missing=true', () => {
  const r = resolveProject(v3, 'nope');
  assert.equal(r.missing, true);
  assert.deepEqual(r.resolved, {});
});

test('validateVault — rejects non-v3', () => {
  assert.throws(() => validateVault({ version: 99 }));
  assert.throws(() => validateVault({ version: 2 }));
  assert.throws(() => validateVault(null));
});

test('resolveString — direct passthrough and shared lookup', () => {
  assert.deepEqual(
    resolveString('plain', { K: { value: 'sv', _modified_at: TS } }),
    { value: 'plain', status: 'ok' }
  );
  assert.deepEqual(
    resolveString('shared.K', { K: { value: 'sv', _modified_at: TS } }),
    { value: 'sv', status: 'ok' }
  );
});

test('resolveString — encrypted passthrough', () => {
  const r = resolveString('enc:abc', {});
  assert.equal(r.status, 'encrypted');
});

test('entryValue / entryModifiedAt extractors', () => {
  assert.equal(entryValue({ value: 'v', _modified_at: TS }), 'v');
  assert.equal(entryModifiedAt({ value: 'v', _modified_at: TS }), TS);
  assert.equal(entryValue('not-an-entry'), null);
  assert.equal(entryModifiedAt(null), null);
});

// ── v1/v2 → v3 auto-upgrade ────────────────────────────────────

test('upgradeVault — v1 flat → v3', () => {
  const v1 = {
    version: 1,
    shared: { K: 'shared-v' },
    projects: { app: { OPENAI: 'sk-x' } },
    metadata: { updated_at: TS },
  };
  const u = upgradeVault(v1);
  assert.equal(u.version, 3);
  assert.equal(u.shared.K.value, 'shared-v');
  assert.equal(u.shared.K._modified_at, TS);
  assert.equal(u.projects.app.OPENAI.value, 'sk-x');
});

test('upgradeVault — v2 per-env objects → flattened v3', () => {
  const v2 = {
    version: 2,
    shared: { K: 'shared-v' },
    projects: {
      app: {
        _default_env: 'production',
        URL: { development: 'pg://dev', production: 'pg://prod' },
        FLAT: 'flat-val',
        ONLY_PROD: { production: 'p' },
        EMPTY: { development: '' },
      },
    },
    metadata: { updated_at: TS },
  };
  const u = upgradeVault(v2);
  assert.equal(u.version, 3);
  // 'default' is preferred; otherwise 'production' wins.
  assert.equal(u.projects.app.URL.value, 'pg://prod');
  assert.equal(u.projects.app.FLAT.value, 'flat-val');
  assert.equal(u.projects.app.ONLY_PROD.value, 'p');
  // _default_env and other underscore keys are dropped.
  assert.equal('_default_env' in u.projects.app, false);
});

test('upgradeVault — already v3 is a no-op', () => {
  assert.equal(upgradeVault(v3).version, 3);
});

test('upgradeVault — unknown version throws', () => {
  assert.throws(() => upgradeVault({ version: 99 }));
});
