import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { OIDCCallbackFunction, OIDCCallbackParams, OIDCResponse } from 'mongodb';
import open from 'open';
import * as oidc from 'openid-client';
import type { OidcConfiguration } from './configuration.js';

export class OidcError extends Error {
  constructor(message = 'Falha na autenticação OIDC. Verifique a configuração e tente novamente.') {
    super(message);
    this.name = 'OidcError';
  }
}

/** Procura um OidcError na cadeia de `cause` (o driver MongoDB embrulha o erro do callback). */
export function findOidcError(error: unknown): OidcError | undefined {
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof OidcError) {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

export interface OidcDependencies {
  discover(configuration: OidcConfiguration, signal: AbortSignal): Promise<oidc.Configuration>;
  openBrowser(url: URL): Promise<void>;
}

function assertTrustedEndpoint(value: string | undefined, allowedHosts: ReadonlySet<string>): URL {
  if (value === undefined) {
    throw new OidcError();
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
      || !allowedHosts.has(url.host.toLowerCase())) {
      throw new OidcError();
    }
    return url;
  } catch {
    throw new OidcError();
  }
}

async function discoverProvider(configuration: OidcConfiguration, signal: AbortSignal): Promise<oidc.Configuration> {
  const secureFetch: oidc.CustomFetch = async (url, options) => {
    assertTrustedEndpoint(url, configuration.providerHosts);
    const combinedSignal = options.signal === undefined ? signal : AbortSignal.any([signal, options.signal]);
    const init: RequestInit = {
      method: options.method,
      headers: options.headers,
      redirect: 'error',
      signal: combinedSignal,
    };
    if (options.body === null || typeof options.body === 'string' || options.body instanceof URLSearchParams) {
      init.body = options.body;
    } else if (options.body !== undefined) {
      throw new OidcError();
    }
    return fetch(url, init);
  };
  return oidc.discovery(
    new URL(configuration.issuer),
    configuration.clientId,
    undefined,
    oidc.None(),
    { [oidc.customFetch]: secureFetch, timeout: 30 },
  );
}

const defaultDependencies: OidcDependencies = {
  discover: discoverProvider,
  async openBrowser(url: URL): Promise<void> {
    await open(url.href);
  },
};

function validateIdpInfo(params: OIDCCallbackParams, configuration: OidcConfiguration): readonly string[] {
  const info = params.idpInfo;
  if (params.version !== 1 || info === undefined
    || info.issuer !== configuration.issuer || info.clientId !== configuration.clientId) {
    throw new OidcError();
  }
  const requestedScopes: unknown = info.requestScopes ?? [];
  if (!Array.isArray(requestedScopes) || requestedScopes.length > 100) {
    throw new OidcError();
  }
  const scopes = new Set(['openid']);
  for (const scope of requestedScopes) {
    if (typeof scope !== 'string' || !configuration.allowedScopes.has(scope)) {
      throw new OidcError();
    }
    scopes.add(scope);
  }
  return [...scopes];
}

interface LoopbackListener {
  readonly response: Promise<URL>;
  close(): Promise<void>;
}

async function listenForCallback(redirectUri: string, expectedState: string, signal: AbortSignal): Promise<LoopbackListener> {
  if (signal.aborted) {
    throw new OidcError();
  }
  const redirect = new URL(redirectUri);
  let resolveResponse: (url: URL) => void = () => undefined;
  let rejectResponse: () => void = () => undefined;
  const response = new Promise<URL>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = () => reject(new OidcError());
  });
  void response.catch(() => undefined);
  const server: Server = createServer((request, outgoing) => {
    const rawUrl = request.url;
    if (request.method !== 'GET' || rawUrl === undefined || rawUrl.length > 8192
      || request.headers.host !== redirect.host) {
      outgoing.writeHead(400).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, redirect);
    } catch {
      outgoing.writeHead(400).end();
      return;
    }
    if (url.origin !== redirect.origin || url.pathname !== redirect.pathname
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState) {
      outgoing.writeHead(400).end();
      return;
    }
    outgoing.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'",
    });
    outgoing.end('Resposta recebida. Você pode fechar esta janela.');
    resolveResponse(url);
  });
  const onAbort = (): void => rejectResponse();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(redirect.port), '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    signal.removeEventListener('abort', onAbort);
    if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
      throw new OidcError(
        `A porta ${redirect.port} do callback OIDC está em uso, talvez por outra instância autenticando. `
        + 'Tente novamente ou use um MONGODB_OIDC_REDIRECT_URI diferente por perfil (ele precisa estar registrado no provedor).',
      );
    }
    throw new OidcError();
  }
  if (signal.aborted) {
    rejectResponse();
  }
  return {
    response,
    async close(): Promise<void> {
      signal.removeEventListener('abort', onAbort);
      rejectResponse();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

export function createOidcHumanCallback(
  configuration: OidcConfiguration,
  dependencies: OidcDependencies = defaultDependencies,
): OIDCCallbackFunction {
  return async (params: OIDCCallbackParams): Promise<OIDCResponse> => {
    try {
      const scopes = validateIdpInfo(params, configuration);
      if (params.timeoutContext.aborted || params.refreshToken !== undefined) {
        throw new OidcError();
      }
      const client = await dependencies.discover(configuration, params.timeoutContext);
      const metadata = client.serverMetadata();
      if (metadata.issuer !== configuration.issuer || !metadata.supportsPKCE('S256')) {
        throw new OidcError();
      }
      assertTrustedEndpoint(metadata.authorization_endpoint, configuration.providerHosts);
      assertTrustedEndpoint(metadata.token_endpoint, configuration.providerHosts);

      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authorizationUrl = oidc.buildAuthorizationUrl(client, {
        redirect_uri: configuration.redirectUri,
        scope: scopes.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      assertTrustedEndpoint(authorizationUrl.href, configuration.providerHosts);
      const listener = await listenForCallback(configuration.redirectUri, state, params.timeoutContext);
      try {
        const [callbackUrl] = await Promise.all([listener.response, dependencies.openBrowser(authorizationUrl)]);
        if (params.timeoutContext.aborted) {
          throw new OidcError();
        }
        const tokens = await oidc.authorizationCodeGrant(client, callbackUrl, {
          pkceCodeVerifier: verifier,
          expectedState: state,
          expectedNonce: nonce,
          idTokenExpected: true,
        });
        if (params.timeoutContext.aborted || tokens.access_token.length === 0) {
          throw new OidcError();
        }
        const expiresInSeconds = tokens.expiresIn();
        return {
          accessToken: tokens.access_token,
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        };
      } finally {
        await listener.close();
      }
    } catch (error) {
      // Mensagens de OidcError são controladas; demais erros podem conter detalhes do provedor.
      throw error instanceof OidcError ? error : new OidcError();
    }
  };
}
