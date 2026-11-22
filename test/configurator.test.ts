import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { createServer } from 'node:net';
import { loadConfiguration } from '../src/infrastructure/configuration.js';
import { readStoredConfiguration, resolveEnvironmentWithSources } from '../src/infrastructure/configuration-store.js';
import { createOidcHumanCallback, OidcError } from '../src/infrastructure/oidc.js';
import { LibsecretStore } from '../src/infrastructure/secret-store.js';
import { isolatedEnvironment, record, StdioSession } from './helpers/stdio.js';

const unix = process.platform !== 'win32';

interface Fixture {
  readonly root: string;
  readonly config: string;
  readonly app: string;
  readonly workspace: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-configurator-'));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const config = join(root, 'config');
  return { root, config, app: join(config, 'mongodb-readonly-mcp'), workspace };
}

function configure(f: Fixture, args: readonly string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [join(process.cwd(), 'dist/interfaces/cli/configure.js'), ...args], {
    cwd: f.workspace,
    env: isolatedEnvironment({ XDG_CONFIG_HOME: f.config, APPDATA: f.config, ...env }),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

async function json(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, 'utf8')));
}

async function callTool(session: StdioSession): Promise<string> {
  const response = await session.request('tools/call', { name: 'find', arguments: { database: 'elsewhere', collection: 'orders', filter: {} } });
  return JSON.stringify(response.result);
}

