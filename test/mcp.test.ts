import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ReadOnlyOperations } from '../src/application/read-only-service.js';
import { createMcpServer, toolSchemas } from '../src/interfaces/mcp/server.js';

async function callWith(operations: ReadOnlyOperations): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(operations);
  const client = new Client({ name: 'tests', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: 'listDatabases', arguments: {} });
  } finally {
    await client.close();
    await server.close();
  }
}

describe('MCP schemas and error boundary', () => {
  it('keeps special filter keys intact for the domain to reject', () => {
    const filter: unknown = JSON.parse('{"__proto__":{"$eq":"x"}}');
    const result = toolSchemas.find.safeParse({ database: 'shop', collection: 'orders', filter });
    assert.ok(result.success);
    assert.ok(Object.hasOwn(result.data.filter, '__proto__'));
    assert.equal(toolSchemas.find.safeParse({
      database: 'shop', collection: 'orders', filter: {}, extra: true,
    }).success, false);
    assert.equal(toolSchemas.countDocuments.safeParse({ database: 'shop', collection: 'orders' }).success, false);
  });

  it('sanitizes driver errors and rejects oversized output', async () => {
    const secret = randomBytes(24).toString('base64url');
    const fail = async (): Promise<never> => { throw new Error(secret); };
    const operations: ReadOnlyOperations = {
      listDatabases: fail,
      listCollections: fail,
      find: fail,
      findOne: fail,
      countDocuments: fail,
      distinct: fail,
    };
    const errorResult = await callWith(operations);
    assert.match(JSON.stringify(errorResult), /Falha ao consultar/u);
    assert.ok(!JSON.stringify(errorResult).includes(secret));
    const oversized = await callWith({
      ...operations,
      async listDatabases(): Promise<{ databases: string[] }> {
        return { databases: ['x'.repeat(300_000)] };
      },
    });
    assert.match(JSON.stringify(oversized), /limite de bytes/u);
  });
});
