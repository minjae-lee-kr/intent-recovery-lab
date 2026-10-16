import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';

// Independently stated fixture contract; no owner code or validator imports.
const retention = 1000,
  margin = 100;
const scenarios = new Set([
  'retained-positive',
  'naive-expired',
  'guarded-postcommit',
  'guarded-precommit',
  'guarded-delayed-arrival',
]);
const plain = (row) => ({ ...row });
function orderedJournal(db) {
  const rows = db
    .prepare('SELECT * FROM journal ORDER BY seq')
    .all()
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  let previous = 0;
  for (const [index, row] of rows.entries()) {
    assert.equal(row.seq, index + 1, 'Complete ordered journal required');
    if (row.clock !== null) {
      assert.ok(
        Number.isSafeInteger(row.clock) && row.clock >= previous,
        'Known fixture clocks must be monotone',
      );
      previous = row.clock;
    }
  }
  return rows;
}

// Current rows alone cannot establish whether pruning respected minimum retention.
function replayDownstream(journal, effects, retained, intent) {
  const active = new Map(),
    seenEffects = new Map(),
    outcomes = new Map();
  for (const entry of journal) {
    assert.equal(entry.intent_key, intent.intent_key);
    assert.ok(Number.isSafeInteger(entry.clock), 'Remote event needs known clock');
    const current = active.get(entry.intent_key);
    let receipt = null;
    if (entry.event === 'post-new-effect') {
      assert.equal(current, undefined, 'New effect requires no retained key');
      const effect = effects.find((e) => e.receipt === entry.detail.receipt);
      assert.ok(effect, 'New-effect event must identify a durable effect');
      assert.equal(seenEffects.has(effect.receipt), false, 'Effect created once');
      assert.equal(effect.created_at, entry.clock);
      assert.equal(effect.intent_key, intent.intent_key);
      assert.equal(effect.units, intent.units);
      seenEffects.set(effect.receipt, effect);
      active.set(entry.intent_key, {
        intent_key: entry.intent_key,
        command: JSON.stringify({ units: intent.units }),
        receipt: effect.receipt,
        expires_at: entry.clock + retention,
      });
      receipt = effect.receipt;
    } else if (entry.event === 'post-replayed') {
      assert.ok(current, 'Replay requires a retained key');
      assert.equal(entry.detail.receipt, current.receipt);
      receipt = current.receipt;
    } else if (entry.event === 'lookup-retained') {
      assert.ok(current, 'Positive lookup requires retained state at that event');
      receipt = current.receipt;
    } else if (entry.event === 'lookup-absent') {
      assert.equal(current, undefined, 'Absent lookup cannot hide a retained key');
    } else if (entry.event === 'dedup-pruned') {
      assert.ok(current, 'Pruning requires an existing retained key');
      assert.ok(
        entry.clock >= current.expires_at,
        'Pruning before minimum retention is not a valid expiry counterexample',
      );
      active.delete(entry.intent_key);
      continue;
    } else {
      assert.equal(entry.event, 'post-drop-before-commit', 'Unsupported remote event');
    }
    assert.match(entry.detail.attemptId ?? '', /^attempt-[1-9][0-9]*$/);
    assert.equal(outcomes.has(entry.detail.attemptId), false, 'One arrival per attempt');
    outcomes.set(entry.detail.attemptId, { entry, receipt });
  }
  assert.equal(seenEffects.size, effects.length, 'No unexplained durable effect');
  assert.deepEqual(retained.map(plain), [...active.values()]);
  return outcomes;
}

