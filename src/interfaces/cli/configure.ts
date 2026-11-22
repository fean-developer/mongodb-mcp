#!/usr/bin/env node
import { dirname } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { ConfigurationError, loadConfiguration } from '../../infrastructure/configuration.js';
import type { Configuration, Environment } from '../../infrastructure/configuration.js';
import {
  connectionVariables,
  describeConfiguration,
  describeTarget,
  explainConfigurationError,
  hasValue,
  isConnectionVariable,
  isOutsideApplicationDirectory,
  listProfiles,
  profilePath,
  readStoredConfiguration,
  resolveEnvironmentWithSources,
  resolveStoredValues,
  resolveTarget,
  secretVariables,
  serializeConfiguration,
  storedReferences,
  validateProfileName,
  withoutConnectionVariables,
  writeConfigurationText,
} from '../../infrastructure/configuration-store.js';
import type { ConfigurationTarget, StoredConfiguration, VariableSources } from '../../infrastructure/configuration-store.js';
import { describeSourceKind, resolveServerSource } from '../../infrastructure/configuration-source.js';
import { withFileLock } from '../../infrastructure/file-lock.js';
import { computeFingerprint, loadFingerprintKey, shortFingerprint } from '../../infrastructure/fingerprint.js';
import { ensurePrivateDirectory, InvalidPrivateFileError, removePrivateFile } from '../../infrastructure/private-file.js';
import { platformSecretStore, secretStoreFor } from '../../infrastructure/secret-store.js';
import type { SecretReference, SecretStore } from '../../infrastructure/secret-store.js';
import { canonicalWorkspace, listBindings, readBinding, removeBinding, writeBinding } from '../../infrastructure/workspace-binding.js';
import type { Prompt } from './setup.js';
import { collectEnvironment, collectOptionalRestrictions, launchCopilot, launchVsCode } from './setup.js';
import { verifyConnection } from './verify-connection.js';

const maxSecretCodePoints = 8_192;
const usage = 'Uso: mongodb-readonly-mcp-configure [--profile <nome>] [--save] [--update] [--unset <VAR>]... '
  + '[--from-env | --ignore-env] [--secret-store=auto|keyring|file] [--check [--force]] [--bind] [--vscode | --copilot]\n'
  + '  ou: --check [--profile <nome>] [--workspace <caminho>]\n'
  + '  ou: --profile <nome> --bind [--workspace <caminho>] | --unbind [--workspace <caminho>]\n'
  + '  ou: --reset [--profile <nome>] [--save] | --list-profiles';

type SecretStoreChoice = 'auto' | 'keyring' | 'file';

interface Options {
  readonly save: boolean;
  readonly update: boolean;
  readonly vscode: boolean;
  readonly copilot: boolean;
  readonly check: boolean;
  readonly profile?: string;
  readonly listProfiles: boolean;
  readonly fromEnv: boolean;
  readonly ignoreEnv: boolean;
  readonly bind: boolean;
  readonly unbind: boolean;
  readonly workspace?: string;
  readonly unset: readonly string[];
  readonly reset: boolean;
  readonly secretStore: SecretStoreChoice;
  readonly secretStoreGiven: boolean;
  readonly force: boolean;
}

const flags = new Set([
  '--save', '--update', '--vscode', '--copilot', '--check', '--list-profiles', '--from-env',
  '--ignore-env', '--bind', '--unbind', '--reset', '--force',
]);

function usageError(reason: string): ConfigurationError {
  return new ConfigurationError(`${reason}\n${usage}`);
}

