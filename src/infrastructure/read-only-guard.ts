import type { CommandStartedEvent, MongoClient } from 'mongodb';
import { PolicyError } from '../domain/query.js';

// Somente comandos de leitura, handshake/autenticação e limpeza de sessão podem sair do processo.
const readCommands = new Set([
  'aggregate',
  'authenticate',
  'buildinfo',
  'connectionstatus',
  'count',
  'distinct',
  'endsessions',
  'find',
  'getmore',
  'getnonce',
  'hello',
  'ismaster',
  'killcursors',
  'listcollections',
  'listdatabases',
  'listindexes',
  'ping',
  'saslcontinue',
  'saslstart',
]);
const writeStages = new Set(['$out', '$merge']);

// O driver copia propriedades enumeráveis ao encapsular erros (ex.: bulkWrite); `name` é só getter lá.
function hideName(error: Error, name: string): void {
  Object.defineProperty(error, 'name', { value: name, enumerable: false, configurable: true, writable: true });
}

export class ReadOnlyViolationError extends PolicyError {
  constructor() {
    super('Operação bloqueada: o MCP está configurado como somente leitura (MONGODB_ONLY_READ=true).');
    hideName(this, 'ReadOnlyViolationError');
  }
}

function hasWriteStage(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline)) {
    return true;
  }
  return pipeline.some((stage: unknown) => typeof stage !== 'object' || stage === null
    || Object.keys(stage).some((name) => writeStages.has(name)));
}

export function isReadOnlyCommand(commandName: string, command: Readonly<Record<string, unknown>>): boolean {
  const name = commandName.toLowerCase();
  if (!readCommands.has(name)) {
    return false;
  }
  return name !== 'aggregate' || !hasWriteStage(command.pipeline);
}

export class MassWriteViolationError extends PolicyError {
  constructor() {
    super('Operação bloqueada: updateMany/deleteMany com filtro vazio afetaria todos os documentos da coleção.');
    hideName(this, 'MassWriteViolationError');
  }
}

function isEmptyFilter(filter: unknown): boolean {
  if (filter === undefined || filter === null) {
    return true;
  }
  return typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0;
}

function isMassStatement(statement: unknown, filterKey: string, isMulti: (entry: Readonly<Record<string, unknown>>) => boolean): boolean {
  if (typeof statement !== 'object' || statement === null) {
    return true;
  }
  const entry = statement as Readonly<Record<string, unknown>>;
  return isMulti(entry) && isEmptyFilter(entry[filterKey]);
}

function hasMassStatement(
  statements: unknown,
  filterKey: string,
  isMulti: (entry: Readonly<Record<string, unknown>>) => boolean,
): boolean {
  // Formatos inesperados são tratados como escrita em massa (fail closed).
  return !Array.isArray(statements) || statements.some((statement) => isMassStatement(statement, filterKey, isMulti));
}

const multiUpdate = (entry: Readonly<Record<string, unknown>>): boolean => entry.multi === true;
const multiDelete = (entry: Readonly<Record<string, unknown>>): boolean => entry.limit === 0 || entry.limit === undefined;
const multiBulk = (entry: Readonly<Record<string, unknown>>): boolean => entry.multi === true
  && ('update' in entry || 'delete' in entry);

// updateMany/deleteMany (inclusive via bulkWrite) sem filtro alteram ou apagam a coleção inteira.
export function isMassWriteCommand(commandName: string, command: Readonly<Record<string, unknown>>): boolean {
  switch (commandName.toLowerCase()) {
    case 'update':
      return hasMassStatement(command.updates, 'q', multiUpdate);
    case 'delete':
      return hasMassStatement(command.deletes, 'q', multiDelete);
    case 'bulkwrite':
      return hasMassStatement(command.ops, 'filter', multiBulk);
    default:
      return false;
  }
}

// Ativo quando MONGODB_ONLY_READ=false: permite escritas, exceto em massa sem filtro.
export class MassWriteGuard {
  constructor(client: MongoClient) {
    if (client.options.monitorCommands !== true) {
      throw new MassWriteViolationError();
    }
    client.on('commandStarted', (event: CommandStartedEvent) => {
      if (isMassWriteCommand(event.commandName, event.command)) {
        throw new MassWriteViolationError();
      }
    });
  }
}

export class ReadOnlyGuard {
  private violated = false;

  constructor(client: MongoClient) {
    if (client.options.monitorCommands !== true) {
      throw new ReadOnlyViolationError();
    }
    // O driver emite commandStarted de forma síncrona antes de enviar o comando; lançar aqui impede o envio.
    client.on('commandStarted', (event: CommandStartedEvent) => {
      if (!isReadOnlyCommand(event.commandName, event.command)) {
        this.violated = true;
        throw new ReadOnlyViolationError();
      }
    });
  }

  assertIntact(): void {
    if (this.violated) {
      throw new ReadOnlyViolationError();
    }
  }
}
