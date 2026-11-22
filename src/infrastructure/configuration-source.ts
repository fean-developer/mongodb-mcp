import { ConfigurationError, loadConfiguration } from './configuration.js';
import type { Configuration, Environment } from './configuration.js';
import {
  applicationDirectory,
  configurationFilePath,
  connectionVariables,
  explainConfigurationError,
  hasValue,
  profilePath,
  resolveEnvironmentWithSources,
  validateProfileName,
} from './configuration-store.js';
import type { ResolvedEnvironment, SecretStoreLookup, VariableSources } from './configuration-store.js';
import { computeFingerprint, loadFingerprintKey } from './fingerprint.js';
import { canonicalWorkspace, readBinding } from './workspace-binding.js';

export type ServerSourceKind = 'explicit-file' | 'profile' | 'binding' | 'default';

export interface ServerSource {
  readonly kind: ServerSourceKind;
  readonly path: string;
  readonly appDirectory: string;
  readonly profile?: string;
  /** Workspace canônico cujo vínculo exige verificação de fingerprint. */
  readonly verifiedWorkspace?: string;
}

export function describeSourceKind(source: ServerSource): string {
  switch (source.kind) {
    case 'explicit-file':
      return 'MONGODB_MCP_CONFIG';
    case 'profile':
      return `perfil ${source.profile ?? ''}${source.verifiedWorkspace === undefined ? '' : ' (vínculo verificado)'}`;
    case 'binding':
      return `vínculo do workspace (perfil ${source.profile ?? ''})`;
    default:
      return 'arquivo padrão compartilhado';
  }
}

/**
 * Decide uma única vez, na inicialização, de onde o servidor lê a configuração:
 * MONGODB_MCP_CONFIG, MONGODB_MCP_PROFILE, vínculo de MONGODB_MCP_WORKSPACE ou o arquivo padrão.
 */
export async function resolveServerSource(env: Environment, warn: (message: string) => void): Promise<ServerSource> {
  const appDirectory = applicationDirectory(env);
  const hasConfig = hasValue(env.MONGODB_MCP_CONFIG);
  const hasProfile = hasValue(env.MONGODB_MCP_PROFILE);
  if (hasConfig && hasProfile) {
    throw new ConfigurationError('Use MONGODB_MCP_CONFIG ou MONGODB_MCP_PROFILE, não ambos.');
  }
  if (hasConfig) {
    return { kind: 'explicit-file', path: configurationFilePath(env), appDirectory };
  }
  const workspace = hasValue(env.MONGODB_MCP_WORKSPACE) ? await canonicalWorkspace(env.MONGODB_MCP_WORKSPACE.trim()) : undefined;
  const binding = workspace === undefined ? undefined : await readBinding(appDirectory, workspace);
  if (hasProfile) {
    const profile = validateProfileName((env.MONGODB_MCP_PROFILE ?? '').trim());
    const path = profilePath(env, profile);
    if (binding !== undefined && binding.profile !== profile) {
      warn(`Aviso: o workspace está vinculado ao perfil "${binding.profile}", mas MONGODB_MCP_PROFILE=${profile}; usando ${profile} sem verificação de fingerprint.`);
    }
    return binding?.profile === profile && workspace !== undefined
      ? { kind: 'profile', path, appDirectory, profile, verifiedWorkspace: workspace }
      : { kind: 'profile', path, appDirectory, profile };
  }
  if (binding !== undefined && workspace !== undefined) {
    return {
      kind: 'binding',
      path: profilePath(env, binding.profile),
      appDirectory,
      profile: binding.profile,
      verifiedWorkspace: workspace,
    };
  }
  if (workspace !== undefined) {
    warn(`Aviso: nenhum perfil vinculado ao workspace ${workspace}; usando o arquivo padrão compartilhado. Use mongodb-readonly-mcp-configure --profile <nome> --bind para isolar este projeto.`);
  }
  return { kind: 'default', path: configurationFilePath(env), appDirectory };
}

export interface LoadedConfiguration {
  readonly configuration: Configuration;
  readonly sources: VariableSources;
  readonly overridden: readonly string[];
  readonly fingerprint?: string;
}

async function verifyFingerprint(source: ServerSource, resolved: ResolvedEnvironment): Promise<string> {
  const workspace = source.verifiedWorkspace ?? '';
  const profile = source.profile ?? '';
  const binding = await readBinding(source.appDirectory, workspace);
  if (binding?.profile !== profile) {
    throw new ConfigurationError('O vínculo deste workspace foi removido ou alterado. Reinicie o servidor MCP para aplicar a mudança.');
  }
  const key = await loadFingerprintKey(source.appDirectory, false);
  if (key === undefined) {
    throw new ConfigurationError(`A chave de fingerprint não existe. Execute mongodb-readonly-mcp-configure --profile ${profile} --bind neste workspace.`);
  }
  const fingerprint = computeFingerprint(key, resolved.values, connectionVariables);
  if (fingerprint !== binding.fingerprint) {
    throw new ConfigurationError(
      `A configuração do perfil "${profile}" mudou desde o vínculo deste workspace. `
      + `Execute mongodb-readonly-mcp-configure --profile ${profile} --bind neste workspace para aceitar a mudança.`,
    );
  }
  return fingerprint;
}

/**
 * Carrega a configuração da fonte resolvida. Fontes explícitas usam somente o arquivo;
 * o arquivo padrão mantém a precedência das variáveis do ambiente.
 */
export async function loadFromSource(
  source: ServerSource,
  env: Environment,
  warn: (message: string) => void,
  stores?: SecretStoreLookup,
): Promise<LoadedConfiguration> {
  const merge = source.kind === 'default';
  const resolved = await resolveEnvironmentWithSources(env, {
    path: source.path,
    merge,
    ...(stores === undefined ? {} : { stores }),
  });
  if (!resolved.fileFound && source.kind !== 'default') {
    warn(`Arquivo de configuração explícito não encontrado: ${source.path}`);
  }
  if (resolved.overridden.length > 0) {
    warn(`Aviso: variáveis do ambiente sobrepõem o arquivo ${source.path}: ${resolved.overridden.join(', ')}.`);
  }
  const fingerprint = source.verifiedWorkspace === undefined ? undefined : await verifyFingerprint(source, resolved);
  let configuration;
  try {
    configuration = loadConfiguration(resolved.values);
  } catch (error) {
    throw error instanceof ConfigurationError
      ? explainConfigurationError(error, env, resolved.sources, { merged: merge })
      : error;
  }
  return {
    configuration,
    sources: resolved.sources,
    overridden: resolved.overridden,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}