function parseArguments(args: readonly string[]): Options {
  const seen = new Set<string>();
  const unset: string[] = [];
  let profile: string | undefined;
  let workspace: string | undefined;
  let secretStore: SecretStoreChoice = 'auto';
  let secretStoreGiven = false;
  const once = (name: string): void => {
    if (seen.has(name)) {
      throw usageError(`Opção repetida: ${name}.`);
    }
    seen.add(name);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const [name, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    const value = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw usageError(`${name} exige um valor.`);
      }
      index += 1;
      return next;
    };
    if (flags.has(name) && inline === undefined) {
      once(name);
    } else if (name === '--profile') {
      once(name);
      profile = validateProfileName(value());
    } else if (name === '--workspace') {
      once(name);
      workspace = value();
    } else if (name === '--unset') {
      const variable = value();
      if (!isConnectionVariable(variable)) {
        throw usageError(`--unset aceita somente variáveis MONGODB_* suportadas: ${variable} não é uma delas.`);
      }
      unset.push(variable);
    } else if (name === '--secret-store') {
      once(name);
      const choice = value();
      if (choice !== 'auto' && choice !== 'keyring' && choice !== 'file') {
        throw usageError('--secret-store deve ser auto, keyring ou file.');
      }
      secretStore = choice;
      secretStoreGiven = true;
    } else {
      throw usageError(`Opção desconhecida: ${arg}.`);
    }
  }
  const has = (name: string): boolean => seen.has(name);
  const options: Options = {
    save: has('--save'),
    update: has('--update') || unset.length > 0,
    vscode: has('--vscode'),
    copilot: has('--copilot'),
    check: has('--check'),
    ...(profile === undefined ? {} : { profile }),
    listProfiles: has('--list-profiles'),
    fromEnv: has('--from-env'),
    ignoreEnv: has('--ignore-env'),
    bind: has('--bind'),
    unbind: has('--unbind'),
    ...(workspace === undefined ? {} : { workspace }),
    unset,
    reset: has('--reset'),
    secretStore,
    secretStoreGiven,
    force: has('--force'),
  };
  if (options.vscode && options.copilot) {
    throw usageError('Use --vscode ou --copilot, não ambos.');
  }
  if (options.fromEnv && options.ignoreEnv) {
    throw usageError('Use --from-env ou --ignore-env, não ambos.');
  }
  if (options.listProfiles && args.length !== 1) {
    throw usageError('--list-profiles não aceita outras opções.');
  }
  if (unset.length > 0 && options.fromEnv) {
    throw usageError('--unset não pode ser combinado com --from-env.');
  }
  if (unset.length > 0 && new Set(unset).size !== unset.length) {
    throw usageError('Variável repetida em --unset.');
  }
  if (options.bind && options.profile === undefined) {
    throw usageError('--bind exige --profile <nome>.');
  }
  if (options.unbind && [...seen].some((flag) => flag !== '--unbind' && flag !== '--workspace')) {
    throw usageError('--unbind aceita somente --workspace.');
  }
  if (options.reset && [...seen].some((flag) => !['--reset', '--save', '--profile'].includes(flag))) {
    throw usageError('--reset aceita somente --save e --profile.');
  }
  if (options.workspace !== undefined && !options.bind && !options.unbind && !options.check) {
    throw usageError('--workspace só é usado com --bind, --unbind ou --check.');
  }
  if (options.force && !options.check) {
    throw usageError('--force só é usado com --check.');
  }
  if (unset.length > 0 && isCheckOnly(options)) {
    throw usageError('--unset não pode ser combinado somente com --check.');
  }
  return options;
}

function writesConfiguration(options: Options): boolean {
  return options.save || options.update || options.fromEnv || options.ignoreEnv || options.vscode
    || options.copilot || options.secretStoreGiven || options.force;
}

function isCheckOnly(options: Options): boolean {
  return options.check && !writesConfiguration(options) && !options.bind;
}

function notify(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function askSecret(description: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new ConfigurationError('Execute a configuração em um terminal interativo.');
  }
  process.stderr.write(`${description}: `);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onKey = (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): void => {
        if (key.ctrl && key.name === 'c') {
          input.off('keypress', onKey);
          reject(new ConfigurationError('Configuração cancelada.'));
        } else if (key.name === 'return' || key.name === 'enter') {
          input.off('keypress', onKey);
          resolve(value);
        } else if (key.name === 'backspace') {
          value = [...value].slice(0, -1).join('');
        } else if (!key.ctrl && !key.meta && character !== undefined && character.length > 0) {
          // Limite em code points, coerente com o backspace.
          if ([...value].length + [...character].length > maxSecretCodePoints) {
            input.off('keypress', onKey);
            reject(new ConfigurationError('Entrada excede o limite permitido.'));
          } else {
            value += character;
          }
        }
      };
      input.on('keypress', onKey);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write('\n');
  }
}

