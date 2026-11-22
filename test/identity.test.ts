import assert from 'node:assert/strict';
import { it } from 'node:test';
import { MongoClient } from 'mongodb';
import { PolicyError } from '../src/domain/query.js';
import { assertAuthenticatedIdentity, assertUnauthenticatedIdentity } from '../src/infrastructure/identity.js';
import {
  isMassWriteCommand,
  isReadOnlyCommand,
  MassWriteGuard,
  MassWriteViolationError,
  ReadOnlyGuard,
  ReadOnlyViolationError,
} from '../src/infrastructure/read-only-guard.js';

it('accepts an authenticated identity regardless of its privileges', () => {
  const status = (actions: readonly string[]): unknown => ({
    authInfo: {
      authenticatedUsers: [{ user: 'app', db: 'shop' }],
      authenticatedUserPrivileges: [{ resource: { db: 'shop', collection: '' }, actions }],
    },
  });
  assert.doesNotThrow(() => assertAuthenticatedIdentity(status(['find', 'insert', 'dropDatabase'])));
  assert.throws(() => assertAuthenticatedIdentity({ authInfo: { authenticatedUsers: [], authenticatedUserPrivileges: [] } }), PolicyError);
  assert.throws(() => assertAuthenticatedIdentity({}), PolicyError);
});

it('allows an anonymous identity only in the unauthenticated mode and rejects inconsistent status', () => {
  const anonymous = { authInfo: { authenticatedUsers: [], authenticatedUserPrivileges: [] } };
  assert.doesNotThrow(() => assertUnauthenticatedIdentity(anonymous));
  assert.throws(() => assertUnauthenticatedIdentity({ authInfo: {} }), PolicyError);
  assert.throws(() => assertUnauthenticatedIdentity({
    authInfo: { authenticatedUsers: [{ user: 'reader' }], authenticatedUserPrivileges: [] },
  }), PolicyError);
});

it('classifies only read commands and write-free pipelines as read-only', () => {
  for (const name of ['find', 'getMore', 'count', 'distinct', 'listCollections', 'listDatabases', 'connectionStatus', 'saslStart']) {
    assert.equal(isReadOnlyCommand(name, {}), true, name);
  }
  for (const name of ['insert', 'update', 'delete', 'findAndModify', 'drop', 'dropDatabase', 'createIndexes', 'create', 'createUser', 'eval']) {
    assert.equal(isReadOnlyCommand(name, {}), false, name);
  }
  assert.equal(isReadOnlyCommand('aggregate', { pipeline: [{ $match: {} }, { $group: { _id: 1 } }] }), true);
  assert.equal(isReadOnlyCommand('aggregate', { pipeline: [{ $match: {} }, { $out: 'copy' }] }), false);
  assert.equal(isReadOnlyCommand('aggregate', { pipeline: [{ $merge: { into: 'copy' } }] }), false);
  assert.equal(isReadOnlyCommand('aggregate', {}), false);
});

it('blocks a write before it reaches the network and stays tripped', () => {
  const client = new MongoClient('mongodb://127.0.0.1:1/', { monitorCommands: true });
  const guard = new ReadOnlyGuard(client);
  assert.doesNotThrow(() => client.emit('commandStarted', { commandName: 'find', command: { find: 'x' } } as never));
  guard.assertIntact();
  assert.throws(() => client.emit('commandStarted', { commandName: 'insert', command: { insert: 'x' } } as never), ReadOnlyViolationError);
  assert.throws(() => guard.assertIntact(), ReadOnlyViolationError);
  assert.throws(() => new ReadOnlyGuard(new MongoClient('mongodb://127.0.0.1:1/')), ReadOnlyViolationError);
});

it('detects updateMany/deleteMany with an empty filter, including bulkWrite', () => {
  assert.equal(isMassWriteCommand('update', { updates: [{ q: {}, u: { $set: { a: 1 } }, multi: true }] }), true);
  assert.equal(isMassWriteCommand('update', { updates: [{ u: { $set: { a: 1 } }, multi: true }] }), true);
  assert.equal(isMassWriteCommand('update', { updates: [{ q: { a: 1 }, u: { $set: { a: 2 } }, multi: true }] }), false);
  assert.equal(isMassWriteCommand('update', { updates: [{ q: {}, u: { $set: { a: 1 } } }] }), false);
  assert.equal(isMassWriteCommand('delete', { deletes: [{ q: {}, limit: 0 }] }), true);
  assert.equal(isMassWriteCommand('delete', { deletes: [{ q: { a: 1 }, limit: 0 }, { q: {}, limit: 0 }] }), true);
  assert.equal(isMassWriteCommand('delete', { deletes: [{ q: {}, limit: 1 }] }), false);
  assert.equal(isMassWriteCommand('delete', { deletes: [{ q: { a: 1 }, limit: 0 }] }), false);
  assert.equal(isMassWriteCommand('delete', {}), true);
  assert.equal(isMassWriteCommand('bulkWrite', { ops: [{ delete: 0, filter: {}, multi: true }] }), true);
  assert.equal(isMassWriteCommand('bulkWrite', { ops: [{ insert: 0, document: {} }, { update: 0, filter: { a: 1 }, multi: true }] }), false);
  assert.equal(isMassWriteCommand('insert', { documents: [{}] }), false);
});

it('blocks mass writes without tripping other writes when the read-only lock is off', () => {
  const client = new MongoClient('mongodb://127.0.0.1:1/', { monitorCommands: true });
  assert.ok(new MassWriteGuard(client));
  const emit = (commandName: string, command: Record<string, unknown>): boolean =>
    client.emit('commandStarted', { commandName, command } as never);
  assert.throws(() => emit('delete', { delete: 'x', deletes: [{ q: {}, limit: 0 }] }), MassWriteViolationError);
  assert.doesNotThrow(() => emit('delete', { delete: 'x', deletes: [{ q: { a: 1 }, limit: 0 }] }));
  assert.doesNotThrow(() => emit('insert', { insert: 'x', documents: [{}] }));
  assert.throws(() => new MassWriteGuard(new MongoClient('mongodb://127.0.0.1:1/')), MassWriteViolationError);
});
