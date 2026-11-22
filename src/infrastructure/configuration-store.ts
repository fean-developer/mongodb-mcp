import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ConnectionString } from 'mongodb-connection-string-url';
import { ConfigurationError, MissingConfigurationError, loadConfiguration } from './configuration.js';
import type { Configuration, Environment } from './configuration.js';
import {
  ensurePrivateDirectory,
  hasCode,
  InvalidPrivateFileError,
  isInside,
  readPrivateFile,
  writePrivateFile,
} from './private-file.js';
import { isSecretReference, readSecret } from './secret-store.js';
import type { SecretReference, SecretStore, SecretStoreName } from './secret-store.js';

export const connectionVariables: readonly string[] = [
  'MONGODB_URI',
  'MONGODB_AUTH_MODE',
  'MONGODB_USERNAME',
  'MONGODB_PASSWORD',
  'MONGODB_AUTH_SOURCE',
  'MONGODB_ALLOWED_DATABASES',
  'MONGODB_ALLOWED_COLLECTIONS',
  'MONGODB_ALLOWED_FIELDS',
  'MONGODB_QUERY_TIMEOUT_MS',
  'MONGODB_ONLY_READ',
  'MONGODB_OIDC_ISSUER',
  'MONGODB_OIDC_CLIENT_ID',
  'MONGODB_OIDC_MONGO_HOSTS',
  'MONGODB_OIDC_PROVIDER_HOSTS',
  'MONGODB_OIDC_ALLOWED_SCOPES',
  'MONGODB_OIDC_REDIRECT_URI',
];
const variableNames = new Set(connectionVariables);
const maxFileBytes = 1_048_576;
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

export type VariableSource = 'ambiente' | 'arquivo' | 'prompt';
export type VariableSources = Record<string, VariableSource>;
export type TargetKind = 'explicit-file' | 'profile' | 'default';
export type SecretStoreLookup = (name: SecretStoreName) => SecretStore;

export interface ConfigurationTarget {
  readonly kind: TargetKind;
  readonly path: string;
  readonly appDirectory: string;
  readonly profile?: string;
}

export interface StoredConfiguration {
  readonly format: 1 | 2;
  readonly variables: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, SecretReference>>;
  readonly text: string;
}

export function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function isConnectionVariable(name: string): boolean {
  return variableNames.has(name);
}

/** Expande `~/` (somente o home do usuário atual) e exige caminho absoluto. */
export function expandHome(path: string, name = 'MONGODB_MCP_CONFIG'): string {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded)) {
    throw new ConfigurationError(`${name} deve ser um caminho absoluto.`);
  }
  return expanded;
}

export function applicationDirectory(env: Environment): string {
  const configuredRoot = process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME;
  const root = hasValue(configuredRoot) && isAbsolute(configuredRoot)
    ? configuredRoot
    : join(homedir(), '.config');
  return join(root, 'mongodb-readonly-mcp');
}

export function configurationFilePath(env: Environment): string {
  if (hasValue(env.MONGODB_MCP_CONFIG)) {
    return expandHome(env.MONGODB_MCP_CONFIG.trim());
  }
  return join(applicationDirectory(env), 'config.json');
}

export function validateProfileName(name: string): string {
  if (!profilePattern.test(name)) {
    throw new ConfigurationError(
      'Nome de perfil inválido: use de 1 a 63 caracteres entre a-z, 0-9, "_" e "-", começando por letra ou número.',
    );
  }
  return name;
}

export function profilesDirectory(env: Environment): string {
  return join(applicationDirectory(env), 'profiles');
}

export function profilePath(env: Environment, name: string): string {
  return join(profilesDirectory(env), `${validateProfileName(name)}.json`);
}

