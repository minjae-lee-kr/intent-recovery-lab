import assert from 'node:assert/strict';
import test from 'node:test';
import { createCopyFeedback, visibleQuantity } from '../src/client/feedback.ts';
import { createClient, contextKey } from '../src/client/model.ts';
import type { StoragePort } from '../src/client/model.ts';

function storage(): StoragePort {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

test('copy feedback expires across A to B to A even when rendering could batch the transitions', () => {
  const client = createClient({
    storage: storage(),
    http: async () => {
      throw new Error('No HTTP expected');
    },
    createId: () => 'copy-intent-a',
    onIntent: () => {},
  });
  client.createIntent(3);
  const feedback = createCopyFeedback(client.getSnapshot().intentId);
  const unsubscribe = client.subscribe(() => feedback.observeIntent(client.getSnapshot().intentId));
  const first = feedback.begin(client.getSnapshot().intentId);
  assert.equal(feedback.isCurrent(first, 'copy-intent-a'), true);
  client.appReturn('unrelated-intent');
  assert.equal(
    feedback.isCurrent(first, 'copy-intent-a'),
    true,
    'unrelated trace changes preserve the copy lifetime',
  );
  client.load('copy-intent-b');
  client.load('copy-intent-a');
  assert.equal(feedback.isCurrent(first, client.getSnapshot().intentId), false);
  const current = feedback.begin(client.getSnapshot().intentId);
  const latest = feedback.begin(client.getSnapshot().intentId);
  assert.equal(
    feedback.isCurrent(current, client.getSnapshot().intentId),
    false,
    'an older failure must not replace a newer copy result',
  );
  assert.equal(feedback.isCurrent(latest, client.getSnapshot().intentId), true);
  feedback.invalidate();
  assert.equal(
    feedback.isCurrent(latest, client.getSnapshot().intentId),
    false,
    'unmounted feedback cannot complete',
  );
  unsubscribe();
  client.dispose();
});

test('recovery quantity stays unknown until a server outcome restores it, independently of a new reservation draft', async () => {
  for (const raw of [null, '{broken']) {
    const local = storage();
    if (raw !== null) local.setItem(contextKey('shared-reservation'), raw);
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const methods: Array<string | undefined> = [];
    const client = createClient({
      storage: local,
      intentId: 'shared-reservation',
      http: async (_path, init) => {
        methods.push(init.method);
        return pending;
      },
      createId: () => 'separate-reservation',
      onIntent: () => {},
    });
    assert.equal(visibleQuantity(client.getSnapshot(), 1), null);
    assert.equal(
      visibleQuantity(client.getSnapshot(), 2),
      null,
      'a separate draft is not recovery evidence',
    );
    client.submit();
    client.reconcile();
    await new Promise<void>((done) => setImmediate(done));
    assert.deepEqual(methods, ['GET']);
    assert.equal(visibleQuantity(client.getSnapshot(), 2), null);
    resolve(
      new Response(
        JSON.stringify({
          intentId: 'shared-reservation',
          command: { offerId: 'workshop', quantity: 3 },
          commandHash: 'a'.repeat(64),
          status: 'confirmed',
          receiptId: 'receipt-three',
          reason: null,
          journalSequence: 1,
        }),
      ),
    );
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(visibleQuantity(client.getSnapshot(), 2), 3);
    client.load(null);
    assert.equal(
      visibleQuantity(client.getSnapshot(), 2),
      2,
      'a new reservation still uses the editable draft',
    );
    client.dispose();
  }
});
