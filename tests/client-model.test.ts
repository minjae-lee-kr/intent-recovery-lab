import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, contextKey, isLedger } from '../src/client/model.ts';
import type { StoragePort } from '../src/client/model.ts';
import type { Outcome } from '../src/protocol.ts';

const INTENT = 'intent-original';
const OTHER = 'intent-separate';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const outcome = (intentId = INTENT, quantity = 1): Outcome => ({
  intentId,
  command: { offerId: 'workshop', quantity },
  commandHash: 'a'.repeat(64),
  status: 'confirmed',
  receiptId: 'receipt-one',
  reason: null,
  journalSequence: 1,
});
function memory() {
  const values = new Map<string, string>();
  const storage: StoragePort = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { storage, values };
}
function seed(storage: StoragePort, intentId = INTENT, attempted = true) {
  storage.setItem(
    contextKey(intentId),
    JSON.stringify({
      version: 1,
      intentId,
      command: { offerId: 'workshop', quantity: 1 },
      attempted,
    }),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(
  options: { storage?: StoragePort; intentId?: string | null; ids?: string[] } = {},
) {
  const storage = options.storage ?? memory().storage;
  const requests: {
    path: string;
    init: RequestInit;
    pending: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const timers = new Set<() => void>();
  const handles: string[] = [];
  let idCount = 0;
  const client = createClient({
    storage,
    intentId: options.intentId,
    createId: () => options.ids?.[idCount++] ?? INTENT,
    onIntent: (id) => handles.push(id),
    http: (path, init) => {
      const pending = deferred<Response>();
      requests.push({ path, init, pending });
      return pending.promise;
    },
    schedule: (callback) => {
      timers.add(callback);
      return () => {
        timers.delete(callback);
      };
    },
  });
  return {
    client,
    storage,
    requests,
    handles,
    timers,
    expire: () => {
      const current = [...timers];
      timers.clear();
      current.forEach((callback) => callback());
    },
  };
}

test('recovery identity and command exist before the first HTTP submission', async () => {
  const h = harness();
  assert.equal(h.client.createIntent(2), true);
  assert.deepEqual(h.handles, [INTENT]);
  h.client.submit('drop-after-commit');
  const saved = JSON.parse(h.storage.getItem(contextKey(INTENT))!);
  assert.equal(saved.attempted, true);
  assert.equal(saved.command.quantity, 2);
  await tick();
  assert.equal(h.requests[0]!.init.method, 'POST');
  assert.equal(new Headers(h.requests[0]!.init.headers).get('Idempotency-Key'), INTENT);
  assert.deepEqual(JSON.parse(String(h.requests[0]!.init.body)), saved.command);
  h.client.dispose();
});

test('storage failure cannot send a new request or silently replace an unknown intent', async () => {
  const m = memory();
  seed(m.storage);
  const h = harness({ storage: m.storage, intentId: INTENT, ids: [OTHER] });
  m.storage.setItem = () => {
    throw new Error('denied');
  };
  assert.equal(h.client.createIntent(1), false);
  assert.equal(h.client.getSnapshot().intentId, INTENT);
  h.client.submit();
  await tick();
  assert.equal(h.requests.length, 0);
  assert.equal(h.client.getSnapshot().issue, 'storage-unavailable');
  assert.deepEqual(h.handles, []);
});

test('lost response remains unknown; retry reuses the key and removes the injected fault', async () => {
  const h = harness();
  h.client.createIntent(1);
  h.client.submit('drop-after-commit');
  await tick();
  h.requests[0]!.pending.reject(new TypeError('connection gone'));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'unknown');
  assert.equal(h.client.getSnapshot().outcome, null);
  h.client.submit();
  await tick();
  assert.equal(new Headers(h.requests[1]!.init.headers).get('Idempotency-Key'), INTENT);
  assert.equal(new Headers(h.requests[1]!.init.headers).get('X-Lab-Fault'), 'none');
  h.requests[1]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().outcome?.receiptId, 'receipt-one');
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
  assert.equal(h.timers.size, 0);
});

test('reload and independent tabs retain the same intent rather than allocate new keys', async () => {
  const shared = memory();
  const first = harness({ storage: shared.storage });
  first.client.createIntent(1);
  first.client.submit();
  await tick();
  const reload = harness({ storage: shared.storage, intentId: INTENT });
  assert.equal(reload.client.getSnapshot().phase, 'unknown');
  reload.client.submit();
  await tick();
  assert.equal(
    new Headers(first.requests[0]!.init.headers).get('Idempotency-Key'),
    new Headers(reload.requests[0]!.init.headers).get('Idempotency-Key'),
  );
  assert.equal(reload.handles.length, 0);
  first.client.dispose();
  reload.client.dispose();
});

test('a never-submitted saved intent reloads ready without making an HTTP request', async () => {
  const m = memory();
  seed(m.storage, INTENT, false);
  const h = harness({ storage: m.storage, intentId: INTENT });
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'idle');
  assert.equal(h.requests.length, 0);
});

