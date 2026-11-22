import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ConfigurationError,
  loadConfiguration,
  missingConfiguration,
} from '../src/infrastructure/configuration.js';
import type { Environment } from '../src/infrastructure/configuration.js';
import { collectEnvironment } from '../src/interfaces/cli/setup.js';
import type { Prompt } from '../src/interfaces/cli/setup.js';

const password = randomBytes(24).toString('base64url');
const base: Environment = {
  MONGODB_AUTH_MODE: 'scram',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/?authSource=shop',
  MONGODB_USERNAME: 'readonly-user',
  MONGODB_PASSWORD: password,
  MONGODB_AUTH_SOURCE: 'shop',
  MONGODB_ALLOWED_DATABASES: 'shop',
  MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
};
const oidcBase: Environment = {
  MONGODB_AUTH_MODE: 'oidc',
  MONGODB_URI: 'mongodb://db.example.test/?tls=true',
  MONGODB_ALLOWED_DATABASES: 'shop',
  MONGODB_ALLOWED_COLLECTIONS: '{"shop":["orders"]}',
  MONGODB_OIDC_ISSUER: 'https://identity.example.test/tenant',
  MONGODB_OIDC_CLIENT_ID: 'public-client',
  MONGODB_OIDC_MONGO_HOSTS: 'db.example.test',
  MONGODB_OIDC_PROVIDER_HOSTS: 'identity.example.test',
};

function assertConfigError(env: Environment): void {
  assert.throws(() => loadConfiguration(env), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(!error.message.includes(password));
    const uri = env.MONGODB_URI;
    if (uri !== undefined) {
      assert.ok(!error.message.includes(uri));
    }
    return true;
  });
}