// Privileged post-shutdown auditor. The retry policy cannot read these journals.
export function audit(localPath, remotePath, scenario) {
  assert.ok(scenarios.has(scenario), 'Known bounded scenario required');
  const local = new DatabaseSync(localPath, { readOnly: true });
  const remote = new DatabaseSync(remotePath, { readOnly: true });
  try {
    const intents = local.prepare('SELECT * FROM intents ORDER BY id').all();
    const grants = local.prepare('SELECT * FROM grants ORDER BY intent_id').all();
    const localJournal = orderedJournal(local),
      remoteJournal = orderedJournal(remote);
    const localClockFloor = local.prepare('SELECT * FROM clock_floor').all();
    const effects = remote.prepare('SELECT * FROM effects ORDER BY created_at,receipt').all();
    const retained = remote.prepare('SELECT * FROM dedup ORDER BY intent_key').all();
    assert.equal(intents.length, 1);
    const intent = intents[0];
    assert.equal(intent.intent_key, `key-${intent.id}`);
    assert.equal(intent.units, 1);
    assert.equal(intent.first_at, 10000);
    assert.equal(intent.retry_before, intent.first_at + retention - margin);
    assert.equal(intent.contract, 'synthetic-retention-v1');
    assert.equal(intent.policy, scenario === 'naive-expired' ? 'naive' : 'guarded');
    assert.equal(localJournal[0].event, 'intent-persisted');
    assert.equal(localJournal[0].clock, intent.first_at);
    assert.deepEqual(localJournal[0].detail, { retention, margin });
    assert.equal(localJournal[1].event, 'dispatch-post');
    const outcomes = replayDownstream(remoteJournal, effects, retained, intent);
    const outbound = localJournal.filter((e) =>
      ['dispatch-post', 'dispatch-lookup'].includes(e.event),
    );
    assert.equal(outbound.length, outcomes.size);
    assert.equal(new Set(outbound.map((e) => e.detail.attemptId)).size, outbound.length);
    const settlementNames = [
      'transport-unknown',
      'observed-absence',
      'unresolved-response',
      'local-grant',
    ];
    const pending = new Map();
    let status = 'unknown',
      grantedReceipt = null,
      dispatchCount = 0;
    for (const event of localJournal.slice(1)) {
      assert.equal(event.intent_key, intent.intent_key);
      if (event.event.startsWith('dispatch-') && event.event !== 'dispatch-refused') {
        assert.ok(['dispatch-post', 'dispatch-lookup'].includes(event.event));
        assert.equal(event.detail.attemptId, `attempt-${++dispatchCount}`);
        assert.equal(event.detail.retryBefore, intent.retry_before);
        assert.equal(pending.size, 0, 'Fixture has sequential attempts per intent');
        assert.notEqual(status, 'confirmed');
        if (event.event === 'dispatch-post') {
          assert.notEqual(event.clock, null, 'POST requires known local clock');
          if (intent.policy === 'guarded') {
            assert.equal(status, 'unknown', 'Reconciliation remains sticky');
            assert.ok(event.clock < intent.retry_before, 'Guarded dispatch before cutoff');
          }
        }
        const outcome = outcomes.get(event.detail.attemptId);
        assert.ok(outcome, 'Each dispatch needs exactly one correlated arrival');
        assert.equal(outcome.entry.event.startsWith('post-'), event.event === 'dispatch-post');
        if (event.clock !== null)
          assert.ok(
            outcome.entry.clock >= event.clock,
            'Synchronized fixture arrival cannot precede dispatch clock',
          );
        pending.set(event.detail.attemptId, outcome);
      } else if (settlementNames.includes(event.event)) {
        const outcome = pending.get(event.detail.attemptId);
        assert.ok(outcome, 'Settlement requires its unique pending dispatch');
        if (event.clock !== null)
          assert.ok(
            event.clock >= outcome.entry.clock,
            'Synchronized fixture settlement cannot precede remote arrival',
          );
        if (event.event === 'local-grant') {
          assert.ok(outcome.receipt, 'Grant requires the correlated positive outcome');
          assert.equal(
            event.detail.receipt,
            outcome.receipt,
            'Grant must use the receipt returned by this exact correlated attempt',
          );
          assert.equal(grantedReceipt, null, 'Only one local grant event');
          grantedReceipt = outcome.receipt;
          status = 'confirmed';
        } else if (event.event === 'observed-absence') {
          assert.equal(outcome.entry.event, 'lookup-absent');
          if (event.clock === null || event.clock >= intent.retry_before)
            status = 'needs-reconciliation';
        }
        pending.delete(event.detail.attemptId);
      } else if (event.event === 'dispatch-refused') {
        assert.equal(pending.size, 0);
        assert.notEqual(status, 'confirmed');
        assert.equal(event.detail.retryBefore, intent.retry_before);
        const reason =
          event.clock === null
            ? 'CLOCK_UNKNOWN'
            : event.clock >= intent.retry_before
              ? 'RETENTION_HORIZON_REACHED'
              : 'RECONCILIATION_REQUIRED';
        assert.equal(event.detail.reason, reason);
        if (event.clock !== null) assert.equal(intent.policy, 'guarded');
        if (reason === 'RECONCILIATION_REQUIRED') assert.equal(status, 'needs-reconciliation');
        status = 'needs-reconciliation';
      } else assert.fail(`Unsupported local event: ${event.event}`);
    }
    assert.equal(pending.size, 0);
    assert.equal(intent.status, status);
    assert.equal(intent.receipt, grantedReceipt);
    assert.deepEqual(
      grants.map(plain),
      grantedReceipt === null
        ? []
        : [
            {
              intent_id: intent.id,
              receipt: grantedReceipt,
              units: intent.units,
            },
          ],
    );
    const dispatched = outbound.filter((e) => e.event === 'dispatch-post');
    const received = remoteJournal.filter((e) => e.event.startsWith('post-'));
    assert.equal(dispatched.length, received.length);
    const checks = {
      localJournalValid: true,
      firstDispatchMetadataPersisted: true,
      frozenHorizonRetained: true,
      grantBoundToCorrelatedOutcome: true,
      retentionChronologyValid: true,
      remoteEffectAtMostOnce: effects.length <= 1,
      remoteEffects: effects.length,
      localGrants: grants.length,
      downstreamPosts: received.length,
      retainedKeys: retained.length,
    };
    if (scenario === 'retained-positive') {
      assert.equal(effects.length, 1);
      assert.equal(grants.length, 1);
      assert.equal(received.length, 2);
      assert.equal(received[0].event, 'post-new-effect');
      assert.equal(received[1].event, 'post-replayed');
      assert.equal(remoteJournal.at(-1).event, 'lookup-retained');
      assert.ok(remoteJournal.at(-1).clock >= retained[0].expires_at);
      checks.positiveLookupBeyondMinimumRecovered = true;
    } else if (scenario === 'naive-expired' || scenario === 'guarded-delayed-arrival') {
      assert.equal(effects.length, 2);
      assert.equal(grants.length, 1);
      assert.equal(received.length, 2);
      assert.ok(remoteJournal.some((e) => e.event === 'dedup-pruned'));
      if (scenario === 'naive-expired') {
        assert.ok(remoteJournal.some((e) => e.event === 'lookup-absent'));
        assert.ok(dispatched[1].clock >= intent.retry_before);
        checks.expectedCounterexample = true;
      } else {
        assert.ok(dispatched[1].clock < intent.retry_before);
        assert.ok(received[1].clock >= intent.first_at + retention);
        assert.equal(received[1].event, 'post-new-effect');
        checks.expectedLimitation = true;
        checks.locallyEligibleRetryArrivedAfterPruning = true;
      }
    } else {
      assert.equal(intent.status, 'needs-reconciliation');
      assert.equal(effects.length, scenario === 'guarded-postcommit' ? 1 : 0);
      assert.equal(grants.length, 0);
      assert.equal(received.length, 1);
      assert.ok(localJournal.some((e) => e.event === 'observed-absence'));
      assert.ok(
        localJournal.some(
          (e) => e.event === 'dispatch-refused' && e.detail.reason === 'CLOCK_UNKNOWN',
        ),
      );
      assert.ok(
        localJournal.some(
          (e) => e.event === 'dispatch-refused' && e.detail.reason === 'RETENTION_HORIZON_REACHED',
        ),
      );
      checks.expiredAutomaticReplayRefused = true;
      checks.uncertaintySurvivedRestart = true;
    }
    return {
      scenario,
      expectedResultEstablished: true,
      checks,
      intents,
      grants,
      effects,
      retained,
      localJournal,
      remoteJournal,
      localClockFloor,
    };
  } finally {
    local.close();
    remote.close();
  }
}
