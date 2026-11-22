import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { ConfigurationError } from './configuration.js';

export type InvalidFileReason = 'json' | 'schema' | 'permissions' | 'symlink' | 'owner' | 'not-file' | 'too-large';

const reasonText: Readonly<Record<InvalidFileReason, string>> = {
  json: 'JSON inválido',
  schema: 'variáveis não suportadas ou valores inválidos',
  permissions: 'permissões diferentes de 0600',
  symlink: 'o caminho é um link simbólico',
  owner: 'o arquivo pertence a outro usuário',
  'not-file': 'não é um arquivo regular',
  'too-large': 'maior que o limite permitido',
};

// Arquivo existente rejeitado. `replaceable` indica se a substituição pode sobrescrevê-lo com segurança.
export class InvalidPrivateFileError extends ConfigurationError {
  readonly reason: InvalidFileReason;
  readonly path: string;

  constructor(reason: InvalidFileReason, path: string, message: string) {
    super(message);
    this.name = 'InvalidPrivateFileError';
    this.reason = reason;
    this.path = path;
  }

  get replaceable(): boolean {
    return this.reason === 'json' || this.reason === 'schema' || this.reason === 'permissions';
  }

  get description(): string {
    return reasonText[this.reason];
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function hasCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

export function describeIoError(error: unknown, path: string, action: 'ler' | 'gravar' | 'remover'): ConfigurationError {
  if (error instanceof ConfigurationError) {
    return error;
  }
  const directory = dirname(path);
  switch (errorCode(error)) {
    case 'EACCES':
    case 'EPERM':
      return new ConfigurationError(action === 'ler'
        ? `Sem permissão para ler ${path}.`
        : `Sem permissão para ${action} em ${directory}.`);
    case 'ENOSPC':
    case 'EDQUOT':
      return new ConfigurationError(`Sem espaço em disco ou cota excedida em ${directory}.`);
    case 'EROFS':
      return new ConfigurationError(`${directory} está em um sistema de arquivos somente leitura.`);
    case 'ENOTDIR':
      return new ConfigurationError(`Um componente de ${path} não é um diretório.`);
    case 'EISDIR':
      return new ConfigurationError(`${path} é um diretório, não um arquivo.`);
    case 'ELOOP':
      return new ConfigurationError(`${path} é um link simbólico; links não são aceitos.`);
    default:
      return new ConfigurationError(action === 'ler'
        ? 'Não foi possível ler a configuração privada; verifique o caminho e as permissões.'
        : 'Não foi possível salvar a configuração privada; verifique o caminho e as permissões.');
  }
}

function currentUid(): number | undefined {
  return process.platform === 'win32' || process.getuid === undefined ? undefined : process.getuid();
}

export function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Lê um arquivo privado sem seguir links e sem bloquear em FIFOs.
 * Retorna undefined se o arquivo não existir.
 */
export async function readPrivateFile(path: string, maxBytes: number): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new InvalidPrivateFileError('symlink', path, `${path} é um link simbólico; links não são aceitos.`);
      }
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        return undefined;
      }
      throw describeIoError(error, path, 'ler');
    }
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return undefined;
    }
    if (hasCode(error, 'ELOOP')) {
      throw new InvalidPrivateFileError('symlink', path, `${path} é um link simbólico; links não são aceitos.`);
    }
    throw describeIoError(error, path, 'ler');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) {
      throw new InvalidPrivateFileError('not-file', path, 'A configuração privada deve ser um arquivo JSON de até 1 MiB.');
    }
    if (stat.size > maxBytes) {
      throw new InvalidPrivateFileError('too-large', path, 'A configuração privada deve ser um arquivo JSON de até 1 MiB.');
    }
    const uid = currentUid();
    if (uid !== undefined && stat.uid !== uid) {
      throw new InvalidPrivateFileError('owner', path, 'A configuração privada deve pertencer ao usuário atual e usar permissões 0600.');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new InvalidPrivateFileError(
        'permissions',
        path,
        `A configuração privada deve pertencer ao usuário atual e usar permissões 0600. Corrija com: chmod 600 ${path}`,
      );
    }
    return await file.readFile('utf8');
  } catch (error) {
    throw describeIoError(error, path, 'ler');
  } finally {
    await file.close();
  }
}

/**
 * Cria o diretório com 0700 e confere dono, tipo e permissões.
 * Diretórios do aplicativo (`appDirectory` e subdiretórios) são corrigidos para 0700;
 * qualquer outro diretório inseguro é recusado.
 */
export async function ensurePrivateDirectory(directory: string, appDirectory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw describeIoError(error, join(directory, '.'), 'gravar');
  }
  const uid = currentUid();
  if (uid === undefined) {
    return;
  }
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    throw describeIoError(error, join(directory, '.'), 'gravar');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ConfigurationError(`${directory} deve ser um diretório real, não um link simbólico.`);
  }
  if (stat.uid !== uid) {
    throw new ConfigurationError(`${directory} pertence a outro usuário; escolha um diretório próprio.`);
  }
  if (isInside(directory, appDirectory)) {
    if ((stat.mode & 0o077) !== 0) {
      try {
        await chmod(directory, 0o700);
      } catch (error) {
        throw describeIoError(error, join(directory, '.'), 'gravar');
      }
    }
    return;
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new ConfigurationError(
      `${directory} permite escrita por outros usuários; use um diretório com permissões 0700 (chmod 700 ${directory}).`,
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Alguns sistemas de arquivos não suportam fsync de diretório.
    if (!['EINVAL', 'EISDIR', 'EPERM', 'EBADF', 'ENOTSUP'].some((code) => hasCode(error, code))) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function restrictWindowsAcl(path: string): Promise<void> {
  const user = process.env.USERNAME;
  if (process.platform !== 'win32' || user === undefined || user === '') {
    return;
  }
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(null));
    child.once('exit', resolve);
  });
  if (code !== 0) {
    throw new ConfigurationError(`Não foi possível restringir a ACL de ${path} ao usuário atual.`);
  }
}

/** Gravação atômica e durável: temporário 0600, fsync, rename e fsync do diretório. */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  for (let attempt = 0; ; attempt += 1) {
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      await syncDirectory(directory);
      await restrictWindowsAcl(path);
      return;
    } catch (error) {
      if (hasCode(error, 'EEXIST') && attempt === 0) {
        continue;
      }
      throw describeIoError(error, path, 'gravar');
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Remove somente um arquivo regular do usuário atual. Retorna false se não existir. */
export async function removePrivateFile(path: string): Promise<boolean> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }
    throw describeIoError(error, path, 'remover');
  }
  const uid = currentUid();
  if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
    throw new ConfigurationError(
      `${path} não é um arquivo regular do usuário atual (link simbólico, diretório ou outro dono). `
      + 'Confira o caminho e remova-o manualmente, se for o caso.',
    );
  }
  try {
    await rm(path);
  } catch (error) {
    throw describeIoError(error, path, 'remover');
  }
  await syncDirectory(dirname(path)).catch(() => undefined);
  return true;
}
