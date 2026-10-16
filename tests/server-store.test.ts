import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { ReservationCommand } from '../src/protocol.ts';
import {
  IntentConflict,
  InvalidReservation,
  ReservationStore,
  commandHash,
} from '../src/server/store.ts';

const command = { offerId: 'workshop', quantity: 2 } as const;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'intent-server-store-'));
  return {
    database: join(directory, 'ledger.sqlite'),
    cleanup() {
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}intent-server-store-`));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('retained intent returns exactly the durable semantic outcome across connection restart', () => {
  const f = fixture();
  let store = new ReservationStore(f.database);
  try {
    const first = store.reserve('intent_restart', command);
    assert.equal(first.status, 'confirmed');
    assert.deepEqual(store.reserve('intent_restart', { quantity: 2, offerId: 'workshop' }), first);
    store.close();
    store = new ReservationStore(f.database);
    assert.deepEqual(store.lookup('intent_restart'), first);
    assert.deepEqual(store.reserve('intent_restart', command), first);
    assert.equal(store.ledger().effects.length, 1);
    assert.equal(store.ledger().remainingCapacity, 10);
    assert.equal(first.commandHash, commandHash({ quantity: 2, offerId: 'workshop' }));
  } finally {
    store.close();
    f.cleanup();
  }
});

test('capacity rejection is a retained terminal outcome; replay and conflict do not mutate it', () => {
  const store = new ReservationStore(':memory:');
  try {
    for (let index = 0; index < 4; index++)
      store.reserve(`consume_${index}`, { offerId: 'workshop', quantity: 3 });
    const rejected = store.reserve('intent_rejected', command);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'capacity-unavailable');
    assert.equal(rejected.receiptId, null);
    const before = store.ledger();
    assert.equal(before.remainingCapacity, 0);
    assert.equal(before.effects.length, 4);
    assert.deepEqual(store.reserve('intent_rejected', command), rejected);
    assert.throws(
      () => store.reserve('intent_rejected', { offerId: 'workshop', quantity: 1 }),
      IntentConflict,
    );
    assert.deepEqual(store.ledger(), before);
  } finally {
    store.close();
  }
});

test('new key intentionally permits another effect for an otherwise identical command', () => {
  const store = new ReservationStore(':memory:');
  try {
    const first = store.reserve('intent_first', command);
    const second = store.reserve('intent_second', command);
    assert.notEqual(first.receiptId, second.receiptId);
    assert.equal(store.ledger().remainingCapacity, 8);
    assert.equal(store.ledger().effects.length, 2);
    assert.throws(
      () => store.reserve('intent_first', { offerId: 'workshop', quantity: 3 }),
      IntentConflict,
    );
    assert.deepEqual(store.lookup('intent_first'), first);
  } finally {
    store.close();
  }
});

test('before-commit hook sees complete tentative outcome but another connection sees old snapshot; throwing rolls all writes back', () => {
  const f = fixture();
  const phases: string[] = [];
  const store = new ReservationStore(f.database, (phase, info) => {
    phases.push(phase);
    assert.equal(info.outcome.status, 'confirmed');
    assert.ok(info.outcome.receiptId);
    const observer = new DatabaseSync(f.database, { readOnly: true });
    try {
      assert.equal(observer.prepare('SELECT count(*) AS count FROM intents').get()!.count, 0);
      assert.equal(observer.prepare('SELECT count(*) AS count FROM effects').get()!.count, 0);
      assert.equal(
        observer.prepare('SELECT remaining_capacity FROM offers').get()!.remaining_capacity,
        12,
      );
    } finally {
      observer.close();
    }
    throw new Error('fixture interrupts before commit');
  });
  try {
    assert.throws(() => store.reserve('intent_before', command), /fixture interrupts/);
    assert.deepEqual(phases, ['before-commit']);
    assert.deepEqual(store.ledger(), {
      initialCapacity: 12,
      remainingCapacity: 12,
      effects: [],
      intents: [],
    });
  } finally {
    store.close();
    f.cleanup();
  }
});

test('after-commit hook failure cannot roll back the outcome, and replay does not rerun commit hooks', () => {
  const f = fixture();
  const phases: string[] = [];
  let store = new ReservationStore(f.database, (phase) => {
    phases.push(phase);
    if (phase === 'after-commit') throw new Error('fixture interrupts after commit');
  });
  try {
    assert.throws(() => store.reserve('intent_after', command), /fixture interrupts/);
    assert.deepEqual(phases, ['before-commit', 'after-commit']);
    const committed = store.lookup('intent_after');
    assert.equal(committed?.status, 'confirmed');
    assert.deepEqual(store.reserve('intent_after', command), committed);
    assert.deepEqual(phases, ['before-commit', 'after-commit']);
    store.close();
    store = new ReservationStore(f.database);
    assert.deepEqual(store.lookup('intent_after'), committed);
    assert.equal(store.ledger().effects.length, 1);
  } finally {
    store.close();
    f.cleanup();
  }
});

test('invalid command or key never enters the ledger', () => {
  const store = new ReservationStore(':memory:');
  try {
    for (const value of [
      null,
      [],
      {},
      { offerId: 'workshop', quantity: 0 },
      { offerId: 'workshop', quantity: 1.5 },
      { offerId: 'workshop', quantity: 2, extra: true },
    ]) {
      assert.throws(
        () => store.reserve('intent_invalid', value as ReservationCommand),
        InvalidReservation,
      );
    }
    assert.throws(() => store.reserve('short', command), InvalidReservation);
    assert.equal(store.ledger().intents.length, 0);
  } finally {
    store.close();
  }
});

test('database constraints reject a confirmed outcome without its matching effect and protect retained rows', () => {
  const f = fixture();
  const store = new ReservationStore(f.database);
  store.reserve('intent_existing', command);
  store.close();
  const db = new DatabaseSync(f.database, { enableForeignKeyConstraints: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      `INSERT INTO intents (intent_id, command_hash, offer_id, quantity, status, receipt_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'intent_unpaired',
      commandHash(command),
      'workshop',
      2,
      'confirmed',
      'receipt_absent',
      null,
    );
    assert.throws(() => db.exec('COMMIT'), /FOREIGN KEY/);
    db.exec('ROLLBACK');
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO intents (intent_id, command_hash, offer_id, quantity, status, receipt_id, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('intent_bad_reason', commandHash(command), 'workshop', 2, 'rejected', null, null),
      /CHECK constraint/,
    );
    assert.throws(
      () =>
        db.prepare('UPDATE intents SET quantity = ? WHERE intent_id = ?').run(1, 'intent_existing'),
      /immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM effects WHERE intent_id = ?').run('intent_existing'),
      /retained/,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
    f.cleanup();
  }
});