describe('connection configuration', () => {
  it('uses the environment and prompts only for missing values for the selected mode', async () => {
    const asked: { name: string; secret: boolean }[] = [];
    const input: Environment = { ...base, MONGODB_USERNAME: undefined, MONGODB_PASSWORD: undefined };
    const prompt: Prompt = {
      async ask(name, _description, secret): Promise<string> {
        asked.push({ name, secret });
        return name === 'MONGODB_USERNAME' ? 'readonly-user' : password;
      },
    };
    const result = await collectEnvironment(input, prompt);
    assert.deepEqual(asked, [
      { name: 'MONGODB_USERNAME', secret: false },
      { name: 'MONGODB_PASSWORD', secret: true },
    ]);
    assert.equal(result.MONGODB_URI, base.MONGODB_URI);
    const configuration = loadConfiguration(result);
    assert.equal(configuration.connection.mode, 'scram');
    assert.ok(configuration.connection.mode === 'scram' && configuration.connection.password === password);

    const missingUri: Environment = { ...base, MONGODB_URI: undefined };
    const uriPrompts: boolean[] = [];
    await collectEnvironment(missingUri, {
      async ask(_name, _description, secret): Promise<string> {
        uriPrompts.push(secret);
        return base.MONGODB_URI ?? '';
      },
    });
    assert.deepEqual(uriPrompts, [true]);
  });

  it('collects only OIDC-specific missing settings and never requests a password', async () => {
    const asked: string[] = [];
    const answers: Record<string, string> = {
      MONGODB_OIDC_CLIENT_ID: 'public-client',
      MONGODB_OIDC_MONGO_HOSTS: 'db.example.test',
      MONGODB_OIDC_PROVIDER_HOSTS: 'identity.example.test',
    };
    const input: Environment = {
      ...oidcBase,
      MONGODB_OIDC_CLIENT_ID: undefined,
      MONGODB_OIDC_MONGO_HOSTS: undefined,
      MONGODB_OIDC_PROVIDER_HOSTS: undefined,
    };
    await collectEnvironment(input, {
      async ask(name, _description, secret): Promise<string> {
        asked.push(name);
        assert.equal(secret, false);
        return answers[name] ?? '';
      },
    });
    assert.deepEqual(asked, [
      'MONGODB_OIDC_CLIENT_ID',
      'MONGODB_OIDC_MONGO_HOSTS',
      'MONGODB_OIDC_PROVIDER_HOSTS',
    ]);
  });

  it('reports missing variables and sanitizes invalid URI, TLS and credential errors', () => {
    assert.deepEqual(missingConfiguration({ MONGODB_AUTH_MODE: 'scram' }), [
      'MONGODB_URI',
      'MONGODB_USERNAME',
      'MONGODB_PASSWORD',
    ]);
    assert.deepEqual(missingConfiguration({}), ['MONGODB_URI']);
    assert.deepEqual(missingConfiguration({
      MONGODB_URI: 'mongodb://db.example.test/?tls=true&authMechanism=MONGODB-OIDC',
    }), [
      'MONGODB_OIDC_ISSUER',
      'MONGODB_OIDC_CLIENT_ID',
      'MONGODB_OIDC_MONGO_HOSTS',
      'MONGODB_OIDC_PROVIDER_HOSTS',
    ]);
    assertConfigError({ ...base, MONGODB_URI: `not-a-uri-${password}` });
    for (const option of [
      'tlsInsecure=true',
      'tlsAllowInvalidCertificates=true',
      'tlsAllowInvalidHostnames=true',
      'sslValidate=false',
    ]) {
      assertConfigError({ ...base, MONGODB_URI: `mongodb://127.0.0.1:27017/?${option}` });
    }
    assertConfigError({ ...base, NODE_TLS_REJECT_UNAUTHORIZED: '0' });
    assertConfigError({ ...base, MONGODB_URI: `mongodb://user:${encodeURIComponent(password)}@127.0.0.1/` });
    assertConfigError({ ...base, MONGODB_AUTH_SOURCE: 'other' });
    assertConfigError({ ...base, MONGODB_URI: 'mongodb://127.0.0.1/?authMechanism=MONGODB-OIDC' });
  });

  it('accepts authenticated URI mode and rejects ambiguous or unauthenticated modes', () => {
    const uri = `mongodb://reader:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=shop`;
    const env: Environment = {
      ...base,
      MONGODB_AUTH_MODE: 'uri',
      MONGODB_URI: uri,
      MONGODB_USERNAME: undefined,
      MONGODB_PASSWORD: undefined,
      MONGODB_AUTH_SOURCE: undefined,
    };
    assert.equal(loadConfiguration(env).connection.mode, 'uri');
    assertConfigError({ ...env, MONGODB_PASSWORD: password });
    assertConfigError({ ...env, MONGODB_URI: 'mongodb://127.0.0.1:27017/' });
    assertConfigError({ ...env, MONGODB_URI: `${uri}&authMechanism=MONGODB-OIDC` });
  });

  it('infers authentication mode and defaults database and collection policies to identity permissions', () => {
    const uri = `mongodb://reader:${encodeURIComponent(password)}@127.0.0.1:27017/?authSource=shop`;
    const uriConfiguration = loadConfiguration({ MONGODB_URI: uri });
    assert.equal(uriConfiguration.connection.mode, 'uri');
    assert.equal(uriConfiguration.policy.allowedDatabaseNames, undefined);
    assert.equal(uriConfiguration.policy.allowedCollectionNames.size, 0);

    const scramConfiguration = loadConfiguration({
      MONGODB_URI: base.MONGODB_URI,
      MONGODB_USERNAME: 'readonly-user',
      MONGODB_PASSWORD: password,
    });
    assert.equal(scramConfiguration.connection.mode, 'scram');
    assert.equal(scramConfiguration.policy.allowedDatabaseNames, undefined);

    const oidcConfiguration = loadConfiguration({
      ...oidcBase,
      MONGODB_AUTH_MODE: undefined,
      MONGODB_ALLOWED_DATABASES: undefined,
      MONGODB_ALLOWED_COLLECTIONS: undefined,
    });
    assert.equal(oidcConfiguration.connection.mode, 'oidc');
    assert.equal(oidcConfiguration.policy.allowedCollectionNames.size, 0);
  });

  it('uses only the URI for an unauthenticated connection and does not prompt for credentials', async () => {
    const uri = 'mongodb://127.0.0.1:27017/flowboard';
    const environment: Environment = { MONGODB_URI: uri };
    assert.deepEqual(missingConfiguration(environment), []);
    assert.equal(loadConfiguration(environment).connection.mode, 'none');
    assert.equal(loadConfiguration({ ...environment, MONGODB_AUTH_MODE: 'none' }).connection.mode, 'none');

    const asked: { name: string; secret: boolean }[] = [];
    const collected = await collectEnvironment({}, {
      async ask(name, _description, secret): Promise<string> {
        asked.push({ name, secret });
        return uri;
      },
    });
    assert.deepEqual(asked, [{ name: 'MONGODB_URI', secret: true }]);
    assert.equal(loadConfiguration(collected).connection.mode, 'none');
  });

  it('does not downgrade authenticated or conflicting configurations to unauthenticated mode', () => {
    const uri = 'mongodb://127.0.0.1:27017/flowboard';
    assert.deepEqual(missingConfiguration({ MONGODB_URI: uri, MONGODB_AUTH_MODE: 'scram' }), [
      'MONGODB_USERNAME',
      'MONGODB_PASSWORD',
    ]);
    assert.deepEqual(missingConfiguration({ MONGODB_URI: uri, MONGODB_USERNAME: 'reader' }), [
      'MONGODB_PASSWORD',
    ]);
    assert.deepEqual(missingConfiguration({ MONGODB_URI: `${uri}?authMechanism=SCRAM-SHA-256` }), [
      'MONGODB_USERNAME',
      'MONGODB_PASSWORD',
    ]);
    const environment: Environment = { MONGODB_URI: uri, MONGODB_AUTH_MODE: 'none' };
    assertConfigError({ ...environment, MONGODB_USERNAME: 'reader' });
    assertConfigError({ ...environment, MONGODB_AUTH_SOURCE: 'shop' });
    assertConfigError({ ...environment, MONGODB_URI: `mongodb://reader:${encodeURIComponent(password)}@127.0.0.1/` });
    assertConfigError({ ...environment, MONGODB_URI: `${uri}?authSource=shop` });
    assertConfigError({ ...environment, MONGODB_URI: `${uri}?authMechanism=MONGODB-AWS` });
    assertConfigError({ ...environment, MONGODB_URI: `${uri}?tlsInsecure=true` });
  });

  it('allows the setup flow to ask only for a URI and mode-specific credentials', async () => {
    const asked: string[] = [];
    const result = await collectEnvironment({}, {
      async ask(name): Promise<string> {
        asked.push(name);
        if (name === 'MONGODB_URI') {
          return base.MONGODB_URI ?? '';
        }
        if (name === 'MONGODB_USERNAME') {
          return 'readonly-user';
        }
        if (name === 'MONGODB_PASSWORD') {
          return password;
        }
        return '';
      },
    });
    assert.deepEqual(asked, ['MONGODB_URI', 'MONGODB_USERNAME', 'MONGODB_PASSWORD']);
    assert.equal(result.MONGODB_AUTH_MODE, undefined);
    assert.equal(result.MONGODB_ALLOWED_DATABASES, undefined);
    assert.equal(result.MONGODB_ALLOWED_COLLECTIONS, undefined);
    assert.equal(loadConfiguration(result).connection.mode, 'scram');
  });

  it('pins OIDC hosts and issuer, requires TLS and does not fall back to SCRAM', () => {
    const configuration = loadConfiguration(oidcBase);
    assert.equal(configuration.connection.mode, 'oidc');
    assertConfigError({ ...oidcBase, MONGODB_URI: 'mongodb://other.example.test/?tls=true' });
    assertConfigError({ ...oidcBase, MONGODB_URI: 'mongodb://db.example.test/?tls=false' });
    assertConfigError({ ...oidcBase, MONGODB_OIDC_ISSUER: 'https://other.example.test/' });
    assertConfigError({ ...oidcBase, MONGODB_OIDC_ISSUER: 'http://identity.example.test/' });
    assertConfigError({ ...oidcBase, MONGODB_PASSWORD: password });
    assertConfigError({ ...oidcBase, MONGODB_URI: 'mongodb://db.example.test/?tls=true&authMechanism=SCRAM-SHA-256' });
    assertConfigError({ ...oidcBase, MONGODB_OIDC_REDIRECT_URI: 'http://0.0.0.0:8400/callback' });
    assert.equal(loadConfiguration({ ...oidcBase, MONGODB_OIDC_REDIRECT_URI: '' }).connection.mode, 'oidc');
  });

  it('keeps explicit database and collection policies optional while validating supplied restrictions', () => {
    assertConfigError({ ...base, MONGODB_ALLOWED_DATABASES: 'admin' });
    assertConfigError({ ...base, MONGODB_ALLOWED_DATABASES: 'shop,local' });
    assertConfigError({ ...base, MONGODB_ALLOWED_COLLECTIONS: '{"shop":["system.users"]}' });
    assertConfigError({ ...base, MONGODB_ALLOWED_COLLECTIONS: '{"other":["orders"]}' });
    assertConfigError({ ...base, MONGODB_ALLOWED_FIELDS: '{"shop":{"orders":["profile","profile.secret"]}}' });
    assertConfigError({ ...base, MONGODB_ALLOWED_FIELDS: '{"shop":{"orders":["_id.secret"]}}' });
    assertConfigError({ ...base, MONGODB_ALLOWED_COLLECTIONS: '{}' });
    assert.equal(loadConfiguration({ ...base, MONGODB_QUERY_TIMEOUT_MS: '' }).queryTimeoutMs, 5_000);
  });

  it('defaults MONGODB_ONLY_READ to true and accepts only true or false', () => {
    assert.equal(loadConfiguration(base).readOnly, true);
    assert.equal(loadConfiguration({ ...base, MONGODB_ONLY_READ: ' TRUE ' }).readOnly, true);
    assert.equal(loadConfiguration({ ...base, MONGODB_ONLY_READ: 'false' }).readOnly, false);
    assertConfigError({ ...base, MONGODB_ONLY_READ: 'no' });
    assertConfigError({ ...base, MONGODB_ONLY_READ: '0' });
  });
});
