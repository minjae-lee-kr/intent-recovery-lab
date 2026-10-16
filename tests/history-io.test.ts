import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHistory } from '../scripts/history/harness.ts';
import { checkHistory } from '../scripts/history/checker.ts';
import { coverage, staleReadControl } from '../scripts/history/assessment.ts';
import { belongs } from '../scripts/history/process.ts';
test('real two-process HTTP history drains delayed accepted work, then rejects a stale-read mutation', async () => {
  const result = await collectHistory(104_729);
  assert.equal(result.executionError, undefined);
  const verdict = checkHistory(result.history);
  assert.equal(verdict.status, 'witness', verdict.reason);
  assert.equal(coverage(result.history).complete, true, JSON.stringify(coverage(result.history)));
  const control = staleReadControl(result.history);
  assert.equal(control.established, true);
  assert.equal('finalLedgerUnchanged' in control && control.finalLedgerUnchanged, true);
  const late = result.history.events.find((e) => e.kind === 'unknown' && e.attemptId === 'late')!;
  const drain = result.history.events.find((e) => e.kind === 'drained' && e.target === 'a')!;
  assert.ok(drain.sequence > late.sequence);
  const unknownWrites = verdict.witness!.filter(
    (e) => e.attemptId === 'late' || e.attemptId === 'lost',
  );
  assert.ok(unknownWrites.every((e) => e.decision === 'apply'));
  const unrelated = structuredClone(result.history);
  const earlyCall = unrelated.events.find(
    (e) => e.kind === 'invoke' && e.attemptId === 'early-read',
  )!;
  const earlyReply = unrelated.events.find(
    (e) => e.kind === 'http' && e.attemptId === 'early-read',
  )!;
  if (earlyCall.kind === 'invoke' && earlyCall.input.kind === 'lookup')
    earlyCall.input.key = 'unrelated-unseen';
  if (earlyReply.kind === 'http')
    earlyReply.body = { intentId: 'unrelated-unseen', status: 'unseen' };
  assert.equal(
    checkHistory(unrelated).status,
    'witness',
    'a legal unrelated lookup is not a consistency defect',
  );
  assert.equal(
    coverage(unrelated).complete,
    false,
    'but it must not establish late-write absence coverage',
  );
  assert.equal(coverage(unrelated).checks.earlyUnseen, false);
  const prematureRead = structuredClone(result.history);
  const timeoutIndex = prematureRead.events.findIndex(
    (e) => e.kind === 'unknown' && e.attemptId === 'late',
  );
  const readIndex = prematureRead.events.findIndex(
    (e) => e.kind === 'invoke' && e.attemptId === 'early-read',
  );
  [prematureRead.events[timeoutIndex], prematureRead.events[readIndex]] = [
    prematureRead.events[readIndex]!,
    prematureRead.events[timeoutIndex]!,
  ];
  prematureRead.events.forEach((e, i) => {
    e.sequence = i + 1;
    e.elapsedMs = i;
  });
  assert.equal(checkHistory(prematureRead).status, 'witness');
  assert.equal(
    coverage(prematureRead).checks.earlyUnseen,
    false,
    'the intended lookup must follow the observer timeout',
  );
});
test('drain messages are tied to the exact run, process instance, target and PID', () => {
  const identity = { runId: 'this-run', instanceId: 'this-process', target: 'a' as const, pid: 42 };
  assert.equal(belongs({ type: 'drained', ...identity }, identity, 'drained'), true);
  for (const [key, value] of Object.entries({
    runId: 'another-run',
    instanceId: 'another-process',
    target: 'b',
    pid: 43,
    type: 'ready',
  }))
    assert.equal(
      belongs({ type: 'drained', ...identity, [key]: value }, identity, 'drained'),
      false,
    );
});
