import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { LedgerView, Outcome } from '../src/protocol.ts';
import { DELAY_BEFORE_COMMIT_MS, MAX_BODY_BYTES, startServer } from '../src/server/server.ts';
import type { ServerOptions } from '../src/server/server.ts';
import { ReservationStore } from '../src/server/store.ts';

const command = { offerId: 'workshop', quantity: 2 } as const;
async function fixture(options: Partial<ServerOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'intent-server-http-'));
  const database = join(directory, 'ledger.sqlite');
  const server = await startServer({ databasePath: database, ...options });
  return {
    ...server,
    directory,
    database,
    async cleanup() {
      await server.close();
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}intent-server-http-`));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function submit(url: string, intentId: string, fault = 'none', options: RequestInit = {}) {
  return fetch(`${url}/api/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': intentId,
      'X-Lab-Fault': fault,
    },
    body: JSON.stringify(command),
    ...options,
  });
}
async function ledger(url: string): Promise<LedgerView> {
  return (await (await fetch(`${url}/api/ledger`)).json()) as LedgerView;
}
async function waitForOutcome(url: string, intentId: string): Promise<Outcome> {
  const deadline = performance.now() + DELAY_BEFORE_COMMIT_MS + 2_000;
  while (performance.now() < deadline) {
    const response = await fetch(`${url}/api/intents/${intentId}`);
    if (response.ok) return (await response.json()) as Outcome;
    await delay(20);
  }
  assert.fail('The deliberately delayed command did not settle within the test bound.');
}

test('real response loss before and after commit produces distinct ledgers; same-key retry recovers one effect', async () => {
  const f = await fixture();
  try {
    await assert.rejects(submit(f.url, 'intent_drop_before', 'drop-before-commit'), TypeError);
    assert.equal((await fetch(`${f.url}/api/intents/intent_drop_before`)).status, 404);
    assert.equal((await ledger(f.url)).effects.length, 0);
    const beforeRecovered = await (await submit(f.url, 'intent_drop_before')).json();
    assert.equal(beforeRecovered.status, 'confirmed');
    await assert.rejects(submit(f.url, 'intent_drop_after', 'drop-after-commit'), TypeError);
    const authoritative = await (await fetch(`${f.url}/api/intents/intent_drop_after`)).json();
    assert.equal(authoritative.status, 'confirmed');
    assert.deepEqual(await (await submit(f.url, 'intent_drop_after')).json(), authoritative);
    const final = await ledger(f.url);
    assert.equal(final.effects.length, 2);
    assert.equal(final.remainingCapacity, 8);
  } finally {
    await f.cleanup();
  }
});

test('unseen is a snapshot, and aborting the waiting caller does not cancel the delayed commit', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const pending = submit(f.url, 'intent_delayed', 'delay-before-commit', {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      pending,
      (error) => error instanceof Error && error.name === 'AbortError',
    );
    await delay(80);
    const unseen = await fetch(`${f.url}/api/intents/intent_delayed`);
    assert.equal(unseen.status, 404);
    assert.deepEqual(await unseen.json(), { intentId: 'intent_delayed', status: 'unseen' });
    controller.abort();
    await rejected;
    const committed = await waitForOutcome(f.url, 'intent_delayed');
    assert.equal(committed.status, 'confirmed');
    assert.deepEqual(await (await submit(f.url, 'intent_delayed')).json(), committed);
    assert.equal((await ledger(f.url)).effects.length, 1);
  } finally {
    await f.cleanup();
  }
});

test('same-intent HTTP concurrency replays one outcome while changed command returns conflict', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => submit(f.url, 'intent_shared')),
    );
    assert.ok(responses.every((response) => response.status === 200));
    const outcomes = await Promise.all(responses.map((response) => response.json()));
    assert.ok(outcomes.every((outcome) => JSON.stringify(outcome) === JSON.stringify(outcomes[0])));
    const conflict = await submit(f.url, 'intent_shared', 'none', {
      body: JSON.stringify({ offerId: 'workshop', quantity: 3 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'INTENT_CONFLICT');
    assert.equal((await ledger(f.url)).effects.length, 1);
    assert.equal((await ledger(f.url)).remainingCapacity, 10);
  } finally {
    await f.cleanup();
  }
});

test('a normal same-key retry can overtake a delayed request without producing a second effect', async () => {
  const f = await fixture();
  try {
    const delayed = submit(f.url, 'intent_overtaken', 'delay-before-commit');
    await delay(80);
    assert.equal((await fetch(`${f.url}/api/intents/intent_overtaken`)).status, 404);
    const recovered = await (await submit(f.url, 'intent_overtaken')).json();
    assert.deepEqual(await (await delayed).json(), recovered);
    assert.equal((await ledger(f.url)).effects.length, 1);
    assert.equal((await ledger(f.url)).remainingCapacity, 10);
  } finally {
    await f.cleanup();
  }
});

test('database write contention is transient uncertainty, never a retained capacity rejection', async () => {
  const f = await fixture();
  const locker = new DatabaseSync(f.database);
  try {
    locker.exec('BEGIN IMMEDIATE');
    const blocked = await submit(f.url, 'intent_busy');
    assert.equal(blocked.status, 503);
    const failure = await blocked.json();
    assert.equal(failure.error.code, 'TEMPORARY_UNAVAILABLE');
    assert.equal(failure.error.retryable, true);
    locker.exec('ROLLBACK');
    assert.equal((await fetch(`${f.url}/api/intents/intent_busy`)).status, 404);
    const retried = await submit(f.url, 'intent_busy');
    assert.equal(retried.status, 200);
    assert.equal((await retried.json()).status, 'confirmed');
    assert.equal((await ledger(f.url)).effects.length, 1);
  } finally {
    if (locker.isTransaction) locker.exec('ROLLBACK');
    locker.close();
    await f.cleanup();
  }
});