/** Destino da configuração: MONGODB_MCP_CONFIG, perfil (--profile/MONGODB_MCP_PROFILE) ou arquivo padrão. */
export function resolveTarget(env: Environment, profile?: string): ConfigurationTarget {
  const appDirectory = applicationDirectory(env);
  const requestedProfile = profile ?? (hasValue(env.MONGODB_MCP_PROFILE) ? env.MONGODB_MCP_PROFILE.trim() : undefined);
  if (requestedProfile !== undefined && hasValue(env.MONGODB_MCP_CONFIG)) {
    throw new ConfigurationError('Use MONGODB_MCP_CONFIG ou --profile (MONGODB_MCP_PROFILE), não ambos.');
  }
  if (requestedProfile !== undefined) {
    return { kind: 'profile', path: profilePath(env, requestedProfile), appDirectory, profile: requestedProfile };
  }
  if (hasValue(env.MONGODB_MCP_CONFIG)) {
    return { kind: 'explicit-file', path: configurationFilePath(env), appDirectory };
  }
  return { kind: 'default', path: configurationFilePath(env), appDirectory };
}

export function describeTarget(target: ConfigurationTarget): string {
  if (target.kind === 'profile') {
    return `perfil ${target.profile ?? ''}`;
  }
  return target.kind === 'explicit-file' ? 'arquivo explícito (MONGODB_MCP_CONFIG)' : 'arquivo padrão compartilhado';
}

export async function listProfiles(env: Environment): Promise<string[]> {
  try {
    return (await readdir(profilesDirectory(env)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((name) => profilePattern.test(name))
      .sort();
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return [];
    }
    throw new ConfigurationError(`Não foi possível listar os perfis em ${profilesDirectory(env)}.`);
  }
}

function invalidSchema(path: string): InvalidPrivateFileError {
  return new InvalidPrivateFileError('schema', path, 'A configuração privada contém variáveis não suportadas ou valores inválidos.');
}

function parseVariables(value: object, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(value)) {
    if (!variableNames.has(name) || typeof content !== 'string') {
      throw invalidSchema(path);
    }
    result[name] = content;
  }
  return result;
}

