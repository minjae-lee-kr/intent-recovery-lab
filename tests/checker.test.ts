import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkLedger, checkRetention } from '../scripts/check-ledger.ts';
import type { LedgerView } from '../src/protocol.ts';

function valid(): LedgerView {
  const command = { offerId: 'workshop' as const, quantity: 2 };
  return {
    initialCapacity: 12,
    remainingCapacity: 10,
    intents: [
      {
        intentId: 'intent-fixture',
        command,
        commandHash: createHash('sha256').update(JSON.stringify(command)).digest('hex'),
        status: 'confirmed',
        receiptId: 'receipt-one',
        reason: null,
        journalSequence: 1,
      },
    ],
    effects: [
      { intentId: 'intent-fixture', offerId: 'workshop', quantity: 2, receiptId: 'receipt-one' },
    ],
  };
}

test('independent checker accepts consistent records but catches each invariant mutation', () => {
  assert.equal(checkLedger(valid()).ok, true);
  const mutations: Array<(ledger: LedgerView) => void> = [
    (ledger) => {
      ledger.effects.push({ ...ledger.effects[0]!, receiptId: 'second-receipt' });
      ledger.remainingCapacity -= 2;
    },
    (ledger) => {
      ledger.effects = [];
      ledger.remainingCapacity = 12;
    },
    (ledger) => {
      ledger.intents = [];
    },
    (ledger) => {
      ledger.remainingCapacity = -1;
    },
    (ledger) => {
      ledger.remainingCapacity = 11;
    },
    (ledger) => {
      ledger.intents[0]!.commandHash = '0'.repeat(64);
    },
    (ledger) => {
      ledger.intents[0]!.status = 'rejected';
      ledger.intents[0]!.receiptId = null;
      ledger.intents[0]!.reason = 'capacity-unavailable';
    },
    (ledger) => {
      ledger.effects[0]!.quantity = 1;
      ledger.remainingCapacity = 11;
    },
    (ledger) => {
      ledger.intents.push({ ...ledger.intents[0]! });
    },
  ];
  for (const mutate of mutations) {
    const ledger = valid();
    mutate(ledger);
    assert.equal(checkLedger(ledger).ok, false);
  }
});

test('an individually consistent later snapshot must still preserve prior outcomes', () => {
  const first = valid();
  const later = valid();
  later.intents[0]!.receiptId = 'replacement';
  later.effects[0]!.receiptId = 'replacement';
  assert.equal(checkLedger(later).ok, true);
  assert.equal(checkRetention(first, later).ok, false);
  assert.equal(checkRetention(first, valid()).ok, true);
});

test('malformed ledger does not produce a clean result', () => {
  for (const value of [
    null,
    [],
    {},
    { intents: [], effects: [] },
    { initialCapacity: 12, remainingCapacity: 12, intents: [null], effects: [] },
  ]) {
    assert.equal(checkLedger(value).ok, false);
  }
  const malformed = { initialCapacity: 12, remainingCapacity: 12, intents: [null], effects: [] };
  assert.equal(checkRetention(valid(), malformed as unknown as LedgerView).ok, false);
});

test('checker rejects internally consistent records with invalid business decisions or input', () => {
  const unjustifiedRejection = valid();
  unjustifiedRejection.remainingCapacity = 12;
  unjustifiedRejection.effects = [];
  unjustifiedRejection.intents[0] = {
    ...unjustifiedRejection.intents[0]!,
    status: 'rejected',
    receiptId: null,
    reason: 'capacity-unavailable',
  };
  assert.ok(
    checkLedger(unjustifiedRejection).violations.some((value) => value.includes('not justified')),
  );
  assert.equal(
    checkLedger({ initialCapacity: 0, remainingCapacity: 0, effects: [], intents: [] }).ok,
    false,
  );
  const emptyId = valid();
  emptyId.intents[0]!.intentId = '';
  emptyId.effects[0]!.intentId = '';
  assert.equal(checkLedger(emptyId).ok, false);
  const extra = valid();
  Object.assign(extra.intents[0]!.command, { ignored: true });
  assert.equal(checkLedger(extra).ok, false);
});
