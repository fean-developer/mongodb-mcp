import {
  MAX_DISTINCT_VALUES,
  MAX_RESULT_BYTES,
  PolicyError,
  authorizeCollection,
  authorizeDatabase,
  authorizeField,
  fieldsFor,
  isDatabaseAllowed,
  isValidCollectionName,
  utf8Bytes,
  validateFilter,
  validateLimit,
  validateProjection,
  validateSkip,
  validateSort,
} from '../domain/query.js';
import type { AccessPolicy, JsonValue, Projection, Sort } from '../domain/query.js';
import type { JsonDocument, ReadPort, ValidatedFindOne, ValidatedQuery } from './read-port.js';

export type FilterInput = Readonly<Record<string, unknown>>;

export interface CollectionRequest {
  readonly database: string;
  readonly collection: string;
  readonly filter: FilterInput;
}

export interface FindOneRequest extends CollectionRequest {
  readonly projection?: Projection | undefined;
  readonly sort?: Sort | undefined;
}

export interface FindRequest extends FindOneRequest {
  readonly limit?: number | undefined;
  readonly skip?: number | undefined;
}

export interface DistinctRequest extends CollectionRequest {
  readonly field: string;
}

export interface DocumentsResult {
  readonly documents: readonly JsonDocument[];
  readonly truncated: boolean;
}

export interface DistinctResult {
  readonly values: readonly JsonValue[];
  readonly truncated: boolean;
}

export interface ReadOnlyOperations {
  listDatabases(): Promise<{ readonly databases: readonly string[] }>;
  listCollections(database: string): Promise<{ readonly collections: readonly string[] }>;
  find(request: FindRequest): Promise<DocumentsResult>;
  findOne(request: FindOneRequest): Promise<{ readonly document: JsonDocument | null }>;
  countDocuments(request: CollectionRequest): Promise<{ readonly count: number }>;
  distinct(request: DistinctRequest): Promise<DistinctResult>;
}

export class OutputLimitError extends Error {
  constructor() {
    super('Resultado excede o limite de bytes permitido.');
    this.name = 'OutputLimitError';
  }
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new OutputLimitError();
  }
  return utf8Bytes(serialized);
}

export class ReadOnlyService implements ReadOnlyOperations {
  constructor(
    private readonly port: ReadPort,
    private readonly policy: AccessPolicy,
    private readonly queryTimeoutMs: number,
  ) {
    if (!Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 30_000) {
      throw new PolicyError('Tempo máximo de consulta inválido.');
    }
  }

  async listDatabases(): Promise<{ readonly databases: readonly string[] }> {
    const names = await this.port.listDatabases(this.queryTimeoutMs);
    return {
      databases: names.filter((name) => isDatabaseAllowed(this.policy, name)),
    };
  }

  async listCollections(databaseInput: string): Promise<{ readonly collections: readonly string[] }> {
    const database = authorizeDatabase(this.policy, databaseInput);
    const allowed = this.policy.allowedCollectionNames.get(database);
    const collections: string[] = [];
    const names = this.port.listCollections(database, allowed === undefined ? undefined : [...allowed], this.queryTimeoutMs);
    for await (const name of names) {
      if (isValidCollectionName(name) && (allowed?.has(name) ?? true)) {
        collections.push(name);
      }
    }
    return { collections };
  }

  async find(request: FindRequest): Promise<DocumentsResult> {
    const base = this.validateFindOne(request);
    const limit = validateLimit(request.limit);
    const skip = validateSkip(request.skip);
    const documents: JsonDocument[] = [];
    let bytes = serializedBytes({ documents, truncated: true });
    let truncated = false;
    for await (const document of this.port.find({ ...base, limit, skip })) {
      const documentBytes = serializedBytes(document) + 1;
      if (documents.length >= limit || bytes + documentBytes > MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }
      documents.push(document);
      bytes += documentBytes;
    }
    return { documents, truncated };
  }

  async findOne(request: FindOneRequest): Promise<{ readonly document: JsonDocument | null }> {
    const document = await this.port.findOne(this.validateFindOne(request));
    const result = { document };
    if (serializedBytes(result) > MAX_RESULT_BYTES) {
      throw new OutputLimitError();
    }
    return result;
  }

  async countDocuments(request: CollectionRequest): Promise<{ readonly count: number }> {
    const count = await this.port.countDocuments(this.validateQuery(request));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new OutputLimitError();
    }
    return { count };
  }

  async distinct(request: DistinctRequest): Promise<DistinctResult> {
    const query = this.validateQuery(request);
    const field = authorizeField(request.field, fieldsFor(this.policy, query.database, query.collection));
    const allValues = await this.port.distinct(query, field);
    const values: JsonValue[] = [];
    let bytes = serializedBytes({ values, truncated: true });
    let truncated = false;
    for (const value of allValues) {
      const valueBytes = serializedBytes(value) + 1;
      if (values.length >= MAX_DISTINCT_VALUES || bytes + valueBytes > MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }
      values.push(value);
      bytes += valueBytes;
    }
    return { values, truncated };
  }

  private validateQuery(request: CollectionRequest): ValidatedQuery {
    const database = authorizeDatabase(this.policy, request.database);
    const collection = authorizeCollection(this.policy, database, request.collection);
    const filter = validateFilter(request.filter, fieldsFor(this.policy, database, collection));
    return { database, collection, filter, queryTimeoutMs: this.queryTimeoutMs };
  }

  private validateFindOne(request: FindOneRequest): ValidatedFindOne {
    const query = this.validateQuery(request);
    const allowedFields = fieldsFor(this.policy, query.database, query.collection);
    const projection = validateProjection(request.projection, allowedFields);
    const sort = validateSort(request.sort, allowedFields);
    return {
      ...query,
      ...(projection === undefined ? {} : { projection }),
      ...(sort === undefined ? {} : { sort }),
    };
  }
}
