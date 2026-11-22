import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError, loadConfiguration } from '../src/infrastructure/configuration.js';
import {
  describeConfiguration,
  readStoredConfiguration,
  resolveEnvironmentWithSources,
  resolveTarget,
  secretVariables,
  serializeConfiguration,
} from '../src/infrastructure/configuration-store.js';
import { withFileLock } from '../src/infrastructure/file-lock.js';
import { computeFingerprint, loadFingerprintKey } from '../src/infrastructure/fingerprint.js';
import {
  describeIoError,
  ensurePrivateDirectory,
  InvalidPrivateFileError,
  readPrivateFile,
  writePrivateFile,
} from '../src/infrastructure/private-file.js';
import { canonicalWorkspace, listBindings, readBinding, writeBinding } from '../src/infrastructure/workspace-binding.js';

const unix = process.platform !== 'win32';

async function temporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function rejectsWith(reason: InvalidPrivateFileError['reason']): (error: unknown) => boolean {
  return (error) => error instanceof InvalidPrivateFileError && error.reason === reason;
}

describe('private storage', () => {
  it('classifies rejected files and tells which ones can be replaced safely', { skip: !unix }, async () => {
    const root = await temporaryRoot('mongodb-mcp-private-');
    const path = join(root, 'config.json');
    try {
      assert.equal(await readPrivateFile(path, 1_024), undefined);
      await writeFile(path, '{}', { mode: 0o644 });
      await chmod(path, 0o644);
      await assert.rejects(readPrivateFile(path, 1_024), (error) => {
        assert.ok(error instanceof InvalidPrivateFileError);
        assert.equal(error.reason, 'permissions');
        assert.equal(error.replaceable, true);
        assert.match(error.message, new RegExp(`chmod 600 ${path}`, 'u'));
        return true;
      });
      await chmod(path, 0o600);
      await writeFile(path, 'x'.repeat(2_048));
      await assert.rejects(readPrivateFile(path, 1_024), rejectsWith('too-large'));
      const link = join(root, 'link.json');
      await symlink(path, link);
      await assert.rejects(readPrivateFile(link, 1_024), (error) => {
        assert.ok(error instanceof InvalidPrivateFileError);
        assert.equal(error.reason, 'symlink');
        assert.equal(error.replaceable, false);
        return true;
      });
      await mkdir(join(root, 'directory.json'));
      await assert.rejects(readPrivateFile(join(root, 'directory.json'), 1_024), rejectsWith('not-file'));
      await writeFile(path, 'not json', { mode: 0o600 });
      await assert.rejects(readStoredConfiguration(path), rejectsWith('json'));
      await writeFile(path, JSON.stringify({ version: 3, variables: {}, secrets: {} }), { mode: 0o600 });
      await assert.rejects(readStoredConfiguration(path), rejectsWith('schema'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes atomically with 0600, fixes application directories and refuses unsafe foreign ones', { skip: !unix }, async () => {
    const root = await temporaryRoot('mongodb-mcp-write-');
    const app = join(root, 'app');
    const foreign = join(root, 'shared');
    try {
      await mkdir(app, { mode: 0o755 });
      await chmod(app, 0o755);
      await ensurePrivateDirectory(join(app, 'profiles'), app);
      assert.equal((await stat(app)).mode & 0o777, 0o755, 'Only the requested directory is changed');
      await ensurePrivateDirectory(app, app);
      assert.equal((await stat(app)).mode & 0o777, 0o700);
      const path = join(app, 'profiles', 'a.json');
      await writePrivateFile(path, '{"MONGODB_URI":"mongodb://a/"}\n');
      await writePrivateFile(path, '{"MONGODB_URI":"mongodb://b/"}\n');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal(await readFile(path, 'utf8'), '{"MONGODB_URI":"mongodb://b/"}\n');
      await mkdir(foreign, { mode: 0o777 });
      await chmod(foreign, 0o777);
      await assert.rejects(ensurePrivateDirectory(foreign, app), /chmod 700/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps file system errors to actionable messages', () => {
    const error = (code: string): Error => Object.assign(new Error(code), { code });
    assert.match(describeIoError(error('EACCES'), '/x/config.json', 'gravar').message, /Sem permissão para gravar em \/x/u);
    assert.match(describeIoError(error('ENOSPC'), '/x/config.json', 'gravar').message, /Sem espaço em disco/u);
    assert.match(describeIoError(error('EROFS'), '/x/config.json', 'gravar').message, /somente leitura/u);
    assert.match(describeIoError(error('ENOTDIR'), '/x/config.json', 'ler').message, /não é um diretório/u);
    assert.match(describeIoError(error('EOTHER'), '/x/config.json', 'ler').message, /configuração privada/u);
  });

  it('serializes concurrent writers, times out and recovers stale locks from dead processes', async () => {
    const root = await temporaryRoot('mongodb-mcp-lock-');
    const path = join(root, 'config.json');
    try {
      const events: string[] = [];
      const writer = (name: string) => withFileLock(path, async () => {
        events.push(`${name}:start`);
        await delay(50);
        events.push(`${name}:end`);
      }, { intervalMs: 10 });
      await Promise.all([writer('a'), writer('b')]);
      assert.ok(events[1]?.endsWith(':end'), `Writers overlapped: ${events.join(', ')}`);
      const holder = withFileLock(path, () => delay(300), { intervalMs: 10 });
      await delay(20);
      await assert.rejects(withFileLock(path, async () => undefined, { timeoutMs: 100, intervalMs: 10 }), /Outra execução do configurador/u);
      await holder;
      const finished = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
      await writeFile(`${path}.lock`, JSON.stringify({ pid: Number(finished.stdout), hostname: hostname(), createdAt: '' }));
      const old = new Date(Date.now() - 60_000);
      await utimes(`${path}.lock`, old, old);
      assert.equal(await withFileLock(path, async () => 'ok', { timeoutMs: 200, intervalMs: 10 }), 'ok');
      await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: '' }));
      await utimes(`${path}.lock`, old, old);
      await assert.rejects(withFileLock(path, async () => undefined, { timeoutMs: 100, intervalMs: 10 }), /Outra execução/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives a keyed fingerprint that changes with the configuration and binds canonical workspaces', async () => {
    const root = await temporaryRoot('mongodb-mcp-fingerprint-');
    const app = join(root, 'app');
    const workspace = join(root, 'project');
    try {
      assert.equal(await loadFingerprintKey(app, false), undefined);
      const key = await loadFingerprintKey(app, true);
      assert.ok(key !== undefined);
      assert.deepEqual(await loadFingerprintKey(app, false), key);
      if (unix) {
        assert.equal((await stat(join(app, 'fingerprint.key'))).mode & 0o777, 0o600);
      }
      const names = ['MONGODB_URI', 'MONGODB_ALLOWED_DATABASES'];
      const first = computeFingerprint(key, { MONGODB_URI: 'mongodb://a/', MONGODB_ALLOWED_DATABASES: 'shop' }, names);
      assert.match(first, /^hmac-sha256:[0-9a-f]{64}$/u);
      assert.equal(computeFingerprint(key, { MONGODB_ALLOWED_DATABASES: 'shop', MONGODB_URI: 'mongodb://a/', OTHER: 'x' }, names), first);
      assert.equal(computeFingerprint(key, { MONGODB_URI: 'mongodb://a/', MONGODB_ALLOWED_DATABASES: 'shop', MONGODB_PASSWORD: '' }, [...names, 'MONGODB_PASSWORD']), first);
      assert.notEqual(computeFingerprint(key, { MONGODB_URI: 'mongodb://a/', MONGODB_ALLOWED_DATABASES: 'other' }, names), first);
      assert.notEqual(computeFingerprint(Buffer.alloc(32), { MONGODB_URI: 'mongodb://a/', MONGODB_ALLOWED_DATABASES: 'shop' }, names), first);

      await mkdir(workspace);
      await symlink(workspace, join(root, 'alias'));
      const canonical = await canonicalWorkspace(join(root, 'alias'));
      assert.equal(canonical, await canonicalWorkspace(workspace));
      await assert.rejects(canonicalWorkspace('relative'), ConfigurationError);
      await writeBinding(app, { version: 1, workspace: canonical, profile: 'a', fingerprint: first });
      assert.deepEqual(await readBinding(app, canonical), { version: 1, workspace: canonical, profile: 'a', fingerprint: first });
      assert.equal((await listBindings(app)).length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('configuration sources', () => {
  it('keeps profiles and the default file apart and gives explicit sources exclusive precedence', async () => {
    const root = await temporaryRoot('mongodb-mcp-targets-');
    const env = { XDG_CONFIG_HOME: root, APPDATA: root };
    try {
      assert.equal(resolveTarget(env).kind, 'default');
      assert.equal(resolveTarget(env, 'a').path, join(root, 'mongodb-readonly-mcp', 'profiles', 'a.json'));
      assert.equal(resolveTarget({ ...env, MONGODB_MCP_PROFILE: 'b' }).profile, 'b');
      assert.throws(() => resolveTarget({ ...env, MONGODB_MCP_CONFIG: join(root, 'x.json') }, 'a'), /não ambos/u);
      assert.throws(() => resolveTarget(env, '../escape'), /Nome de perfil inválido/u);
      assert.equal(resolveTarget({ ...env, MONGODB_MCP_CONFIG: '~/x.json' }).kind, 'explicit-file');

      const path = join(root, 'explicit.json');
      await writeFile(path, serializeConfiguration({ MONGODB_URI: 'mongodb://file-host/', MONGODB_ALLOWED_DATABASES: 'fromfile' }), { mode: 0o600 });
      const exported = { MONGODB_URI: 'mongodb://env-host/', MONGODB_ALLOWED_DATABASES: 'fromenv' };
      const merged = await resolveEnvironmentWithSources(exported, { path });
      assert.equal(merged.values.MONGODB_URI, 'mongodb://env-host/');
      assert.deepEqual(merged.overridden, ['MONGODB_URI', 'MONGODB_ALLOWED_DATABASES']);
      const exclusive = await resolveEnvironmentWithSources(exported, { path, merge: false });
      assert.equal(exclusive.values.MONGODB_URI, 'mongodb://file-host/');
      assert.deepEqual(exclusive.sources, { MONGODB_URI: 'arquivo', MONGODB_ALLOWED_DATABASES: 'arquivo' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('summarizes a configuration without URI, credentials or client IDs', () => {
    const password = 'p4ss-very-secret';
    const configuration = loadConfiguration({
      MONGODB_URI: `mongodb://reader:${password}@db1.example.test:27017,db2.example.test/?replicaSet=rs`,
      MONGODB_ALLOWED_DATABASES: 'shop',
    });
    const text = describeConfiguration(configuration, { MONGODB_URI: 'prompt', MONGODB_ALLOWED_DATABASES: 'arquivo' }, '/p/config.json').join('\n');
    assert.match(text, /db1\.example\.test:27017, db2\.example\.test/u);
    assert.match(text, /Usuário: definido/u);
    assert.match(text, /arquivo: MONGODB_ALLOWED_DATABASES; prompt: MONGODB_URI/u);
    assert.ok(!text.includes(password));
    assert.ok(!text.includes('reader'));
    assert.deepEqual(secretVariables({ MONGODB_URI: `mongodb://reader:${password}@h/`, MONGODB_PASSWORD: 'x' }), ['MONGODB_URI', 'MONGODB_PASSWORD']);
    assert.deepEqual(secretVariables({ MONGODB_URI: 'mongodb://h/' }), []);
  });
});