/** Lê o arquivo (formato 1 ou 2) sem resolver segredos. Retorna undefined se não existir. */
export async function readStoredConfiguration(path: string): Promise<StoredConfiguration | undefined> {
  const text = await readPrivateFile(path, maxFileBytes);
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidPrivateFileError('json', path, 'Não foi possível ler a configuração privada; verifique o JSON e as permissões.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPrivateFileError('schema', path, 'A configuração privada deve conter um objeto JSON de variáveis MongoDB.');
  }
  if (!('version' in value)) {
    return { format: 1, variables: parseVariables(value, path), secrets: {}, text };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (record.version !== 2 || keys !== 'secrets,variables,version'
    || typeof record.variables !== 'object' || record.variables === null || Array.isArray(record.variables)
    || typeof record.secrets !== 'object' || record.secrets === null || Array.isArray(record.secrets)) {
    throw invalidSchema(path);
  }
  const variables = parseVariables(record.variables, path);
  const secrets: Record<string, SecretReference> = {};
  for (const [name, reference] of Object.entries(record.secrets)) {
    if (!variableNames.has(name) || Object.hasOwn(variables, name) || !isSecretReference(reference)) {
      throw invalidSchema(path);
    }
    secrets[name] = reference;
  }
  return { format: 2, variables, secrets, text };
}

/** Resolve os segredos do cofre e devolve todas as variáveis em texto, somente em memória. */
export async function resolveStoredValues(
  stored: StoredConfiguration,
  stores?: SecretStoreLookup,
): Promise<Record<string, string>> {
  const result: Record<string, string> = { ...stored.variables };
  for (const [name, reference] of Object.entries(stored.secrets)) {
    result[name] = await readSecret(reference, name, stores);
  }
  return result;
}

export function storedReferences(stored: StoredConfiguration | undefined): SecretReference[] {
  return stored === undefined ? [] : Object.values(stored.secrets);
}

export interface ResolvedEnvironment {
  readonly values: Record<string, string | undefined>;
  readonly sources: VariableSources;
  /** Variáveis do ambiente que sobrepuseram valores diferentes do arquivo. */
  readonly overridden: readonly string[];
  readonly path: string;
  readonly fileFound: boolean;
}

/**
 * Lê o arquivo de `path` (ou o caminho derivado do ambiente) e, com `merge`, aplica as variáveis
 * não vazias do ambiente por cima. Sem `merge`, as MONGODB_* do ambiente são ignoradas.
 */
export async function resolveEnvironmentWithSources(
  env: Environment,
  options: { readonly path?: string; readonly merge?: boolean; readonly stores?: SecretStoreLookup } = {},
): Promise<ResolvedEnvironment> {
  const path = options.path ?? configurationFilePath(env);
  const merge = options.merge ?? true;
  const stored = await readStoredConfiguration(path);
  const saved = stored === undefined ? {} : await resolveStoredValues(stored, options.stores);
  const values: Record<string, string | undefined> = merge ? { ...env } : withoutConnectionVariables(env);
  const sources: VariableSources = {};
  const overridden: string[] = [];
  for (const name of connectionVariables) {
    const fromEnvironment = env[name];
    const fromFile = saved[name];
    if (merge && hasValue(fromEnvironment)) {
      sources[name] = 'ambiente';
      if (fromFile !== undefined && fromFile !== fromEnvironment) {
        overridden.push(name);
      }
    } else if (fromFile !== undefined) {
      values[name] = fromFile;
      sources[name] = 'arquivo';
    }
  }
  return { values, sources, overridden, path, fileFound: stored !== undefined };
}

export async function resolveEnvironment(env: Environment): Promise<Record<string, string | undefined>> {
  return (await resolveEnvironmentWithSources(env)).values;
}

export function withoutConnectionVariables(env: Environment): Record<string, string | undefined> {
  const result = { ...env };
  for (const name of variableNames) {
    delete result[name];
  }
  return result;
}

// Uma fonte explícita (MONGODB_MCP_CONFIG ou MONGODB_MCP_PROFILE) torna o arquivo a única fonte.
export function serverEnvironment(env: Environment): Environment {
  return hasValue(env.MONGODB_MCP_CONFIG) || hasValue(env.MONGODB_MCP_PROFILE) ? withoutConnectionVariables(env) : env;
}

function namesBySource(sources: VariableSources, source: VariableSource): string[] {
  return connectionVariables.filter((name) => sources[name] === source);
}

export interface ExplainOptions {
  /** Descrição do arquivo de origem; omitida nas mensagens devolvidas às tools. */
  readonly location?: string;
  /** Ambiente e arquivo foram mesclados (precedência do ambiente). */
  readonly merged?: boolean;
  readonly update?: boolean;
}

export function explainConfigurationError(
  error: ConfigurationError,
  env: Environment,
  sources?: VariableSources,
  options: ExplainOptions = {},
): ConfigurationError {
  if (error instanceof MissingConfigurationError) {
    return error;
  }
  const fromEnvironment = sources === undefined
    ? connectionVariables.filter((name) => hasValue(env[name]))
    : namesBySource(sources, 'ambiente');
  const fromFile = sources === undefined ? [] : namesBySource(sources, 'arquivo');
  const parts = [error.message];
  if (fromFile.length > 0) {
    parts.push(`Valores vindos do arquivo ${options.location ?? 'salvo'}: ${fromFile.join(', ')}.`);
  }
  if (fromEnvironment.length > 0) {
    if (options.merged ?? true) {
      parts.push(
        `Variáveis definidas no ambiente têm precedência sobre o arquivo salvo: ${fromEnvironment.join(', ')}. `
        + 'Remova-as do ambiente (unset) ou corrija-as; o cliente MCP herda o ambiente em que foi aberto. '
        + 'Alternativa: defina MONGODB_MCP_CONFIG ou MONGODB_MCP_PROFILE no env do servidor MCP para usar somente o arquivo.',
      );
    } else {
      parts.push(`Valores importados do ambiente: ${fromEnvironment.join(', ')}.`);
    }
  }
  if (options.update === true) {
    parts.push('Execute sem --update para substituir a configuração salva.');
  }
  return parts.length === 1 ? error : new ConfigurationError(parts.join(' '));
}

/** Hosts da URI, sem userinfo nem opções. */
export function configurationHosts(uri: string): string[] {
  try {
    return [...new ConnectionString(uri).hosts];
  } catch {
    return [];
  }
}

function userDefined(configuration: Configuration): string {
  const { connection } = configuration;
  if (connection.mode === 'scram') {
    return 'definido';
  }
  if (connection.mode !== 'uri') {
    return 'não se aplica';
  }
  try {
    return new ConnectionString(connection.uri).username === '' ? 'não definido' : 'definido';
  } catch {
    return 'não definido';
  }
}

export interface DescribeOptions {
  readonly sourceKind?: string;
  readonly fingerprint?: string;
  readonly binding?: string;
}

/** Resumo seguro: nunca inclui URI, senha, userinfo, client ID nem JSON bruto. */
export function describeConfiguration(
  configuration: Configuration,
  sources: VariableSources,
  path: string,
  options: DescribeOptions = {},
): string[] {
  const { policy } = configuration;
  const databases = policy.allowedDatabaseNames === undefined ? 'todos os acessíveis' : [...policy.allowedDatabaseNames].join(', ');
  const hosts = configurationHosts(configuration.connection.uri);
  const lines = [`Arquivo: ${path}`];
  if (options.sourceKind !== undefined) {
    lines.push(`Fonte: ${options.sourceKind}`);
  }
  lines.push(
    `Modo de autenticação: ${configuration.connection.mode}`,
    `Hosts: ${hosts.length === 0 ? 'não identificados' : hosts.join(', ')}`,
    `Usuário: ${userDefined(configuration)}`,
    `Bancos permitidos: ${databases}`,
    `Coleções restritas: ${policy.allowedCollectionNames.size > 0 ? 'sim' : 'não'}; campos restritos: ${policy.allowedFields.size > 0 ? 'sim' : 'não'}`,
    `Somente leitura: ${configuration.readOnly ? 'sim' : 'não'}; timeout: ${configuration.queryTimeoutMs} ms`,
  );
  const origins = (['ambiente', 'arquivo', 'prompt'] as const)
    .map((source) => [source, namesBySource(sources, source)] as const)
    .filter(([, names]) => names.length > 0)
    .map(([source, names]) => `${source}: ${names.join(', ')}`);
  if (origins.length > 0) {
    lines.push(`Origem: ${origins.join('; ')}`);
  }
  if (options.fingerprint !== undefined) {
    lines.push(`Fingerprint: ${options.fingerprint}`);
  }
  if (options.binding !== undefined) {
    lines.push(`Vínculo do workspace: ${options.binding}`);
  }
  return lines;
}

/** Variáveis que devem ir para o cofre: senha e URI com senha no userinfo. */
export function secretVariables(values: Environment): string[] {
  const result: string[] = [];
  if (hasValue(values.MONGODB_URI)) {
    try {
      if (new ConnectionString(values.MONGODB_URI).password !== '') {
        result.push('MONGODB_URI');
      }
    } catch {
      // URI inválida é rejeitada por loadConfiguration.
    }
  }
  if (hasValue(values.MONGODB_PASSWORD)) {
    result.push('MONGODB_PASSWORD');
  }
  return result;
}

export function connectionValues(values: Environment): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of connectionVariables) {
    const value = values[name];
    if (hasValue(value)) {
      result[name] = value;
    }
  }
  return result;
}

