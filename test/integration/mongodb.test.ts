import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { MongoClient, ObjectId } from 'mongodb';
import { ReadOnlyService } from '../../src/application/read-only-service.js';
import { PolicyError } from '../../src/domain/query.js';
import { loadConfiguration } from '../../src/infrastructure/configuration.js';
import { saveEnvironment } from '../../src/infrastructure/configuration-store.js';
import type { Environment } from '../../src/infrastructure/configuration.js';
import { createMongoClient, MongoReadAdapter } from '../../src/infrastructure/mongodb-read-adapter.js';
import { MassWriteViolationError, ReadOnlyViolationError } from '../../src/infrastructure/read-only-guard.js';
import { isolatedEnvironment, record, StdioSession } from '../helpers/stdio.js';

const execFileAsync = promisify(execFile);

async function docker(args: readonly string[], env: Environment = process.env): Promise<string> {
  const result = await execFileAsync('docker', [...args], { env, timeout: 90_000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

async function waitForMongo(
  uri: string,
  credentials?: { readonly username: string; readonly password: string },
): Promise<MongoClient> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, {
      ...(credentials === undefined ? {} : { auth: credentials, authSource: 'admin' }),
      serverSelectionTimeoutMS: 1_000,
      connectTimeoutMS: 1_000,
    });
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      return client;
    } catch {
      await client.close();
      await delay(500);
    }
  }
  throw new Error('MongoDB descartável não ficou pronto no tempo esperado.');
}

function toolPayload(result: unknown): Record<string, unknown> {
  const response = record(result);
  assert.notEqual(response.isError, true);
  assert.ok(Array.isArray(response.content));
  const first: unknown = response.content[0];
  const content = record(first);
  const text = content.text;
  assert.ok(typeof text === 'string');
  return record(JSON.parse(text));
}

