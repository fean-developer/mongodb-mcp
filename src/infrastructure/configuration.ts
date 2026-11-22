import { ConnectionString } from 'mongodb-connection-string-url';
import {
  PolicyError,
  isValidCollectionName,
  isValidDatabaseName,
  utf8Bytes,
  validateFieldName,
} from '../domain/query.js';
import type { AccessPolicy } from '../domain/query.js';

export type Environment = Readonly<Record<string, string | undefined>>;
export type AuthMode = 'none' | 'uri' | 'scram' | 'oidc';

export interface OidcConfiguration {
  readonly issuer: string;
  readonly clientId: string;
  readonly mongoHosts: readonly string[];
  readonly providerHosts: ReadonlySet<string>;
  readonly allowedScopes: ReadonlySet<string>;
  readonly redirectUri: string;
}

export type ConnectionConfiguration =
  | { readonly mode: 'none'; readonly uri: string }
  | { readonly mode: 'uri'; readonly uri: string }
  | {
      readonly mode: 'scram';
      readonly uri: string;
      readonly username: string;
      readonly password: string;
      readonly authSource?: string;
    }
  | { readonly mode: 'oidc'; readonly uri: string; readonly oidc: OidcConfiguration };

export interface Configuration {
  readonly connection: ConnectionConfiguration;
  readonly policy: AccessPolicy;
  readonly queryTimeoutMs: number;
  readonly readOnly: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export class MissingConfigurationError extends ConfigurationError {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    super(
      `Configuração necessária: ${variables.join(', ')}. Configure no ambiente ou execute `
      + 'mongodb-readonly-mcp-configure (instalação global) ou npm run configure (repositório) no terminal '
      + 'do mesmo ambiente em que o MCP é executado e tente a tool novamente. '
      + 'Não envie URI, usuário ou senha pelo chat.',
    );
    this.name = 'MissingConfigurationError';
    this.variables = variables;
  }
}

const commonVariables = [
  'MONGODB_URI',
] as const;
const oidcVariables = [
  'MONGODB_OIDC_ISSUER',
  'MONGODB_OIDC_CLIENT_ID',
  'MONGODB_OIDC_MONGO_HOSTS',
  'MONGODB_OIDC_PROVIDER_HOSTS',
] as const;
const maxPolicyEntries = 100;
const maxPolicyBytes = 65_536;

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export function isAuthMode(value: string | undefined): value is AuthMode {
  return value === 'none' || value === 'uri' || value === 'scram' || value === 'oidc';
}

function inferredAuthMode(env: Environment): AuthMode {
  if (isPresent(env.MONGODB_AUTH_MODE)) {
    if (!isAuthMode(env.MONGODB_AUTH_MODE)) {
      throw new ConfigurationError('MONGODB_AUTH_MODE deve ser none, uri, scram ou oidc.');
    }
    return env.MONGODB_AUTH_MODE;
  }
  if (Object.entries(env).some(([name, value]) => name.startsWith('MONGODB_OIDC_') && isPresent(value))) {
    return 'oidc';
  }
  if (isPresent(env.MONGODB_USERNAME) || isPresent(env.MONGODB_PASSWORD) || isPresent(env.MONGODB_AUTH_SOURCE)) {
    return 'scram';
  }
  const uri = env.MONGODB_URI;
  if (isPresent(uri)) {
    const query = uri.split('?', 2)[1]?.split('#', 1)[0] ?? '';
    const options = [...new URLSearchParams(query).entries()];
    const mechanism = options.find(([name]) => name.toLowerCase() === 'authmechanism')?.[1]?.toUpperCase();
    if (mechanism === 'MONGODB-OIDC') {
      return 'oidc';
    }
    if (hasUriUserInfo(uri) || mechanism === 'MONGODB-X509' || mechanism === 'MONGODB-AWS') {
      return 'uri';
    }
    if (options.some(([name]) => ['authmechanism', 'authmechanismproperties', 'authsource'].includes(name.toLowerCase()))) {
      return 'scram';
    }
  }
  return 'none';
}

