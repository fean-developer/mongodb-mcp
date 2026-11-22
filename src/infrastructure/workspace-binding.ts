import { createHash } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ConfigurationError } from './configuration.js';
import { isFingerprint } from './fingerprint.js';
import {
  ensurePrivateDirectory,
  hasCode,
  InvalidPrivateFileError,
  readPrivateFile,
  removePrivateFile,
  writePrivateFile,
} from './private-file.js';

const maxBindingBytes = 4_096;
const profilePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

export interface WorkspaceBinding {
  readonly version: 1;
  readonly workspace: string;
  readonly profile: string;
  readonly fingerprint: string;
}

export function bindingsDirectory(appDirectory: string): string {
  return join(appDirectory, 'bindings');
}

export async function canonicalWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) {
    throw new ConfigurationError('O workspace deve ser um caminho absoluto.');
  }
  try {
    return await realpath(workspace);
  } catch {
    throw new ConfigurationError(`O workspace ${workspace} não existe ou não pode ser acessado.`);
  }
}

export function bindingPath(appDirectory: string, canonical: string): string {
  return join(bindingsDirectory(appDirectory), `${createHash('sha256').update(canonical, 'utf8').digest('hex')}.json`);
}

function parseBinding(text: string, path: string): WorkspaceBinding {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidPrivateFileError('json', path, `O vínculo de workspace ${path} é inválido.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidPrivateFileError('schema', path, `O vínculo de workspace ${path} é inválido.`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'fingerprint,profile,version,workspace' || record.version !== 1
    || typeof record.workspace !== 'string' || typeof record.profile !== 'string'
    || !profilePattern.test(record.profile) || !isFingerprint(record.fingerprint)) {
    throw new InvalidPrivateFileError('schema', path, `O vínculo de workspace ${path} é inválido.`);
  }
  return { version: 1, workspace: record.workspace, profile: record.profile, fingerprint: record.fingerprint };
}

/** Lê o vínculo do workspace (caminho já canônico). Retorna undefined se não houver vínculo. */
export async function readBinding(appDirectory: string, canonical: string): Promise<WorkspaceBinding | undefined> {
  const path = bindingPath(appDirectory, canonical);
  const text = await readPrivateFile(path, maxBindingBytes);
  if (text === undefined) {
    return undefined;
  }
  const binding = parseBinding(text, path);
  if (binding.workspace !== canonical) {
    throw new ConfigurationError(`O vínculo ${path} não corresponde ao workspace ${canonical}. Execute --unbind e --bind novamente.`);
  }
  return binding;
}

export async function writeBinding(appDirectory: string, binding: WorkspaceBinding): Promise<string> {
  const directory = bindingsDirectory(appDirectory);
  await ensurePrivateDirectory(directory, appDirectory);
  const path = bindingPath(appDirectory, binding.workspace);
  await writePrivateFile(path, `${JSON.stringify(binding, null, 2)}\n`);
  return path;
}

export async function removeBinding(appDirectory: string, canonical: string): Promise<boolean> {
  return removePrivateFile(bindingPath(appDirectory, canonical));
}

/** Lista os vínculos válidos; arquivos inválidos são ignorados. */
export async function listBindings(appDirectory: string): Promise<WorkspaceBinding[]> {
  let names: string[];
  try {
    names = await readdir(bindingsDirectory(appDirectory));
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return [];
    }
    throw error;
  }
  const result: WorkspaceBinding[] = [];
  for (const name of names.filter((entry) => /^[0-9a-f]{64}\.json$/u.test(entry)).sort()) {
    const path = join(bindingsDirectory(appDirectory), name);
    try {
      const text = await readPrivateFile(path, maxBindingBytes);
      if (text !== undefined) {
        result.push(parseBinding(text, path));
      }
    } catch {
      // Vínculos inválidos não impedem a listagem.
    }
  }
  return result;
}
