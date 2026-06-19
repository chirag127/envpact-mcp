// Cross-platform test runner. pnpm scripts on Windows dispatch via
// cmd.exe which doesn't expand globs, so 'node --test tests/*.test.js'
// passes the literal path on Windows runners. This script does the
// glob in Node itself, then re-invokes node --test with each matching
// file as an explicit arg.
//
// If any matched file is a .ts/.mts/.cts, the script auto-adds
// `--import tsx` to the child invocation so TypeScript test files
// load via the tsx loader. tsx must be installed as a devDep.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.test\.[mc]?[jt]s$/.test(name)) out.push(full);
  }
  return out;
}

const tests = walk('tests');
if (tests.length === 0) {
  console.error('no test files found under tests/');
  process.exit(1);
}

const hasTypeScript = tests.some((f) => /\.[mc]?ts$/.test(f));

// Inherit any --loader / --require / --experimental-* flags the
// parent node was launched with; spawnSync(process.execPath) does
// NOT replay execArgv automatically.
const parentFlags = process.execArgv.filter((a) =>
  a.startsWith('--import')
  || a.startsWith('--loader')
  || a.startsWith('--require')
  || a.startsWith('--experimental-')
);

const args = [...parentFlags];
if (hasTypeScript && !parentFlags.some((a) => a.startsWith('--import'))) {
  args.push('--import', 'tsx');
}
args.push(...process.argv.slice(2), '--test', ...tests);

const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
