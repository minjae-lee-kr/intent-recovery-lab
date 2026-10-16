import { performance } from 'node:perf_hooks';
import { prepare } from './prepare.ts';
import { initial, stateKey, step } from './spec.ts';
import type { State } from './spec.ts';
import { replayWitness } from './replay.ts';
import type { Verdict, WitnessStep } from './types.ts';

export function checkHistory(
  value: unknown,
  budget: { maxStates?: number; timeoutMs?: number } = {},
): Verdict {
  const maxStates = budget.maxStates ?? 100_000;
  const timeoutMs = budget.timeoutMs ?? 2_000;
  if (
    !Number.isSafeInteger(maxStates) ||
    maxStates < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  )
    return { status: 'invalid', reason: 'Invalid checker budget.', exploredStates: 0 };
  const prepared = prepare(value);
  if ('status' in prepared) return prepared;
  const { operations } = prepared;
  const all = (1 << operations.length) - 1;
  const predecessors = operations.map((op, i) =>
    operations.reduce(
      (mask, before, j) =>
        mask |
        (j !== i &&
        ((before.output.kind !== 'unknown' && before.observation.sequence < op.call.sequence) ||
          op.call.input.kind === 'snapshot')
          ? 1 << j
          : 0),
      0,
    ),
  );
  const seen = new Set<string>();
  const start = performance.now();
  let exploredStates = 0;
  let exhaustedBudget = false;
  function visit(done: number, state: State, path: WitnessStep[]): WitnessStep[] | undefined {
    if (exploredStates >= maxStates || performance.now() - start >= timeoutMs) {
      exhaustedBudget = true;
      return;
    }
    exploredStates++;
    if (done === all) return path;
    const memo = `${done}:${stateKey(state)}`;
    if (seen.has(memo)) return;
    seen.add(memo);
    for (const [i, op] of operations.entries()) {
      if (done & (1 << i) || (done & predecessors[i]!) !== predecessors[i]) continue;
      const choices: WitnessStep['decision'][] =
        op.output.kind === 'unknown' ? ['omit', 'apply'] : ['apply'];
      for (const decision of choices) {
        const next = step(state, op, decision);
        if (!next) continue;
        const found = visit(done | (1 << i), next, [
          ...path,
          { attemptId: op.call.attemptId, decision },
        ]);
        if (found) return found;
        if (exhaustedBudget) return;
      }
    }
  }
  const witness = visit(0, initial(), []);
  if (witness) {
    const replay = replayWitness(prepared.history, witness);
    if (!replay.ok)
      return {
        status: 'invalid',
        reason: `Checker witness failed independent replay: ${replay.reason}`,
        exploredStates,
      };
    return {
      status: 'witness',
      reason: 'A legal explanation exists for this finite observed semantic history.',
      exploredStates,
      witness,
    };
  }
  return exhaustedBudget
    ? {
        status: 'inconclusive',
        reason: 'Search budget expired; no consistency verdict was established.',
        exploredStates,
      }
    : {
        status: 'counterexample',
        reason: 'Exhaustive bounded search found no legal explanation for these observations.',
        exploredStates,
      };
}