const terminalPrompt: Prompt = {
  async ask(_variable: string, description: string, secret: boolean): Promise<string> {
    if (!process.stdin.isTTY) {
      throw new ConfigurationError('Há valores ausentes. Execute o configurador em um terminal interativo.');
    }
    if (secret) {
      return askSecret(description);
    }
    const readline = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await readline.question(`${description}: `);
    } finally {
      readline.close();
    }
  },
};

async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const answer = (await terminalPrompt.ask('CONFIRM', question, false)).trim().toLowerCase();
  if (answer.length === 0) {
    return defaultYes;
  }
  return ['s', 'sim', 'y', 'yes'].includes(answer);
}

function requireTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new ConfigurationError(
      'Execute o configurador em um terminal interativo ou use --save para confirmar a gravação sem perguntas.',
    );
  }
}

function environmentNames(env: Environment): string[] {
  return connectionVariables.filter((name) => hasValue(env[name]));
}

function invalidFileHint(error: InvalidPrivateFileError): string {
  return error.reason === 'permissions'
    ? `Corrija com: chmod 600 ${error.path}`
    : 'Use --reset para apagá-lo e configurar novamente.';
}

type FileState = { readonly kind: 'missing' } | { readonly kind: 'valid'; readonly stored: StoredConfiguration }
  | { readonly kind: 'invalid'; readonly error: InvalidPrivateFileError };

async function readFileState(path: string): Promise<FileState> {
  try {
    const stored = await readStoredConfiguration(path);
    return stored === undefined ? { kind: 'missing' } : { kind: 'valid', stored };
  } catch (error) {
    if (error instanceof InvalidPrivateFileError) {
      return { kind: 'invalid', error };
    }
    throw error;
  }
}

function sameState(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'valid' && b.kind === 'valid') {
    return a.stored.text === b.stored.text;
  }
  if (a.kind === 'invalid' && b.kind === 'invalid') {
    return a.error.reason === b.error.reason;
  }
  return true;
}

async function fingerprintFor(appDirectory: string, values: Environment): Promise<string> {
  const key = await loadFingerprintKey(appDirectory, true);
  if (key === undefined) {
    throw new ConfigurationError('Não foi possível criar a chave de fingerprint.');
  }
  return computeFingerprint(key, values, connectionVariables);
}

async function bindWorkspace(target: ConfigurationTarget, workspacePath: string, fingerprint: string): Promise<void> {
  const workspace = await canonicalWorkspace(workspacePath);
  await writeBinding(target.appDirectory, { version: 1, workspace, profile: target.profile ?? '', fingerprint });
  notify(`Workspace ${workspace} vinculado ao perfil ${target.profile ?? ''} (fingerprint ${shortFingerprint(fingerprint)}).`);
}

async function deleteReferences(references: readonly SecretReference[]): Promise<void> {
  for (const reference of references) {
    try {
      await secretStoreFor(reference.store).delete(reference);
    } catch {
      notify(`Aviso: não foi possível remover um segredo antigo do cofre ${reference.store}.`);
    }
  }
}

