import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHistory } from '../scripts/history/checker.ts';
import { replayWitness } from '../scripts/history/replay.ts';
import { checkLedger } from '../scripts/check-ledger.ts';
import {
  fixture,
  result,
  ledger,
  conflict,
  lateHistory,
  permutationOracle,
} from './helpers/history-fixtures.ts';
import type { History } from '../scripts/history/types.ts';

function compare(history: History, expected: boolean) {
  assert.equal(permutationOracle(history), expected, 'independent permutation oracle');
  const verdict = checkHistory(history);
  assert.equal(verdict.status, expected ? 'witness' : 'counterexample', verdict.reason);
  if (verdict.witness) assert.equal(replayWitness(history, verdict.witness).ok, true);
  return verdict;
}
test('unknown write can take effect after timeout and an unseen read', () => {
  const history = lateHistory();
  const verdict = compare(history, true);
  assert.deepEqual(
    verdict.witness?.map((s) => s.attemptId),
    ['early', 'write', 'late', 'final'],
  );
});
test('a valid final ledger does not excuse an acknowledged-write stale read', () => {
  const f = fixture();
  const value = result('purchase-stale');
  f.invoke('write', { kind: 'reserve', key: value.intentId, quantity: 1 });
  f.http('write', 200, value);
  f.invoke('read', { kind: 'lookup', key: value.intentId }, 'b');
  f.http('read', 404, { intentId: value.intentId, status: 'unseen' });
  assert.equal(checkLedger(ledger([value])).ok, true);
  compare(f.finish([value]), false);
});
test('a future pending write cannot explain an already completed read', () => {
  const f = fixture();
  const value = result('purchase-future');
  f.invoke('read', { kind: 'lookup', key: value.intentId });
  f.http('read', 200, value);
  f.invoke('write', { kind: 'reserve', key: value.intentId, quantity: 1 }, 'b');
  f.unknown('write');
  compare(f.finish([value]), false);
});
test('both changed-command winners are legal during overlap, not in forced call order', () => {
  for (const winner of [1, 2]) {
    const f = fixture();
    const value = result('purchase-overlap', winner);
    f.invoke('one', { kind: 'reserve', key: value.intentId, quantity: 1 });
    f.invoke('two', { kind: 'reserve', key: value.intentId, quantity: 2 }, 'b');
    f.http('two', winner === 2 ? 200 : 409, winner === 2 ? value : conflict);
    f.http('one', winner === 1 ? 200 : 409, winner === 1 ? value : conflict);
    compare(f.finish([value]), true);
  }
});
test('pending same-command retries admit one effect without assigning the actual creator', () => {
  const f = fixture();
  const value = result('purchase-retry');
  f.invoke('unknown', { kind: 'reserve', key: value.intentId, quantity: 1 });
  f.unknown('unknown');
  f.invoke('retry', { kind: 'reserve', key: value.intentId, quantity: 1 }, 'b');
  f.http('retry', 200, value);
  const history = f.finish([value]);
  compare(history, true);
  for (const decision of ['apply', 'omit'] as const)
    assert.equal(
      replayWitness(history, [
        { attemptId: 'unknown', decision },
        { attemptId: 'retry', decision: 'apply' },
        { attemptId: 'final', decision: 'apply' },
      ]).ok,
      true,
    );
});
test('later capacity consumption cannot justify an earlier rejection', () => {
  const f = fixture();
  const rejection = result('purchase-rejected', 3, 5, true);
  f.invoke('reject', { kind: 'reserve', key: rejection.intentId, quantity: 3 });
  f.http('reject', 200, rejection);
  const confirmations = Array.from({ length: 4 }, (_, i) => result(`purchase-full-${i}`, 3, i + 1));
  for (const [i, value] of confirmations.entries()) {
    f.invoke(`write-${i}`, { kind: 'reserve', key: value.intentId, quantity: 3 });
    f.http(`write-${i}`, 200, value);
  }
  assert.equal(checkLedger(ledger([...confirmations, rejection])).ok, true);
  compare(f.finish([...confirmations, rejection]), false);
});
test('a receipt change cannot hide behind identical success counts', () => {
  const f = fixture();
  const value = result('purchase-receipt');
  f.invoke('one', { kind: 'reserve', key: value.intentId, quantity: 1 });
  f.invoke('two', { kind: 'reserve', key: value.intentId, quantity: 1 }, 'b');
  f.http('one', 200, value);
  f.http('two', 200, { ...value, receiptId: 'different-receipt' });
  compare(f.finish([value]), false);
});
test('pure model search never mutates the recorded history across failed branches', () => {
  const history = lateHistory();
  const before = JSON.stringify(history);
  checkHistory(history);
  checkHistory(history, { maxStates: 1 });
  assert.equal(JSON.stringify(history), before);
});
test('witness replay rejects missing, duplicate, omitted-known, and reordered operations', () => {
  const history = lateHistory();
  const witness = checkHistory(history).witness!;
  assert.equal(replayWitness(history, witness.slice(1)).ok, false);
  assert.equal(replayWitness(history, [...witness.slice(0, -1), witness[0]]).ok, false);
  assert.equal(
    replayWitness(
      history,
      witness.map((s) => (s.attemptId === 'late' ? { ...s, decision: 'omit' } : s)),
    ).ok,
    false,
  );
  assert.equal(replayWitness(history, [...witness].reverse()).ok, false);
});
test('budget and missing drain are inconclusive, never pass', () => {
  assert.equal(checkHistory(lateHistory(), { maxStates: 0 }).status, 'inconclusive');
  assert.equal(checkHistory(lateHistory(), { timeoutMs: 0 }).status, 'inconclusive');
  const history = lateHistory();
  history.events = history.events
    .filter((e) => e.kind === 'invoke' || e.kind === 'http' || e.kind === 'unknown')
    .slice(0, -2);
  assert.equal(checkHistory(history).status, 'inconclusive');
});
test('duplicate/missing attempt, other-run drain, and premature fence invalidate evidence', () => {
  for (const mutate of [
    (h: History) => h.plannedAttemptIds.push(h.plannedAttemptIds[0]!),
    (h: History) => h.plannedAttemptIds.push('never-dispatched'),
    (h: History) => {
      const e = h.events.find((e) => e.kind === 'drained')!;
      if (e.kind === 'drained') e.runId = 'another-run';
    },
    (h: History) => {
      const e = h.events.find((e) => e.kind === 'drained')!;
      Object.assign(e, { kind: 'fence' });
    },
  ]) {
    const h = lateHistory();
    mutate(h);
    assert.equal(checkHistory(h).status, 'invalid');
  }
});
test('actual malformed success is a protocol counterexample, not permissive uncertainty', () => {
  const h = lateHistory();
  const e = h.events.find((e) => e.kind === 'http' && e.status === 200)!;
  if (e.kind === 'http') e.body = { unexpected: true };
  assert.equal(checkHistory(h).status, 'counterexample');
});
test('outcome-unknown HTTP503 follows the same pending semantics in both checkers', () => {
  const h = lateHistory();
  const index = h.events.findIndex((e) => e.kind === 'unknown');
  const old = h.events[index]!;
  if (old.kind !== 'unknown') throw new Error('Fixture lacks unknown write');
  h.events[index] = {
    kind: 'http',
    sequence: old.sequence,
    elapsedMs: old.elapsedMs,
    attemptId: old.attemptId,
    status: 503,
    body: {
      error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Outcome unavailable.', retryable: true },
    },
  };
  compare(h, true);
});
test('array-shaped target or fault cannot bypass scalar evidence contracts', () => {
  for (const changed of [{ target: ['a'] }, { target: ['reader'] }, { fault: ['none'] }]) {
    const h = lateHistory();
    Object.assign(h.events[0]!, changed);
    assert.equal(checkHistory(h).status, 'invalid');
  }
});
test('deep malformed ledger commands are classified before canonical hashing', () => {
  const h = lateHistory();
  const final = h.events.at(-1)!;
  assert.equal(final.kind, 'http');
  let nested: unknown = 1;
  for (let i = 0; i < 7_000; i++) nested = [nested];
  if (final.kind === 'http')
    (final.body as { intents: { command: { quantity: unknown } }[] }).intents[0]!.command.quantity =
      nested;
  assert.equal(checkHistory(h, { timeoutMs: 0 }).status, 'counterexample');
});
