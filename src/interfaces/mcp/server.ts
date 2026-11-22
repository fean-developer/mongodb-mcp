import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { FilterInput, ReadOnlyOperations } from '../../application/read-only-service.js';
import { OutputLimitError } from '../../application/read-only-service.js';
import { MAX_LIMIT, MAX_SKIP, PolicyError, utf8Bytes } from '../../domain/query.js';
import type { Projection, Sort } from '../../domain/query.js';
import { ConfigurationError } from '../../infrastructure/configuration.js';
import { findOidcError } from '../../infrastructure/oidc.js';
import { serverInfo, toolIcons } from './branding.js';

const MAX_MCP_RESULT_BYTES = 262_144;
const annotations = { readOnlyHint: true, destructiveHint: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProjection(value: unknown): value is Projection {
  return isRecord(value) && Object.values(value).every((direction) => direction === 0 || direction === 1);
}

function isSort(value: unknown): value is Sort {
  return isRecord(value) && Object.values(value).every((direction) => direction === 1 || direction === -1);
}

const filterSchema = z.custom<FilterInput>(isRecord);
const projectionSchema = z.custom<Projection>(isProjection);
const sortSchema = z.custom<Sort>(isSort);
const databaseSchema = z.string().min(1).max(63);
const collectionSchema = z.string().min(1).max(200);
const collectionFields = {
  database: databaseSchema,
  collection: collectionSchema,
  filter: filterSchema,
};

export const toolSchemas = {
  listDatabases: z.strictObject({}),
  listCollections: z.strictObject({ database: databaseSchema }),
  find: z.strictObject({
    ...collectionFields,
    projection: projectionSchema.optional(),
    sort: sortSchema.optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    skip: z.number().int().min(0).max(MAX_SKIP).optional(),
  }),
  findOne: z.strictObject({
    ...collectionFields,
    projection: projectionSchema.optional(),
    sort: sortSchema.optional(),
  }),
  countDocuments: z.strictObject(collectionFields),
  distinct: z.strictObject({
    ...collectionFields,
    field: z.string().min(1).max(256),
  }),
};

const databaseProperty = { type: 'string', minLength: 1, maxLength: 63 };
const collectionProperty = { type: 'string', minLength: 1, maxLength: 200 };
const filterProperty = {
  type: 'object',
  description: 'Filtro obrigatório. Use campos, $eq, $ne, $gt, $gte, $lt, $lte, $in, $and e $or.',
  additionalProperties: true,
};
const projectionProperty = {
  type: 'object',
  additionalProperties: { type: 'integer', enum: [0, 1] },
};
const sortProperty = {
  type: 'object',
  additionalProperties: { type: 'integer', enum: [1, -1] },
};
const collectionProperties = {
  database: databaseProperty,
  collection: collectionProperty,
  filter: filterProperty,
};

function inputSchema(properties: Record<string, object>, required: string[]): Tool['inputSchema'] {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const tools: readonly Tool[] = [
  {
    name: 'listDatabases',
    description: 'Lista apenas bancos autorizados pela política e pela identidade MongoDB.',
    inputSchema: inputSchema({}, []),
    annotations,
  },
  {
    name: 'listCollections',
    description: 'Lista apenas coleções autorizadas no banco informado.',
    inputSchema: inputSchema({ database: databaseProperty }, ['database']),
    annotations,
  },
  {
    name: 'find',
    description: 'Consulta documentos paginados; informa quando há mais resultados ou truncamento.',
    inputSchema: inputSchema({
      ...collectionProperties,
      projection: projectionProperty,
      sort: sortProperty,
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 20 },
      skip: { type: 'integer', minimum: 0, maximum: MAX_SKIP, default: 0 },
    }, ['database', 'collection', 'filter']),
    annotations,
  },
  {
    name: 'findOne',
    description: 'Consulta um documento autorizado ou retorna null.',
    inputSchema: inputSchema({
      ...collectionProperties,
      projection: projectionProperty,
      sort: sortProperty,
    }, ['database', 'collection', 'filter']),
    annotations,
  },
  {
    name: 'countDocuments',
    description: 'Retorna a contagem exata dos documentos que satisfazem o filtro.',
    inputSchema: inputSchema(collectionProperties, ['database', 'collection', 'filter']),
    annotations,
  },
  {
    name: 'distinct',
    description: 'Retorna valores distintos limitados e informa se a resposta foi truncada.',
    inputSchema: inputSchema({
      ...collectionProperties,
      field: { type: 'string', minLength: 1, maxLength: 256 },
    }, ['database', 'collection', 'filter', 'field']),
    annotations,
  },
];

const rawCallSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({ name: z.string(), arguments: z.unknown().optional() }).loose(),
});

function parseArguments<Schema extends z.ZodType>(schema: Schema, args: unknown): z.output<Schema> {
  const parsed = schema.safeParse(args === undefined ? {} : args);
  if (!parsed.success) {
    throw new PolicyError('Argumentos da tool inválidos.');
  }
  return parsed.data;
}

async function dispatch(operations: ReadOnlyOperations, name: string, args: unknown): Promise<unknown> {
  switch (name) {
    case 'listDatabases':
      parseArguments(toolSchemas.listDatabases, args);
      return operations.listDatabases();
    case 'listCollections': {
      const input = parseArguments(toolSchemas.listCollections, args);
      return operations.listCollections(input.database);
    }
    case 'find':
      return operations.find(parseArguments(toolSchemas.find, args));
    case 'findOne':
      return operations.findOne(parseArguments(toolSchemas.findOne, args));
    case 'countDocuments':
      return operations.countDocuments(parseArguments(toolSchemas.countDocuments, args));
    case 'distinct':
      return operations.distinct(parseArguments(toolSchemas.distinct, args));
    default:
      throw new PolicyError('Tool não disponível.');
  }
}

function successResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new OutputLimitError();
  }
  const result: CallToolResult = { content: [{ type: 'text', text }] };
  if (utf8Bytes(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) {
    throw new OutputLimitError();
  }
  return result;
}

function errorResult(error: unknown): CallToolResult {
  const oidcError = findOidcError(error);
  const message = error instanceof PolicyError || error instanceof OutputLimitError || error instanceof ConfigurationError
    ? error.message
    : oidcError?.message ?? 'Falha ao consultar o MongoDB. Verifique a conexão, a autenticação e as permissões.';
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function createMcpServer(operations: ReadOnlyOperations | (() => Promise<ReadOnlyOperations>)): Server {
  const server = new Server(
    serverInfo(),
    { capabilities: { tools: { listChanged: false }, logging: {} } },
  );
  const listed = tools.map((tool) => (toolIcons.length > 0 ? { ...tool, icons: toolIcons } : tool));
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(rawCallSchema, async (request) => {
    try {
      const configured = typeof operations === 'function' ? await operations() : operations;
      return successResult(await dispatch(configured, request.params.name, request.params.arguments));
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
