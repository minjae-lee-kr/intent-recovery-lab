import { prepare } from './prepare.ts';
import { initial, step } from './spec.ts';
import type { WitnessStep } from './types.ts';

// Separate witness verifier: no search cache, search eligibility masks or search decisions.
export function replayWitness(history: unknown, witness: unknown): { ok: boolean; reason: string } {
  const prepared = prepare(history);
  if ('status' in prepared) return { ok: false, reason: prepared.reason };
  if (!Array.isArray(witness) || witness.length !== prepared.operations.length)
    return { ok: false, reason: 'Witness must account for every operation.' };
  const byId = new Map(prepared.operations.map((op) => [op.call.attemptId, op]));
  const positions = new Map<string, number>();
  for (const [index, item] of witness.entries()) {
    if (
      !item ||
      typeof item !== 'object' ||
      !byId.has(item.attemptId) ||
      positions.has(item.attemptId) ||
      !['apply', 'omit'].includes(item.decision)
    )
      return { ok: false, reason: 'Malformed or duplicate witness operation.' };
    positions.set(item.attemptId, index);
  }
  for (const current of prepared.operations) {
    for (const before of prepared.operations) {
      if (
        before.output.kind !== 'unknown' &&
        before.observation.sequence < current.call.sequence &&
        positions.get(before.call.attemptId)! >= positions.get(current.call.attemptId)!
      )
        return { ok: false, reason: 'Witness violates response-before-invocation precedence.' };
    }
    if (
      current.call.input.kind === 'snapshot' &&
      positions.get(current.call.attemptId) !== witness.length - 1
    )
      return {
        ok: false,
        reason: 'Final snapshot must follow every applied or omitted pending operation.',
      };
  }
  let state = initial();
  for (const item of witness as WitnessStep[]) {
    const next = step(state, byId.get(item.attemptId)!, item.decision);
    if (!next) return { ok: false, reason: `Illegal sequential step: ${item.attemptId}.` };
    state = next;
  }
  return {
    ok: true,
    reason: 'Witness independently replayed against the sequential specification.',
  };
}