export function missingConfiguration(env: Environment): readonly string[] {
  const required: string[] = [...commonVariables];
  const modeSpecified = isPresent(env.MONGODB_AUTH_MODE);
  const hasModeSignal = modeSpecified
    || isPresent(env.MONGODB_URI)
    || isPresent(env.MONGODB_USERNAME)
    || isPresent(env.MONGODB_PASSWORD)
    || isPresent(env.MONGODB_AUTH_SOURCE)
    || Object.entries(env).some(([name, value]) => name.startsWith('MONGODB_OIDC_') && isPresent(value));
  if (hasModeSignal && modeSpecified && !isAuthMode(env.MONGODB_AUTH_MODE)) {
    return required.filter((name) => !isPresent(env[name]));
  }
  if (hasModeSignal && inferredAuthMode(env) === 'scram') {
    required.push('MONGODB_USERNAME', 'MONGODB_PASSWORD');
  } else if (hasModeSignal && inferredAuthMode(env) === 'oidc') {
    required.push(...oidcVariables);
  }
  return required.filter((name) => !isPresent(env[name]));
}

function requireValue(env: Environment, name: string): string {
  const value = env[name];
  if (!isPresent(value)) {
    throw new ConfigurationError(`Variável obrigatória ausente: ${name}.`);
  }
  return value;
}

function parseJsonObject(value: string, variableName: string): Record<string, unknown> {
  if (utf8Bytes(value) > maxPolicyBytes) {
    throw new ConfigurationError(`${variableName} excede o limite permitido.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigurationError(`${variableName} deve conter um objeto JSON válido.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`${variableName} deve conter um objeto JSON válido.`);
  }
  return parsed as Record<string, unknown>;
}

function stringList(value: unknown, variableName: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxPolicyEntries) {
    throw new ConfigurationError(`${variableName} deve conter listas não vazias de até 100 itens.`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || result.includes(item)) {
      throw new ConfigurationError(`${variableName} contém itens inválidos ou duplicados.`);
    }
    result.push(item);
  }
  return result;
}

function policyFromEnvironment(env: Environment): AccessPolicy {
  const rawDatabaseNames = env.MONGODB_ALLOWED_DATABASES;
  let allowedDatabaseNames: Set<string> | undefined;
  if (isPresent(rawDatabaseNames)) {
    const databaseNames = rawDatabaseNames.split(',').map((name) => name.trim());
    if (databaseNames.length > maxPolicyEntries || databaseNames.some((name) => !isValidDatabaseName(name))
      || new Set(databaseNames).size !== databaseNames.length) {
      throw new ConfigurationError('MONGODB_ALLOWED_DATABASES contém bancos inválidos ou duplicados.');
    }
    allowedDatabaseNames = new Set(databaseNames);
  }
  const allowedCollectionNames = new Map<string, ReadonlySet<string>>();
  const rawCollections = env.MONGODB_ALLOWED_COLLECTIONS;
  if (isPresent(rawCollections)) {
    const collectionConfig = parseJsonObject(rawCollections, 'MONGODB_ALLOWED_COLLECTIONS');
    if (Object.keys(collectionConfig).length === 0) {
      throw new ConfigurationError('MONGODB_ALLOWED_COLLECTIONS deve restringir ao menos um banco.');
    }
    for (const [database, value] of Object.entries(collectionConfig)) {
      if (!isValidDatabaseName(database) || (allowedDatabaseNames !== undefined && !allowedDatabaseNames.has(database))) {
        throw new ConfigurationError('MONGODB_ALLOWED_COLLECTIONS contém um banco não autorizado.');
      }
      const names = stringList(value, 'MONGODB_ALLOWED_COLLECTIONS');
      if (names.some((name) => !isValidCollectionName(name))) {
        throw new ConfigurationError('MONGODB_ALLOWED_COLLECTIONS contém coleções inválidas.');
      }
      allowedCollectionNames.set(database, new Set(names));
    }
  }

  const allowedFields = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  const rawFields = env.MONGODB_ALLOWED_FIELDS;
  if (isPresent(rawFields)) {
    const fieldConfig = parseJsonObject(rawFields, 'MONGODB_ALLOWED_FIELDS');
    for (const [database, collections] of Object.entries(fieldConfig)) {
      if (!isValidDatabaseName(database)
        || (allowedDatabaseNames !== undefined && !allowedDatabaseNames.has(database))
        || typeof collections !== 'object' || collections === null || Array.isArray(collections)) {
        throw new ConfigurationError('MONGODB_ALLOWED_FIELDS contém uma configuração inválida.');
      }
      const allowedCollections = allowedCollectionNames.get(database);
      const fieldSets = new Map<string, ReadonlySet<string>>();
      for (const [collection, value] of Object.entries(collections)) {
        if (!isValidCollectionName(collection) || (allowedCollections !== undefined && !allowedCollections.has(collection))) {
          throw new ConfigurationError('MONGODB_ALLOWED_FIELDS contém uma coleção não autorizada.');
        }
        const fields = stringList(value, 'MONGODB_ALLOWED_FIELDS');
        try {
          fields.forEach(validateFieldName);
        } catch (error) {
          if (error instanceof PolicyError) {
            throw new ConfigurationError('MONGODB_ALLOWED_FIELDS contém campos inválidos.');
          }
          throw error;
        }
        if (fields.some((field) => field.startsWith('_id.')
          || fields.some((other) => other !== field && other.startsWith(`${field}.`)))) {
          throw new ConfigurationError('MONGODB_ALLOWED_FIELDS contém caminhos sobrepostos ou _id parcial.');
        }
        fieldSets.set(collection, new Set(fields));
      }
      allowedFields.set(database, fieldSets);
    }
  }
  return {
    allowedDatabaseNames,
    allowedCollectionNames,
    allowedFields,
  };
}

