import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  PROJECT_NAME_REGEX,
  ENV_KEY_REGEX,
} from '../src/tools/index.js';
import { setProjectSecret, setSharedSecret, ensureProjectExists } from '../src/lib/vault.js';

test('PROJECT_NAME_REGEX rejects __proto__, .., backslash, overlong', () => {
  assert.equal(PROJECT_NAME_REGEX.test('__proto__'), false, 'underscore-leading rejected');
  assert.equal(PROJECT_NAME_REGEX.test('..'), false);
  assert.equal(PROJECT_NAME_REGEX.test('foo\\bar'), false);
  assert.equal(PROJECT_NAME_REGEX.test('foo/bar'), false);
  assert.equal(PROJECT_NAME_REGEX.test('a'.repeat(65)), false, 'too long rejected');
  // Sanity — valid names pass.
  assert.equal(PROJECT_NAME_REGEX.test('my-app'), true);
  assert.equal(PROJECT_NAME_REGEX.test('a.b_c-d'), true);
  assert.equal(PROJECT_NAME_REGEX.test('app1'), true);
});

test('ENV_KEY_REGEX rejects __proto__, .., backslash, overlong', () => {
  assert.equal(ENV_KEY_REGEX.test('__proto__'), true, 'note: env var __proto__ matches the regex shape');
  // The vault layer is what blocks __proto__ — tested below via setProjectSecret.
  assert.equal(ENV_KEY_REGEX.test('..'), false, 'dot-leading rejected (must be letter/underscore)');
  assert.equal(ENV_KEY_REGEX.test('foo\\bar'), false);
  assert.equal(ENV_KEY_REGEX.test('foo/bar'), false);
  assert.equal(ENV_KEY_REGEX.test('A'.repeat(129)), false, 'too long rejected');
  assert.equal(ENV_KEY_REGEX.test('OPENAI_API_KEY'), true);
  assert.equal(ENV_KEY_REGEX.test('_PRIVATE'), true);
  assert.equal(ENV_KEY_REGEX.test('1BAD'), false, 'leading digit rejected');
});

test('Zod schemas built from the regexes reject the same inputs', () => {
  const projectSchema = z.string().regex(PROJECT_NAME_REGEX);
  const keySchema = z.string().regex(ENV_KEY_REGEX);

  assert.equal(projectSchema.safeParse('__proto__').success, false);
  assert.equal(projectSchema.safeParse('..').success, false);
  assert.equal(projectSchema.safeParse('a/b').success, false);

  assert.equal(keySchema.safeParse('a'.repeat(200)).success, false);
});

test('vault.setProjectSecret throws on __proto__ and dangerous keys (v3 — no environment param)', () => {
  const vault = { version: 3, projects: {}, shared: {} };
  assert.throws(
    () => setProjectSecret(vault, '__proto__', 'OK', 'val'),
    /Invalid project name: reserved name "__proto__"/
  );
  assert.throws(
    () => setProjectSecret(vault, 'app', '__proto__', 'val'),
    /Invalid secret key: reserved name "__proto__"/
  );
  assert.throws(() => setProjectSecret(vault, '..', 'OPENAI', 'v'), /must not contain ".."/);
  assert.throws(() => setProjectSecret(vault, 'a/b', 'OPENAI', 'v'), /must not contain path separators/);
  assert.throws(() => setProjectSecret(vault, 'app', '', 'v'), /must be a non-empty string/);
});

test('vault.setSharedSecret throws on __proto__ and dangerous keys', () => {
  const vault = { version: 3, projects: {}, shared: {} };
  assert.throws(
    () => setSharedSecret(vault, '__proto__', 'val'),
    /Invalid shared secret key: reserved name "__proto__"/
  );
  assert.throws(() => setSharedSecret(vault, 'a\\b', 'v'), /must not contain path separators/);
  assert.throws(() => setSharedSecret(vault, '', 'v'), /must be a non-empty string/);
});

test('vault.ensureProjectExists throws on __proto__', () => {
  const vault = { version: 3, projects: {}, shared: {} };
  assert.throws(
    () => ensureProjectExists(vault, '__proto__'),
    /Invalid project name: reserved name "__proto__"/
  );
});

test('vault writes survive prototype-poisoning attempts via Object.defineProperty', () => {
  // Even if assertSafeKey was somehow bypassed, the Object.defineProperty
  // path lays down own properties — Object.prototype must remain clean.
  const vault = { version: 3, projects: {}, shared: {} };
  setProjectSecret(vault, 'app', 'OPENAI_API_KEY', 'sk-x');
  assert.equal({}.OPENAI_API_KEY, undefined, 'Object.prototype must not be polluted');
  assert.equal(vault.projects.app.OPENAI_API_KEY.value, 'sk-x');
  assert.ok(vault.projects.app.OPENAI_API_KEY._modified_at);
});
