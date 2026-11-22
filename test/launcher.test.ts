import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { launchCopilot, launchVsCode } from '../src/interfaces/cli/setup.js';
import { isolatedEnvironment } from './helpers/stdio.js';

it('launches a client without injecting connection variables or secrets in arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-launch-test-'));
  const executable = join(root, 'fake-code');
  const output = join(root, 'result.json');
  const workspace = fileURLToPath(new URL('../', import.meta.url));
  const secret = randomBytes(24).toString('base64url');
  const program = `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const workspace = process.env.MONGODB_MCP_ROOT;
const server = spawn(process.execPath, ['dist/main.js'], { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let count = 0;
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n');
    if (end < 0) break;
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const response = JSON.parse(line);
    if (response.id === 1) {
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
      server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\\n');
    }
    if (response.id === 2) {
      count = response.result.tools.length;
      server.stdin.end();
    }
  }
});
server.on('close', code => {
  const args = process.argv.slice(2).join(' ');
  const result = { count, code, isolatedProfile: args.includes('--user-data-dir'), secretInArguments: args.includes(process.env.MONGODB_PASSWORD) || args.includes(process.env.MONGODB_URI), connectionInEnvironment: ['MONGODB_URI', 'MONGODB_PASSWORD', 'MONGODB_AUTH_MODE'].some(name => process.env[name] !== undefined) };
  fs.writeFileSync(process.env.LAUNCH_TEST_OUTPUT, JSON.stringify(result));
});
server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'launcher-test', version: '1' }
} }) + '\\n');
`;
  try {
    await writeFile(executable, program, { mode: 0o700 });
    const env = isolatedEnvironment({
      MONGODB_AUTH_MODE: 'scram',
      MONGODB_URI: 'mongodb://127.0.0.1:1/',
      MONGODB_USERNAME: 'readonly-user',
      MONGODB_PASSWORD: secret,
      MONGODB_AUTH_SOURCE: 'shop',
      MONGODB_ALLOWED_DATABASES: 'shop',
      MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
      MONGODB_ALLOWED_FIELDS: '',
      MONGODB_QUERY_TIMEOUT_MS: '',
      LAUNCH_TEST_OUTPUT: output,
    });
    await launchVsCode(env, workspace, executable);
    let content: string | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        content = await readFile(output, 'utf8');
        break;
      } catch {
        await delay(100);
      }
    }
    assert.ok(content !== undefined);
    const result: unknown = JSON.parse(content);
    assert.deepEqual(result, { count: 6, code: 0, isolatedProfile: false, secretInArguments: false, connectionInEnvironment: false });

    await unlink(output);
    await launchCopilot(env, workspace, executable);
    const cliResult: unknown = JSON.parse(await readFile(output, 'utf8'));
    assert.deepEqual(cliResult, { count: 6, code: 0, isolatedProfile: false, secretInArguments: false, connectionInEnvironment: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