describe('configurator profiles and isolation', () => {
  it('keeps two instances with different databases from mixing values (A then B)', async () => {
    const f = await fixture();
    const passwordA = randomBytes(18).toString('base64url');
    try {
      const a = configure(f, ['--profile', 'a', '--save', '--from-env', '--secret-store=file'], {
        MONGODB_AUTH_MODE: 'scram',
        MONGODB_URI: 'mongodb://host-a.example.test/',
        MONGODB_USERNAME: 'reader-a',
        MONGODB_PASSWORD: passwordA,
        MONGODB_AUTH_SOURCE: 'bancoA',
        MONGODB_ALLOWED_DATABASES: 'bancoA',
      });
      assert.equal(a.status, 0, a.stderr);
      assert.ok(!a.stderr.includes(passwordA));
      assert.match(a.stderr, /Novo arquivo criado em .*profiles\/a\.json \(fingerprint hmac-sha256:[0-9a-f]{12}\)/u);
      const b = configure(f, ['--profile', 'b', '--save', '--from-env', '--secret-store=file'], {
        MONGODB_URI: 'mongodb://host-b.example.test/',
        MONGODB_ALLOWED_DATABASES: 'bancoB',
      });
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(await json(join(f.app, 'profiles', 'b.json')), {
        MONGODB_URI: 'mongodb://host-b.example.test/',
        MONGODB_ALLOWED_DATABASES: 'bancoB',
      });
      const profileA = await json(join(f.app, 'profiles', 'a.json'));
      assert.equal(profileA.MONGODB_URI, 'mongodb://host-a.example.test/');
      assert.equal(profileA.MONGODB_PASSWORD, passwordA);
      await assert.rejects(readFile(join(f.app, 'config.json')), { code: 'ENOENT' });

      const list = configure(f, ['--list-profiles']);
      assert.equal(list.status, 0, list.stderr);
      assert.match(list.stderr, /^a: .*host-a\.example\.test.*bancoA/mu);
      assert.match(list.stderr, /^b: .*host-b\.example\.test.*bancoB/mu);
      assert.ok(!list.stderr.includes(passwordA));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('refuses to silently merge exported variables into the shared default file', async () => {
    const f = await fixture();
    try {
      const env = { MONGODB_URI: 'mongodb://host-a.example.test/', MONGODB_ALLOWED_DATABASES: 'bancoA' };
      const refused = configure(f, ['--save'], env);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /O ambiente define MONGODB_URI, MONGODB_ALLOWED_DATABASES\. Use --from-env .* ou --ignore-env/u);
      await assert.rejects(readFile(join(f.app, 'config.json')), { code: 'ENOENT' });
      const imported = configure(f, ['--save', '--from-env'], env);
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(imported.stderr, /Importando do ambiente: MONGODB_URI, MONGODB_ALLOWED_DATABASES/u);
      const profile = configure(f, ['--profile', 'other', '--save'], { ...env, MONGODB_URI: 'mongodb://ignored/' });
      assert.equal(profile.status, 1, 'Explicit targets ignore exported variables, so required values are missing');
      assert.match(profile.stderr, /Variáveis do ambiente ignoradas/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('updates, unsets, resets and rejects invalid combinations explicitly', async () => {
    const f = await fixture();
    const profile = join(f.root, 'config', 'mongodb-readonly-mcp', 'profiles', 'a.json');
    try {
      const missing = configure(f, ['--profile', 'a', '--update', '--save']);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Não há configuração salva .* para atualizar/u);
      assert.equal(configure(f, ['--profile', 'a', '--save', '--from-env'], {
        MONGODB_URI: 'mongodb://host-a/', MONGODB_ALLOWED_DATABASES: 'shop', MONGODB_QUERY_TIMEOUT_MS: '5000',
      }).status, 0);
      const updated = configure(f, ['--profile', 'a', '--update', '--save', '--from-env'], { MONGODB_ALLOWED_DATABASES: 'sales' });
      assert.equal(updated.status, 0, updated.stderr);
      assert.deepEqual(await json(profile), {
        MONGODB_URI: 'mongodb://host-a/', MONGODB_ALLOWED_DATABASES: 'sales', MONGODB_QUERY_TIMEOUT_MS: '5000',
      });
      const unset = configure(f, ['--profile', 'a', '--save', '--unset', 'MONGODB_QUERY_TIMEOUT_MS']);
      assert.equal(unset.status, 0, unset.stderr);
      assert.deepEqual(await json(profile), { MONGODB_URI: 'mongodb://host-a/', MONGODB_ALLOWED_DATABASES: 'sales' });

      const invalidUpdate = configure(f, ['--profile', 'a', '--save', '--unset', 'MONGODB_URI']);
      assert.equal(invalidUpdate.status, 1);
      assert.match(invalidUpdate.stderr, /Valores vindos do arquivo .*profiles\/a\.json/u);
      assert.match(invalidUpdate.stderr, /Execute sem --update/u);

      for (const args of [
        ['--unknown'],
        ['--vscode', '--copilot'],
        ['--from-env', '--ignore-env'],
        ['--bind'],
        ['--unset', 'PATH'],
        ['--list-profiles', '--save'],
        ['--profile', 'Invalid Name'],
      ]) {
        const result = configure(f, args);
        assert.equal(result.status, 1, args.join(' '));
      }

      await writeFile(profile, 'garbage', { mode: 0o600 });
      const blocked = configure(f, ['--profile', 'a', '--update', '--save']);
      assert.equal(blocked.status, 1);
      assert.match(blocked.stderr, /inválido \(JSON inválido\).*--reset/u);
      const reset = configure(f, ['--profile', 'a', '--reset', '--save']);
      assert.equal(reset.status, 0, reset.stderr);
      await assert.rejects(readFile(profile), { code: 'ENOENT' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('binds a workspace to a profile and refuses a changed profile until it is bound again', async () => {
    const f = await fixture();
    const env = { MONGODB_URI: 'mongodb://127.0.0.1:1/', MONGODB_ALLOWED_DATABASES: 'shop' };
    const server = { XDG_CONFIG_HOME: f.config, APPDATA: f.config, MONGODB_MCP_WORKSPACE: f.workspace };
    try {
      const saved = configure(f, ['--profile', 'a', '--save', '--from-env', '--bind'], env);
      assert.equal(saved.status, 0, saved.stderr);
      assert.match(saved.stderr, /vinculado ao perfil a/u);
      assert.equal((await readdir(join(f.app, 'bindings'))).length, 1);

      const bound = new StdioSession({ ...server, MONGODB_URI: 'mongodb://stale-env/', MONGODB_AUTH_MODE: 'uri' });
      try {
        await bound.initialize();
        assert.match(await callTool(bound), /Banco de dados não autorizado/u);
      } finally {
        assert.equal(await bound.close(), 0);
      }
      // Mensagem informativa segue pelo log MCP no nível info, não pelo stderr (exibido como aviso).
      assert.match(bound.logs.join('\n'), /^info: Configuração carregada de .*profiles\/a\.json \(fonte vínculo do workspace \(perfil a\)\).*fingerprint hmac-sha256:/mu);
      assert.ok(!bound.stderr.includes('Configuração carregada'));
      assert.ok(!bound.stderr.includes('stale-env'));

      const changed = configure(f, ['--profile', 'a', '--save', '--from-env'], { ...env, MONGODB_ALLOWED_DATABASES: 'other' });
      assert.equal(changed.status, 0, changed.stderr);
      const diverged = new StdioSession(server);
      try {
        await diverged.initialize();
        const text = await callTool(diverged);
        assert.match(text, /mudou desde o vínculo deste workspace/u);
        assert.match(text, /--profile a --bind/u);
      } finally {
        assert.equal(await diverged.close(), 0);
      }
      const check = configure(f, ['--check', '--profile', 'a']);
      assert.equal(check.status, 1);
      assert.match(check.stderr, /Vínculo do workspace: divergente/u);

      assert.equal(configure(f, ['--profile', 'a', '--bind']).status, 0);
      const accepted = new StdioSession(server);
      try {
        await accepted.initialize();
        assert.match(await callTool(accepted), /Banco de dados não autorizado/u);
      } finally {
        assert.equal(await accepted.close(), 0);
      }

      const unbind = configure(f, ['--unbind']);
      assert.equal(unbind.status, 0, unbind.stderr);
      assert.match(unbind.stderr, /removido/u);
      const reset = configure(f, ['--profile', 'a', '--reset', '--save']);
      assert.equal(reset.status, 0, reset.stderr);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('stores secrets in the system keyring through stdin only', { skip: !unix }, async () => {
    const f = await fixture();
    const tools = join(f.root, 'bin');
    const vault = join(f.root, 'vault');
    const password = randomBytes(18).toString('base64url');
    const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_SECRET_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'argv.log'), JSON.stringify(args) + '\\n');
const file = path.join(dir, 'item-' + args[args.indexOf('id') + 1]);
if (args[0] === 'store') fs.writeFileSync(file, fs.readFileSync(0, 'utf8'));
else if (args[0] === 'lookup') { if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8')); else process.exit(1); }
else if (args[0] === 'clear') fs.rmSync(file, { force: true });
`;
    try {
      await mkdir(tools);
      await mkdir(vault);
      await writeFile(join(tools, 'secret-tool'), fake, { mode: 0o700 });
      const env = {
        PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fake',
        FAKE_SECRET_DIR: vault,
      };
      const values = { MONGODB_AUTH_MODE: 'scram', MONGODB_URI: 'mongodb://127.0.0.1:1/', MONGODB_USERNAME: 'reader', MONGODB_PASSWORD: password };
      const saved = configure(f, ['--profile', 'a', '--save', '--from-env', '--secret-store=keyring'], { ...env, ...values });
      assert.equal(saved.status, 0, saved.stderr);
      const path = join(f.app, 'profiles', 'a.json');
      const text = await readFile(path, 'utf8');
      assert.ok(!text.includes(password));
      const stored = await readStoredConfiguration(path);
      assert.equal(stored?.format, 2);
      assert.deepEqual(Object.keys(stored?.secrets ?? {}), ['MONGODB_PASSWORD']);
      assert.ok(!(await readFile(join(vault, 'argv.log'), 'utf8')).includes(password));
      const store = new LibsecretStore(join(tools, 'secret-tool'), { ...process.env, ...env });
      const resolved = await resolveEnvironmentWithSources({}, { path, merge: false, stores: () => store });
      assert.equal(resolved.values.MONGODB_PASSWORD, password);
      assert.equal(loadConfiguration(resolved.values).connection.mode, 'scram');

      const replaced = configure(f, ['--profile', 'a', '--save', '--from-env', '--secret-store=file'], { ...env, ...values });
      assert.equal(replaced.status, 0, replaced.stderr);
      assert.deepEqual((await readdir(vault)).filter((name) => name.startsWith('item-')), [], 'Old keyring items are removed');

      const unavailable = configure(f, ['--profile', 'b', '--save', '--from-env', '--secret-store=keyring'], {
        ...values, DBUS_SESSION_BUS_ADDRESS: undefined, XDG_RUNTIME_DIR: undefined,
      });
      assert.equal(unavailable.status, 1);
      assert.match(unavailable.stderr, /--secret-store=file/u);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('OIDC callback port', () => {
  it('explains a callback port already used by another instance', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    assert.ok(address !== null && typeof address !== 'string');
    const config = {
      issuer: 'https://identity.example.test/tenant',
      clientId: 'public-client',
      mongoHosts: ['db.example.test'],
      providerHosts: new Set(['identity.example.test']),
      allowedScopes: new Set(['openid']),
      redirectUri: `http://127.0.0.1:${address.port}/callback`,
    };
    try {
      await assert.rejects(
        createOidcHumanCallback(config, {
          async discover() {
            const oidc = await import('openid-client');
            return new oidc.Configuration({
              issuer: config.issuer,
              authorization_endpoint: 'https://identity.example.test/authorize',
              token_endpoint: 'https://identity.example.test/token',
              code_challenge_methods_supported: ['S256'],
            }, config.clientId, undefined, oidc.None());
          },
          async openBrowser() {
            assert.fail('The browser must not open when the callback port is busy');
          },
        })({ version: 1, timeoutContext: new AbortController().signal, idpInfo: { issuer: config.issuer, clientId: config.clientId } }),
        (error) => error instanceof OidcError && new RegExp(`porta ${address.port} do callback OIDC está em uso`, 'u').test(error.message),
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