function parseUri(uri: string): ConnectionString {
  if (utf8Bytes(uri) > 16_384) {
    throw new ConfigurationError('MONGODB_URI excede o limite permitido.');
  }
  try {
    return new ConnectionString(uri);
  } catch {
    throw new ConfigurationError('MONGODB_URI deve ser uma connection string MongoDB válida.');
  }
}

function uriOptions(parsed: ConnectionString): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  for (const [name, value] of parsed.searchParams) {
    const key = name.toLowerCase();
    if (options.has(key)) {
      throw new ConfigurationError('MONGODB_URI contém uma opção duplicada.');
    }
    options.set(key, value);
  }
  for (const name of [
    'tlsinsecure',
    'tlsallowinvalidcertificates',
    'tlsallowinvalidhostnames',
    'tlsdisablecertificaterevocationcheck',
    'tlsdisableocspendpointcheck',
  ]) {
    const value = options.get(name);
    if (value !== undefined && value.toLowerCase() !== 'false') {
      throw new ConfigurationError('MONGODB_URI contém uma opção TLS insegura.');
    }
  }
  const sslValidate = options.get('sslvalidate');
  if (sslValidate !== undefined && sslValidate.toLowerCase() !== 'true') {
    throw new ConfigurationError('MONGODB_URI contém uma opção TLS insegura.');
  }
  return options;
}

function hasUriUserInfo(uri: string): boolean {
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/u, 1)[0];
  return authority?.includes('@') ?? false;
}

function rejectSeparateCredentials(env: Environment): void {
  if (isPresent(env.MONGODB_USERNAME) || isPresent(env.MONGODB_PASSWORD) || isPresent(env.MONGODB_AUTH_SOURCE)) {
    throw new ConfigurationError('Credenciais separadas só são aceitas no modo scram.');
  }
}

function commaSeparated(value: string, name: string): string[] {
  const items = value.split(',').map((item) => item.trim().toLowerCase());
  if (items.length === 0 || items.length > maxPolicyEntries || items.some((item) => item.length === 0)
    || new Set(items).size !== items.length) {
    throw new ConfigurationError(`${name} contém valores inválidos ou duplicados.`);
  }
  return items;
}

