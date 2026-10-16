import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { audit } from './check.mjs';
import { mutationControls } from './sensitivity.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
export const fixture = {
  ttl: 1000,
  conservativeMargin: 100,
  clockUnits: 'explicit logical fixture units; no elapsed-time benchmark',
  clockTrust: 'parent-controlled equal-rate zero-offset fixture',
};
export const limits = [
  'Not an exactly-once proof, provider integration, power-loss test, or performance measurement.',
  'Cache absence cannot certify no historical effect. Auditor access is unavailable to the retry policy.',
  'The guard refuses dispatch at/after its cutoff, not remote arrival after pruning or an in-transit request.',
  'Synchronized injected clocks and the configured margin do not establish real clock or transit bounds.',
];
function observe(log, type, data) {
  log.push({ sequence: log.length + 1, type, ...data });
}
function bounded(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned child/control timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function launch(role, path, providerUrl, log = []) {
  const child = spawn(
    process.execPath,
    [join(here, 'worker.mjs'), role, path, ...(providerUrl ? [providerUrl] : [])],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '',
    closed = false,
    request = 0;
  const pending = new Map();
  child.stderr.on('data', (b) => (stderr = (stderr + b.toString()).slice(-4000)));
  const exit = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }),
  );
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message) => {
      if (message.type === 'ready') resolve(message);
      else {
        const p = pending.get(message.id);
        if (p) {
          pending.delete(message.id);
          message.ok ? p.resolve(message) : p.reject(new Error(message.error));
        }
      }
    });
  });
  let start;
  try {
    start = await bounded(
      Promise.race([
        ready,
        exit.then(() => {
          throw new Error(`Exited before ready: ${stderr}`);
        }),
      ]),
      5000,
    );
  } catch (error) {
    if (!closed) child.kill('SIGKILL');
    await bounded(exit, 5000);
    throw error;
  }
  assert.equal(start.pid, child.pid);
  assert.equal(start.role, role);
  assert.match(start.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  observe(log, 'process-ready', { role, pid: child.pid });
  const rpc = async (type, value) => {
    const id = ++request;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, type, value }, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
    const result = await bounded(p, 5000);
    observe(log, 'fixture-control', {
      role,
      pid: child.pid,
      control: type,
      ...(value === undefined ? {} : { value }),
    });
    return result;
  };
  return {
    url: start.url,
    rpc,
    async stop() {
      if (closed) return;
      try {
        await rpc('stop');
        const result = await bounded(exit, 5000);
        assert.equal(result.code, 0);
        observe(log, 'process-exit', { role, pid: child.pid, ...result });
      } finally {
        if (!closed) {
          child.kill('SIGKILL');
          await bounded(exit, 5000);
        }
      }
    },
    async kill() {
      if (!closed) {
        child.kill('SIGKILL');
        await bounded(exit, 5000);
      }
    },
  };
}
const cases = [
  'retained-positive',
  'naive-expired',
  'guarded-postcommit',
  'guarded-precommit',
  'guarded-delayed-arrival',
];
// The relay gates an actual request, not the downstream clock or its transaction.
// Logical clocks advance while this request is held; no transit duration is measured.
async function heldRetryRelay(upstream, log) {
  let posts = 0,
    release,
    arrived,
    closePromise;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const held = new Promise((resolve) => {
    arrived = resolve;
  });
  const active = new Set();
  const server = createServer((req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    ) {
      res.writeHead(403, { Connection: 'close' });
      res.end();
      return;
    }
    if (
      !['GET', 'POST'].includes(req.method) ||
      (req.method === 'POST' && req.headers['content-type'] !== 'application/json')
    ) {
      res.writeHead(400, { Connection: 'close' });
      res.end();
      return;
    }
    const task = (async () => {
      const chunks = [];
      let size = 0;
      const bodyTimer = setTimeout(() => req.destroy(), 1000);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) throw new Error('RELAY_BODY_LIMIT');
          chunks.push(chunk);
        }
      } finally {
        clearTimeout(bodyTimer);
      }
      const payload = Buffer.concat(chunks);
      const attemptId = req.headers['x-research-attempt'];
      if (req.method === 'POST' && ++posts === 2) {
        observe(log, 'relay-held', { attemptId });
        arrived(attemptId);
        await gate;
        observe(log, 'relay-forwarded', { attemptId });
      }
      const response = await fetch(upstream + req.url, {
        method: req.method,
        headers: {
          'x-research-attempt': attemptId,
          ...(req.headers['idempotency-key']
            ? { 'idempotency-key': req.headers['idempotency-key'] }
            : {}),
          ...(payload.length ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload.length ? { body: payload } : {}),
        signal: AbortSignal.timeout(2500),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(bytes);
    })()
      .catch(() => res.destroy())
      .finally(() => active.delete(task));
    active.add(task);
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 2000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    held,
    release,
    stop() {
      return (closePromise ??= (async () => {
        release();
        const timer = setTimeout(() => server.closeAllConnections(), 500);
        try {
          await bounded(new Promise((resolve) => server.close(resolve)), 4000);
          await bounded(Promise.allSettled([...active]), 4000);
        } finally {
          clearTimeout(timer);
          server.closeAllConnections();
        }
      })());
    },
  };
}
export async function collectRetention() {
  const directory = await mkdtemp(join(resolve(tmpdir()), 'retention-horizon-'));
  const evidence = { fixture, limits, cases: [], mutationControls: [] };
  try {
    for (const scenario of cases) {
      const log = [],
        caseDir = join(directory, scenario);
      await mkdir(caseDir);
      const localPath = join(caseDir, 'local.sqlite'),
        remotePath = join(caseDir, 'downstream.sqlite');
      const owned = [];
      let local, remote, relay;
      try {
        remote = await launch('downstream', remotePath, undefined, log);
        owned.push(remote);
        if (scenario === 'guarded-delayed-arrival') relay = await heldRetryRelay(remote.url, log);
        local = await launch('local', localPath, relay?.url ?? remote.url, log);
        owned.push(local);
        const clock = async (value) => {
          await local.rpc('clock', value);
          await remote.rpc('clock', value);
        };
        await clock(10000);
        const intentId = 'intent-same-business',
          policy = scenario === 'naive-expired' ? 'naive' : 'guarded';
        const send = async (action) => {
          observe(log, 'local-http-invoke', { intentId, action });
          const response = await fetch(`${local.url}/intents`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ intentId, units: 1, policy, action }),
            signal: AbortSignal.timeout(4000),
          });
          const body = await response.json();
          observe(log, 'local-http-response', {
            intentId,
            action,
            status: response.status,
            body,
          });
          return { status: response.status, body };
        };
        await remote.rpc('fault', scenario === 'guarded-precommit' ? 'before' : 'after');
        const first = await send('execute');
        assert.equal(first.status, 202);
        assert.equal(first.body.status, 'unknown');
        if (scenario === 'guarded-delayed-arrival') {
          await clock(10020);
          const retry = send('execute');
          // Attach a failure observer immediately while the parent opens the gate.
          void retry.catch(() => {});
          assert.equal(await bounded(relay.held, 1000), 'attempt-2');
          await clock(12000);
          await remote.rpc('prune');
          relay.release();
          const delayed = await retry;
          assert.equal(delayed.status, 200);
          assert.equal(delayed.body.status, 'confirmed');
        } else if (scenario === 'retained-positive') {
          await clock(10020);
          await remote.rpc('fault', 'after');
          const replay = await send('execute');
          assert.equal(replay.body.status, 'unknown');
          await clock(12000);
          const recovered = await send('reconcile');
          assert.equal(recovered.status, 200);
          assert.equal(recovered.body.status, 'confirmed');
        } else {
          await clock(12000);
          await remote.rpc('prune');
          const lookup = await send('reconcile');
          assert.equal(lookup.body.status, 'needs-reconciliation');
          const retried = await send('execute');
          assert.equal(
            retried.body.status,
            policy === 'naive' ? 'confirmed' : 'needs-reconciliation',
          );
        }
        await local.stop();
        local = await launch('local', localPath, remote.url, log);
        owned.push(local);
        const restart = await send('execute');
        const unresolved = ['guarded-postcommit', 'guarded-precommit'].includes(scenario);
        assert.equal(restart.body.status, unresolved ? 'needs-reconciliation' : 'confirmed');
        if (unresolved) {
          await assert.rejects(local.rpc('clock', 10000), /monotonically/);
          observe(log, 'clock-rollback-rejected', {
            role: 'local',
            attemptedClock: 10000,
          });
          await local.rpc('clock', 12000);
          const again = await send('execute');
          assert.equal(again.body.status, 'needs-reconciliation');
        }
        await local.stop();
        await relay?.stop();
        await remote.stop();
        const checked = audit(localPath, remotePath, scenario);
        evidence.cases.push({ scenario, observations: log, audit: checked });
        if (scenario === 'naive-expired')
          evidence.mutationControls = await mutationControls(
            localPath,
            remotePath,
            join(caseDir, 'controls'),
          );
      } finally {
        try {
          await relay?.stop();
        } finally {
          await Promise.allSettled(owned.map((worker) => worker.kill()));
        }
      }
    }
    const pre = evidence.cases.find((c) => c.scenario === 'guarded-precommit');
    const post = evidence.cases.find((c) => c.scenario === 'guarded-postcommit');
    const visible = (c) =>
      c.observations
        .filter((e) => e.type === 'local-http-response')
        .map((e) => ({
          status: e.status,
          body: e.body,
        }));
    assert.deepEqual(visible(pre), visible(post));
    const localTables = (c) => ({
      intents: c.audit.intents,
      grants: c.audit.grants,
      journal: c.audit.localJournal,
      clockFloor: c.audit.localClockFloor,
    });
    assert.deepEqual(localTables(pre), localTables(post));
    evidence.localObservationsIndistinguishable = {
      between: ['guarded-precommit', 'guarded-postcommit'],
      normalization: 'none; same intent and key in independent fresh databases',
      httpResponsesEqual: true,
      durableLocalJournalsEqual: true,
      allLocalTablesEqual: true,
      equal: true,
      remoteEffectCounts: [pre.audit.effects.length, post.audit.effects.length],
    };
    evidence.expectedResultsEstablished =
      evidence.cases.length === 5 &&
      evidence.cases.every((c) => c.audit.expectedResultEstablished) &&
      evidence.mutationControls.every((c) => c.accepted === (c.kind === 'baseline'));
    return evidence;
  } finally {
    // Remove only this invocation's fresh directory, after all owned workers stop.
    const resolved = resolve(directory);
    assert.equal(dirname(resolved), resolve(tmpdir()));
    assert.ok(basename(resolved).startsWith('retention-horizon-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}
