import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, contextKey, isLedger } from '../src/client/model.ts';
import type { Client, Phase, StoragePort } from '../src/client/model.ts';
import { startServer } from '../src/server/server.ts';

function memory(): StoragePort {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function waitFor(client: Client, phase: Phase) {
  if (client.getSnapshot().phase === phase) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Did not reach ${phase}`));
    }, 5_000);
    const unsubscribe = client.subscribe(() => {
      if (client.getSnapshot().phase === phase) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}
function connect(url: string, storage: StoragePort, intentId?: string) {
  return createClient({
    storage,
    intentId,
    createId: () => 'http-client-intent',
    onIntent: () => {},
    http: (path, init) => fetch(`${url}${path}`, init),
  });
}
async function ledger(url: string) {
  const value: unknown = await (await fetch(`${url}/api/ledger`)).json();
  assert.ok(isLedger(value));
  return value;
}

test('real HTTP response loss after SQLite commit: client unknown, ledger committed, reload reconciles one effect', async (t) => {
  // This test uses the actual HTTP handler and SQLite transaction in memory.
  // Process-restart durability is exercised separately by the crash harness.
  const server = await startServer({ databasePath: ':memory:' });
  t.after(() => server.close());
  const storage = memory();
  const first = connect(server.url, storage);
  t.after(() => first.dispose());
  first.createIntent(2);
  first.submit('drop-after-commit');
  await waitFor(first, 'unknown');
  assert.equal(first.getSnapshot().outcome, null);
  const saved = await ledger(server.url);
  assert.equal(saved.effects.length, 1);
  assert.equal(saved.remainingCapacity, 10);
  assert.equal(saved.intents[0]!.status, 'confirmed');
  assert.equal(
    first.getSnapshot().phase,
    'unknown',
    'diagnostic lookup must not confirm the product state',
  );
  const reloaded = connect(server.url, storage, 'http-client-intent');
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.getSnapshot().phase, 'unknown');
  reloaded.reconcile();
  await waitFor(reloaded, 'confirmed');
  assert.equal(reloaded.getSnapshot().outcome?.receiptId, saved.effects[0]!.receiptId);
  first.submit();
  await waitFor(first, 'confirmed');
  assert.equal(first.getSnapshot().outcome?.receiptId, reloaded.getSnapshot().outcome?.receiptId);
  assert.equal((await ledger(server.url)).effects.length, 1);
});

test('real HTTP drop before commit leaves unknown; unseen observation and same-intent retry recover', async (t) => {
  const server = await startServer({ databasePath: ':memory:' });
  t.after(() => server.close());
  const client = connect(server.url, memory());
  t.after(() => client.dispose());
  client.createIntent(1);
  client.submit('drop-before-commit');
  await waitFor(client, 'unknown');
  assert.equal((await ledger(server.url)).effects.length, 0);
  client.reconcile();
  await waitFor(client, 'unknown');
  assert.equal(client.getSnapshot().issue, 'unseen');
  assert.equal(client.getSnapshot().context?.intentId, 'http-client-intent');
  client.submit();
  await waitFor(client, 'confirmed');
  assert.equal((await ledger(server.url)).effects.length, 1);
});

test('two independent client controllers submit one retained intent and converge on the same real effect', async (t) => {
  const server = await startServer({ databasePath: ':memory:' });
  t.after(() => server.close());
  const storage = memory();
  const first = connect(server.url, storage);
  first.createIntent(1);
  const second = connect(server.url, storage, 'http-client-intent');
  t.after(() => {
    first.dispose();
    second.dispose();
  });
  first.submit();
  second.submit();
  await Promise.all([waitFor(first, 'confirmed'), waitFor(second, 'confirmed')]);
  assert.equal(first.getSnapshot().outcome?.receiptId, second.getSnapshot().outcome?.receiptId);
  assert.equal((await ledger(server.url)).effects.length, 1);
  assert.equal(JSON.parse(storage.getItem(contextKey('http-client-intent'))!).attempted, true);
});