test('GET unseen after a timeout is an observation, not a terminal failure or a new intent', async () => {
  const h = harness();
  h.client.createIntent(1);
  h.client.submit('delay-before-commit');
  await tick();
  h.expire();
  assert.equal(h.client.getSnapshot().issue, 'timeout');
  assert.equal(h.requests[0]!.init.signal?.aborted, true);
  h.client.reconcile();
  await tick();
  h.requests[1]!.pending.resolve(response({ intentId: INTENT, status: 'unseen' }, 404));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'unknown');
  assert.equal(h.client.getSnapshot().issue, 'unseen');
  assert.equal(h.client.getSnapshot().context?.intentId, INTENT);
  h.client.reconcile();
  await tick();
  h.requests[2]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
  h.requests[0]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
  assert.equal(h.client.getSnapshot().trace.at(-1)?.event, 'stale');
});

test('older not-found body resolving after a newer commit cannot downgrade knowledge', async () => {
  const m = memory();
  seed(m.storage);
  const h = harness({ storage: m.storage, intentId: INTENT });
  const delayedBody = deferred<unknown>();
  h.client.reconcile();
  await tick();
  h.requests[0]!.pending.resolve({ status: 404, json: () => delayedBody.promise } as Response);
  await tick();
  h.client.stopWaiting();
  h.client.reconcile();
  await tick();
  h.requests[1]!.pending.resolve(response(outcome()));
  await tick();
  delayedBody.resolve({ intentId: INTENT, status: 'unseen' });
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
  assert.equal(h.client.getSnapshot().outcome?.receiptId, 'receipt-one');
  assert.equal(h.client.getSnapshot().trace.at(-1)?.event, 'stale');
});

test('stopping local waiting leaves the command recoverable and ignores a late response', async () => {
  const h = harness();
  h.client.createIntent(1);
  h.client.submit();
  await tick();
  h.client.stopWaiting();
  assert.equal(h.client.getSnapshot().phase, 'unknown');
  assert.equal(h.client.getSnapshot().issue, 'stopped');
  assert.equal(h.client.getSnapshot().context?.attempted, true);
  h.requests[0]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'unknown');
  h.client.reconcile();
  await tick();
  h.requests[1]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
});

test('a late failure cannot overwrite a separate intent or clear its pending request', async () => {
  const h = harness({ ids: [INTENT, OTHER] });
  h.client.createIntent(1);
  h.client.submit();
  await tick();
  h.client.createIntent(1);
  h.client.submit();
  await tick();
  h.requests[0]!.pending.reject(new Error('late'));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'sending');
  assert.equal(h.client.getSnapshot().intentId, OTHER);
  assert.equal(h.timers.size, 1);
  h.requests[1]!.pending.resolve(response(outcome(OTHER)));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
});

test('missing or corrupt local context allows only GET; authoritative terminal evidence restores it', async () => {
  for (const raw of [
    null,
    '{broken',
    JSON.stringify({
      version: 1,
      intentId: OTHER,
      command: { offerId: 'workshop', quantity: 1 },
      attempted: true,
    }),
  ]) {
    const m = memory();
    if (raw !== null) m.values.set(contextKey(INTENT), raw);
    const h = harness({ storage: m.storage, intentId: INTENT });
    h.client.submit();
    await tick();
    assert.equal(h.requests.length, 0);
    h.client.reconcile();
    await tick();
    assert.equal(h.requests[0]!.init.method, 'GET');
    h.requests[0]!.pending.resolve(response(outcome()));
    await tick();
    assert.equal(h.client.getSnapshot().phase, 'confirmed');
    assert.equal(h.client.getSnapshot().context?.intentId, INTENT);
    assert.equal(JSON.parse(m.values.get(contextKey(INTENT))!).attempted, true);
    assert.equal(h.handles.length, 0);
  }
});

test('missing context and unseen result never synthesize a command for retry', async () => {
  const h = harness({ intentId: INTENT });
  h.client.reconcile();
  await tick();
  h.requests[0]!.pending.resolve(response({ intentId: INTENT, status: 'unseen' }, 404));
  await tick();
  h.client.submit();
  await tick();
  assert.equal(h.client.getSnapshot().context, null);
  assert.equal(h.requests.length, 1);
  assert.equal(h.client.getSnapshot().phase, 'unknown');
});

