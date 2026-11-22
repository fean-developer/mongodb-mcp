import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ConfigurationError,
  isAuthMode,
  loadConfiguration,
  MissingConfigurationError,
  missingConfiguration,
} from '../../infrastructure/configuration.js';
import type { Environment } from '../../infrastructure/configuration.js';
import { withoutConnectionVariables } from '../../infrastructure/configuration-store.js';
import type { VariableSources } from '../../infrastructure/configuration-store.js';

// Raiz do pacote instalado (dist/interfaces/cli ou src/interfaces/cli → três níveis acima).
export const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

// A conexão é lida do arquivo salvo; injetar MONGODB_* no cliente deixaria valores obsoletos
// herdados pela janela e por seus terminais, sobrepondo configurações futuras.
export function clientEnvironment(env: Environment, workspace: string, profile?: string): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...withoutConnectionVariables(env), MONGODB_MCP_ROOT: packageRoot };
  if (profile !== undefined) {
    delete result.MONGODB_MCP_CONFIG;
    result.MONGODB_MCP_PROFILE = profile;
    result.MONGODB_MCP_WORKSPACE = workspace;
  }
  return result;
}

export interface Prompt {
  ask(variable: string, description: string, secret: boolean): Promise<string>;
}

const descriptions: Readonly<Record<string, string>> = {
  MONGODB_URI: 'Connection string MongoDB',
  MONGODB_ALLOWED_DATABASES: 'Bancos permitidos, separados por vírgula',
  MONGODB_ALLOWED_COLLECTIONS: 'JSON de coleções permitidas por banco',
  MONGODB_USERNAME: 'Usuário SCRAM',
  MONGODB_PASSWORD: 'Senha SCRAM',
  MONGODB_OIDC_ISSUER: 'Issuer HTTPS do provedor OIDC',
  MONGODB_OIDC_CLIENT_ID: 'Client ID público OIDC',
  MONGODB_OIDC_MONGO_HOSTS: 'Hosts MongoDB OIDC permitidos, separados por vírgula',
  MONGODB_OIDC_PROVIDER_HOSTS: 'Hosts HTTPS do provedor OIDC, separados por vírgula',
  MONGODB_ONLY_READ: 'Somente leitura (true ou false)',
  MONGODB_QUERY_TIMEOUT_MS: 'Timeout das consultas em milissegundos',
  MONGODB_AUTH_SOURCE: 'Banco de autenticação SCRAM (authSource)',
  MONGODB_OIDC_REDIRECT_URI: 'URI de redirecionamento OIDC (loopback registrada no provedor)',
};

const maxAttempts = 3;

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

export async function collectEnvironment(
  existing: Environment,
  prompt: Prompt,
  sources?: VariableSources,
): Promise<Record<string, string | undefined>> {
  const env = { ...existing };
  if (isPresent(env.MONGODB_AUTH_MODE) && !isAuthMode(env.MONGODB_AUTH_MODE)) {
    throw new ConfigurationError('MONGODB_AUTH_MODE deve ser none, uri, scram ou oidc.');
  }
  while (true) {
    const name = missingConfiguration(env)[0];
    if (name === undefined) {
      break;
    }
    const description = descriptions[name];
    if (description === undefined) {
      throw new ConfigurationError('Não foi possível solicitar uma variável obrigatória.');
    }
    const answer = await prompt.ask(name, description, name === 'MONGODB_URI' || name === 'MONGODB_PASSWORD');
    if (!isPresent(answer)) {
      throw new ConfigurationError(`Variável obrigatória ausente: ${name}.`);
    }
    env[name] = answer;
    if (sources !== undefined) {
      sources[name] = 'prompt';
    }
  }
  loadConfiguration(env);
  return env;
}

/** Variáveis opcionais oferecidas no modo interativo, conforme o modo de autenticação. */
export function optionalVariables(env: Environment): string[] {
  const names = ['MONGODB_ALLOWED_DATABASES', 'MONGODB_ALLOWED_COLLECTIONS', 'MONGODB_ONLY_READ', 'MONGODB_QUERY_TIMEOUT_MS'];
  const { mode } = loadConfiguration(env).connection;
  if (mode === 'scram') {
    names.push('MONGODB_AUTH_SOURCE');
  } else if (mode === 'oidc') {
    names.push('MONGODB_OIDC_REDIRECT_URI');
  }
  return names;
}

/**
 * Pergunta as restrições opcionais. Enter mantém o valor atual e "-" o remove.
 * Cada resposta é validada; após três tentativas inválidas a configuração é cancelada.
 */
export async function collectOptionalRestrictions(
  existing: Environment,
  prompt: Prompt,
  sources: VariableSources,
  notify: (message: string) => void,
): Promise<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...existing };
  for (const name of optionalVariables(env)) {
    const current = env[name];
    for (let attempt = 1; ; attempt += 1) {
      const answer = (await prompt.ask(
        name,
        `${descriptions[name] ?? name} [atual: ${isPresent(current) ? current : 'não definido'}; Enter mantém, "-" remove]`,
        false,
      )).trim();
      if (answer.length === 0) {
        break;
      }
      const candidate = { ...env };
      if (answer === '-') {
        delete candidate[name];
      } else {
        candidate[name] = answer;
      }
      try {
        loadConfiguration(candidate);
      } catch (error) {
        if (!(error instanceof ConfigurationError) || error instanceof MissingConfigurationError || attempt >= maxAttempts) {
          throw error;
        }
        notify(`${error.message} Tente novamente.`);
        continue;
      }
      if (answer === '-') {
        delete env[name];
        delete sources[name];
      } else {
        env[name] = answer;
        sources[name] = 'prompt';
      }
      break;
    }
  }
  return env;
}

export async function launchVsCode(
  env: Environment,
  workspace: string,
  executable = 'code',
  profile?: string,
): Promise<void> {
  const child = spawn(executable, ['--new-window', workspace], {
    env: clientEnvironment(env, workspace, profile),
    stdio: 'ignore',
    detached: true,
  });
  const earlyExit = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new ConfigurationError('Não foi possível iniciar o VS Code pelo comando code.')));
    child.once('exit', (code) => resolve(code));
  });
  const outcome = await Promise.race([
    earlyExit,
    new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), 1_000)),
  ]);
  if (outcome !== 'running' && outcome !== 0) {
    throw new ConfigurationError('O VS Code não iniciou. Verifique a instalação do comando code.');
  }
  child.unref();
}

export async function launchCopilot(
  env: Environment,
  workspace: string,
  executable = 'copilot',
  profile?: string,
): Promise<void> {
  const child = spawn(executable, [], {
    cwd: workspace,
    env: clientEnvironment(env, workspace, profile),
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new ConfigurationError('Não foi possível iniciar o Copilot CLI.')));
    child.once('exit', resolve);
  });
  if (exitCode !== 0) {
    throw new ConfigurationError('O Copilot CLI encerrou com erro.');
  }
}
