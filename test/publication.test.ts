import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { z } from 'zod';
import { serverVersion } from '../src/interfaces/mcp/branding.js';

const npmMetadata = z.object({
  name: z.string(),
  version: z.string(),
  mcpName: z.string(),
  bin: z.record(z.string(), z.string()),
});
const registryMetadata = z.object({
  name: z.string(),
  version: z.string(),
  packages: z.array(z.object({
    registryType: z.string(),
    identifier: z.string(),
    version: z.string(),
    transport: z.object({ type: z.string() }),
    environmentVariables: z.array(z.object({
      name: z.string(),
      isRequired: z.boolean().optional(),
      isSecret: z.boolean().optional(),
    })),
  })),
});
const lockMetadata = z.object({
  name: z.string(),
  version: z.string(),
  packages: z.object({ '': z.object({ name: z.string(), version: z.string() }) }),
});

it('keeps npm, MCP Registry and server metadata consistent', () => {
  const npm = npmMetadata.parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  const registry = registryMetadata.parse(JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')));
  const lock = lockMetadata.parse(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')));
  const npmPackage = registry.packages.find((entry) => entry.registryType === 'npm');
  const executableName = npm.name.split('/').at(-1);
  const uri = npmPackage?.environmentVariables.find((entry) => entry.name === 'MONGODB_URI');

  assert.ok(npmPackage);
  assert.ok(executableName);
  assert.ok(uri);
  assert.equal(registry.name, npm.mcpName);
  assert.equal(registry.version, npm.version);
  assert.equal(npmPackage.identifier, npm.name);
  assert.equal(npmPackage.version, npm.version);
  assert.equal(npmPackage.transport.type, 'stdio');
  assert.equal(lock.name, npm.name);
  assert.equal(lock.version, npm.version);
  assert.equal(lock.packages[''].name, npm.name);
  assert.equal(lock.packages[''].version, npm.version);
  assert.equal(serverVersion, npm.version);
  assert.equal(npm.bin[executableName], 'dist/main.js');
  assert.equal(uri.isSecret, true);
  assert.notEqual(uri.isRequired, true);
});
