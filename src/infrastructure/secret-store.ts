import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConfigurationError } from './configuration.js';

export type SecretStoreName = 'libsecret' | 'keychain' | 'dpapi';

export type SecretReference =
  | { readonly store: 'libsecret' | 'keychain'; readonly id: string }
  | { readonly store: 'dpapi'; readonly ciphertext: string };

export interface SecretStore {
  readonly name: SecretStoreName;
  available(): Promise<boolean>;
  set(label: string, value: string): Promise<SecretReference>;
  get(reference: SecretReference): Promise<string>;
  delete(reference: SecretReference): Promise<void>;
}

const service = 'mongodb-readonly-mcp';
const timeoutMs = 10_000;

interface ToolResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Os valores secretos trafegam apenas pelo stdin; o argv contém somente identificadores.
function runTool(
  executable: string,
  args: readonly string[],
  input: string,
  timeout = timeoutMs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ToolResult): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout: '', stderr: 'timeout' });
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', () => finish({ code: null, stdout: '', stderr: 'error' }));
    child.once('close', (code) => finish({ code, stdout, stderr }));
    child.stdin.once('error', () => undefined);
    child.stdin.end(input);
  });
}

function unavailable(store: SecretStoreName, name: string): ConfigurationError {
  return new ConfigurationError(
    `Não foi possível ler o segredo ${name} do cofre ${store}. Desbloqueie o chaveiro ou reconfigure com --secret-store=file.`,
  );
}

function writeFailure(store: SecretStoreName): ConfigurationError {
  return new ConfigurationError(`Não foi possível gravar o segredo no cofre ${store}. Desbloqueie o chaveiro ou use --secret-store=file.`);
}

export class LibsecretStore implements SecretStore {
  readonly name = 'libsecret';

  constructor(private readonly executable = 'secret-tool', private readonly env: NodeJS.ProcessEnv = process.env) {}

  async available(): Promise<boolean> {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return false;
    }
    if (this.env.DBUS_SESSION_BUS_ADDRESS === undefined && this.env.XDG_RUNTIME_DIR === undefined) {
      return false;
    }
    const result = await runTool(this.executable, ['lookup', 'service', service, 'id', 'availability-probe'], '', 3_000, this.env);
    return (result.code === 0 || result.code === 1) && result.stderr.trim() === '';
  }

  async set(label: string, value: string): Promise<SecretReference> {
    const id = randomUUID();
    const result = await runTool(this.executable, ['store', `--label=${service} ${label}`, 'service', service, 'id', id], value, timeoutMs, this.env);
    if (result.code !== 0) {
      throw writeFailure(this.name);
    }
    return { store: 'libsecret', id };
  }

  async get(reference: SecretReference): Promise<string> {
    if (reference.store !== 'libsecret') {
      throw new ConfigurationError('Referência de segredo incompatível com o cofre libsecret.');
    }
    const result = await runTool(this.executable, ['lookup', 'service', service, 'id', reference.id], '', timeoutMs, this.env);
    if (result.code !== 0 || result.stdout === '') {
      throw new ConfigurationError('lookup');
    }
    return result.stdout;
  }

  async delete(reference: SecretReference): Promise<void> {
    if (reference.store === 'libsecret') {
      await runTool(this.executable, ['clear', 'service', service, 'id', reference.id], '', timeoutMs, this.env);
    }
  }
}

// O Keychain recebe o valor em base64 pelo modo interativo (`security -i`), evitando argv e problemas de aspas.
export class KeychainStore implements SecretStore {
  readonly name = 'keychain';