async function chooseSecretStore(options: Options, secrets: readonly string[], interactive: boolean): Promise<SecretStore | undefined> {
  if (secrets.length === 0 || options.secretStore === 'file') {
    return undefined;
  }
  const store = platformSecretStore();
  if (await store.available()) {
    return store;
  }
  if (options.secretStore === 'keyring') {
    throw new ConfigurationError(`O cofre do sistema (${store.name}) não está disponível. Desbloqueie o chaveiro ou use --secret-store=file.`);
  }
  if (interactive && await confirm(
    `O cofre do sistema (${store.name}) não está disponível. Salvar ${secrets.join(', ')} em texto no arquivo privado (0600)? [s/N]`,
  )) {
    return undefined;
  }
  throw new ConfigurationError(
    `O cofre do sistema (${store.name}) não está disponível para ${secrets.join(', ')}. `
    + 'Use --secret-store=file para gravá-los em texto no arquivo privado (0600).',
  );
}

async function testConnection(configuration: Configuration, options: Options, interactive: boolean): Promise<boolean> {
  const wanted = options.check || (interactive && await confirm('Testar a conexão antes de salvar? [S/n]', true));
  if (!wanted) {
    return false;
  }
  if (configuration.connection.mode === 'oidc') {
    if (!process.stdin.isTTY) {
      throw new ConfigurationError('O teste OIDC exige login no navegador; execute em um terminal interativo ou remova --check.');
    }
    notify('O teste fará login OIDC no navegador.');
  }
  try {
    const result = await verifyConnection(configuration);
    notify(`Conexão e permissões verificadas. Modo: ${result.mode}. Bancos autorizados: ${result.databases}.`);
    return true;
  } catch (error) {
    if (!(error instanceof ConfigurationError) || !options.force) {
      throw error instanceof ConfigurationError
        ? new ConfigurationError(`${error.message} Nada foi salvo; use --force para salvar mesmo assim.`)
        : error;
    }
    notify(`${error.message} Configuração salva sem conexão verificada.`);
    return false;
  }
}

