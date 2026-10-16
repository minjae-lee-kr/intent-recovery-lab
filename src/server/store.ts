import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INITIAL_CAPACITY, OFFER_ID, isCommand, isIntentId } from '../protocol.ts';
import type { Effect, LedgerView, Outcome, ReservationCommand } from '../protocol.ts';

export type CheckpointPhase = 'before-commit' | 'after-commit';
export interface CheckpointInfo {
  readonly intentId: string;
  readonly outcome: Readonly<Outcome>;
}
/** Synchronous fixture hook. Never await or perform asynchronous work inside it. */
export type Checkpoint = (phase: CheckpointPhase, info: CheckpointInfo) => void;
export const DATABASE_BUSY_TIMEOUT_MS = 2_000;

export class IntentConflict extends Error {
  constructor() {
    super('This intent already belongs to a different command.');
  }
}
export class InvalidReservation extends Error {
  constructor() {
    super('Use a valid intent ID and a workshop quantity from one to three.');
  }
}
export class InjectedDropBeforeCommit extends Error {
  constructor() {
    super('Synthetic response drop with tentative writes rolled back.');
  }
}

// The canonical command is deliberately narrow: no optional defaults, timestamps,
// client metadata or JSON property order participate in command identity.
export function commandHash(command: ReservationCommand): string {
  return createHash('sha256')
    .update(JSON.stringify({ offerId: command.offerId, quantity: command.quantity }))
    .digest('hex');
}

type Row = Record<string, string | number | bigint | Uint8Array | null>;
function outcomeFrom(row: Row): Outcome {
  return {
    intentId: String(row.intent_id),
    command: { offerId: OFFER_ID, quantity: Number(row.quantity) },
    commandHash: String(row.command_hash),
    status: row.status as Outcome['status'],
    receiptId: row.receipt_id as string | null,
    reason: row.reason as Outcome['reason'],
    journalSequence: Number(row.journal_sequence),
  };
}

/** One synchronous SQLite connection. The database file is shared by cooperating processes. */
export class ReservationStore {
  private readonly db: DatabaseSync;
  private readonly checkpoint: Checkpoint | undefined;