test('a post-commit fixture error returns transient uncertainty and retains the queryable outcome', async () => {
  const f = await fixture({
    checkpoint(phase) {
      if (phase === 'after-commit') throw new Error('private path or SQL must not leak');
    },
  });
  try {
    const failed = await submit(f.url, 'intent_hook_error');
    assert.equal(failed.status, 503);
    const error = await failed.json();
    assert.equal(error.error.retryable, true);
    assert.doesNotMatch(error.error.message, /private path|SQL/);
    const known = await (await fetch(`${f.url}/api/intents/intent_hook_error`)).json();
    assert.equal(known.status, 'confirmed');
    assert.deepEqual(await (await submit(f.url, 'intent_hook_error')).json(), known);
  } finally {
    await f.cleanup();
  }
});

test('local HTTP boundary rejects foreign Host/Origin, invalid bodies, unknown faults and duplicate key headers', async () => {
  const f = await fixture();
  try {
    const foreignHost = await new Promise<number>((resolveStatus, reject) => {
      const request = httpRequest(
        `${f.url}/api/ledger`,
        { headers: { Host: 'attacker.example' } },
        (response) => {
          response.resume();
          response.once('end', () => resolveStatus(response.statusCode!));
        },
      );
      request.once('error', reject);
      request.end();
    });
    assert.equal(foreignHost, 403);
    assert.equal(
      (
        await submit(f.url, 'intent_origin', 'none', {
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': 'intent_origin',
            Origin: 'https://attacker.example',
          },
        })
      ).status,
      403,
    );
    assert.equal((await submit(f.url, 'intent_invalid', 'other')).status, 400);
    for (const body of ['{', 'null', '[]', JSON.stringify({ ...command, extra: true })]) {
      assert.equal((await submit(f.url, 'intent_bad_body', 'none', { body })).status, 400);
    }
    assert.equal(
      (await submit(f.url, 'intent_oversize', 'none', { body: ' '.repeat(MAX_BODY_BYTES + 1) }))
        .status,
      413,
    );
    const duplicateStatus = await new Promise<number>((resolveStatus, reject) => {
      const request = httpRequest(
        `${f.url}/api/reservations`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': ['intent_duplicate', 'intent_duplicate'],
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolveStatus(response.statusCode!));
        },
      );
      request.once('error', reject);
      request.end(JSON.stringify(command));
    });
    assert.equal(duplicateStatus, 400);
    const response = await fetch(`${f.url}/api/ledger`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).intents.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('shutdown drains accepted delayed work before closing SQLite and is idempotent', async () => {
  const f = await fixture();
  try {
    const pending = submit(f.url, 'intent_shutdown', 'delay-before-commit').then(
      () => undefined,
      () => undefined,
    );
    await delay(80);
    const started = performance.now();
    await Promise.all([f.close(), f.close()]);
    await pending;
    assert.ok(performance.now() - started < DELAY_BEFORE_COMMIT_MS + 2_000);
    const reopened = new ReservationStore(f.database);
    try {
      assert.equal(reopened.lookup('intent_shutdown')?.status, 'confirmed');
    } finally {
      reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('shutdown closes an incomplete request body within the grace bound', async () => {
  const f = await fixture();
  const url = new URL(f.url);
  const socket = connect(Number(url.port), '127.0.0.1');
  socket.on('error', () => undefined);
  try {
    await new Promise<void>((resolveConnected) => socket.once('connect', resolveConnected));
    socket.write(
      `POST /api/reservations HTTP/1.1\r\nHost: ${url.host}\r\nIdempotency-Key: intent_partial\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
    );
    await delay(30);
    const start = performance.now();
    await f.close();
    assert.ok(performance.now() - start < 2_500);
  } finally {
    socket.destroy();
    await f.cleanup();
  }
});

test('listener startup failure closes its SQLite connection', async () => {
  const f = await fixture();
  const failedDatabase = join(f.directory, 'failed-start.sqlite');
  try {
    await assert.rejects(
      startServer({ databasePath: failedDatabase, port: Number(new URL(f.url).port) }),
      { code: 'EADDRINUSE' },
    );
    // Windows refuses removal of an open SQLite file; reopening and cleaning the
    // directory also exercises the startup rollback on both supported platforms.
    const reopened = new ReservationStore(failedDatabase);
    try {
      assert.equal(reopened.ledger().remainingCapacity, 12);
    } finally {
      reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('static serving stays inside its configured public directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'intent-server-static-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(staticRoot);
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Synthetic lab</title>');
  writeFileSync(join(directory, 'outside.html'), 'must not be served');
  const f = await fixture({ staticRoot });
  try {
    const index = await fetch(f.url);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Synthetic lab/);
    assert.equal((await fetch(`${f.url}/%2e%2e%2foutside.html`)).status, 404);
    assert.equal((await fetch(`${f.url}/.env`)).status, 404);
    assert.equal((await fetch(`${f.url}/api/unknown`)).status, 404);
  } finally {
    await f.cleanup();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}intent-server-static-`));
    rmSync(directory, { recursive: true, force: true });
  }
});