async function writeFlow(options: Options, env: Environment): Promise<void> {
  const interactive = !options.save;
  if (interactive) {
    requireTerminal();
  }
  const target = resolveTarget(env, options.profile);
  const location = `${target.path} (${describeTarget(target)})`;
  const initial = await readFileState(target.path);
  if (initial.kind === 'invalid') {
    const { error } = initial;
    if (options.update || !error.replaceable) {
      throw new ConfigurationError(
        `O arquivo ${target.path} é inválido (${error.description}) e não pode ser ${options.update ? 'atualizado' : 'substituído com segurança'}. `
        + invalidFileHint(error),
      );
    }
    if (interactive) {
      if (!await confirm(`O arquivo ${target.path} é inválido (${error.description}). Substituí-lo? [s/N]`)) {
        throw new ConfigurationError('Configuração cancelada; nenhum arquivo foi salvo.');
      }
    } else {
      notify(`Aviso: o arquivo ${target.path} é inválido (${error.description}) e será substituído.`);
    }
  }
  if (initial.kind === 'missing') {
    if (options.update) {
      throw new ConfigurationError(`Não há configuração salva em ${target.path} para atualizar. Execute sem --update.`);
    }
    if (target.kind === 'explicit-file' && interactive
      && !await confirm(`O arquivo ${target.path} não existe. Criar? [s/N]`)) {
      throw new ConfigurationError('Configuração cancelada; nenhum arquivo foi salvo.');
    }
  }
  const stored = initial.kind === 'valid' ? initial.stored : undefined;

  const names = environmentNames(env);
  let importEnvironment = options.fromEnv;
  if (!options.fromEnv && !options.ignoreEnv && names.length > 0) {
    if (target.kind !== 'default') {
      notify(`Variáveis do ambiente ignoradas (destino explícito; use --from-env para importá-las): ${names.join(', ')}.`);
    } else if (interactive) {
      importEnvironment = await confirm(`O ambiente define ${names.join(', ')}. Importar estas variáveis do ambiente? [s/N]`);
    } else {
      throw new ConfigurationError(
        `O ambiente define ${names.join(', ')}. Use --from-env para importá-las ou --ignore-env para ignorá-las.`,
      );
    }
  }
  if (options.fromEnv) {
    notify(names.length === 0
      ? 'Nenhuma variável MONGODB_* no ambiente para importar.'
      : `Importando do ambiente: ${names.join(', ')}.`);
  }

  let useBase = options.update;
  if (!useBase && stored !== undefined && interactive) {
    try {
      const existing = loadConfiguration(await resolveStoredValues(stored));
      notify('Configuração salva atual:');
      for (const line of describeConfiguration(existing, {}, target.path)) {
        notify(`  ${line}`);
      }
    } catch (error) {
      notify(`A configuração salva não é válida: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
    }
    useBase = await confirm('Usar a configuração salva como base? [s/N]');
  }

  const sources: VariableSources = {};
  const values: Record<string, string | undefined> = withoutConnectionVariables(env);
  if (useBase && stored !== undefined) {
    for (const [name, value] of Object.entries(await resolveStoredValues(stored))) {
      values[name] = value;
      sources[name] = 'arquivo';
    }
  }
  if (importEnvironment) {
    for (const name of names) {
      values[name] = env[name];
      sources[name] = 'ambiente';
    }
  }
  for (const name of options.unset) {
    delete values[name];
    delete sources[name];
  }

  const explain = (error: unknown): unknown => (error instanceof ConfigurationError
    ? explainConfigurationError(error, env, sources, { location, merged: false, update: options.update })
    : error);
  let collected: Record<string, string | undefined>;
  let configuration: Configuration;
  try {
    collected = await collectEnvironment(values, terminalPrompt, sources);
    if (interactive && await confirm('Configurar restrições opcionais (bancos, coleções, somente leitura, timeout)? [s/N]')) {
      collected = await collectOptionalRestrictions(collected, terminalPrompt, sources, notify);
    }
    configuration = loadConfiguration(collected);
  } catch (error) {
    throw explain(error);
  }

  const secrets = secretVariables(collected);
  const store = await chooseSecretStore(options, secrets, interactive);
  const verified = await testConnection(configuration, options, interactive);

  notify('Configuração a salvar:');
  for (const line of describeConfiguration(configuration, sources, target.path, { sourceKind: describeTarget(target) })) {
    notify(`  ${line}`);
  }
  if (secrets.length > 0) {
    notify(store === undefined
      ? `  Segredos (${secrets.join(', ')}): em texto no arquivo privado (0600).`
      : `  Segredos (${secrets.join(', ')}): no cofre do sistema (${store.name}).`);
  }
  if (interactive && !await confirm(`Salvar esta configuração em ${target.path}? [s/N]`)) {
    throw new ConfigurationError('Configuração cancelada; nenhum arquivo foi salvo.');
  }

  await ensurePrivateDirectory(dirname(target.path), target.appDirectory);
  await withFileLock(target.path, async () => {
    if (!sameState(initial, await readFileState(target.path))) {
      throw new ConfigurationError(`O arquivo ${target.path} foi alterado por outra execução durante a configuração. Execute novamente.`);
    }
    const references: Record<string, SecretReference> = {};
    try {
      if (store !== undefined) {
        for (const name of secrets) {
          references[name] = await store.set(`mongodb-readonly-mcp ${describeTarget(target)} ${name}`, collected[name] ?? '');
        }
      }
      await writeConfigurationText(target, serializeConfiguration(collected, references));
    } catch (error) {
      await deleteReferences(Object.values(references));
      throw error;
    }
    await deleteReferences(storedReferences(stored));
  });

  const fingerprint = await fingerprintFor(target.appDirectory, collected);
  notify(`${initial.kind === 'missing' ? 'Novo arquivo criado' : 'Configuração salva'} em ${target.path} (fingerprint ${shortFingerprint(fingerprint)}).`);
  if (!verified) {
    notify('A conexão não foi verificada; execute o configurador com --check para testá-la.');
  }
  if (isOutsideApplicationDirectory(target)) {
    notify(`O arquivo está fora do diretório privado padrão; confira as permissões de ${dirname(target.path)}.`);
  }
  notify('Um MCP iniciado sem configuração a reconhecerá na próxima tool. Para trocar uma conexão já ativa, reinicie o MCP.');

  // npm run executa na raiz do pacote; no comando global, usa a pasta em que o usuário está.
  const workspace = options.workspace ?? process.cwd();
  const launching = options.vscode || options.copilot;
  if (target.kind === 'profile' && (options.bind || launching)) {
    await bindWorkspace(target, workspace, fingerprint);
  } else if (launching) {
    notify('Aviso: a janela usará o arquivo padrão compartilhado; use --profile para isolar este projeto.');
  }
  const profile = target.kind === 'profile' ? target.profile : undefined;
  if (options.copilot) {
    await launchCopilot(env, workspace, 'copilot', profile);
  } else if (options.vscode) {
    await launchVsCode(env, workspace, 'code', profile);
    notify('Abertura do VS Code solicitada. A configuração salva não depende da herança de ambiente da janela.');
  }
}

async function checkFlow(options: Options, env: Environment): Promise<void> {
  const sourceEnv: Record<string, string | undefined> = {
    ...env,
    MONGODB_MCP_WORKSPACE: options.workspace ?? env.MONGODB_MCP_WORKSPACE ?? process.cwd(),
  };
  if (options.profile !== undefined) {
    sourceEnv.MONGODB_MCP_PROFILE = options.profile;
  }
  const source = await resolveServerSource(sourceEnv, () => undefined);
  const merged = source.kind === 'default';
  const resolved = await resolveEnvironmentWithSources(env, { path: source.path, merge: merged });
  if (!resolved.fileFound && source.kind !== 'default') {
    throw new ConfigurationError(`Arquivo de configuração não encontrado: ${source.path}`);
  }
  let configuration: Configuration;
  try {
    configuration = loadConfiguration(resolved.values);
  } catch (error) {
    throw error instanceof ConfigurationError
      ? explainConfigurationError(error, env, resolved.sources, { location: source.path, merged })
      : error;
  }
  const key = await loadFingerprintKey(source.appDirectory, false);
  const fingerprint = key === undefined ? undefined : computeFingerprint(key, resolved.values, connectionVariables);
  let bindingStatus: string | undefined;
  let divergence: string | undefined;
  if (source.profile !== undefined) {
    const workspace = await canonicalWorkspace(sourceEnv.MONGODB_MCP_WORKSPACE ?? process.cwd());
    const binding = await readBinding(source.appDirectory, workspace);
    if (binding === undefined) {
      bindingStatus = 'inexistente';
    } else if (binding.profile !== source.profile) {
      bindingStatus = `vinculado a outro perfil (${binding.profile})`;
    } else if (binding.fingerprint === fingerprint) {
      bindingStatus = 'ok';
    } else {
      bindingStatus = 'divergente';
      divergence = `A configuração do perfil "${source.profile}" mudou desde o vínculo deste workspace. `
        + `Execute mongodb-readonly-mcp-configure --profile ${source.profile} --bind neste workspace para aceitar a mudança.`;
    }
  }
  for (const line of describeConfiguration(configuration, resolved.sources, source.path, {
    sourceKind: describeSourceKind(source),
    ...(fingerprint === undefined ? {} : { fingerprint: shortFingerprint(fingerprint) }),
    ...(bindingStatus === undefined ? {} : { binding: bindingStatus }),
  })) {
    notify(line);
  }
  if (resolved.overridden.length > 0) {
    notify(`Aviso: variáveis do ambiente sobrepõem o arquivo ${source.path}: ${resolved.overridden.join(', ')}.`);
  }
  if (divergence !== undefined) {
    throw new ConfigurationError(divergence);
  }
  if (configuration.connection.mode === 'oidc') {
    notify('O teste fará login OIDC no navegador.');
  }
  const result = await verifyConnection(configuration);
  notify(
    `Conexão e permissões verificadas. Modo: ${result.mode}. Somente leitura: ${result.readOnly ? 'sim' : 'não'}. `
    + `Bancos autorizados: ${result.databases}.`,
  );
}

async function bindFlow(options: Options, env: Environment): Promise<void> {
  const target = resolveTarget(env, options.profile);
  const stored = await readStoredConfiguration(target.path);
  if (stored === undefined) {
    throw new ConfigurationError(`O perfil ${target.profile ?? ''} não existe em ${target.path}. Configure-o antes de vinculá-lo.`);
  }
  const values = await resolveStoredValues(stored);
  loadConfiguration(values);
  await bindWorkspace(target, options.workspace ?? process.cwd(), await fingerprintFor(target.appDirectory, values));
}

async function unbindFlow(options: Options, env: Environment): Promise<void> {
  const target = resolveTarget({ ...env, MONGODB_MCP_PROFILE: undefined, MONGODB_MCP_CONFIG: undefined });
  const workspace = await canonicalWorkspace(options.workspace ?? process.cwd());
  notify(await removeBinding(target.appDirectory, workspace)
    ? `Vínculo do workspace ${workspace} removido.`
    : `Nenhum vínculo encontrado para o workspace ${workspace}.`);
}

async function resetFlow(options: Options, env: Environment): Promise<void> {
  const target = resolveTarget(env, options.profile);
  if (!options.save) {
    requireTerminal();
    if (!await confirm(`Apagar ${target.path}? [s/N]`)) {
      throw new ConfigurationError('Operação cancelada; nada foi apagado.');
    }
  }
  const removed = (await readFileState(target.path)).kind !== 'missing' && await withFileLock(target.path, async () => {
    const state = await readFileState(target.path);
    const existed = await removePrivateFile(target.path);
    if (state.kind === 'valid') {
      await deleteReferences(storedReferences(state.stored));
    }
    return existed;
  });
  notify(removed ? `Configuração ${target.path} apagada.` : `Não há configuração em ${target.path}.`);
  if (target.profile !== undefined) {
    const bound = (await listBindings(target.appDirectory)).filter((binding) => binding.profile === target.profile);
    if (bound.length > 0) {
      notify(`Workspaces ainda vinculados ao perfil ${target.profile} (use --unbind neles): ${bound.map((binding) => binding.workspace).join(', ')}.`);
    }
  }
}

async function listFlow(env: Environment): Promise<void> {
  const names = await listProfiles(env);
  if (names.length === 0) {
    notify('Nenhum perfil configurado.');
    return;
  }
  const ports = new Map<string, string[]>();
  for (const name of names) {
    try {
      const stored = await readStoredConfiguration(profilePath(env, name));
      if (stored === undefined) {
        continue;
      }
      const configuration = loadConfiguration(await resolveStoredValues(stored));
      const lines = describeConfiguration(configuration, {}, profilePath(env, name)).slice(1);
      notify(`${name}: ${lines.join('; ')}`);
      if (configuration.connection.mode === 'oidc') {
        const port = new URL(configuration.connection.oidc.redirectUri).port;
        ports.set(port, [...(ports.get(port) ?? []), name]);
      }
    } catch (error) {
      const reason = error instanceof InvalidPrivateFileError
        ? error.description
        : error instanceof Error ? error.message : 'erro desconhecido';
      notify(`${name}: inválido: ${reason}`);
    }
  }
  for (const [port, profiles] of ports) {
    if (profiles.length > 1) {
      notify(`Aviso: os perfis OIDC ${profiles.join(', ')} usam a mesma porta de callback ${port}; autenticações simultâneas vão conflitar.`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const env = process.env;
  if (options.listProfiles) {
    await listFlow(env);
  } else if (options.unbind) {
    await unbindFlow(options, env);
  } else if (options.reset) {
    await resetFlow(options, env);
  } else if (isCheckOnly(options)) {
    await checkFlow(options, env);
  } else if (options.bind && !writesConfiguration(options)) {
    await bindFlow(options, env);
  } else {
    await writeFlow(options, env);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ConfigurationError
    ? error.message
    : 'Falha ao configurar o servidor MCP.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
