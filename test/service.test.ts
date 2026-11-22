import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReadOnlyService, OutputLimitError } from '../src/application/read-only-service.js';
import type { FilterInput } from '../src/application/read-only-service.js';
import type {
  JsonDocument,
  ReadPort,
  ValidatedFind,
} from '../src/application/read-port.js';
import { MAX_RESULT_BYTES, PolicyError } from '../src/domain/query.js';
import type { AccessPolicy, JsonValue } from '../src/domain/query.js';

class StubPort implements ReadPort {
  readonly calls: string[] = [];
  documents: JsonDocument[] = [];
  distinctValues: JsonValue[] = [];
  lastFind: ValidatedFind | undefined;
  closedFindCursors = 0;

  async listDatabases(): Promise<readonly string[]> {
    this.calls.push('listDatabases');
    return ['shop', 'admin', 'other'];
  }

  async *listCollections(): AsyncIterable<string> {
    this.calls.push('listCollections');
    yield 'orders';
    yield 'system.users';
    yield 'private';
  }

  async *find(query: ValidatedFind): AsyncIterable<JsonDocument> {
    this.calls.push('find');
    this.lastFind = query;
    try {
      yield* this.documents;
    } finally {
      this.closedFindCursors += 1;
    }
  }

  async findOne(): Promise<JsonDocument | null> {
    this.calls.push('findOne');
    return this.documents[0] ?? null;
  }

  async countDocuments(): Promise<number> {
    this.calls.push('countDocuments');
    return this.documents.length;
  }

  async distinct(): Promise<readonly JsonValue[]> {
    this.calls.push('distinct');
    return this.distinctValues;
  }
}

function policy(fields?: readonly string[]): AccessPolicy {
  return {
    allowedDatabaseNames: new Set(['shop']),
    allowedCollectionNames: new Map([['shop', new Set(['orders'])]]),
    allowedFields: fields === undefined
      ? new Map()
      : new Map([['shop', new Map([['orders', new Set(fields)]])]]),
  };
}

const request = { database: 'shop', collection: 'orders', filter: {} };

