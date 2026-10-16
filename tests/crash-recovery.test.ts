import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launchFixture } from './helpers/fixture-process.ts';
import { checkLedger, checkRetention } from '../scripts/check-ledger.ts';
import type { LedgerView, Outcome } from '../src/protocol.ts';

const command = { offerId: 'workshop', quantity: 1 };
async function ledger(url: string): Promise<LedgerView> {
  const response = await fetch(`${url}/api/ledger`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const value = (await response.json()) as LedgerView;
  assert.deepEqual(checkLedger(value), { ok: true, violations: [] });
  return value;
}
async function reserve(url: string, intentId: string): Promise<Outcome> {
  const response = await fetch(`${url}/api/reservations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': intentId },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(6000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Outcome;
}

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(
    `parent kills a real child ${phase}; reopening the same database recovers one intent`,
    { timeout: 20000 },
    async () => {
      const parent = resolve(tmpdir());
      const directory = await mkdtemp(join(parent, 'intent-crash-'));
      assert.equal(dirname(directory), parent);
      const database = join(directory, 'lab.sqlite');
      const marker = join(directory, 'checkpoint.json');
      const intentId = `crash-${phase}`;
      const child = await launchFixture(database, { phase, marker });
      let restarted: Awaited<ReturnType<typeof launchFixture>> | undefined;
      try {
        // Attach rejection handler immediately: the connection is supposed to disappear.
        const interrupted = fetch(`${child.url}/api/reservations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': intentId },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(6000),
        }).then(
          (response) => ({ kind: 'http', status: response.status }),
          (error: unknown) => ({
            kind: 'transport-error',
            name: error instanceof Error ? error.name : 'unknown',
          }),
        );
        const checkpoint = (await child.waitForCheckpoint()) as { phase: string; outcome: Outcome };
        assert.equal(checkpoint.phase, phase);
        await child.kill();
        assert.deepEqual(
          await interrupted,
          { kind: 'transport-error', name: 'TypeError' },
          'A fetch socket failure is distinct from HTTP rejection or our assertion failures.',
        );
        restarted = await launchFixture(database);
        const recovered = await ledger(restarted.url);
        assert.equal(recovered.effects.length, phase === 'before-commit' ? 0 : 1);
        assert.equal(recovered.remainingCapacity, phase === 'before-commit' ? 12 : 11);
        const retry = await reserve(restarted.url, intentId);
        assert.equal(retry.status, 'confirmed');
        if (phase === 'after-commit')
          assert.deepEqual(
            retry,
            checkpoint.outcome,
            'lost acknowledgement must recover the exact durable outcome',
          );
        const final = await ledger(restarted.url);
        assert.equal(final.effects.length, 1);
        assert.equal(final.remainingCapacity, 11);
        assert.equal(checkRetention(recovered, final).ok, true);
      } finally {
        await child.kill();
        await restarted?.kill();
        assert.equal(dirname(directory), parent);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test(
  'two independent server processes sharing SQLite converge on the same intent',
  { timeout: 20000 },
  async () => {
    const parent = resolve(tmpdir());
    const directory = await mkdtemp(join(parent, 'intent-concurrency-'));
    assert.equal(dirname(directory), parent);
    const first = await launchFixture(join(directory, 'lab.sqlite'));
    let second: Awaited<ReturnType<typeof launchFixture>> | undefined;
    try {
      second = await launchFixture(join(directory, 'lab.sqlite'));
      const outcomes = await Promise.all([
        reserve(first.url, 'shared-intent-0001'),
        reserve(second.url, 'shared-intent-0001'),
        reserve(first.url, 'shared-intent-0001'),
        reserve(second.url, 'shared-intent-0001'),
      ]);
      for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
      const actual = await ledger(first.url);
      assert.equal(actual.effects.length, 1);
      assert.equal(actual.remainingCapacity, 11);
      assert.deepEqual(await ledger(second.url), actual);
    } finally {
      await first.kill();
      await second?.kill();
      assert.equal(dirname(directory), parent);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
