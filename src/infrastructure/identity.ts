import { PolicyError } from '../domain/query.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertUnauthenticatedIdentity(status: unknown): void {
  if (!isRecord(status) || !isRecord(status.authInfo)
    || !Array.isArray(status.authInfo.authenticatedUsers) || status.authInfo.authenticatedUsers.length !== 0
    || !Array.isArray(status.authInfo.authenticatedUserPrivileges)
    || status.authInfo.authenticatedUserPrivileges.length !== 0) {
    throw new PolicyError('O modo sem autenticação exige uma conexão MongoDB sem identidade autenticada.');
  }
}

// Os privilégios da identidade não são restringidos aqui: a leitura é garantida pelo ReadOnlyGuard.
export function assertAuthenticatedIdentity(status: unknown): void {
  if (!isRecord(status) || !isRecord(status.authInfo)
    || !Array.isArray(status.authInfo.authenticatedUsers) || status.authInfo.authenticatedUsers.length !== 1) {
    throw new PolicyError('A conexão MongoDB deve usar exatamente uma identidade autenticada.');
  }
}
