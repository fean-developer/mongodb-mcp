import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Environment } from '../../src/infrastructure/configuration.js';

export interface RpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface Pending {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
}

export function isolatedEnvironment(env: Environment): Record<string, string | undefined> {
  const inherited = { ...process.env };
  for (const name of Object.keys(inherited)) {
    if (name.startsWith('MONGODB_')) {
      delete inherited[name];
    }
  }
  return {
    ...inherited,
    NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    // Diretório inexistente: isola do arquivo privado real sem tornar MONGODB_MCP_CONFIG explícito.
    XDG_CONFIG_HOME: join(tmpdir(), `mongodb-mcp-missing-${randomUUID()}`),
    APPDATA: join(tmpdir(), `mongodb-mcp-missing-${randomUUID()}`),
    ...env,
  };
}

export class StdioSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  stderr = '';
  readonly logs: string[] = [];
  invalidStdoutLines = 0;
  stdoutLines = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(env: Environment) {
    const workspace = fileURLToPath(new URL('../../', import.meta.url));
    this.child = spawn(process.execPath, ['dist/main.js'], {
      cwd: workspace,
      env: isolatedEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => {
      this.child.once('close', (code) => {
        for (const waiting of this.pending.values()) {
          waiting.reject(new Error('O servidor encerrou antes da resposta.'));
        }
        this.pending.clear();
        resolve(code);
      });
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr += chunk; });
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => {
      this.stdoutLines += 1;
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== 'object' || value === null || !('jsonrpc' in value) || value.jsonrpc !== '2.0') {
          throw new Error('Mensagem não é JSON-RPC.');
        }
        if ('method' in value && value.method === 'notifications/message' && 'params' in value) {
          const params = value.params as { level?: unknown; data?: unknown };
          this.logs.push(`${String(params.level)}: ${String(params.data)}`);
        }
        if ('id' in value && typeof value.id === 'number') {
          const waiting = this.pending.get(value.id);
          if (waiting !== undefined) {
            this.pending.delete(value.id);
            waiting.resolve(value as RpcResponse);
          }
        }
      } catch {
        this.invalidStdoutLines += 1;
        for (const waiting of this.pending.values()) {
          waiting.reject(new Error('Stdout contém uma mensagem que não é JSON-RPC.'));
        }
        this.pending.clear();
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Tempo esgotado aguardando resposta MCP.'));
      }, 12_000);
      this.pending.set(id, {
        resolve(response): void {
          clearTimeout(timer);
          resolve(response);
        },
        reject(error): void {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async initialize(): Promise<unknown> {
    const response = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'integration-tests', version: '1.0.0' },
    });
    if (response.error !== undefined) {
      throw new Error('Falha ao inicializar o cliente MCP.');
    }
    this.notify('notifications/initialized');
    return response.result;
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5_000);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Resultado MCP inválido.');
  }
  return value as Record<string, unknown>;
}
