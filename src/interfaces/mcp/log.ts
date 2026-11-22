import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';

const maxPending = 50;

/**
 * Envia mensagens não fatais pelo log do protocolo MCP (notifications/message), que o cliente exibe
 * com o nível correto. O stderr fica reservado para erros. Mensagens emitidas antes do handshake
 * aguardam a notificação initialized.
 */
export class McpLog {
  private server: Server | undefined;
  private ready = false;
  private readonly pending: { level: LoggingLevel; data: string }[] = [];

  attach(server: Server): void {
    this.server = server;
    const previous = server.oninitialized;
    server.oninitialized = () => {
      previous?.();
      this.ready = true;
      for (const entry of this.pending.splice(0)) {
        this.send(entry.level, entry.data);
      }
    };
  }

  info(message: string): void {
    this.send('info', message);
  }

  warning(message: string): void {
    this.send('warning', message);
  }

  private send(level: LoggingLevel, data: string): void {
    const server = this.server;
    if (server === undefined || !this.ready) {
      if (this.pending.length < maxPending) {
        this.pending.push({ level, data });
      }
      return;
    }
    server.sendLoggingMessage({ level, logger: 'mongodb-readonly-mcp', data }).catch(() => {
      process.stderr.write(`${data}\n`);
    });
  }
}
