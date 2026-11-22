#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReadOnlyService } from './application/read-only-service.js';
import { ConfigurationError } from './infrastructure/configuration.js';
import { createMongoClient, MongoReadAdapter } from './infrastructure/mongodb-read-adapter.js';
import { configurationHosts, explainConfigurationError, serverEnvironment } from './infrastructure/configuration-store.js';
import { describeSourceKind, loadFromSource, resolveServerSource } from './infrastructure/configuration-source.js';
import { shortFingerprint } from './infrastructure/fingerprint.js';
import { McpLog } from './interfaces/mcp/log.js';
import { createMcpServer } from './interfaces/mcp/server.js';
import type { ReadOnlyOperations } from './application/read-only-service.js';

async function main(): Promise<void> {
  let adapter: MongoReadAdapter | undefined;
  let operations: Promise<ReadOnlyOperations> | undefined;
  let stopping = false;
  // stderr é exibido como aviso pelos clientes; mensagens não fatais seguem pelo log MCP.
  const log = new McpLog();
  const warn = (message: string): void => { log.warning(message); };
  // A fonte é decidida uma única vez; um erro aqui é repetido em cada chamada de tool.
  const source = resolveServerSource(process.env, warn);
  source.catch(() => undefined);
  const initializeOperations = async (): Promise<ReadOnlyOperations> => {
    const resolvedSource = await source;
    const environment = serverEnvironment(process.env);
    const { configuration, fingerprint, sources } = await loadFromSource(resolvedSource, environment, warn);
    if (stopping) {
      throw new ConfigurationError('O servidor MCP está encerrando.');
    }
    let client;
    try {
      client = createMongoClient(configuration.connection);
    } catch {
      // A mensagem do driver pode conter a URI; não a repasse.
      throw explainConfigurationError(
        new ConfigurationError('URI ou opções de conexão MongoDB inválidas.'),
        environment,
        sources,
        { merged: resolvedSource.kind === 'default' },
      );
    }
    adapter = new MongoReadAdapter(client, configuration.connection.mode, configuration.readOnly);
    const hosts = configurationHosts(configuration.connection.uri);
    const databases = configuration.policy.allowedDatabaseNames === undefined
      ? 'todos os acessíveis'
      : [...configuration.policy.allowedDatabaseNames].join(', ');
    log.info(
      `Configuração carregada de ${resolvedSource.path} (fonte ${describeSourceKind(resolvedSource)}): `
      + `modo ${configuration.connection.mode}, hosts ${hosts.join(', ') || 'não identificados'}, bancos ${databases}`
      + `${fingerprint === undefined ? '' : `, fingerprint ${shortFingerprint(fingerprint)}`}.`,
    );
    if (!configuration.readOnly) {
      log.warning(
        'Aviso: MONGODB_ONLY_READ=false desativa a trava de leitura do MCP; updateMany/deleteMany com filtro vazio continuam bloqueados. Esta versão expõe apenas tools de leitura.',
      );
    }
    return new ReadOnlyService(adapter, configuration.policy, configuration.queryTimeoutMs);
  };
  const getOperations = (): Promise<ReadOnlyOperations> => {
    operations ??= initializeOperations().catch((error: unknown) => {
      operations = undefined;
      throw error;
    });
    return operations;
  };
  try {
    await getOperations();
  } catch (error) {
    // Configuração ausente ou inválida não derruba o processo: as tools informam o problema ao cliente.
    if (!(error instanceof ConfigurationError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
  }
  const server = createMcpServer(getOperations);
  log.attach(server);

  const shutdown = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    let failed = false;
    try {
      await server.close();
    } catch {
      failed = true;
    }
    if (adapter !== undefined) {
      try {
        await adapter.close();
      } catch {
        failed = true;
      }
    }
    if (failed) {
      process.stderr.write('Falha ao encerrar o servidor ou a conexão MongoDB.\n');
      process.exitCode = 1;
    }
  };

  server.onclose = () => { void shutdown(); };
  server.onerror = () => { process.stderr.write('Erro de protocolo MCP.\n'); };
  process.stdin.once('end', () => { void shutdown(); });
  process.stdout.once('error', () => {
    process.stderr.write('Falha ao enviar uma resposta MCP.\n');
    process.exitCode = 1;
    void shutdown();
  });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });

  try {
    await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65_536 }));
  } catch {
    await shutdown();
    throw new Error('Falha ao iniciar o transporte MCP.');
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof ConfigurationError
    ? error.message
    : 'Falha ao iniciar o servidor MCP. Verifique a configuração.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
