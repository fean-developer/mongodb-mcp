import { createHmac, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError } from './configuration.js';
import { describeIoError, ensurePrivateDirectory, hasCode, readPrivateFile } from './private-file.js';

const prefix = 'mongodb-readonly-mcp/fingerprint/v1\n';
const algorithm = 'hmac-sha256:';

export function fingerprintKeyPath(appDirectory: string): string {
  return join(appDirectory, 'fingerprint.key');
}

function parseKey(text: string, path: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/u.test(hex)) {
    throw new ConfigurationError(`A chave de fingerprint ${path} é inválida. Remova-a e execute o configurador com --bind novamente.`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Lê a chave HMAC local. Com `create`, cria uma chave aleatória de 32 bytes (0600) se não existir.
 * Sem `create`, retorna undefined quando a chave não existe.
 */
export async function loadFingerprintKey(appDirectory: string, create: boolean): Promise<Buffer | undefined> {
  const path = fingerprintKeyPath(appDirectory);
  const existing = await readPrivateFile(path, 1_024);
  if (existing !== undefined) {
    return parseKey(existing, path);
  }
  if (!create) {
    return undefined;
  }
  await ensurePrivateDirectory(appDirectory, appDirectory);
  const key = randomBytes(32);
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${key.toString('hex')}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) {
      const created = await readPrivateFile(path, 1_024);
      if (created !== undefined) {
        return parseKey(created, path);
      }
    }
    throw describeIoError(error, path, 'gravar');
  }
}

function canonical(values: Readonly<Record<string, string | undefined>>, names: Iterable<string>): string {
  const entries: [string, string][] = [];
  for (const name of names) {
    const value = values[name];
    if (value !== undefined && value.trim().length > 0) {
      entries.push([name, value]);
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

export function computeFingerprint(
  key: Buffer,
  values: Readonly<Record<string, string | undefined>>,
  names: Iterable<string>,
): string {
  return algorithm + createHmac('sha256', key).update(prefix + canonical(values, names), 'utf8').digest('hex');
}

export function shortFingerprint(fingerprint: string): string {
  return fingerprint.startsWith(algorithm)
    ? algorithm + fingerprint.slice(algorithm.length, algorithm.length + 12)
    : fingerprint.slice(0, 12);
}

export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^hmac-sha256:[0-9a-f]{64}$/u.test(value);
}