it('accepts privileged identities, blocks writes with MONGODB_ONLY_READ and serves authorized queries over stdio', { timeout: 150_000 }, async () => {
  const configRoot = await mkdtemp(join(tmpdir(), 'mongodb-mcp-auth-config-'));
  const configPath = join(configRoot, 'config.json');
  const suffix = randomBytes(8).toString('hex');
  const container = `mongodb-mcp-readonly-${suffix}`;
  const adminUser = `admin-${suffix}`;
  const adminPassword = randomBytes(24).toString('base64url');
  const readerUser = `reader-${suffix}`;
  const readerPassword = randomBytes(24).toString('base64url');
  let started = false;
  let admin: MongoClient | undefined;
  let adapter: MongoReadAdapter | undefined;

  try {
    await docker([
      'run', '--rm', '--detach', '--name', container,
      '--publish', '127.0.0.1::27017',
      '--env', 'MONGO_INITDB_ROOT_USERNAME',
      '--env', 'MONGO_INITDB_ROOT_PASSWORD',
      'mongo:8.0',
    ], {
      ...process.env,
      MONGO_INITDB_ROOT_USERNAME: adminUser,
      MONGO_INITDB_ROOT_PASSWORD: adminPassword,
    });
    started = true;
    const mapping = await docker(['port', container, '27017/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
    assert.ok(match?.[1] !== undefined);
    const uri = `mongodb://127.0.0.1:${match[1]}/?directConnection=true`;
    admin = await waitForMongo(uri, { username: adminUser, password: adminPassword });
    const firstId = new ObjectId();
    await admin.db('shop').collection('orders').insertMany([
      { _id: firstId, name: 'Alpha', amount: 1, category: 'A', createdAt: new Date('2024-01-02T03:04:05Z'), secret: 'hidden' },
      { name: 'Beta', amount: 2, category: 'B', createdAt: new Date('2024-02-02T03:04:05Z'), secret: 'hidden' },
      { name: 'Gamma', amount: 3, category: 'A', createdAt: new Date('2024-03-02T03:04:05Z'), secret: 'hidden' },
    ]);
    await admin.db('shop').collection('private').insertOne({ secret: 'hidden' });
    await admin.db('elsewhere').collection('orders').insertOne({ name: 'not-authorized' });
    await admin.db('shop').command({
      createUser: readerUser,
      pwd: readerPassword,
      roles: [{ role: 'read', db: 'shop' }],
    });

    const environment: Environment = {
      MONGODB_AUTH_MODE: 'scram',
      MONGODB_URI: uri,
      MONGODB_USERNAME: readerUser,
      MONGODB_PASSWORD: readerPassword,
      MONGODB_AUTH_SOURCE: 'shop',
      MONGODB_ALLOWED_DATABASES: 'shop',
      MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
      MONGODB_ALLOWED_FIELDS: '{"shop":{"orders":["_id","name","amount","category","createdAt"]}}',
      MONGODB_QUERY_TIMEOUT_MS: '5000',
    };
    const configuration = loadConfiguration(environment);
    const readClient = createMongoClient(configuration.connection);
    adapter = new MongoReadAdapter(readClient, configuration.connection.mode, configuration.readOnly);
    const service = new ReadOnlyService(adapter, configuration.policy, configuration.queryTimeoutMs);

    const privilegedConfiguration = loadConfiguration({
      ...environment,
      MONGODB_USERNAME: adminUser,
      MONGODB_PASSWORD: adminPassword,
      MONGODB_AUTH_SOURCE: 'admin',
    });
    assert.equal(privilegedConfiguration.readOnly, true);
    const privilegedClient = createMongoClient(privilegedConfiguration.connection);
    const privilegedAdapter = new MongoReadAdapter(
      privilegedClient,
      privilegedConfiguration.connection.mode,
      privilegedConfiguration.readOnly,
    );
    try {
      const privilegedService = new ReadOnlyService(
        privilegedAdapter,
        privilegedConfiguration.policy,
        privilegedConfiguration.queryTimeoutMs,
      );
      assert.equal((await privilegedService.countDocuments({ database: 'shop', collection: 'orders', filter: {} })).count, 3);
      const orders = privilegedClient.db('shop').collection('orders');
      for (const write of [
        () => orders.insertOne({ name: 'should-not-exist' }),
        () => orders.updateOne({}, { $set: { name: 'changed' } }),
        () => orders.deleteOne({}),
        () => orders.aggregate([{ $match: {} }, { $out: 'copied' }]).toArray(),
        () => orders.drop(),
      ]) {
        await assert.rejects(write(), ReadOnlyViolationError);
      }
      await assert.rejects(
        privilegedService.countDocuments({ database: 'shop', collection: 'orders', filter: {} }),
        ReadOnlyViolationError,
      );
    } finally {
      await privilegedAdapter.close();
    }
    assert.equal(await admin.db('shop').collection('orders').countDocuments({ name: { $in: ['should-not-exist', 'changed'] } }), 0);
    assert.equal(await admin.db('shop').collection('orders').countDocuments(), 3);
    assert.deepEqual((await admin.db('shop').listCollections({ name: 'copied' }).toArray()).length, 0);

    const unguardedConfiguration = loadConfiguration({
      ...environment,
      MONGODB_USERNAME: adminUser,
      MONGODB_PASSWORD: adminPassword,
      MONGODB_AUTH_SOURCE: 'admin',
      MONGODB_ONLY_READ: 'false',
    });
    const unguardedClient = createMongoClient(unguardedConfiguration.connection);
    const unguardedAdapter = new MongoReadAdapter(unguardedClient, unguardedConfiguration.connection.mode, false);
    try {
      const unguardedService = new ReadOnlyService(
        unguardedAdapter,
        unguardedConfiguration.policy,
        unguardedConfiguration.queryTimeoutMs,
      );
      assert.equal((await unguardedService.countDocuments({ database: 'shop', collection: 'orders', filter: {} })).count, 3);
      const scratch = unguardedClient.db('shop').collection('scratch');
      await scratch.insertMany([{ written: true }, { written: true }]);
      await assert.rejects(scratch.updateMany({}, { $set: { written: false } }), MassWriteViolationError);
      await assert.rejects(scratch.deleteMany({}), MassWriteViolationError);
      await assert.rejects(scratch.bulkWrite([{ deleteMany: { filter: {} } }]), /filtro vazio/u);
      assert.equal(await admin.db('shop').collection('scratch').countDocuments({ written: true }), 2);
      assert.equal((await scratch.updateMany({ written: true }, { $set: { written: false } })).modifiedCount, 2);
      assert.equal((await scratch.deleteMany({ written: false })).deletedCount, 2);
      assert.equal(await admin.db('shop').collection('scratch').countDocuments(), 0);
      await admin.db('shop').collection('scratch').drop();
    } finally {
      await unguardedAdapter.close();
    }
    const identityStatus: unknown = await readClient.db('admin').command({ connectionStatus: 1, showPrivileges: true });
    const roles = record(record(identityStatus).authInfo).authenticatedUserRoles;
    assert.ok(Array.isArray(roles));
    assert.equal(roles.length, 1);
    assert.equal(record(roles[0]).role, 'read');
    assert.equal(record(roles[0]).db, 'shop');

    assert.deepEqual(await service.listDatabases(), { databases: ['shop'] });
    assert.deepEqual(await service.listCollections('shop'), { collections: ['orders'] });
    assert.deepEqual(await service.countDocuments({ database: 'shop', collection: 'orders', filter: {} }), { count: 3 });
    await assert.rejects(service.find({ database: 'shop', collection: 'private', filter: {} }), PolicyError);
    const identityScopedConfiguration = loadConfiguration({
      ...environment,
      MONGODB_ALLOWED_DATABASES: undefined,
      MONGODB_ALLOWED_COLLECTIONS: undefined,
      MONGODB_ALLOWED_FIELDS: undefined,
    });
    const identityScopedService = new ReadOnlyService(
      new MongoReadAdapter(
        readClient,
        identityScopedConfiguration.connection.mode,
        identityScopedConfiguration.readOnly,
      ),
      identityScopedConfiguration.policy,
      identityScopedConfiguration.queryTimeoutMs,
    );
    assert.deepEqual(await identityScopedService.listDatabases(), { databases: ['shop'] });
    assert.deepEqual(
      [...(await identityScopedService.listCollections('shop')).collections].sort(),
      ['orders', 'private'],
    );
    assert.deepEqual(await identityScopedService.countDocuments({
      database: 'shop',
      collection: 'private',
      filter: {},
    }), { count: 1 });
    const page = await service.find({
      database: 'shop', collection: 'orders', filter: {}, sort: { name: 1 }, limit: 2,
    });
    assert.equal(page.documents.length, 2);
    assert.equal(page.truncated, true);
    assert.equal(page.documents[0]?.name, 'Alpha');
    assert.ok(!Object.hasOwn(page.documents[0] ?? {}, 'secret'));
    assert.deepEqual(page.documents[0]?._id, { $oid: firstId.toHexString() });
    const lastPage = await service.find({
      database: 'shop', collection: 'orders', filter: {}, sort: { name: 1 }, limit: 2, skip: 2,
    });
    assert.equal(lastPage.documents.length, 1);
    assert.equal(lastPage.truncated, false);
    const found = await service.findOne({
      database: 'shop', collection: 'orders', filter: { _id: { $oid: firstId.toHexString() } },
    });
    assert.equal(found.document?.name, 'Alpha');
    const dateCount = await service.countDocuments({
      database: 'shop', collection: 'orders', filter: { createdAt: { $gte: { $date: '2024-02-01T00:00:00Z' } } },
    });
    assert.equal(dateCount.count, 2);
    const distinct = await service.distinct({ database: 'shop', collection: 'orders', filter: {}, field: 'category' });
    assert.deepEqual([...distinct.values].sort(), ['A', 'B']);
    assert.equal(distinct.truncated, false);

    assert.equal((await service.countDocuments({ database: 'shop', collection: 'orders', filter: {} })).count, 3);

    const anonymousSession = new StdioSession({ MONGODB_URI: uri });
    try {
      await anonymousSession.initialize();
      for (const [name, args] of [
        ['listDatabases', {}],
        ['listCollections', { database: 'shop' }],
        ['find', { database: 'shop', collection: 'orders', filter: {} }],
      ] as const) {
        const response = await anonymousSession.request('tools/call', { name, arguments: args });
        assert.equal(record(response.result).isError, true);
      }
    } finally {
      assert.equal(await anonymousSession.close(), 0);
    }

    await saveEnvironment({ ...environment, MONGODB_MCP_CONFIG: configPath });
    const session = new StdioSession({ MONGODB_MCP_CONFIG: configPath });
    try {
      await session.initialize();
      const listing = await session.request('tools/list');
      assert.equal(record(listing.result).tools instanceof Array, true);
      assert.equal((record(listing.result).tools as unknown[]).length, 6);
      const response = await session.request('tools/call', {
        name: 'find',
        arguments: { database: 'shop', collection: 'orders', filter: {}, sort: { name: 1 }, limit: 2 },
      });
      const payload = toolPayload(response.result);
      assert.ok(Array.isArray(payload.documents));
      assert.equal(payload.documents.length, 2);
      assert.equal(payload.truncated, true);
      assert.ok(!JSON.stringify(payload).includes('secret'));
      assert.ok(!JSON.stringify(response).includes(readerPassword));
      assert.ok(!JSON.stringify(response).includes(uri));
      assert.ok(!session.stderr.includes(readerPassword));
      assert.ok(!session.stderr.includes(uri));
      assert.equal(session.invalidStdoutLines, 0);
    } finally {
      assert.equal(await session.close(), 0);
    }
  } finally {
    if (adapter !== undefined) {
      await adapter.close();
    }
    if (admin !== undefined) {
      await admin.close();
    }
    await rm(configRoot, { recursive: true, force: true });
    if (started) {
      await docker(['stop', '--time', '2', container]);
    }
  }
});

it('serves an unauthenticated MongoDB over stdio while enforcing MCP restrictions', { timeout: 150_000 }, async () => {
  const container = `mongodb-mcp-anonymous-${randomBytes(8).toString('hex')}`;
  const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-integration-config-'));
  const location: Environment = { XDG_CONFIG_HOME: root, APPDATA: root, MONGODB_MCP_CONFIG: undefined };
  let started = false;
  let client: MongoClient | undefined;

  try {
    await docker([
      'run', '--rm', '--detach', '--name', container,
      '--publish', '127.0.0.1::27017',
      'mongo:8.0',
    ]);
    started = true;
    const mapping = await docker(['port', container, '27017/tcp']);
    const match = /^127\.0\.0\.1:(\d+)$/u.exec(mapping);
    assert.ok(match?.[1] !== undefined);
    const uri = `mongodb://127.0.0.1:${match[1]}/?directConnection=true`;
    client = await waitForMongo(uri);
    await client.db('shop').collection('orders').insertMany([
      { name: 'Alpha', secret: 'hidden' },
      { name: 'Beta', secret: 'hidden' },
    ]);
    await client.db('shop').collection('private').insertOne({ secret: 'hidden' });
    await client.db('elsewhere').collection('items').insertOne({ name: 'Other' });

    const environment: Environment = { MONGODB_URI: uri };
    const session = new StdioSession(location);
    try {
      await session.initialize();
      const missing = await session.request('tools/call', { name: 'listDatabases', arguments: {} });
      assert.equal(record(missing.result).isError, true);
      assert.match(JSON.stringify(missing.result), /MONGODB_URI/u);
      const imported = await execFileAsync(process.execPath, ['dist/interfaces/cli/configure.js', '--save', '--from-env', '--secret-store=file'], {
        env: isolatedEnvironment({ ...location, ...environment }), timeout: 10_000,
      });
      assert.ok(!imported.stderr.includes(uri));
      const checked = await execFileAsync(process.execPath, ['dist/interfaces/cli/configure.js', '--check'], {
        env: isolatedEnvironment(location), timeout: 15_000,
      });
      assert.match(checked.stderr, /Conexão e permissões verificadas/u);
      assert.match(checked.stderr, /Origem: arquivo: MONGODB_URI/u);
      assert.ok(!checked.stderr.includes(uri));
      const databases = toolPayload((await session.request('tools/call', {
        name: 'listDatabases', arguments: {},
      })).result);
      assert.ok(Array.isArray(databases.databases));
      assert.deepEqual([...databases.databases].sort(), ['elsewhere', 'shop']);

      const collections = toolPayload((await session.request('tools/call', {
        name: 'listCollections', arguments: { database: 'shop' },
      })).result);
      assert.ok(Array.isArray(collections.collections));
      assert.deepEqual([...collections.collections].sort(), ['orders', 'private']);

      const result = toolPayload((await session.request('tools/call', {
        name: 'find',
        arguments: { database: 'shop', collection: 'orders', filter: {}, projection: { _id: 0, name: 1 }, sort: { name: 1 } },
      })).result);
      assert.deepEqual(result.documents, [{ name: 'Alpha' }, { name: 'Beta' }]);

      const one = toolPayload((await session.request('tools/call', {
        name: 'findOne',
        arguments: { database: 'shop', collection: 'orders', filter: { name: 'Alpha' }, projection: { _id: 0, name: 1 } },
      })).result);
      assert.deepEqual(one.document, { name: 'Alpha' });
      const count = toolPayload((await session.request('tools/call', {
        name: 'countDocuments', arguments: { database: 'shop', collection: 'orders', filter: {} },
      })).result);
      assert.equal(count.count, 2);
      const distinct = toolPayload((await session.request('tools/call', {
        name: 'distinct', arguments: { database: 'shop', collection: 'orders', field: 'name', filter: {} },
      })).result);
      assert.ok(Array.isArray(distinct.values));
      assert.deepEqual([...distinct.values].sort(), ['Alpha', 'Beta']);

      const write = await session.request('tools/call', {
        name: 'insertOne', arguments: { database: 'shop', collection: 'orders', document: { name: 'forbidden' } },
      });
      assert.equal(record(write.result).isError, true);
      assert.equal(session.invalidStdoutLines, 0);
    } finally {
      assert.equal(await session.close(), 0);
    }

    const restricted = new StdioSession({
      ...environment,
      MONGODB_ALLOWED_DATABASES: 'shop',
      MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
      MONGODB_ALLOWED_FIELDS: '{"shop":{"orders":["name"]}}',
    });
    try {
      await restricted.initialize();
      const collections = toolPayload((await restricted.request('tools/call', {
        name: 'listCollections', arguments: { database: 'shop' },
      })).result);
      assert.deepEqual(collections.collections, ['orders']);
      const denied = await restricted.request('tools/call', {
        name: 'find', arguments: { database: 'shop', collection: 'private', filter: {} },
      });
      assert.equal(record(denied.result).isError, true);
      const result = toolPayload((await restricted.request('tools/call', {
        name: 'find', arguments: { database: 'shop', collection: 'orders', filter: {}, sort: { name: 1 } },
      })).result);
      assert.deepEqual(result.documents, [{ name: 'Alpha' }, { name: 'Beta' }]);
    } finally {
      assert.equal(await restricted.close(), 0);
    }
  } finally {
    if (client !== undefined) {
      await client.close();
    }
    await rm(root, { recursive: true, force: true });
    if (started) {
      await docker(['stop', '--time', '2', container]);
    }
  }
});