describe('read-only service guardrails', () => {
  it('filters listings and rejects unauthorized resources before contacting the adapter', async () => {
    const port = new StubPort();
    const service = new ReadOnlyService(port, policy(), 5_000);
    await assert.rejects(service.listCollections('admin'), PolicyError);
    await assert.rejects(service.find({ ...request, database: 'other' }), PolicyError);
    await assert.rejects(service.findOne({ ...request, collection: 'private' }), PolicyError);
    await assert.rejects(service.countDocuments({ ...request, collection: 'system.users' }), PolicyError);
    await assert.rejects(service.distinct({ ...request, database: 'LOCAL', field: 'name' }), PolicyError);
    assert.deepEqual(port.calls, []);
    assert.deepEqual(await service.listDatabases(), { databases: ['shop'] });
    assert.deepEqual(await service.listCollections('shop'), { collections: ['orders'] });
  });

  it('uses the read identity as the default database and collection boundary', async () => {
    const port = new StubPort();
    const service = new ReadOnlyService(port, {
      allowedDatabaseNames: undefined,
      allowedCollectionNames: new Map(),
      allowedFields: new Map(),
    }, 5_000);

    assert.deepEqual(await service.listDatabases(), { databases: ['shop', 'other'] });
    assert.deepEqual(await service.listCollections('other'), { collections: ['orders', 'private'] });
    assert.deepEqual(await service.countDocuments({
      database: 'other',
      collection: 'private',
      filter: {},
    }), { count: 0 });
  });

  it('rejects dangerous and malformed recursive filters without calling the adapter', async () => {
    const port = new StubPort();
    const service = new ReadOnlyService(port, policy(), 5_000);
    const filters: unknown[] = [
      { $where: 'return true' },
      { age: { $regex: '.*' } },
      { $and: [{ name: 'ok' }, { $or: [{ $expr: 'code' }] }] },
      JSON.parse('{"__proto__":{"$eq":"x"}}'),
      { 'profile.constructor': 'x' },
      { name: { $in: ['ok', { $where: 'code' }] } },
      { created: { $date: '2024-02-31T00:00:00Z' } },
      { id: { $oid: 'not-an-object-id' } },
      { name: { nested: 'unsupported' } },
    ];
    for (const filter of filters) {
      await assert.rejects(service.find({ ...request, filter: filter as FilterInput }), PolicyError);
    }
    let nested: FilterInput = { name: 'ok' };
    for (let depth = 0; depth < 10; depth += 1) {
      nested = { $and: [nested] };
    }
    await assert.rejects(service.find({ ...request, filter: nested }), PolicyError);
    assert.deepEqual(port.calls, []);

    assert.deepEqual(await service.countDocuments(request), { count: 0 });
    assert.deepEqual(port.calls, ['countDocuments']);
  });

  it('enforces field restrictions on filters, sort, projection and distinct', async () => {
    const port = new StubPort();
    const service = new ReadOnlyService(port, policy(['name', 'age', 'created']), 5_000);
    await assert.rejects(service.find({ ...request, filter: { secret: 1 } }), PolicyError);
    await assert.rejects(service.find({ ...request, sort: { secret: 1 } }), PolicyError);
    await assert.rejects(service.find({ ...request, projection: { secret: 1 } }), PolicyError);
    await assert.rejects(service.find({ ...request, projection: { name: 0 } }), PolicyError);
    await assert.rejects(service.distinct({ ...request, field: 'secret' }), PolicyError);
    assert.deepEqual(port.calls, []);

    await service.find({
      ...request,
      filter: {
        $and: [
          { age: { $gte: 18, $in: [18, 19] } },
          { created: { $date: '2024-01-02T03:04:05Z' } },
        ],
      },
      sort: { name: -1 },
    });
    assert.equal(port.lastFind?.projection?.name, 1);
    assert.equal(port.lastFind?.projection?.age, 1);
    assert.equal(port.lastFind?.projection?._id, 0);
    assert.equal(port.lastFind?.sort?.name, -1);
    assert.equal(port.lastFind?.filter[0]?.kind, 'logical');

    const idOnlyPort = new StubPort();
    const idOnly = new ReadOnlyService(idOnlyPort, policy(['_id']), 5_000);
    await assert.rejects(idOnly.find({ ...request, projection: { _id: 0 } }), PolicyError);
    assert.deepEqual(idOnlyPort.calls, []);
  });

  it('bounds pagination and result bytes, signals truncation and closes cursors', async () => {
    const port = new StubPort();
    const service = new ReadOnlyService(port, policy(), 5_000);
    await assert.rejects(service.find({ ...request, limit: 101 }), PolicyError);
    await assert.rejects(service.find({ ...request, skip: 10_001 }), PolicyError);
    assert.deepEqual(port.calls, []);

    port.documents = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    assert.deepEqual(await service.find({ ...request, limit: 2 }), {
      documents: [{ name: 'a' }, { name: 'b' }],
      truncated: true,
    });
    assert.equal(port.closedFindCursors, 1);

    port.documents = [{ name: 'x'.repeat(MAX_RESULT_BYTES) }];
    assert.deepEqual(await service.find(request), { documents: [], truncated: true });
    assert.equal(port.closedFindCursors, 2);
    await assert.rejects(service.findOne(request), OutputLimitError);

    port.distinctValues = Array.from({ length: 101 }, (_, index) => index);
    const distinct = await service.distinct({ ...request, field: 'name' });
    assert.equal(distinct.values.length, 100);
    assert.equal(distinct.truncated, true);
    port.distinctValues = ['x'.repeat(MAX_RESULT_BYTES)];
    assert.deepEqual(await service.distinct({ ...request, field: 'name' }), { values: [], truncated: true });
  });
});
