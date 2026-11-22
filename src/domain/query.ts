export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_SKIP = 10_000;
export const MAX_FILTER_BYTES = 16_384;
export const MAX_RESULT_BYTES = 120_000;
export const MAX_DISTINCT_VALUES = 100;

const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES = 500;
const MAX_FILTER_ARRAY_ITEMS = 100;
const MAX_FIELD_COUNT = 100;
const MAX_VALUE_LENGTH = 4_096;
const forbiddenSegments = new Set(['__proto__', 'constructor', 'prototype']);
const forbiddenDatabases = new Set(['admin', 'config', 'local']);
const encoder = new TextEncoder();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type QueryLiteral =
  | null
  | boolean
  | number
  | string
  | { readonly kind: 'date' | 'objectId'; readonly value: string };

export type Comparison =
  | {
      readonly operator: '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte';
      readonly value: QueryLiteral;
    }
  | { readonly operator: '$in'; readonly values: readonly QueryLiteral[] };

export type Filter = readonly (
  | { readonly kind: 'field'; readonly field: string; readonly comparisons: readonly Comparison[] }
  | { readonly kind: 'logical'; readonly operator: '$and' | '$or'; readonly filters: readonly Filter[] }
)[];

export type Projection = Readonly<Record<string, 0 | 1>>;
export type Sort = Readonly<Record<string, 1 | -1>>;

export interface AccessPolicy {
  /** Sem lista, qualquer banco válido (exceto admin, config e local) que a identidade puder ler. */
  readonly allowedDatabaseNames: ReadonlySet<string> | undefined;
  /** Bancos sem entrada aceitam qualquer coleção válida (exceto system.*). */
  readonly allowedCollectionNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly allowedFields: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127);
  });
}

export function isValidDatabaseName(value: string): boolean {
  return value.length > 0
    && utf8Bytes(value) <= 63
    && !/[\\/\s."$*<>:|?]/u.test(value)
    && !containsControlCharacter(value)
    && !forbiddenDatabases.has(value.toLowerCase())
    && !forbiddenSegments.has(value);
}

export function isValidCollectionName(value: string): boolean {
  return value.length > 0
    && utf8Bytes(value) <= 200
    && !value.toLowerCase().startsWith('system.')
    && !value.startsWith('.')
    && !value.endsWith('.')
    && !value.includes('$')
    && !containsControlCharacter(value)
    && !forbiddenSegments.has(value);
}

export function validateFieldName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > 256) {
    throw new PolicyError('Campo inválido.');
  }
  const segments = value.split('.');
  if (segments.length > 20 || segments.some(
    (segment) => segment.length === 0
      || forbiddenSegments.has(segment)
      || segment.includes('$')
      || containsControlCharacter(segment),
  )) {
    throw new PolicyError('Campo inválido.');
  }
  return value;
}

export function isDatabaseAllowed(policy: AccessPolicy, value: string): boolean {
  return isValidDatabaseName(value) && (policy.allowedDatabaseNames?.has(value) ?? true);
}

export function authorizeDatabase(policy: AccessPolicy, value: unknown): string {
  if (typeof value !== 'string' || !isDatabaseAllowed(policy, value)) {
    throw new PolicyError('Banco de dados não autorizado.');
  }
  return value;
}

export function authorizeCollection(policy: AccessPolicy, database: string, value: unknown): string {
  if (typeof value !== 'string'
    || !isValidCollectionName(value)
    || !(policy.allowedCollectionNames.get(database)?.has(value) ?? true)) {
    throw new PolicyError('Coleção não autorizada.');
  }
  return value;
}

export function fieldsFor(policy: AccessPolicy, database: string, collection: string): ReadonlySet<string> | undefined {
  return policy.allowedFields.get(database)?.get(collection);
}

export function authorizeField(value: unknown, allowedFields: ReadonlySet<string> | undefined): string {
  const field = validateFieldName(value);
  if (allowedFields !== undefined && !allowedFields.has(field)) {
    throw new PolicyError('Campo não autorizado.');
  }
  return field;
}

function entriesOf(value: unknown): [string, unknown][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyError('Objeto de consulta inválido.');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PolicyError('Objeto de consulta inválido.');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new PolicyError('Objeto de consulta inválido.');
  }
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new PolicyError('Objeto de consulta inválido.');
    }
    const item: unknown = descriptor.value;
    entries.push([key, item]);
  }
  if (entries.length > MAX_FIELD_COUNT) {
    throw new PolicyError('Consulta excede o número máximo de campos.');
  }
  return entries;
}

function arrayItems(value: unknown, allowEmpty: boolean): unknown[] {
  if (!Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_FILTER_ARRAY_ITEMS
    || (!allowEmpty && value.length === 0)
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.keys(value).length !== value.length) {
    throw new PolicyError('Lista de filtro inválida.');
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new PolicyError('Lista de filtro inválida.');
    }
    const item: unknown = descriptor.value;
    items.push(item);
  }
  return items;
}

interface FilterState {
  nodes: number;
  readonly allowedFields: ReadonlySet<string> | undefined;
}

function countNode(state: FilterState): void {
  state.nodes += 1;
  if (state.nodes > MAX_FILTER_NODES) {
    throw new PolicyError('Filtro excede o tamanho permitido.');
  }
}

