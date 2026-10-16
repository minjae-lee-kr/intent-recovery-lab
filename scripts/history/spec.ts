// Independent sequential reservation specification. No store or protocol implementation imports.
import type { ObservedOutcome, Operation, WitnessStep } from './types.ts';
export interface RecordValue {
  quantity: number;
  status: 'confirmed' | 'rejected';
  receipt: string | null | undefined;
}
export interface State {
  remaining: number;
  records: ReadonlyMap<string, RecordValue>;
}
export const initial = (): State => ({ remaining: 12, records: new Map() });
function observe(state: State, value: ObservedOutcome): State | undefined {
  const current = state.records.get(value.intentId);
  if (!current || current.quantity !== value.command.quantity || current.status !== value.status)
    return;
  if (current.status === 'rejected') return value.receiptId === null ? state : undefined;
  if (!value.receiptId || (current.receipt !== undefined && current.receipt !== value.receiptId))
    return;
  for (const [key, row] of state.records)
    if (key !== value.intentId && row.receipt === value.receiptId) return;
  const records = new Map(state.records);
  records.set(value.intentId, { ...current, receipt: value.receiptId });
  return { ...state, records };
}
export function step(
  state: State,
  op: Operation,
  decision: WitnessStep['decision'],
): State | undefined {
  const { input } = op.call;
  const output = op.output;
  if (decision === 'omit') return output.kind === 'unknown' ? state : undefined;
  if (input.kind === 'reserve') {
    const retained = state.records.get(input.key);
    if (retained && retained.quantity !== input.quantity)
      return output.kind === 'conflict' || output.kind === 'unknown' ? state : undefined;
    let next = state;
    if (!retained) {
      const confirmed = state.remaining >= input.quantity;
      const records = new Map(state.records);
      records.set(input.key, {
        quantity: input.quantity,
        status: confirmed ? 'confirmed' : 'rejected',
        receipt: confirmed ? undefined : null,
      });
      next = { remaining: state.remaining - (confirmed ? input.quantity : 0), records };
    }
    if (output.kind === 'unknown') return next;
    return output.kind === 'outcome' ? observe(next, output.outcome) : undefined;
  }
  if (input.kind === 'lookup') {
    if (output.kind === 'unknown') return state;
    if (output.kind === 'unseen') return state.records.has(input.key) ? undefined : state;
    return output.kind === 'outcome' ? observe(state, output.outcome) : undefined;
  }
  if (
    output.kind !== 'snapshot' ||
    state.remaining !== output.remaining ||
    state.records.size !== output.outcomes.length
  )
    return;
  let next: State | undefined = state;
  for (const row of output.outcomes) {
    next = observe(next, row);
    if (!next) return;
  }
  return next;
}
export function stateKey(state: State): string {
  return JSON.stringify([
    state.remaining,
    [...state.records]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, row]) => [
        key,
        row.quantity,
        row.status,
        row.receipt === undefined ? ['unbound'] : row.receipt,
      ]),
  ]);
}