function mongoHosts(env: Environment): string[] {
  const hosts = commaSeparated(requireValue(env, 'MONGODB_OIDC_MONGO_HOSTS'), 'MONGODB_OIDC_MONGO_HOSTS');
  for (const host of hosts) {
    const base = host.startsWith('*.') ? host.slice(2) : host;
    if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/u.test(base)
      || base.includes('..') || base.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))) {
      throw new ConfigurationError('MONGODB_OIDC_MONGO_HOSTS contém hosts inválidos.');
    }
  }
  return hosts;
}

function matchesMongoHost(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((allowed) => {
    if (allowed === host) {
      return true;
    }
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    return false;
  });
}

function providerHosts(env: Environment): ReadonlySet<string> {
  const hosts = commaSeparated(requireValue(env, 'MONGODB_OIDC_PROVIDER_HOSTS'), 'MONGODB_OIDC_PROVIDER_HOSTS');
  for (const host of hosts) {
    try {
      const url = new URL(`https://${host}`);
      if (url.host !== host || url.username !== '' || url.password !== '' || url.pathname !== '/') {
        throw new Error();
      }
    } catch {
      throw new ConfigurationError('MONGODB_OIDC_PROVIDER_HOSTS contém hosts inválidos.');
    }
  }
  return new Set(hosts);
}

function oidcConfiguration(env: Environment, parsed: ConnectionString, options: ReadonlyMap<string, string>): OidcConfiguration {
  const issuer = requireValue(env, 'MONGODB_OIDC_ISSUER');
  const allowedProviderHosts = providerHosts(env);
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.search !== '' || url.hash !== '' || !allowedProviderHosts.has(url.host.toLowerCase())) {
      throw new Error();
    }
  } catch {
    throw new ConfigurationError('MONGODB_OIDC_ISSUER deve ser HTTPS e usar um host autorizado.');
  }
  const allowedMongoHosts = mongoHosts(env);
  for (const host of parsed.hosts) {
    let hostname: string;
    try {
      hostname = new URL(`mongodb://${host}`).hostname.toLowerCase();
    } catch {
      throw new ConfigurationError('MONGODB_URI contém um host OIDC inválido.');
    }
    if (!matchesMongoHost(hostname, allowedMongoHosts)) {
      throw new ConfigurationError('MONGODB_URI contém um host OIDC não autorizado.');
    }
  }
  const tls = options.get('tls')?.toLowerCase();
  const ssl = options.get('ssl')?.toLowerCase();
  if (tls === 'false' || ssl === 'false' || (!parsed.isSRV && tls !== 'true' && ssl !== 'true')) {
    throw new ConfigurationError('O modo oidc exige TLS habilitado.');
  }

  const redirectUri = isPresent(env.MONGODB_OIDC_REDIRECT_URI)
    ? env.MONGODB_OIDC_REDIRECT_URI
    : 'http://127.0.0.1:8400/callback';
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
      || Number(url.port) < 1024 || url.pathname !== '/callback' || url.search !== '' || url.hash !== ''
      || url.username !== '' || url.password !== '') {
      throw new Error();
    }
  } catch {
    throw new ConfigurationError('MONGODB_OIDC_REDIRECT_URI deve ser um callback HTTP de loopback válido.');
  }
  const scopesValue = isPresent(env.MONGODB_OIDC_ALLOWED_SCOPES) ? env.MONGODB_OIDC_ALLOWED_SCOPES : 'openid';
  const scopes = scopesValue.split(',').map((scope) => scope.trim());
  if (scopes.some((scope) => scope.length === 0 || scope.length > 200 || /\s/u.test(scope))) {
    throw new ConfigurationError('MONGODB_OIDC_ALLOWED_SCOPES contém escopos inválidos.');
  }
  const allowedScopes = new Set(['openid', ...scopes]);
  return {
    issuer,
    clientId: requireValue(env, 'MONGODB_OIDC_CLIENT_ID'),
    mongoHosts: allowedMongoHosts,
    providerHosts: allowedProviderHosts,
    allowedScopes,
    redirectUri,
  };
}

