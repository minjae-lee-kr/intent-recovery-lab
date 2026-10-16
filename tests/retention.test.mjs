import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { connect } from 'node:net';
import { collectRetention, launch } from '../scripts/retention/collect.mjs';
import { retentionReportText } from '../scripts/retention/report.mjs';

test(
  'separate HTTP owners expose retention ambiguity, reject false evidence and preserve the late-arrival limitation',
  { timeout: 30000 },
  async () => {
    const result = await collectRetention();
    assert.equal(result.expectedResultsEstablished, true);
    assert.deepEqual(
      result.cases.map((c) => [
        c.scenario,
        c.audit.checks.remoteEffects,
        c.audit.checks.localGrants,
      ]),
      [
        ['retained-positive', 1, 1],
        ['naive-expired', 2, 1],
        ['guarded-postcommit', 1, 0],
        ['guarded-precommit', 0, 0],
        ['guarded-delayed-arrival', 2, 1],
      ],
    );
    assert.equal(result.localObservationsIndistinguishable.allLocalTablesEqual, true);
    assert.equal(result.localObservationsIndistinguishable.normalization.startsWith('none;'), true);
    const late = result.cases.find((c) => c.scenario === 'guarded-delayed-arrival');
    const posts = late.audit.localJournal.filter((e) => e.event === 'dispatch-post');
    assert.deepEqual(
      posts.map((e) => e.clock),
      [10000, 10020],
    );
    assert.equal(late.audit.checks.remoteEffectAtMostOnce, false);
    const held = late.observations.find((e) => e.type === 'relay-held');
    const pruned = late.observations.find(
      (e) => e.type === 'fixture-control' && e.control === 'prune',
    );
    const forwarded = late.observations.find((e) => e.type === 'relay-forwarded');
    assert.ok(held.sequence < pruned.sequence && pruned.sequence < forwarded.sequence);
    assert.equal(held.attemptId, posts[1].detail.attemptId);
    assert.equal(forwarded.attemptId, held.attemptId);
    for (const c of result.cases) {
      const ready = c.observations.filter((e) => e.type === 'process-ready');
      const exited = c.observations.filter((e) => e.type === 'process-exit');
      assert.equal(ready.length, exited.length);
      for (const started of ready) {
        const end = exited.find((e) => e.pid === started.pid && e.sequence > started.sequence);
        assert.equal(end?.code, 0);
      }
    }
    assert.equal(result.mutationControls.find((c) => c.kind === 'baseline').accepted, true);
    for (const control of result.mutationControls.filter((c) => c.kind !== 'baseline'))
      assert.equal(control.accepted, false, control.kind);
    assert.match(
      result.mutationControls.find((c) => c.kind === 'unacknowledged-existing-receipt').message,
      /exact correlated attempt/,
    );
    assert.match(
      result.mutationControls.find((c) => c.kind === 'premature-pruning').message,
      /before minimum retention/,
    );
    assert.doesNotMatch(JSON.stringify(result), /[A-Z]:\\|\/Users\/|\/home\//);
  },
);

test('an unestablished report does not claim the late-arrival or identical-observation result', () => {
  const report = retentionReportText({
    runId: 'failed-fixture',
    completedAt: 'unavailable',
    sourceBefore: { git: { state: 'unavailable' }, sha256: 'unavailable' },
    sourceStable: false,
    passed: false,
    cases: [],
    mutationControls: [],
    executionError: { message: 'Fixture failed.' },
  });
  assert.match(report, /NOT ESTABLISHED/);
  assert.doesNotMatch(report, /The delayed request was dispatched/);
  assert.doesNotMatch(report, /This verdict includes two repeated-effect counterexamples/);
  assert.doesNotMatch(report, /cases have identical local observations/);
});

test(
  'owned retention fixture bounds malformed and partial HTTP input without exposing exception details',
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(resolve(tmpdir()), 'retention-input-'));
    let owner;
    try {
      owner = await launch('local', join(directory, 'local.sqlite'), 'http://127.0.0.1:1');
      const send = (body, headers = {}) =>
        fetch(owner.url + '/intents', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body,
          signal: AbortSignal.timeout(3000),
        });
      const origin = await send('{}', { origin: 'https://example.invalid' });
      assert.equal(origin.status, 403);
      await origin.text();
      const oversize = await send(' '.repeat(1025));
      assert.equal(oversize.status, 413);
      assert.deepEqual(await oversize.json(), { error: 'BODY_LIMIT' });
      const invalid = await send('{');
      assert.equal(invalid.status, 400);
      assert.deepEqual(await invalid.json(), { error: 'INVALID_JSON' });
      const port = Number(new URL(owner.url).port);
      const partial = await new Promise((resolveReply, reject) => {
        const socket = connect(port, '127.0.0.1');
        let text = '';
        socket.setTimeout(2500, () =>
          socket.destroy(new Error('Partial-body deadline was not enforced')),
        );
        socket.on('error', reject);
        socket.on('data', (bytes) => {
          text += bytes;
        });
        socket.on('end', () => resolveReply(text));
        socket.on('connect', () =>
          socket.write(
            `POST /intents HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
          ),
        );
      });
      assert.match(partial, /HTTP\/1.1 408/);
      assert.match(partial, /BODY_TIMEOUT/);
      assert.doesNotMatch(partial, /sqlite|stack|[A-Z]:\\/i);
    } finally {
      try {
        await owner?.stop();
      } finally {
        await owner?.kill();
      }
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('retention-input-'));
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  },
);
