import type { Filter, JsonValue, Projection, Sort } from '../domain/query.js';

export type JsonDocument = { readonly [key: string]: JsonValue };

export interface ValidatedQuery {
  readonly database: string;
  readonly collection: string;
  readonly filter: Filter;
  readonly queryTimeoutMs: number;
}

export interface ValidatedFind extends ValidatedQuery {
  readonly projection?: Projection;
  readonly sort?: Sort;
  readonly limit: number;
  readonly skip: number;
}

export interface ValidatedFindOne extends ValidatedQuery {
  readonly projection?: Projection;
  readonly sort?: Sort;
}

export interface ReadPort {
  listDatabases(queryTimeoutMs: number): Promise<readonly string[]>;
  listCollections(
    database: string,
    allowedCollectionNames: readonly string[] | undefined,
    queryTimeoutMs: number,
  ): AsyncIterable<string>;
  find(query: ValidatedFind): AsyncIterable<JsonDocument>;
  findOne(query: ValidatedFindOne): Promise<JsonDocument | null>;
  countDocuments(query: ValidatedQuery): Promise<number>;
  distinct(query: ValidatedQuery, field: string): Promise<readonly JsonValue[]>;
}
