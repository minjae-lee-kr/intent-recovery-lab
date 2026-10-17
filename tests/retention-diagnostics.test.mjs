import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { collectRetention, launch } from '../scripts/retention/collect.mjs';
import { failureContext } from '../scripts/retention/failure.mjs';
import { retentionReportText } from '../scripts/retention/report.mjs';

const canary = 'PRIVATE_CANARY C:\\private\\ledger.sqlite SELECT secret FROM ledger';
function unsafeError(code) {
  return Object.assign(new Error(canary), { name: canary, code });
}
function failedReport(error) {
  return {
    runId: 'failed-fixture',
    completedAt: 'unavailable',
    sourceBefore: { git: { state: 'unavailable' }, sha256: 'unavailable' },
    sourceStable: false,
    passed: false,
    cases: [],
    mutationControls: [],
    executionError: {
      name: 'RetentionFixtureFailure',
      message: 'The bounded fixture did not establish its expected result.',
      context: failureContext(error),
    },
  };
}
function restoredBuiltins(t) {
  t.mock.restoreAll();
  syncBuiltinESMExports();
}

test(
  'second parent request failure keeps its pre-cleanup context and redacts raw errors',
  { timeout: 10000 },
  async (t) => {
    const nativeFetch = globalThis.fetch,
      nativeSpawn = childProcess.spawn,
      nativeRm = fs.rm;
    const children = [];
    let calls = 0,
      cleanupDirectory,
      error;
    t.mock.method(childProcess, 'spawn', (...args) => {
      const child = nativeSpawn(...args);
      const observed = { closed: false };
      child.once('close', () => {
        observed.closed = true;
      });
      children.push(observed);
      return child;
    });
    t.mock.method(fs, 'rm', async (path) => {
      cleanupDirectory = path;
      throw unsafeError('EACCES');
    });
    syncBuiltinESMExports();
    t.mock.method(globalThis, 'fetch', async (...args) => {
      if (++calls === 2)
        throw Object.assign(unsafeError(canary), { cause: unsafeError('ECONNRESET') });
      const response = await nativeFetch(...args);
      assert.equal(response.status, 202);
      return response;
    });
    try {
      await assert.rejects(collectRetention(), (failure) => {
        error = failure;
        return true;
      });
    } finally {
      restoredBuiltins(t);
      if (cleanupDirectory) {
        const target = resolve(cleanupDirectory);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('retention-horizon-'));
        await nativeRm(target, { recursive: true, force: true, maxRetries: 3 });
      }
    }
    assert.equal(calls, 2);
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.closed));
    assert.ok(cleanupDirectory, 'the later cleanup error was actually exercised');
    const context = failureContext(error);
    assert.deepEqual(context, {
      scenario: 'retained-positive',
      phase: 'fetch',
      code: 'ECONNRESET',
      request: { ordinal: 2, action: 'execute', status: null },
      workers: [
        { instance: 1, role: 'downstream', readyObserved: true, closeObserved: false },
        { instance: 2, role: 'local', readyObserved: true, closeObserved: false },
      ],
    });
    assert.ok(Object.isFrozen(context) && Object.isFrozen(context.workers[0]));
    const report = failedReport(error),
      text = retentionReportText(report);
    assert.deepEqual(report.cases, []);
    assert.match(text, /NOT ESTABLISHED/);
    assert.match(text, /retained-positive · fetch · ECONNRESET/);
    assert.match(text, /Request \/ 요청: 2 · execute · HTTP not observed/);
    assert.match(text, /No close observation does not establish that a worker was alive/);
    assert.doesNotMatch(
      JSON.stringify(report) + text + JSON.stringify(error),
      /PRIVATE_CANARY|SELECT secret|private\\|EACCES|stack|stderr/,
    );
  },
);

test(
  'body rejection records an observed status and maps an unknown code to OTHER',
  { timeout: 10000 },
  async (t) => {
    const nativeFetch = globalThis.fetch;
    let calls = 0,
      error;
    t.mock.method(globalThis, 'fetch', async (...args) => {
      calls++;
      const response = await nativeFetch(...args);
      return {
        status: response.status,
        async json() {
          await response.text();
          throw unsafeError(canary);
        },
      };
    });
    try {
      await assert.rejects(collectRetention(), (failure) => {
        error = failure;
        return true;
      });
    } finally {
      restoredBuiltins(t);
    }
    assert.equal(calls, 1);
    const context = failureContext(error);
    assert.equal(context.phase, 'body');
    assert.equal(context.code, 'OTHER');
    assert.deepEqual(context.request, { ordinal: 1, action: 'execute', status: 202 });
    assert.ok(context.workers.every((worker) => worker.readyObserved && !worker.closeObserved));
    assert.doesNotMatch(
      JSON.stringify(failedReport(error)) + retentionReportText(failedReport(error)),
      /PRIVATE_CANARY|SELECT secret/,
    );
  },
);

test(
  'a completed response does not remain an active request during an assertion failure',
  { timeout: 10000 },
  async (t) => {
    let error;
    t.mock.method(globalThis, 'fetch', async () => ({
      status: 418,
      json: async () => ({ status: 'unknown' }),
    }));
    try {
      await assert.rejects(collectRetention(), (failure) => {
        error = failure;
        return true;
      });
    } finally {
      restoredBuiltins(t);
    }
    assert.equal(failureContext(error).phase, 'assertion');
    assert.equal(failureContext(error).request, null);
  },
);

test('startup failure is frozen before cleanup closes the child and throws another error', async (t) => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1;
  let killed = false,
    error;
  child.kill = () => {
    killed = true;
    child.emit('close', null, 'SIGKILL');
    throw unsafeError('EACCES');
  };
  t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => child.emit('error', unsafeError('ENOENT')));
    return child;
  });
  syncBuiltinESMExports();
  const state = { scenario: 'retained-positive', phase: 'launch', workers: [] };
  try {
    await assert.rejects(launch('local', 'unused.sqlite', undefined, [], state), (failure) => {
      error = failure;
      return true;
    });
  } finally {
    restoredBuiltins(t);
  }
  assert.equal(killed, true);
  assert.equal(state.workers[0].closeObserved, true, 'cleanup really produced a close event');
  assert.deepEqual(failureContext(error), {
    scenario: 'retained-positive',
    phase: 'launch',
    request: null,
    code: 'ENOENT',
    workers: [{ instance: 1, role: 'local', readyObserved: false, closeObserved: false }],
  });
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE_CANARY|EACCES|SIGKILL/);
});

test('an observed startup close is recorded without exporting child stderr', async (t) => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1;
  child.kill = () => assert.fail('an already closed child must not be killed');
  t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from(canary));
      child.emit('close', 2, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  let error;
  try {
    await assert.rejects(launch('local', 'unused.sqlite'), (failure) => {
      error = failure;
      return true;
    });
  } finally {
    restoredBuiltins(t);
  }
  assert.deepEqual(failureContext(error), {
    scenario: null,
    phase: 'launch',
    request: null,
    code: 'OTHER',
    workers: [
      {
        instance: 1,
        role: 'local',
        readyObserved: false,
        closeObserved: true,
        code: 2,
        signal: null,
      },
    ],
  });
  assert.doesNotMatch(
    JSON.stringify(error) + retentionReportText(failedReport(error)),
    /PRIVATE_CANARY|SELECT secret/,
  );
});