  constructor(databasePath: string, checkpoint?: Checkpoint) {
    if (!databasePath) throw new Error('An explicit database path is required.');
    if (databasePath !== ':memory:') mkdirSync(dirname(resolve(databasePath)), { recursive: true });
    this.checkpoint = checkpoint;
    this.db = new DatabaseSync(databasePath, {
      timeout: DATABASE_BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
    });
    try {
      // DELETE journal + FULL synchronization make the tested durability model explicit.
      // This is process-crash recovery, not a claim about arbitrary disks or power failures.
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS offers (
            offer_id TEXT PRIMARY KEY CHECK (offer_id = 'workshop'),
            initial_capacity INTEGER NOT NULL CHECK (initial_capacity = 12),
            remaining_capacity INTEGER NOT NULL CHECK (remaining_capacity BETWEEN 0 AND initial_capacity)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS intents (
            journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            intent_id TEXT NOT NULL UNIQUE,
            command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
            offer_id TEXT NOT NULL REFERENCES offers(offer_id),
            quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 3),
            status TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected')),
            receipt_id TEXT UNIQUE REFERENCES effects(receipt_id) DEFERRABLE INITIALLY DEFERRED,
            reason TEXT,
            UNIQUE (intent_id, receipt_id, offer_id, quantity),
            CHECK ((status = 'confirmed' AND receipt_id IS NOT NULL AND reason IS NULL)
              OR (status = 'rejected' AND receipt_id IS NULL AND reason IS 'capacity-unavailable'))
          ) STRICT;
          CREATE TABLE IF NOT EXISTS effects (
            receipt_id TEXT PRIMARY KEY,
            intent_id TEXT NOT NULL UNIQUE,
            offer_id TEXT NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 3),
            FOREIGN KEY (intent_id, receipt_id, offer_id, quantity)
              REFERENCES intents(intent_id, receipt_id, offer_id, quantity)
          ) STRICT;
          CREATE TRIGGER IF NOT EXISTS intents_no_update BEFORE UPDATE ON intents
            BEGIN SELECT RAISE(ABORT, 'Intent outcomes are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS intents_no_delete BEFORE DELETE ON intents
            BEGIN SELECT RAISE(ABORT, 'Intent history is retained'); END;
          CREATE TRIGGER IF NOT EXISTS effects_no_update BEFORE UPDATE ON effects
            BEGIN SELECT RAISE(ABORT, 'Reservation effects are immutable'); END;
          CREATE TRIGGER IF NOT EXISTS effects_no_delete BEFORE DELETE ON effects
            BEGIN SELECT RAISE(ABORT, 'Reservation effects are retained'); END;
          PRAGMA user_version = 1;
        `);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO offers (offer_id, initial_capacity, remaining_capacity) VALUES (?, ?, ?)',
          )
          .run(OFFER_ID, INITIAL_CAPACITY, INITIAL_CAPACITY);
        this.db.exec('COMMIT');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  reserve(
    intentId: string,
    input: ReservationCommand,
    options: { rollbackBeforeCommit?: boolean } = {},
  ): Outcome {
    if (!isIntentId(intentId) || !isCommand(input)) throw new InvalidReservation();
    const command: ReservationCommand = { offerId: input.offerId, quantity: input.quantity };
    const hash = commandHash(command);
    let outcome: Outcome;
    // Admission happens before reading the idempotency record or capacity. SQLite
    // serializes writers across processes; no await can interleave on this connection.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM intents WHERE intent_id = ?').get(intentId);
      if (existing) {
        outcome = outcomeFrom(existing);
        if (
          outcome.commandHash !== hash ||
          outcome.command.quantity !== command.quantity ||
          existing.offer_id !== command.offerId
        )
          throw new IntentConflict();
        this.db.exec('COMMIT');
        return outcome;
      }
      const capacity = this.db
        .prepare('SELECT remaining_capacity FROM offers WHERE offer_id = ?')
        .get(command.offerId);
      if (!capacity) throw new Error('The configured offer is absent.');
      const confirmed = Number(capacity.remaining_capacity) >= command.quantity;
      const receiptId = confirmed ? `receipt_${randomUUID()}` : null;
      const insert = this.db
        .prepare(
          `INSERT INTO intents
        (intent_id, command_hash, offer_id, quantity, status, receipt_id, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intentId,
          hash,
          command.offerId,
          command.quantity,
          confirmed ? 'confirmed' : 'rejected',
          receiptId,
          confirmed ? null : 'capacity-unavailable',
        );
      if (confirmed) {
        const changed = this.db
          .prepare(
            `UPDATE offers SET remaining_capacity = remaining_capacity - ?
          WHERE offer_id = ? AND remaining_capacity >= ?`,
          )
          .run(command.quantity, command.offerId, command.quantity);
        if (changed.changes !== 1)
          throw new Error('Capacity changed during the writer transaction.');
        this.db
          .prepare(
            'INSERT INTO effects (receipt_id, intent_id, offer_id, quantity) VALUES (?, ?, ?, ?)',
          )
          .run(receiptId, intentId, command.offerId, command.quantity);
      }
      outcome = {
        intentId,
        command,
        commandHash: hash,
        status: confirmed ? 'confirmed' : 'rejected',
        receiptId,
        reason: confirmed ? null : 'capacity-unavailable',
        journalSequence: Number(insert.lastInsertRowid),
      };
      this.notify('before-commit', outcome);
      if (options.rollbackBeforeCommit) throw new InjectedDropBeforeCommit();
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    // Outside the rollback block: a failing observer cannot turn a committed outcome
    // into a rolled-back one. The HTTP layer reports uncertainty, never rejection.
    this.notify('after-commit', outcome);
    return outcome;
  }

  private notify(phase: CheckpointPhase, outcome: Outcome): void {
    this.checkpoint?.(
      phase,
      Object.freeze({
        intentId: outcome.intentId,
        outcome: Object.freeze({ ...outcome, command: Object.freeze({ ...outcome.command }) }),
      }),
    );
  }

  lookup(intentId: string): Outcome | undefined {
    if (!isIntentId(intentId)) throw new InvalidReservation();
    const row = this.db.prepare('SELECT * FROM intents WHERE intent_id = ?').get(intentId);
    return row ? outcomeFrom(row) : undefined;
  }

  ledger(): LedgerView {
    // Multiple SELECTs share one read snapshot even if another process commits.
    this.db.exec('BEGIN');
    try {
      const capacity = this.db
        .prepare('SELECT initial_capacity, remaining_capacity FROM offers WHERE offer_id = ?')
        .get(OFFER_ID);
      if (!capacity) throw new Error('The configured offer is absent.');
      const effects = this.db
        .prepare(
          'SELECT receipt_id, intent_id, offer_id, quantity FROM effects ORDER BY receipt_id',
        )
        .all()
        .map(
          (row) =>
            ({
              receiptId: String(row.receipt_id),
              intentId: String(row.intent_id),
              offerId: OFFER_ID,
              quantity: Number(row.quantity),
            }) satisfies Effect,
        );
      const intents = this.db
        .prepare('SELECT * FROM intents ORDER BY journal_sequence')
        .all()
        .map(outcomeFrom);
      this.db.exec('COMMIT');
      return {
        initialCapacity: Number(capacity.initial_capacity),
        remainingCapacity: Number(capacity.remaining_capacity),
        effects,
        intents,
      };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