function connectionFromEnvironment(env: Environment, mode: AuthMode): ConnectionConfiguration {
  const uri = requireValue(env, 'MONGODB_URI');
  const parsed = parseUri(uri);
  const options = uriOptions(parsed);
  const mechanism = options.get('authmechanism')?.toUpperCase();
  if (mode !== 'oidc' && mechanism === 'MONGODB-OIDC') {
    throw new ConfigurationError('MONGODB-OIDC exige MONGODB_AUTH_MODE=oidc.');
  }
  if (mode === 'none') {
    rejectSeparateCredentials(env);
    if (hasUriUserInfo(uri) || options.has('authmechanism')
      || options.has('authmechanismproperties') || options.has('authsource')) {
      throw new ConfigurationError('MONGODB_URI conflita com o modo sem autenticação.');
    }
    return { mode, uri };
  }
  if (mode === 'uri') {
    rejectSeparateCredentials(env);
    if (!hasUriUserInfo(uri) && mechanism !== 'MONGODB-X509' && mechanism !== 'MONGODB-AWS') {
      throw new ConfigurationError(
        'MONGODB_AUTH_MODE=uri exige uma identidade autenticada na URI. '
        + 'Para MongoDB sem autenticação, use MONGODB_AUTH_MODE=none; para credenciais separadas, use scram.',
      );
    }
    return { mode, uri };
  }
  if (mode === 'scram') {
    if (hasUriUserInfo(uri) || (mechanism !== undefined && mechanism !== 'SCRAM-SHA-256')
      || options.has('authmechanismproperties')) {
      throw new ConfigurationError('MONGODB_URI conflita com o modo scram.');
    }
    const authSource = isPresent(env.MONGODB_AUTH_SOURCE) ? env.MONGODB_AUTH_SOURCE : undefined;
    if (authSource !== undefined && options.has('authsource') && options.get('authsource') !== authSource) {
      throw new ConfigurationError('MONGODB_AUTH_SOURCE conflita com a URI.');
    }
    return {
      mode,
      uri,
      username: requireValue(env, 'MONGODB_USERNAME'),
      password: requireValue(env, 'MONGODB_PASSWORD'),
      ...(authSource === undefined ? {} : { authSource }),
    };
  }
  rejectSeparateCredentials(env);
  if (parsed.password !== '' || (mechanism !== undefined && mechanism !== 'MONGODB-OIDC')
    || options.has('authmechanismproperties')
    || (options.has('authsource') && options.get('authsource') !== '$external')) {
    throw new ConfigurationError('MONGODB_URI conflita com o modo oidc.');
  }
  return { mode, uri, oidc: oidcConfiguration(env, parsed, options) };
}

export function loadConfiguration(env: Environment): Configuration {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new ConfigurationError('NODE_TLS_REJECT_UNAUTHORIZED=0 não é permitido.');
  }
  if (isPresent(env.MONGODB_AUTH_MODE) && !isAuthMode(env.MONGODB_AUTH_MODE)) {
    throw new ConfigurationError('MONGODB_AUTH_MODE deve ser none, uri, scram ou oidc.');
  }
  const missing = missingConfiguration(env);
  if (missing.length > 0) {
    throw new MissingConfigurationError(missing);
  }
  const timeout = isPresent(env.MONGODB_QUERY_TIMEOUT_MS) ? env.MONGODB_QUERY_TIMEOUT_MS : '5000';
  if (!/^\d+$/u.test(timeout) || Number(timeout) < 100 || Number(timeout) > 30_000) {
    throw new ConfigurationError('MONGODB_QUERY_TIMEOUT_MS deve estar entre 100 e 30000.');
  }
  const onlyRead = isPresent(env.MONGODB_ONLY_READ) ? env.MONGODB_ONLY_READ.trim().toLowerCase() : 'true';
  if (onlyRead !== 'true' && onlyRead !== 'false') {
    throw new ConfigurationError('MONGODB_ONLY_READ deve ser true ou false.');
  }
  return {
    connection: connectionFromEnvironment(env, inferredAuthMode(env)),
    policy: policyFromEnvironment(env),
    queryTimeoutMs: Number(timeout),
    readOnly: onlyRead === 'true',
  };
}
