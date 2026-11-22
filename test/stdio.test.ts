import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Environment } from '../src/infrastructure/configuration.js';
import { saveEnvironment } from '../src/infrastructure/configuration-store.js';
import { record, StdioSession } from './helpers/stdio.js';

const secret = randomBytes(24).toString('base64url');
const environment: Environment = {
  MONGODB_AUTH_MODE: 'scram',
  MONGODB_URI: 'mongodb://127.0.0.1:1/?directConnection=true',
  MONGODB_USERNAME: 'readonly-user',
  MONGODB_PASSWORD: secret,
  MONGODB_AUTH_SOURCE: 'shop',
  MONGODB_ALLOWED_DATABASES: 'shop',
  MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
  MONGODB_ALLOWED_FIELDS: '',
  MONGODB_QUERY_TIMEOUT_MS: '',
};

async function call(session: StdioSession, name: string, args: unknown): Promise<Record<string, unknown>> {
  const response = await session.request('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined);
  return record(response.result);
}

describe('MCP stdio protocol', () => {
  it('advertises exactly six read-only tools and rejects invalid requests without database access', async () => {
    const session = new StdioSession(environment);
    try {
      const serverInfo = record(record(await session.initialize()).serverInfo);
      assert.equal(serverInfo.title, 'MongoDB Read-Only MCP');
      assert.ok(Array.isArray(serverInfo.icons));
      const icons = serverInfo.icons.map(record);
      assert.deepEqual(icons.map((icon) => icon.sizes), [['64x64'], ['128x128']]);
      for (const icon of icons) {
        // O VS Code só exibe ícones de servidores stdio em data:/file: com PNG, JPEG, WEBP ou GIF.
        assert.equal(icon.mimeType, 'image/png');
        assert.match(String(icon.src), /^data:image\/png;base64,iVBORw0KGgo/u);
      }
      const response = await session.request('tools/list');
      const result = record(response.result);
      assert.ok(Array.isArray(result.tools));
      const tools = result.tools.map(record);
      for (const tool of tools) {
        assert.ok(Array.isArray(tool.icons));
        assert.deepEqual(tool.icons.map(record).map((icon) => icon.sizes), [['64x64']]);
      }
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        'countDocuments', 'distinct', 'find', 'findOne', 'listCollections', 'listDatabases',
      ]);
      for (const tool of tools) {
        const annotations = record(tool.annotations);
        assert.equal(annotations.readOnlyHint, true);
        assert.equal(annotations.destructiveHint, false);
        assert.equal(record(tool.inputSchema).additionalProperties, false);
      }
      assert.equal((await call(session, 'listDatabases', { unexpected: true })).isError, true);
      assert.equal((await call(session, 'listDatabases', JSON.parse('{"__proto__":1}'))).isError, true);
      assert.equal((await call(session, 'insertOne', {})).isError, true);
      assert.equal((await call(session, 'find', {
        database: 'shop', collection: 'orders', filter: {}, limit: 101,
      })).isError, true);
      assert.equal((await call(session, 'find', {
        database: 'shop', collection: 'orders', filter: { $where: 'return true' },
      })).isError, true);
      assert.equal((await call(session, 'find', {
        database: 'shop', collection: 'orders', filter: JSON.parse('{"__proto__":{"$eq":"x"}}'),
      })).isError, true);
      assert.equal((await call(session, 'find', {
        database: 'shop', collection: 'private', filter: {},
      })).isError, true);
      assert.equal(session.invalidStdoutLines, 0);
      assert.ok(session.stdoutLines >= 8);
      assert.ok(!session.stderr.includes(secret));
    } finally {
      assert.equal(await session.close(), 0);
    }
  });

  it('keeps MCP available for missing configuration and reports it through tools', async () => {
    const missing = new StdioSession({
      MONGODB_AUTH_MODE: undefined,
      MONGODB_URI: undefined,
      MONGODB_USERNAME: undefined,
      MONGODB_PASSWORD: undefined,
      MONGODB_ALLOWED_DATABASES: undefined,
      MONGODB_ALLOWED_COLLECTIONS: undefined,
      MONGODB_OIDC_ISSUER: undefined,
      MONGODB_OIDC_CLIENT_ID: undefined,
      MONGODB_OIDC_MONGO_HOSTS: undefined,
      MONGODB_OIDC_PROVIDER_HOSTS: undefined,
    });
    try {
      await missing.initialize();
      const response = await missing.request('tools/call', { name: 'listDatabases', arguments: {} });
      const result = record(response.result);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /MONGODB_URI/u);
      assert.match(JSON.stringify(result), /mongodb-readonly-mcp-configure \(instalação global\) ou npm run configure/u);
      assert.match(JSON.stringify(result), /Não envie URI, usuário ou senha pelo chat/u);
      assert.equal(missing.invalidStdoutLines, 0);
    } finally {
      assert.equal(await missing.close(), 0);
    }

    const uri = `mongodb://reader:${encodeURIComponent(secret)}@127.0.0.1/?notARealOption=1`;
    const invalid = new StdioSession({
      ...environment,
      MONGODB_AUTH_MODE: 'uri',
      MONGODB_URI: uri,
      MONGODB_USERNAME: undefined,
      MONGODB_PASSWORD: undefined,
      MONGODB_AUTH_SOURCE: undefined,
    });
    try {
      await invalid.initialize();
      const response = await invalid.request('tools/call', { name: 'listDatabases', arguments: {} });
      const text = JSON.stringify(response.result);
      assert.equal(record(response.result).isError, true);
      assert.match(text, /precedência sobre o arquivo salvo: MONGODB_URI, MONGODB_AUTH_MODE/u);
      assert.ok(!text.includes(secret));
      assert.ok(!text.includes(uri));
      assert.equal(invalid.invalidStdoutLines, 0);
    } finally {
      assert.equal(await invalid.close(), 0);
    }
    assert.ok(!invalid.stderr.includes(secret));
    assert.ok(!invalid.stderr.includes(uri));
  });

  it('recovers in the same MCP process when private configuration is corrected after startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-reconfigure-'));
    const path = join(root, 'config.json');
    const session = new StdioSession({ MONGODB_MCP_CONFIG: path });
    try {
      await session.initialize();
      const missing = await call(session, 'listDatabases', {});
      assert.equal(missing.isError, true);
      assert.match(JSON.stringify(missing), /MONGODB_URI/u);
      await writeFile(path, secret, { mode: 0o600 });
      const invalid = await call(session, 'listDatabases', {});
      assert.equal(invalid.isError, true);
      assert.match(JSON.stringify(invalid), /configuração privada/u);
      assert.ok(!JSON.stringify(invalid).includes(secret));
      await saveEnvironment({
        MONGODB_MCP_CONFIG: path,
        MONGODB_URI: 'mongodb://127.0.0.1:1/',
        MONGODB_ALLOWED_DATABASES: 'shop',
      });
      const configured = await call(session, 'find', { database: 'elsewhere', collection: 'orders', filter: {} });
      assert.equal(configured.isError, true);
      assert.match(JSON.stringify(configured), /Banco de dados não autorizado/u);
      assert.doesNotMatch(JSON.stringify(configured), /Configuração necessária/u);
      assert.equal(session.invalidStdoutLines, 0);
    } finally {
      assert.equal(await session.close(), 0);
      await rm(root, { recursive: true, force: true });
    }
  });
});