  constructor(private readonly executable = 'security') {}

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return false;
    }
    const result = await runTool(this.executable, ['default-keychain'], '', 3_000);
    return result.code === 0;
  }

  async set(_label: string, value: string): Promise<SecretReference> {
    const id = randomUUID();
    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const result = await runTool(this.executable, ['-i'], `add-generic-password -U -s ${service} -a ${id} -w ${encoded}\n`);
    if (result.code !== 0 || result.stderr.trim() !== '') {
      throw writeFailure(this.name);
    }
    return { store: 'keychain', id };
  }

  async get(reference: SecretReference): Promise<string> {
    if (reference.store !== 'keychain') {
      throw new ConfigurationError('Referência de segredo incompatível com o cofre keychain.');
    }
    const result = await runTool(this.executable, ['find-generic-password', '-s', service, '-a', reference.id, '-w'], '');
    if (result.code !== 0) {
      throw new ConfigurationError('lookup');
    }
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async delete(reference: SecretReference): Promise<void> {
    if (reference.store === 'keychain') {
      await runTool(this.executable, ['delete-generic-password', '-s', service, '-a', reference.id], '');
    }
  }
}

const powershellArgs = ['-NoProfile', '-NonInteractive', '-Command'];
const protectScript = '$ErrorActionPreference="Stop";'
  + '$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()));'
  + '[Console]::Out.Write((ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString))';
const unprotectScript = '$ErrorActionPreference="Stop";'
  + '$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim());'
  + '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);'
  + 'try{$t=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)};'
  + '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)))';

// DPAPI de escopo do usuário: o texto cifrado fica no próprio arquivo e só o mesmo usuário/máquina decifra.
export class DpapiStore implements SecretStore {
  readonly name = 'dpapi';

  constructor(private readonly executable = 'powershell.exe', private readonly force = false) {}

  async available(): Promise<boolean> {
    if (process.platform !== 'win32' && !this.force) {
      return false;
    }
    const result = await runTool(this.executable, [...powershellArgs, 'exit 0'], '', 10_000);
    return result.code === 0;
  }

  async set(_label: string, value: string): Promise<SecretReference> {
    const result = await runTool(this.executable, [...powershellArgs, protectScript], Buffer.from(value, 'utf8').toString('base64'));
    const ciphertext = result.stdout.trim();
    if (result.code !== 0 || !/^[0-9a-fA-F]+$/u.test(ciphertext)) {
      throw writeFailure(this.name);
    }
    return { store: 'dpapi', ciphertext };
  }

  async get(reference: SecretReference): Promise<string> {
    if (reference.store !== 'dpapi') {
      throw new ConfigurationError('Referência de segredo incompatível com o cofre dpapi.');
    }
    const result = await runTool(this.executable, [...powershellArgs, unprotectScript], reference.ciphertext);
    if (result.code !== 0) {
      throw new ConfigurationError('lookup');
    }
    return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  }

  async delete(): Promise<void> {
    // O texto cifrado vive no próprio arquivo; não há item externo para remover.
  }
}

export function platformSecretStore(): SecretStore {
  if (process.platform === 'win32') {
    return new DpapiStore();
  }
  if (process.platform === 'darwin') {
    return new KeychainStore();
  }
  return new LibsecretStore();
}

export function secretStoreFor(name: SecretStoreName): SecretStore {
  switch (name) {
    case 'libsecret':
      return new LibsecretStore();
    case 'keychain':
      return new KeychainStore();
    case 'dpapi':
      return new DpapiStore();
  }
}

export async function readSecret(reference: SecretReference, variable: string, stores: (name: SecretStoreName) => SecretStore = secretStoreFor): Promise<string> {
  try {
    return await stores(reference.store).get(reference);
  } catch {
    throw unavailable(reference.store, variable);
  }
}

export function isSecretReference(value: unknown): value is SecretReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (record.store === 'dpapi') {
    return keys === 'ciphertext,store' && typeof record.ciphertext === 'string' && /^[0-9a-fA-F]{1,65536}$/u.test(record.ciphertext);
  }
  return (record.store === 'libsecret' || record.store === 'keychain') && keys === 'id,store'
    && typeof record.id === 'string' && /^[0-9a-f-]{36}$/u.test(record.id);
}
