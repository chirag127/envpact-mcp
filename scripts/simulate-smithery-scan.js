// Simulate Smithery's bundle scan. Extracts the .mcpb, parses the manifest,
// spawns the server EXACTLY as the manifest specifies, sends MCP
// initialize + tools/list, prints what comes back.
//
// Usage: node scripts/simulate-smithery-scan.js [path-to-extracted-bundle]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TMP = process.argv[2] || process.argv.slice(2).find((a) => fs.existsSync(a));
if (!TMP || !fs.existsSync(TMP)) {
  console.error('error: pass an extracted-bundle directory as argv[2]');
  process.exit(1);
}

const m = JSON.parse(fs.readFileSync(path.join(TMP, 'manifest.json'), 'utf8'));
const dir = TMP.replaceAll('\\', '/');

const args = m.server.mcp_config.args.map((a) => a.replaceAll('${__dirname}', dir));
const env = {};
for (const [k, v] of Object.entries(m.server.mcp_config.env || {})) {
  let val = v;
  for (const [uk, uv] of Object.entries(m.user_config || {})) {
    val = val.replaceAll('${user_config.' + uk + '}', uv.default || '');
  }
  val = val.replaceAll('${HOME}', process.env.HOME || process.env.USERPROFILE || '');
  env[k] = val;
}

console.log('command:', m.server.mcp_config.command, args.join(' '));
console.log('env:', JSON.stringify(env));
console.log('');

const child = spawn(m.server.mcp_config.command, args, {
  env: { ...process.env, ...env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smithery-sim', version: '0.0.1' } } };
const inited = { jsonrpc: '2.0', method: 'notifications/initialized' };
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

setTimeout(() => send(init), 100);
setTimeout(() => send(inited), 500);
setTimeout(() => send(list), 800);

setTimeout(() => {
  child.kill();
  console.log('=== STDERR ===');
  console.log(stderr || '(empty)');
  console.log('=== STDOUT (first 2 KB) ===');
  console.log(stdout.slice(0, 2000));
  console.log('');
  console.log('=== parsed ===');
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.id === 1) console.log('  initialize OK:', JSON.stringify(r.result?.serverInfo) || JSON.stringify(r.error));
      if (r.id === 2) {
        if (r.result?.tools) console.log('  tools/list: ' + r.result.tools.length + ' tools — ' + r.result.tools.map((t) => t.name).join(', '));
        else console.log('  tools/list FAIL:', JSON.stringify(r.error));
      }
    } catch (_) { /* not json */ }
  }
}, 2500);
