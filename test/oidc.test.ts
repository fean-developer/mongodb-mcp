import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import type { OIDCCallbackParams } from 'mongodb';
import * as oidc from 'openid-client';
import { loadConfiguration } from '../src/infrastructure/configuration.js';
import type { OidcConfiguration } from '../src/infrastructure/configuration.js';
import { createMongoClient } from '../src/infrastructure/mongodb-read-adapter.js';
import { createOidcHumanCallback, OidcError } from '../src/infrastructure/oidc.js';
import type { OidcDependencies } from '../src/infrastructure/oidc.js';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Porta de teste indisponível.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

function configuration(port: number): OidcConfiguration {
  return {
    issuer: 'https://identity.example.test/tenant',
    clientId: 'public-client',
    mongoHosts: ['db.example.test'],
    providerHosts: new Set(['identity.example.test']),
    allowedScopes: new Set(['openid', 'email']),
    redirectUri: `http://127.0.0.1:${port}/callback`,
  };
}

function callbackParams(config: OidcConfiguration, signal = new AbortController().signal): OIDCCallbackParams {
  return {
    version: 1,
    timeoutContext: signal,
    idpInfo: { issuer: config.issuer, clientId: config.clientId, requestScopes: ['email'] },
  };
}

function provider(config: OidcConfiguration, authorizationEndpoint = 'https://identity.example.test/authorize'): oidc.Configuration {
  return new oidc.Configuration({
    issuer: config.issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: 'https://identity.example.test/token',
    jwks_uri: 'https://identity.example.test/jwks',
    code_challenge_methods_supported: ['S256'],
    id_token_signing_alg_values_supported: ['RS256'],
  }, config.clientId, undefined, oidc.None());
}

function jwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('human OIDC callback', () => {
  it('wires the human callback and allowed MongoDB hosts into the driver', async () => {
    const config = loadConfiguration({
      MONGODB_AUTH_MODE: 'oidc',
      MONGODB_URI: 'mongodb://db.example.test/?tls=true',
      MONGODB_ALLOWED_DATABASES: 'shop',
      MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
      MONGODB_OIDC_ISSUER: 'https://identity.example.test/tenant',
      MONGODB_OIDC_CLIENT_ID: 'public-client',
      MONGODB_OIDC_MONGO_HOSTS: 'db.example.test',
      MONGODB_OIDC_PROVIDER_HOSTS: 'identity.example.test',
    });
    const client = createMongoClient(config.connection);
    try {
      assert.equal(client.options.credentials?.mechanism, 'MONGODB-OIDC');
      assert.equal(typeof client.options.credentials?.mechanismProperties.OIDC_HUMAN_CALLBACK, 'function');
      assert.deepEqual(client.options.credentials?.mechanismProperties.ALLOWED_HOSTS, ['db.example.test']);
    } finally {
      await client.close();
    }
  });

  it('uses a browser, loopback state, nonce and S256 PKCE with a mocked provider', async () => {
    const config = configuration(await unusedPort());
    const client = provider(config);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const accessToken = randomBytes(24).toString('base64url');
    let browserUrl: URL | undefined;
    let tokenRequests = 0;
    client[oidc.customFetch] = async (url, options) => {
      assert.equal(url, 'https://identity.example.test/token');
      assert.ok(options.body instanceof URLSearchParams);
      assert.ok(browserUrl !== undefined);
      const verifier = options.body.get('code_verifier');
      assert.ok(verifier !== null);
      assert.equal(await oidc.calculatePKCECodeChallenge(verifier), browserUrl.searchParams.get('code_challenge'));
      assert.equal(options.body.get('redirect_uri'), config.redirectUri);
      const now = Math.floor(Date.now() / 1000);
      const header = jwtPart({ alg: 'RS256', typ: 'JWT' });
      const payload = jwtPart({
        iss: config.issuer,
        aud: config.clientId,
        sub: 'test-subject',
        iat: now,
        exp: now + 300,
        nonce: browserUrl.searchParams.get('nonce'),
      });
      const signingInput = `${header}.${payload}`;
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
      tokenRequests += 1;
      return new Response(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: `${signingInput}.${signature}`,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const dependencies: OidcDependencies = {
      async discover(): Promise<oidc.Configuration> {
        return client;
      },
      async openBrowser(url): Promise<void> {
        browserUrl = url;
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('scope'), 'openid email');
        const state = url.searchParams.get('state');
        assert.ok(state !== null);
        const invalid = new URL(config.redirectUri);
        invalid.searchParams.set('state', 'invalid');
        invalid.searchParams.set('code', 'fake-code');
        assert.equal((await fetch(invalid)).status, 400);
        const valid = new URL(config.redirectUri);
        valid.searchParams.set('state', state);
        valid.searchParams.set('code', 'fake-code');
        assert.equal((await fetch(valid)).status, 200);
      },
    };
    const result = await createOidcHumanCallback(config, dependencies)(callbackParams(config));
    assert.ok(result.accessToken === accessToken);
    assert.ok(result.expiresInSeconds !== undefined && result.expiresInSeconds > 0);
    assert.equal(tokenRequests, 1);
    await assert.rejects(fetch(config.redirectUri));
  });

  it('rejects issuer, client, scope and endpoint mismatches before opening a browser', async () => {
    const config = configuration(await unusedPort());
    let browserOpened = false;
    let discoveryCalls = 0;
    const dependencies: OidcDependencies = {
      async discover(): Promise<oidc.Configuration> {
        discoveryCalls += 1;
        return provider(config, 'https://untrusted.example.test/authorize');
      },
      async openBrowser(): Promise<void> {
        browserOpened = true;
      },
    };
    const callback = createOidcHumanCallback(config, dependencies);
    const params = callbackParams(config);
    await assert.rejects(callback({ ...params, idpInfo: {
      issuer: 'https://untrusted.example.test', clientId: config.clientId,
    } }), OidcError);
    await assert.rejects(callback({ ...params, idpInfo: {
      issuer: config.issuer, clientId: 'other-client',
    } }), OidcError);
    await assert.rejects(callback({ ...params, idpInfo: {
      issuer: config.issuer, clientId: config.clientId, requestScopes: ['unapproved'],
    } }), OidcError);
    assert.equal(discoveryCalls, 0);
    await assert.rejects(callback(params), OidcError);
    assert.equal(discoveryCalls, 1);
    assert.equal(browserOpened, false);
  });

  it('closes the loopback listener when the driver cancels authentication', async () => {
    const port = await unusedPort();
    const config = configuration(port);
    const controller = new AbortController();
    const dependencies: OidcDependencies = {
      async discover(): Promise<oidc.Configuration> {
        return provider(config);
      },
      async openBrowser(): Promise<void> {
        controller.abort();
      },
    };
    await assert.rejects(createOidcHumanCallback(config, dependencies)(callbackParams(config, controller.signal)), OidcError);
    await assert.rejects(fetch(config.redirectUri));
  });
});
