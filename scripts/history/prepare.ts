// A public evidence boundary, separate from the application protocol validators.
import { createHash } from 'node:crypto';
import { checkLedger } from '../check-ledger.ts';
import { MODEL_VERSION } from './types.ts';
import type {
  History,
  Input,
  ObservedOutcome,
  Operation,
  Output,
  Prepared,
  Verdict,
} from './types.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const key = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).sort().join(',') === [...expected].sort().join(',');
function input(v: unknown): v is Input {
  if (!object(v)) return false;
  if (v.kind === 'snapshot') return keys(v, ['kind']);
  if (v.kind === 'lookup') return keys(v, ['kind', 'key']) && key(v.key);
  return (
    v.kind === 'reserve' &&
    keys(v, ['kind', 'key', 'quantity']) &&
    key(v.key) &&
    integer(v.quantity) &&
    v.quantity >= 1 &&
    v.quantity <= 3
  );
}
function outcome(v: unknown): v is ObservedOutcome {
  if (
    !object(v) ||
    !key(v.intentId) ||
    !object(v.command) ||
    !keys(v.command, ['offerId', 'quantity'])
  )
    return false;
  if (
    v.command.offerId !== 'workshop' ||
    !integer(v.command.quantity) ||
    v.command.quantity < 1 ||
    v.command.quantity > 3
  )
    return false;
  const digest = createHash('sha256')
    .update(JSON.stringify({ offerId: 'workshop', quantity: v.command.quantity }))
    .digest('hex');
  return (
    keys(v, [
      'intentId',
      'command',
      'commandHash',
      'status',
      'receiptId',
      'reason',
      'journalSequence',
    ]) &&
    v.commandHash === digest &&
    integer(v.journalSequence) &&
    v.journalSequence > 0 &&
    ((v.status === 'confirmed' && text(v.receiptId) && v.reason === null) ||
      (v.status === 'rejected' && v.receiptId === null && v.reason === 'capacity-unavailable'))
  );
}
function errorCode(v: unknown, code: string, retryable: boolean): boolean {
  return (
    object(v) &&
    keys(v, ['error']) &&
    object(v.error) &&
    keys(v.error, ['code', 'message', 'retryable']) &&
    v.error.code === code &&
    text(v.error.message) &&
    v.error.retryable === retryable
  );
}
const verdict = (status: Verdict['status'], reason: string): Verdict => ({
  status,
  reason,
  exploredStates: 0,
});
export function prepare(value: unknown): Prepared | Verdict {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.modelVersion !== MODEL_VERSION ||
    !text(value.runId) ||
    !integer(value.seed) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.plannedAttemptIds) ||
    !Array.isArray(value.writers)
  )
    return verdict('invalid', 'Invalid history envelope or unsupported model version.');
  if (value.events.length > 100 || value.plannedAttemptIds.length > 16)
    return verdict('inconclusive', 'History exceeds the bounded experiment size.');
  if (
    value.plannedAttemptIds.length < 1 ||
    !value.plannedAttemptIds.every(text) ||
    new Set(value.plannedAttemptIds).size !== value.plannedAttemptIds.length
  )
    return verdict('invalid', 'Attempt manifest must be nonempty and unique.');
  if (
    value.writers.length !== 2 ||
    !value.writers.every(
      (w) =>
        object(w) &&
        (w.target === 'a' || w.target === 'b') &&
        text(w.instanceId) &&
        integer(w.pid) &&
        w.pid > 0,
    )
  )
    return verdict('invalid', 'Exactly two identified writer processes are required.');
  const writers = value.writers as History['writers'];
  if (
    new Set(writers.map((w) => w.target)).size !== 2 ||
    new Set(writers.map((w) => w.instanceId)).size !== 2 ||
    new Set(writers.map((w) => w.pid)).size !== 2
  )
    return verdict('invalid', 'Writer identity must be distinct.');
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  const drained = new Set<string>();
  const exited = new Set<string>();
  let fence = 0;
  let stopStarted = false;
  let previousMs = 0;
  for (const [index, raw] of value.events.entries()) {
    if (
      !object(raw) ||
      raw.sequence !== index + 1 ||
      typeof raw.elapsedMs !== 'number' ||
      !Number.isFinite(raw.elapsedMs) ||
      raw.elapsedMs < previousMs
    )
      return verdict(
        'invalid',
        'Events require contiguous sequence numbers and monotone elapsed time.',
      );
    previousMs = raw.elapsedMs;
    if (raw.kind === 'invoke') {
      if (
        !text(raw.attemptId) ||
        calls.has(raw.attemptId) ||
        !value.plannedAttemptIds.includes(raw.attemptId) ||
        !input(raw.input) ||
        typeof raw.target !== 'string' ||
        !['a', 'b', 'reader'].includes(raw.target) ||
        typeof raw.fault !== 'string' ||
        !['none', 'drop-before-commit', 'drop-after-commit', 'delay-before-commit'].includes(
          raw.fault,
        )
      )
        return verdict('invalid', 'Invalid invocation or attempt identity.');
      if (raw.input.kind === 'snapshot') {
        if (!fence || raw.target !== 'reader' || raw.fault !== 'none')
          return verdict(
            'invalid',
            'Final snapshot must follow the drain fence on the fresh reader.',
          );
      } else if (stopStarted || fence || raw.target === 'reader')
        return verdict('invalid', 'Work was invoked after shutdown began or on the reader.');
      if (raw.input.kind !== 'reserve' && raw.fault !== 'none')
        return verdict('invalid', 'Only writes can carry a fault.');
      calls.set(raw.attemptId, index);
    } else if (raw.kind === 'http' || raw.kind === 'unknown') {
      if (!text(raw.attemptId) || !calls.has(raw.attemptId) || results.has(raw.attemptId))
        return verdict('invalid', 'Observer result has no unique prior invocation.');
      if (
        raw.kind === 'http'
          ? !integer(raw.status) || raw.status < 100 || raw.status > 599 || !('body' in raw)
          : !text(raw.error)
      )
        return verdict('invalid', 'Malformed observer result.');
      if (stopStarted && !fence)
        return verdict('invalid', 'Observers must settle before shutdown starts.');
      results.set(raw.attemptId, index);
    } else if (raw.kind === 'drained' || raw.kind === 'exited') {
      const w = writers.find((w) => w.target === raw.target);
      if (
        !w ||
        raw.runId !== value.runId ||
        raw.instanceId !== w.instanceId ||
        raw.pid !== w.pid ||
        fence
      )
        return verdict('invalid', 'Drain/exit evidence does not belong to this run and writer.');
      if (calls.size !== results.size)
        return verdict('invalid', 'Shutdown began before observer completion.');
      stopStarted = true;
      if (raw.kind === 'drained') {
        if (drained.has(w.target)) return verdict('invalid', 'Duplicate drain acknowledgement.');
        drained.add(w.target);
      } else {
        if (!drained.has(w.target) || exited.has(w.target))
          return verdict('invalid', 'Writer exit must follow its unique drain acknowledgement.');
        exited.add(w.target);
      }
    } else if (raw.kind === 'fence') {
      if (fence || drained.size !== 2 || exited.size !== 2)
        return verdict('invalid', 'Fence lacks both acknowledged drains and exits.');
      fence = raw.sequence as number;
    } else return verdict('invalid', 'Unknown event kind.');
  }
  if (!fence) return verdict('inconclusive', 'The two-writer drain fence was not established.');
  if (calls.size !== value.plannedAttemptIds.length || results.size !== calls.size)
    return verdict(
      'invalid',
      'The attempt manifest, invocations and observer results do not match.',
    );
  const history = value as unknown as History;
  const operations: Operation[] = [];
  for (const [id, index] of calls) {
    const call = history.events[index]!;
    const observation = history.events[results.get(id)!]!;
    if (call.kind !== 'invoke' || (observation.kind !== 'http' && observation.kind !== 'unknown'))
      return verdict('invalid', 'Event pairing failed.');
    const arg = call.input;
    let output: Output;
    if (
      observation.kind === 'unknown' ||
      (observation.status === 503 && errorCode(observation.body, 'TEMPORARY_UNAVAILABLE', true))
    )
      output = { kind: 'unknown' };
    else if (arg.kind === 'snapshot') {
      const body = observation.body;
      // Bound and validate the records before the older ledger check hashes fields.
      // A nested non-command is an observed protocol defect, not a recursive hash input.
      if (
        observation.status !== 200 ||
        !object(body) ||
        !Array.isArray(body.intents) ||
        !Array.isArray(body.effects) ||
        body.intents.length > 16 ||
        body.effects.length > 16 ||
        !body.intents.every(outcome)
      )
        return verdict(
          'counterexample',
          'Malformed or oversized terminal metadata in the observed ledger.',
        );
      if (!checkLedger(body).ok)
        return verdict('counterexample', 'The observed final ledger violates the ledger contract.');
      output = {
        kind: 'snapshot',
        remaining: body.remainingCapacity as number,
        outcomes: body.intents,
      };
    } else if (
      observation.status === 200 &&
      outcome(observation.body) &&
      observation.body.intentId === arg.key &&
      (arg.kind !== 'reserve' || observation.body.command.quantity === arg.quantity)
    )
      output = { kind: 'outcome', outcome: observation.body };
    else if (
      arg.kind === 'lookup' &&
      observation.status === 404 &&
      object(observation.body) &&
      keys(observation.body, ['intentId', 'status']) &&
      observation.body.intentId === arg.key &&
      observation.body.status === 'unseen'
    )
      output = { kind: 'unseen' };
    else if (
      arg.kind === 'reserve' &&
      observation.status === 409 &&
      errorCode(observation.body, 'INTENT_CONFLICT', false)
    )
      output = { kind: 'conflict' };
    else return verdict('counterexample', `Observed protocol violation for ${id}.`);
    operations.push({ call, observation, output });
  }
  const snapshots = operations.filter((op) => op.call.input.kind === 'snapshot');
  if (snapshots.length !== 1 || snapshots[0] !== operations.at(-1))
    return verdict(
      'invalid',
      'Exactly one final snapshot is required, after all other invocations.',
    );
  if (snapshots[0]!.output.kind === 'unknown')
    return verdict('inconclusive', 'Final snapshot was unavailable.');
  // Full metadata retention is checked separately from the semantic model's order search.
  const final = snapshots[0]!.output;
  if (final.kind !== 'snapshot') return verdict('invalid', 'Invalid snapshot classification.');
  const canonical = (o: ObservedOutcome) =>
    JSON.stringify([
      o.intentId,
      o.command.quantity,
      o.commandHash,
      o.status,
      o.receiptId,
      o.reason,
      o.journalSequence,
    ]);
  for (const op of operations)
    if (op.output.kind === 'outcome') {
      const observed = op.output.outcome;
      const retained = final.outcomes.find((o) => o.intentId === observed.intentId);
      if (!retained || canonical(observed) !== canonical(retained))
        return verdict(
          'counterexample',
          `Acknowledged outcome was changed or lost: ${op.call.attemptId}.`,
        );
    }
  if (
    operations.filter((op) => op.call.input.kind === 'reserve' && op.output.kind === 'unknown')
      .length > 2
  )
    return verdict('inconclusive', 'More than two unknown writes exceeds this experiment scope.');
  return { history, operations };
}