/** Serializa no formato 1 (sem cofre) ou 2 (com referências de segredo). */
export function serializeConfiguration(values: Environment, secrets: Readonly<Record<string, SecretReference>> = {}): string {
  const plain = connectionValues(values);
  let document: object;
  if (Object.keys(secrets).length === 0) {
    document = plain;
  } else {
    for (const name of Object.keys(secrets)) {
      delete plain[name];
    }
    document = { version: 2, variables: plain, secrets };
  }
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > maxFileBytes) {
    throw new ConfigurationError('A configuração privada excede o limite de 1 MiB.');
  }
  return text;
}

/** Garante o diretório privado do destino e grava o texto de forma atômica e durável. */
export async function writeConfigurationText(target: Pick<ConfigurationTarget, 'path' | 'appDirectory'>, text: string): Promise<void> {
  await ensurePrivateDirectory(dirname(target.path), target.appDirectory);
  await writePrivateFile(target.path, text);
}

export function isOutsideApplicationDirectory(target: Pick<ConfigurationTarget, 'path' | 'appDirectory'>): boolean {
  return !isInside(dirname(target.path), target.appDirectory);
}

/** Compatível com versões anteriores: valida e grava as variáveis em texto (formato 1). */
export async function saveEnvironment(env: Environment): Promise<string> {
  loadConfiguration(env);
  const target = resolveTarget({ ...env, MONGODB_MCP_PROFILE: undefined });
  await writeConfigurationText(target, serializeConfiguration(env));
  return target.path;
}
