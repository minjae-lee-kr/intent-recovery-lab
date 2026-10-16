// Deliberately separate from the store: inspect observable records, not implementation branches.
import { createHash } from 'node:crypto';
import type { LedgerView, Outcome } from '../src/protocol.ts';

export interface LedgerCheck {
  ok: boolean;
  violations: string[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value);

export function checkLedger(value: unknown): LedgerCheck {
  const violations: string[] = [];
  const fail = (message: string) => {
    violations.push(message);
  };
  if (!object(value) || !Array.isArray(value.intents) || !Array.isArray(value.effects)) {
    return { ok: false, violations: ['ledger envelope is invalid'] };
  }
  if (value.initialCapacity !== 12)
    fail('initial capacity must match the fixed fixture capacity of 12');
  if (!integer(value.remainingCapacity) || value.remainingCapacity < 0)
    fail('remaining capacity is invalid');
  const intents = new Map<string, Record<string, unknown>>();
  const sequences = new Set<number>();
  for (const row of value.intents) {
    if (!object(row) || typeof row.intentId !== 'string' || !object(row.command)) {
      fail('intent record is invalid');
      continue;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(row.intentId))
      fail('intent identifier is invalid');
    if (intents.has(row.intentId)) fail(`duplicate intent: ${row.intentId}`);
    intents.set(row.intentId, row);
    if (
      !integer(row.journalSequence) ||
      row.journalSequence < 1 ||
      sequences.has(row.journalSequence)
    )
      fail(`invalid journal sequence: ${row.intentId}`);
    else sequences.add(row.journalSequence);
    if (
      Object.keys(row.command).length !== 2 ||
      row.command.offerId !== 'workshop' ||
      !integer(row.command.quantity) ||
      row.command.quantity < 1 ||
      row.command.quantity > 3
    )
      fail(`invalid command: ${row.intentId}`);
    const expectedHash = createHash('sha256')
      .update(JSON.stringify({ offerId: row.command.offerId, quantity: row.command.quantity }))
      .digest('hex');
    if (row.commandHash !== expectedHash) fail(`command digest mismatch: ${row.intentId}`);
    if (row.status === 'confirmed') {
      if (typeof row.receiptId !== 'string' || !row.receiptId || row.reason !== null)
        fail(`invalid confirmed outcome: ${row.intentId}`);
    } else if (row.status === 'rejected') {
      if (row.receiptId !== null || row.reason !== 'capacity-unavailable')
        fail(`invalid rejected outcome: ${row.intentId}`);
    } else fail(`nonterminal persisted outcome: ${row.intentId}`);
  }
  const receipts = new Set<string>();
  const effectsByIntent = new Map<string, number>();
  let consumed = 0;
  for (const effect of value.effects) {
    if (
      !object(effect) ||
      typeof effect.intentId !== 'string' ||
      typeof effect.receiptId !== 'string'
    ) {
      fail('effect record is invalid');
      continue;
    }
    if (receipts.has(effect.receiptId)) fail(`duplicate receipt: ${effect.receiptId}`);
    receipts.add(effect.receiptId);
    effectsByIntent.set(effect.intentId, (effectsByIntent.get(effect.intentId) ?? 0) + 1);
    if (!integer(effect.quantity) || effect.quantity < 1 || effect.quantity > 3)
      fail(`invalid effect quantity: ${effect.intentId}`);
    else consumed += effect.quantity;
    const intent = intents.get(effect.intentId);
    if (
      !intent ||
      !object(intent.command) ||
      intent.status !== 'confirmed' ||
      effect.offerId !== 'workshop' ||
      effect.offerId !== intent.command.offerId ||
      effect.quantity !== intent.command.quantity ||
      effect.receiptId !== intent.receiptId
    ) {
      fail(`effect is not coupled to a matching confirmed intent: ${effect.intentId}`);
    }
  }
  for (const [id, intent] of intents) {
    if ((effectsByIntent.get(id) ?? 0) !== (intent.status === 'confirmed' ? 1 : 0))
      fail(`effect cardinality mismatch: ${id}`);
  }
  // History is retained and writers serialize before deciding. Reconstructing the
  // decision order catches a plausible but unjustified "sold out" outcome that
  // conservation and foreign-key checks alone would accept.
  let available = 12;
  const ordered = [...intents.values()].sort(
    (a, b) => Number(a.journalSequence) - Number(b.journalSequence),
  );
  for (const intent of ordered) {
    if (
      !object(intent.command) ||
      !integer(intent.command.quantity) ||
      intent.command.quantity < 1 ||
      intent.command.quantity > 3
    )
      continue;
    if (intent.status === 'confirmed') {
      if (available < intent.command.quantity)
        fail(`confirmation exceeded available capacity: ${String(intent.intentId)}`);
      available -= intent.command.quantity;
    } else if (intent.status === 'rejected' && available >= intent.command.quantity) {
      fail(`capacity rejection was not justified: ${String(intent.intentId)}`);
    }
  }
  if (available !== value.remainingCapacity)
    fail('journal decisions do not reconstruct remaining capacity');
  if (
    integer(value.initialCapacity) &&
    integer(value.remainingCapacity) &&
    value.initialCapacity !== value.remainingCapacity + consumed
  )
    fail('capacity is not conserved');
  return { ok: violations.length === 0, violations };
}

function canonicalOutcome(outcome: Outcome): string {
  return JSON.stringify([
    outcome.intentId,
    outcome.command.offerId,
    outcome.command.quantity,
    outcome.commandHash,
    outcome.status,
    outcome.receiptId,
    outcome.reason,
    outcome.journalSequence,
  ]);
}

export function checkRetention(before: LedgerView, after: LedgerView): LedgerCheck {
  const violations = [...checkLedger(before).violations, ...checkLedger(after).violations];
  if (violations.length > 0) return { ok: false, violations };
  const current = new Map(after.intents.map((intent) => [intent.intentId, intent]));
  for (const intent of before.intents) {
    const retained = current.get(intent.intentId);
    if (!retained || canonicalOutcome(retained) !== canonicalOutcome(intent))
      violations.push(`committed outcome changed or disappeared: ${intent.intentId}`);
  }
  if (before.initialCapacity !== after.initialCapacity) violations.push('initial capacity changed');
  return { ok: violations.length === 0, violations };
}
