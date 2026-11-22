import { ReadOnlyService } from '../../application/read-only-service.js';
import { PolicyError } from '../../domain/query.js';
import { ConfigurationError } from '../../infrastructure/configuration.js';
import type { Configuration } from '../../infrastructure/configuration.js';
import { findOidcError } from '../../infrastructure/oidc.js';
import { createMongoClient, MongoReadAdapter } from '../../infrastructure/mongodb-read-adapter.js';

export interface VerificationResult {
  readonly mode: string;
  readonly readOnly: boolean;
  readonly databases: number;
}

/** Conecta, lista os bancos autorizados e encerra. Mensagens do driver não são repassadas. */
export async function verifyConnection(configuration: Configuration): Promise<VerificationResult> {
  let client;
  try {
    client = createMongoClient(configuration.connection);
  } catch {
    throw new ConfigurationError('URI ou opções de conexão MongoDB inválidas.');
  }
  const adapter = new MongoReadAdapter(client, configuration.connection.mode, configuration.readOnly);
  try {
    const service = new ReadOnlyService(adapter, configuration.policy, configuration.queryTimeoutMs);
    const { databases } = await service.listDatabases();
    return { mode: configuration.connection.mode, readOnly: configuration.readOnly, databases: databases.length };
  } catch (error) {
    if (error instanceof PolicyError) {
      throw new ConfigurationError(error.message);
    }
    const oidcError = findOidcError(error);
    if (oidcError !== undefined) {
      throw new ConfigurationError(oidcError.message);
    }
    throw new ConfigurationError('Falha ao verificar MongoDB. Verifique a conexão, a autenticação e as permissões.');
  } finally {
    await adapter.close();
  }
}
