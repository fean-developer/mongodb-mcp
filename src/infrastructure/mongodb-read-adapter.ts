import { BSON, MongoClient, ObjectId } from 'mongodb';
import type { FindCursor, FindOptions, MongoClientOptions } from 'mongodb';
import type { JsonDocument, ReadPort, ValidatedFind, ValidatedFindOne, ValidatedQuery } from '../application/read-port.js';
import type { Filter, JsonValue, QueryLiteral } from '../domain/query.js';
import type { AuthMode, ConnectionConfiguration } from './configuration.js';
import { createOidcHumanCallback } from './oidc.js';
import { assertAuthenticatedIdentity, assertUnauthenticatedIdentity } from './identity.js';
import { MassWriteGuard, ReadOnlyGuard } from './read-only-guard.js';

export function createMongoClient(configuration: ConnectionConfiguration): MongoClient {
  const common: MongoClientOptions = {
    connectTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    maxPoolSize: 5,
    monitorCommands: true,
  };
  if (configuration.mode === 'uri' || configuration.mode === 'none') {
    return new MongoClient(configuration.uri, common);
  }
  if (configuration.mode === 'scram') {
    return new MongoClient(configuration.uri, {
      ...common,
      auth: { username: configuration.username, password: configuration.password },
      authMechanism: 'SCRAM-SHA-256',
      ...(configuration.authSource === undefined ? {} : { authSource: configuration.authSource }),
    });
  }
  return new MongoClient(configuration.uri, {
    ...common,
    authMechanism: 'MONGODB-OIDC',
    authSource: '$external',
    authMechanismProperties: {
      OIDC_HUMAN_CALLBACK: createOidcHumanCallback(configuration.oidc),
      ALLOWED_HOSTS: [...configuration.oidc.mongoHosts],
    },
  });
}

function mongoLiteral(value: QueryLiteral): unknown {
  if (value !== null && typeof value === 'object') {
    return value.kind === 'date' ? new Date(value.value) : new ObjectId(value.value);
  }
  return value;
}

function mongoFilter(filter: Filter): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const clause of filter) {
    if (clause.kind === 'logical') {
      result[clause.operator] = clause.filters.map(mongoFilter);
      continue;
    }
    const comparisons: Record<string, unknown> = Object.create(null);
    for (const comparison of clause.comparisons) {
      comparisons[comparison.operator] = comparison.operator === '$in'
        ? comparison.values.map(mongoLiteral)
        : mongoLiteral(comparison.value);
    }
    result[clause.field] = comparisons;
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function jsonValue(value: unknown): JsonValue {
  const serialized = BSON.EJSON.stringify(value, { relaxed: false });
  if (serialized === undefined) {
    throw new Error('O MongoDB retornou um valor não serializável.');
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed)) {
    throw new Error('O MongoDB retornou um valor não serializável.');
  }
  return parsed;
}

function jsonDocument(value: unknown): JsonDocument {
  const parsed = jsonValue(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('O MongoDB retornou um documento inválido.');
  }
  return parsed as JsonDocument;
}

export class MongoReadAdapter implements ReadPort {
  private connection: Promise<MongoClient> | undefined;
  private readonly guard: ReadOnlyGuard | undefined;
  readonly massWriteGuard: MassWriteGuard | undefined;

  constructor(
    private readonly client: MongoClient,
    private readonly authMode: AuthMode,
    readOnly: boolean,
  ) {
    this.guard = readOnly ? new ReadOnlyGuard(client) : undefined;
    this.massWriteGuard = readOnly ? undefined : new MassWriteGuard(client);
  }

  private async connected(queryTimeoutMs: number): Promise<MongoClient> {
    this.guard?.assertIntact();
    this.connection ??= this.client.connect().catch((error: unknown) => {
      this.connection = undefined;
      throw error;
    });
    const client = await this.connection;
    const status: unknown = await client.db('admin').command({
      connectionStatus: 1,
      showPrivileges: true,
      maxTimeMS: queryTimeoutMs,
    });
    if (this.authMode === 'none') {
      assertUnauthenticatedIdentity(status);
    } else {
      assertAuthenticatedIdentity(status);
    }
    return client;
  }

  async listDatabases(queryTimeoutMs: number): Promise<readonly string[]> {
    const client = await this.connected(queryTimeoutMs);
    const result = await client.db().admin().listDatabases({
      authorizedDatabases: true,
      nameOnly: true,
      maxTimeMS: queryTimeoutMs,
    });
    return result.databases.map((database) => database.name);
  }

  async *listCollections(
    database: string,
    allowedCollectionNames: readonly string[] | undefined,
    queryTimeoutMs: number,
  ): AsyncIterable<string> {
    const client = await this.connected(queryTimeoutMs);
    const cursor = client.db(database).listCollections(
      allowedCollectionNames === undefined ? {} : { name: { $in: [...allowedCollectionNames] } },
      { nameOnly: true, authorizedCollections: true, maxTimeMS: queryTimeoutMs },
    );
    try {
      for await (const collection of cursor) {
        yield collection.name;
      }
    } finally {
      await cursor.close();
    }
  }

  private async findCursor(query: ValidatedFindOne, limit: number, skip: number): Promise<FindCursor> {
    const client = await this.connected(query.queryTimeoutMs);
    const options: FindOptions = {
      limit,
      skip,
      maxTimeMS: query.queryTimeoutMs,
      ...(query.projection === undefined ? {} : { projection: query.projection }),
      ...(query.sort === undefined ? {} : { sort: query.sort }),
    };
    return client.db(query.database).collection(query.collection).find(mongoFilter(query.filter), options);
  }

  async *find(query: ValidatedFind): AsyncIterable<JsonDocument> {
    const cursor = await this.findCursor(query, query.limit + 1, query.skip);
    try {
      for await (const document of cursor) {
        yield jsonDocument(document);
      }
    } finally {
      await cursor.close();
    }
  }

  async findOne(query: ValidatedFindOne): Promise<JsonDocument | null> {
    const cursor = await this.findCursor(query, 1, 0);
    try {
      const document: unknown = await cursor.next();
      return document === null ? null : jsonDocument(document);
    } finally {
      await cursor.close();
    }
  }

  async countDocuments(query: ValidatedQuery): Promise<number> {
    const client = await this.connected(query.queryTimeoutMs);
    return client.db(query.database).collection(query.collection).countDocuments(mongoFilter(query.filter), {
      maxTimeMS: query.queryTimeoutMs,
    });
  }

  async distinct(query: ValidatedQuery, field: string): Promise<readonly JsonValue[]> {
    const client = await this.connected(query.queryTimeoutMs);
    const values: readonly unknown[] = await client.db(query.database).collection(query.collection).distinct(
      field,
      mongoFilter(query.filter),
      { maxTimeMS: query.queryTimeoutMs },
    );
    return values.map(jsonValue);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
