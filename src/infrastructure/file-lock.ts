import { hostname } from 'node:os';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigurationError } from './configuration.js';
import { describeIoError, hasCode } from './private-file.js';

export interface FileLockOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly staleMs?: number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, 'ESRCH');
  }
}

// Remove o lock somente se for antigo, do mesmo host e de um processo inexistente.
async function removeIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= staleMs) {
      return false;
    }
    const content: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (typeof content !== 'object' || content === null || !('pid' in content) || !('hostname' in content)) {
      return false;
    }
    const { pid, hostname: owner } = content;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || owner !== hostname() || processExists(pid)) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function withFileLock<T>(path: string, action: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const { timeoutMs = 5_000, intervalMs = 100, staleMs = 30_000 } = options;
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw describeIoError(error, lockPath, 'gravar');
      }
    }
    if (await removeIfStale(lockPath, staleMs)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ConfigurationError(`Outra execução do configurador está gravando ${path}. Tente novamente.`);
    }
    await delay(intervalMs);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }));
  } finally {
    await handle.close();
  }
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}
