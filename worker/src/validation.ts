/**
 * Validation regexes mirroring envpact-mcp/src/tools/index.js so
 * the Worker rejects the same inputs the local stdio MCP rejects.
 *
 * v3: ENVIRONMENT_REGEX is gone — environments are not part of the
 * v3 schema.
 */
export const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafeKey(name: string, kind = 'key'): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`Invalid ${kind}: must be a non-empty string`);
  }
  if (RESERVED.has(name)) {
    throw new Error(`Invalid ${kind}: reserved name "${name}"`);
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid ${kind}: must not contain path separators`);
  }
  if (name === '.' || name === '..' || name.split('.').some((s) => s === '..')) {
    throw new Error(`Invalid ${kind}: must not contain ".." segments`);
  }
}
