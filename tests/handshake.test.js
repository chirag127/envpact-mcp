import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'src', 'index.js');

function rpcCall(server, message) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const newline = buf.indexOf('\n');
      if (newline >= 0) {
        const line = buf.slice(0, newline);
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === message.id) {
            server.stdout.off('data', onData);
            resolve(parsed);
          }
        } catch (_e) { /* keep buffering */ }
      }
    };
    server.stdout.on('data', onData);
    server.stdin.write(JSON.stringify(message) + '\n');
    setTimeout(() => reject(new Error('rpc timeout')), 4000);
  });
}

test('MCP server: initialize + tools/list returns all 8 tools', async () => {
  const server = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENVPACT_TEST: '1' },
  });
  try {
    const init = await rpcCall(server, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      },
    });
    assert.equal(init.result.serverInfo.name, 'envpact');

    server.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    );

    const list = await rpcCall(server, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'add_secret',
      'add_shared_secret',
      'generate_env',
      'list_environments',
      'list_projects',
      'list_shared',
      'rotate_secret',
      'sync_github',
    ]);
  } finally {
    server.kill();
  }
});