test('callback correlation can initiate a GET but cannot create or confirm a reservation', async () => {
  const h = harness();
  h.client.createIntent(1);
  h.client.appReturn(OTHER);
  await tick();
  assert.equal(h.requests.length, 0);
  h.client.appReturn(INTENT);
  await tick();
  assert.equal(h.requests[0]!.init.method, 'GET');
  assert.equal(h.client.getSnapshot().outcome, null);
  h.requests[0]!.pending.resolve(response(outcome()));
  await tick();
  h.client.appReturn(INTENT);
  await tick();
  assert.equal(h.requests.length, 1);
});

test('malformed, mismatched and command-conflicting replies never become confirmation', async () => {
  for (const body of [
    null,
    { ...outcome(), receiptId: {} },
    outcome(OTHER),
    outcome(INTENT, 2),
    { ...outcome(), journalSequence: 0 },
  ]) {
    const h = harness();
    h.client.createIntent(1);
    h.client.submit();
    await tick();
    h.requests[0]!.pending.resolve(response(body));
    await tick();
    assert.equal(h.client.getSnapshot().phase, 'unknown');
    assert.equal(h.client.getSnapshot().issue, 'invalid-response');
    assert.equal(h.client.getSnapshot().outcome, null);
  }
});

test('invalid 404 body is not an unseen observation; conflict and transient storage failure stay unknown', async () => {
  for (const [status, body, issue] of [
    [404, { intentId: OTHER, status: 'unseen' }, 'invalid-response'],
    [409, { error: { code: 'INTENT_CONFLICT' } }, 'conflict'],
    [503, { error: { code: 'BUSY' } }, 'server-unavailable'],
  ] as const) {
    const m = memory();
    seed(m.storage);
    const h = harness({ storage: m.storage, intentId: INTENT });
    h.client.reconcile();
    await tick();
    h.requests[0]!.pending.resolve(response(body, status));
    await tick();
    assert.equal(h.client.getSnapshot().phase, 'unknown');
    assert.equal(h.client.getSnapshot().issue, issue);
  }
});

test('capacity rejection is a validated terminal outcome, not a retryable transport failure', async () => {
  const h = harness();
  h.client.createIntent(1);
  h.client.submit();
  await tick();
  h.requests[0]!.pending.resolve(
    response({ ...outcome(), status: 'rejected', receiptId: null, reason: 'capacity-unavailable' }),
  );
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'rejected');
  h.client.submit();
  h.client.reconcile();
  await tick();
  assert.equal(h.requests.length, 1);
});

test('storage failure after authoritative recovery preserves confirmed knowledge', async () => {
  const m = memory();
  const h = harness({ storage: m.storage, intentId: INTENT });
  m.storage.setItem = () => {
    throw new Error('full');
  };
  h.client.reconcile();
  await tick();
  h.requests[0]!.pending.resolve(response(outcome()));
  await tick();
  assert.equal(h.client.getSnapshot().phase, 'confirmed');
  assert.equal(h.client.getSnapshot().issue, 'restore-unpersisted');
});

test('snapshots and persisted commands cannot be changed through shared object aliases', () => {
  const h = harness();
  h.client.createIntent(1);
  const original = h.client.getSnapshot();
  assert.throws(() => {
    (original.context!.command as { quantity: number }).quantity = 3;
  }, TypeError);
  assert.throws(() => {
    (original.trace as unknown[]).push({});
  }, TypeError);
  assert.equal(h.client.getSnapshot().context?.command.quantity, 1);
});

test('invalid URL never generates an ID or calls an endpoint', async () => {
  const h = harness({ intentId: '../../private' });
  h.client.submit();
  h.client.reconcile();
  await tick();
  assert.equal(h.client.getSnapshot().issue, 'invalid-link');
  assert.equal(h.requests.length, 0);
  assert.equal(h.handles.length, 0);
});

test('diagnostic ledger rejects impossible counts and malformed outcome/effect boundaries', () => {
  const valid = {
    initialCapacity: 12,
    remainingCapacity: 11,
    intents: [outcome()],
    effects: [{ receiptId: 'receipt-one', intentId: INTENT, offerId: 'workshop', quantity: 1 }],
  };
  assert.equal(isLedger(valid), true);
  for (const invalid of [
    null,
    { ...valid, remainingCapacity: -1 },
    { ...valid, remainingCapacity: 13 },
    { ...valid, effects: [{ quantity: 1 }] },
    { ...valid, intents: [{}] },
  ])
    assert.equal(isLedger(invalid), false);
});