function parseLiteral(value: unknown, state: FilterState): QueryLiteral {
  countNode(state);
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && utf8Bytes(value) <= MAX_VALUE_LENGTH) {
    return value;
  }
  const entries = entriesOf(value);
  if (entries.length !== 1) {
    throw new PolicyError('Valor de filtro inválido.');
  }
  const entry = entries[0];
  if (entry === undefined) {
    throw new PolicyError('Valor de filtro inválido.');
  }
  const [key, item] = entry;
  if (key === '$oid' && typeof item === 'string' && /^[a-f\d]{24}$/iu.test(item)) {
    return { kind: 'objectId', value: item.toLowerCase() };
  }
  if (key === '$date' && typeof item === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(item);
    const timestamp = Date.parse(item);
    if (match !== null && Number.isFinite(timestamp)) {
      const expected = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
      if (new Date(timestamp).toISOString() === expected) {
        return { kind: 'date', value: expected };
      }
    }
  }
  throw new PolicyError('Valor de filtro inválido.');
}

function parseComparisons(value: unknown, state: FilterState): readonly Comparison[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ operator: '$eq', value: parseLiteral(value, state) }];
  }
  const entries = entriesOf(value);
  if (entries.length === 1 && (entries[0]?.[0] === '$oid' || entries[0]?.[0] === '$date')) {
    return [{ operator: '$eq', value: parseLiteral(value, state) }];
  }
  if (entries.length === 0) {
    throw new PolicyError('Condição de filtro inválida.');
  }
  return entries.map(([operator, operand]): Comparison => {
    countNode(state);
    if (operator === '$in') {
      return { operator, values: arrayItems(operand, true).map((item) => parseLiteral(item, state)) };
    }
    if (operator === '$eq' || operator === '$ne' || operator === '$gt'
      || operator === '$gte' || operator === '$lt' || operator === '$lte') {
      return { operator, value: parseLiteral(operand, state) };
    }
    throw new PolicyError('Operador de filtro não permitido.');
  });
}

function parseFilterObject(value: unknown, depth: number, state: FilterState): Filter {
  if (depth > MAX_FILTER_DEPTH) {
    throw new PolicyError('Filtro excede a profundidade permitida.');
  }
  countNode(state);
  return entriesOf(value).map(([key, item]) => {
    if (key === '$and' || key === '$or') {
      return {
        kind: 'logical',
        operator: key,
        filters: arrayItems(item, false).map((child) => parseFilterObject(child, depth + 1, state)),
      };
    }
    if (key.startsWith('$')) {
      throw new PolicyError('Operador de filtro não permitido.');
    }
    const field = authorizeField(key, state.allowedFields);
    return { kind: 'field', field, comparisons: parseComparisons(item, state) };
  });
}

export function validateFilter(value: unknown, allowedFields: ReadonlySet<string> | undefined): Filter {
  const result = parseFilterObject(value, 0, { nodes: 0, allowedFields });
  if (utf8Bytes(JSON.stringify(value)) > MAX_FILTER_BYTES) {
    throw new PolicyError('Filtro excede o limite de bytes.');
  }
  return result;
}

function allowedProjection(allowedFields: ReadonlySet<string>, includeId: boolean): Record<string, 0 | 1> {
  const result: Record<string, 0 | 1> = Object.create(null);
  for (const field of allowedFields) {
    if (field !== '_id' || includeId) {
      result[field] = 1;
    }
  }
  if (!includeId || !allowedFields.has('_id')) {
    result._id = 0;
  }
  if (!Object.values(result).includes(1)) {
    throw new PolicyError('A projeção deve incluir ao menos um campo autorizado.');
  }
  return result;
}

export function validateProjection(value: unknown, allowedFields: ReadonlySet<string> | undefined): Projection | undefined {
  if (value === undefined) {
    return allowedFields === undefined ? undefined : allowedProjection(allowedFields, true);
  }
  const entries = entriesOf(value);
  const result: Record<string, 0 | 1> = Object.create(null);
  let includes = false;
  let excludes = false;
  for (const [key, direction] of entries) {
    if (direction !== 0 && direction !== 1) {
      throw new PolicyError('Projeção inválida.');
    }
    if (key === '_id' && direction === 0) {
      validateFieldName(key);
    } else {
      authorizeField(key, allowedFields);
    }
    result[key] = direction;
    if (key !== '_id') {
      includes ||= direction === 1;
      excludes ||= direction === 0;
    }
  }
  if (includes && excludes) {
    throw new PolicyError('Não misture inclusão e exclusão na projeção.');
  }
  if (allowedFields !== undefined) {
    if (excludes) {
      throw new PolicyError('Use projeção por inclusão quando houver restrição de campos.');
    }
    if (!includes && result._id !== 1) {
      return allowedProjection(allowedFields, result._id !== 0);
    }
    if (!allowedFields.has('_id')) {
      result._id = 0;
    }
  }
  return result;
}

export function validateSort(value: unknown, allowedFields: ReadonlySet<string> | undefined): Sort | undefined {
  if (value === undefined) {
    return undefined;
  }
  const result: Record<string, 1 | -1> = Object.create(null);
  for (const [key, direction] of entriesOf(value)) {
    authorizeField(key, allowedFields);
    if (direction !== 1 && direction !== -1) {
      throw new PolicyError('Ordenação inválida.');
    }
    result[key] = direction;
  }
  return result;
}

export function validateLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new PolicyError('Limite deve estar entre 1 e 100.');
  }
  return value;
}

export function validateSkip(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_SKIP) {
    throw new PolicyError('Skip deve estar entre 0 e 10000.');
  }
  return value;
}
