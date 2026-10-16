import { createHash } from 'node:crypto';
import type {
  Event,
  History,
  Input,
  ObservedOutcome,
  Target,
} from '../../scripts/history/types.ts';
export function result(key: string, quantity = 1, sequence = 1, rejected = false): ObservedOutcome {
  return {
    intentId: key,
    command: { offerId: 'workshop', quantity },
    commandHash: createHash('sha256')
      .update(JSON.stringify({ offerId: 'workshop', quantity }))
      .digest('hex'),
    status: rejected ? 'rejected' : 'confirmed',
    receiptId: rejected ? null : `receipt-${key}`,
    reason: rejected ? 'capacity-unavailable' : null,
    journalSequence: sequence,
  };
}
export function ledger(outcomes: ObservedOutcome[]) {
  return {
    initialCapacity: 12,
    remainingCapacity:
      12 -
      outcomes.filter((o) => o.status === 'confirmed').reduce((n, o) => n + o.command.quantity, 0),
    intents: outcomes,
    effects: outcomes
      .filter((o) => o.status === 'confirmed')
      .map((o) => ({
        intentId: o.intentId,
        receiptId: o.receiptId!,
        offerId: 'workshop',
        quantity: o.command.quantity,
      })),
  };
}
type WithoutClock<T> = T extends Event ? Omit<T, 'sequence' | 'elapsedMs'> : never;
export function fixture() {
  const history: History = {
    schemaVersion: 1,
    modelVersion: 'reservation-history-v1',
    runId: 'fixture-run',
    seed: 1,
    plannedAttemptIds: [],
    writers: [
      { target: 'a', instanceId: 'fixture-a', pid: 101 },
      { target: 'b', instanceId: 'fixture-b', pid: 102 },
    ],
    events: [],
  };
  const add = (event: WithoutClock<Event>) => {
    history.events.push({
      ...event,
      sequence: history.events.length + 1,
      elapsedMs: history.events.length,
    } as Event);
  };
  return {
    history,
    invoke(id: string, input: Input, target: Target = 'a') {
      history.plannedAttemptIds.push(id);
      add({ kind: 'invoke', attemptId: id, target, input, fault: 'none' });
    },
    http(id: string, status: number, body: unknown) {
      add({ kind: 'http', attemptId: id, status, body });
    },
    unknown(id: string) {
      add({ kind: 'unknown', attemptId: id, error: 'TimeoutError' });
    },
    finish(outcomes: ObservedOutcome[]): History {
      for (const w of history.writers) {
        add({ kind: 'drained', ...w, runId: history.runId });
        add({ kind: 'exited', ...w, runId: history.runId });
      }
      add({ kind: 'fence' });
      this.invoke('final', { kind: 'snapshot' }, 'reader');
      this.http('final', 200, ledger(outcomes));
      return history;
    },
  };
}
export const conflict = {
  error: {
    code: 'INTENT_CONFLICT',
    message: 'The key already has a different command.',
    retryable: false,
  },
};
export function lateHistory(): History {
  const f = fixture();
  const value = result('purchase-late');
  f.invoke('write', { kind: 'reserve', key: value.intentId, quantity: 1 });
  f.unknown('write');
  f.invoke('early', { kind: 'lookup', key: value.intentId }, 'b');
  f.http('early', 404, { intentId: value.intentId, status: 'unseen' });
  f.invoke('late', { kind: 'lookup', key: value.intentId }, 'b');
  f.http('late', 200, value);
  return f.finish([value]);
}

// Deliberately simple independent test oracle: enumerate all operation permutations and
// all optional-write subsets, then evaluate a separate compact sequential definition.
// Only hand fixtures <= 6 operations belong here; it does not import prepare/spec/search.
export function permutationOracle(history: History): boolean {
  const calls = history.events.filter((e) => e.kind === 'invoke');
  if (calls.length > 6) throw new Error('Tiny oracle only.');
  const operations = calls.map((call) => ({
    call,
    end: history.events.find(
      (e) => (e.kind === 'http' || e.kind === 'unknown') && e.attemptId === call.attemptId,
    )!,
  }));
  const unknown = (end: Event) =>
    end.kind === 'unknown' ||
    (end.kind === 'http' &&
      end.status === 503 &&
      (end.body as { error?: { code?: string } }).error?.code === 'TEMPORARY_UNAVAILABLE');
  const permutations = function* (items: number[]): Generator<number[]> {
    if (!items.length) {
      yield [];
      return;
    }
    for (const i of items)
      for (const rest of permutations(items.filter((j) => j !== i))) yield [i, ...rest];
  };
  for (const order of permutations(operations.map((_, i) => i))) {
    if (operations[order.at(-1)!]!.call.input.kind !== 'snapshot') continue;
    const pos = new Map(order.map((i, p) => [i, p]));
    if (
      operations.some((a, i) =>
        operations.some(
          (b, j) =>
            !unknown(a.end) && a.end.sequence < b.call.sequence && pos.get(i)! > pos.get(j)!,
        ),
      )
    )
      continue;
    const uncertain = operations.flatMap((o, i) => (unknown(o.end) ? [i] : []));
    for (let subset = 0; subset < 2 ** uncertain.length; subset++) {
      let remaining = 12;
      const records = new Map<string, { quantity: number; confirmed: boolean; receipt?: string }>();
      let legal = true;
      for (const i of order) {
        const { call, end } = operations[i]!;
        const input = call.input;
        if (unknown(end) && !(subset & (1 << uncertain.indexOf(i)))) continue;
        if (end.kind !== 'http' && end.kind !== 'unknown') throw new Error('Bad test fixture');
        const body =
          end.kind === 'http' && !unknown(end) ? (end.body as Record<string, unknown>) : undefined;
        const match = (key: string, observed: Record<string, unknown>) => {
          const saved = records.get(key);
          const cmd = observed.command as { quantity: number } | undefined;
          if (
            !saved ||
            cmd?.quantity !== saved.quantity ||
            observed.status !== (saved.confirmed ? 'confirmed' : 'rejected')
          )
            return false;
          if (!saved.confirmed) return observed.receiptId === null;
          if (saved.receipt !== undefined && saved.receipt !== observed.receiptId) return false;
          if (
            typeof observed.receiptId !== 'string' ||
            [...records].some(([other, row]) => other !== key && row.receipt === observed.receiptId)
          )
            return false;
          saved.receipt = observed.receiptId;
          return true;
        };
        if (input.kind === 'reserve') {
          const saved = records.get(input.key);
          if (saved && saved.quantity !== input.quantity) {
            if (!unknown(end) && end.kind === 'http' && end.status !== 409) legal = false;
          } else {
            if (!saved) {
              const yes = remaining >= input.quantity;
              records.set(input.key, { quantity: input.quantity, confirmed: yes });
              if (yes) remaining -= input.quantity;
            }
            if (body && (end.kind !== 'http' || end.status !== 200 || !match(input.key, body)))
              legal = false;
          }
        } else if (input.kind === 'lookup') {
          if (
            body &&
            (end.kind !== 'http' ||
              (end.status === 404
                ? records.has(input.key)
                : end.status !== 200 || !match(input.key, body)))
          )
            legal = false;
        } else {
          const rows = body?.intents as Record<string, unknown>[];
          if (
            !rows ||
            body?.remainingCapacity !== remaining ||
            rows.length !== records.size ||
            !rows.every((row) => match(String(row.intentId), row))
          )
            legal = false;
        }
        if (!legal) break;
      }
      if (legal) return true;
    }
  }
  return false;
}
