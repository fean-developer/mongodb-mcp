import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigurationError, loadConfiguration } from '../src/infrastructure/configuration.js';
import { configurationFilePath, resolveEnvironment, saveEnvironment, serverEnvironment } from '../src/infrastructure/configuration-store.js';
import { isolatedEnvironment } from './helpers/stdio.js';

describe('private configuration', () => {
  it('imports only supported variables, protects saved secrets and gives exported values precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-config-'));
    const path = join(root, 'private', 'config.json');
    const secret = randomBytes(24).toString('base64url');
    const location = { MONGODB_MCP_CONFIG: path };
    try {
      await saveEnvironment({
        ...location,
        MONGODB_URI: 'mongodb://127.0.0.1:1/',
        MONGODB_USERNAME: 'reader',
        MONGODB_PASSWORD: secret,
        MONGODB_ALLOWED_DATABASES: 'shop',
        UNRELATED_SECRET: secret,
      });
      const saved: unknown = JSON.parse(await readFile(path, 'utf8'));
      assert.ok(typeof saved === 'object' && saved !== null);
      assert.equal(Object.hasOwn(saved, 'UNRELATED_SECRET'), false);
      assert.equal(Object.hasOwn(saved, 'MONGODB_MCP_CONFIG'), false);
      if (process.platform !== 'win32') {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(root, 'private'))).mode & 0o777, 0o700);
      }
      const fallback = await resolveEnvironment({ ...location, MONGODB_URI: '', MONGODB_PASSWORD: ' ' });
      assert.equal(fallback.MONGODB_PASSWORD, secret);
      assert.equal(loadConfiguration(fallback).connection.mode, 'scram');
      const exported = await resolveEnvironment({ ...location, MONGODB_PASSWORD: 'replacement', MONGODB_ALLOWED_DATABASES: 'other' });
      assert.equal(exported.MONGODB_PASSWORD, 'replacement');
      assert.equal(exported.MONGODB_ALLOWED_DATABASES, 'other');
      await saveEnvironment(exported);
      assert.equal((await resolveEnvironment(location)).MONGODB_PASSWORD, 'replacement');
      assert.equal((await resolveEnvironment(location)).MONGODB_ALLOWED_DATABASES, 'other');
      const stale = { ...location, MONGODB_URI: 'mongodb://localhost:27017/stale', MONGODB_AUTH_MODE: 'uri', OTHER: 'kept' };
      const fromFile = await resolveEnvironment(serverEnvironment(stale));
      assert.equal(fromFile.MONGODB_URI, 'mongodb://127.0.0.1:1/');
      assert.equal(fromFile.MONGODB_AUTH_MODE, undefined);
      assert.equal(fromFile.MONGODB_PASSWORD, 'replacement');
      assert.equal(fromFile.OTHER, 'kept');
      assert.equal(serverEnvironment({ MONGODB_URI: 'x' }).MONGODB_URI, 'x');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports invalid, unsafe or unreadable files without exposing their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-config-errors-'));
    const path = join(root, 'config.json');
    const location = { MONGODB_MCP_CONFIG: path };
    const secret = randomBytes(24).toString('base64url');
    const sanitized = (error: unknown): boolean => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(!error.message.includes(secret));
      return true;
    };
    try {
      assert.deepEqual(await resolveEnvironment(location), location);
      assert.throws(() => configurationFilePath({ MONGODB_MCP_CONFIG: 'relative.json' }), ConfigurationError);
      for (const text of [
        secret,
        JSON.stringify({ PATH: secret }),
        JSON.stringify({ MONGODB_URI: 42, MONGODB_PASSWORD: secret }),
      ]) {
        await writeFile(path, text, { mode: 0o600 });
        await assert.rejects(resolveEnvironment(location), sanitized);
      }
      if (process.platform !== 'win32') {
        await writeFile(path, JSON.stringify({ MONGODB_URI: secret }));
        await chmod(path, 0o644);
        await assert.rejects(resolveEnvironment(location), /0600/u);
        await chmod(path, 0o600);
        const link = join(root, 'link.json');
        await symlink(path, link);
        await assert.rejects(resolveEnvironment({ MONGODB_MCP_CONFIG: link }), sanitized);
        const fifo = join(root, 'config.pipe');
        const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
        assert.equal(created.status, 0, created.stderr);
        const rejected = spawnSync(process.execPath, ['dist/interfaces/cli/configure.js', '--check'], {
          env: isolatedEnvironment({ MONGODB_MCP_CONFIG: fifo }), encoding: 'utf8', timeout: 3_000,
        });
        assert.equal(rejected.status, 1, 'A non-regular configuration file must fail without hanging');
        assert.match(rejected.stderr, /deve ser um arquivo JSON/u);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('saves an exported shell environment without starting another client or printing secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mongodb-mcp-config-cli-'));
    const path = join(root, 'config.json');
    const secret = randomBytes(24).toString('base64url');
    const env = isolatedEnvironment({
      XDG_CONFIG_HOME: join(root, 'xdg'),
      MONGODB_MCP_CONFIG: path,
      MONGODB_URI: 'mongodb://127.0.0.1:1/',
      MONGODB_USERNAME: 'reader',
      MONGODB_PASSWORD: secret,
    });
    try {
      const noConsent = spawnSync(process.execPath, ['dist/interfaces/cli/configure.js'], { env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(noConsent.status, 1);
      await assert.rejects(readFile(path), { code: 'ENOENT' });
      const saved = spawnSync(process.execPath, ['dist/interfaces/cli/configure.js', '--save', '--from-env', '--secret-store=file'], {
        env, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(saved.status, 0, saved.stderr);
      assert.equal(saved.stdout, '');
      assert.ok(!saved.stderr.includes(secret));
      assert.ok(!saved.stderr.includes(env.MONGODB_URI ?? ''));
      assert.match(saved.stderr, /não foi verificada/u);
      const restored = await resolveEnvironment({ MONGODB_MCP_CONFIG: path });
      assert.equal(restored.MONGODB_PASSWORD, secret);
      assert.equal(loadConfiguration(restored).connection.mode, 'scram');
      await writeFile(path, secret);
      const check = spawnSync(process.execPath, ['dist/interfaces/cli/configure.js', '--check'], {
        env: isolatedEnvironment({ MONGODB_MCP_CONFIG: path }), encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(check.status, 1);
      assert.match(check.stderr, /configuração privada/u);
      assert.ok(!check.stderr.includes(secret));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
