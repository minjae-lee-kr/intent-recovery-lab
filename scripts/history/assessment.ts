import { checkHistory } from './checker.ts';
import { prepare } from './prepare.ts';
import type { History } from './types.ts';
export function coverage(history: History): { complete: boolean; checks: Record<string, boolean> } {
  const prepared = prepare(history);
  if ('status' in prepared) return { complete: false, checks: { usableClosedHistory: false } };
  const ops = prepared.operations;
  const writes = ops.filter((o) => o.call.input.kind === 'reserve');
  const known = writes.filter((o) => o.output.kind !== 'unknown');
  const final = ops.at(-1)!.output;
  const named = (id: string) => ops.find((o) => o.call.attemptId === id);
  const late = named('late');
  const early = named('early-read');
  const anchor = named('anchor');
  const anchorRead = named('anchor-read');
  const checks = {
    bothWritersObserved: new Set(writes.map((o) => o.call.target)).size === 2,
    overlappingKnownWritesAcrossWriters: known.some((a) =>
      known.some(
        (b) =>
          a.call.target !== b.call.target &&
          a.call.sequence < b.observation.sequence &&
          b.call.sequence < a.observation.sequence,
      ),
    ),
    sameKeyRetry: writes.some(
      (a) =>
        a.output.kind === 'outcome' &&
        writes.some(
          (b) =>
            a !== b &&
            b.output.kind === 'outcome' &&
            a.call.input.kind === 'reserve' &&
            b.call.input.kind === 'reserve' &&
            a.call.input.key === b.call.input.key &&
            a.call.input.quantity === b.call.input.quantity,
        ),
    ),
    changedCommandConflict: writes.some((o) => o.output.kind === 'conflict'),
    capacityRejection: writes.some(
      (o) => o.output.kind === 'outcome' && o.output.outcome.status === 'rejected',
    ),
    twoUnknownWrites: writes.filter((o) => o.output.kind === 'unknown').length === 2,
    earlyUnseen:
      late?.call.input.kind === 'reserve' &&
      late.output.kind === 'unknown' &&
      early?.call.input.kind === 'lookup' &&
      early.call.input.key === late.call.input.key &&
      early.output.kind === 'unseen' &&
      late.observation.sequence < early.call.sequence,
    bothUnknownIntentsRetained:
      final.kind === 'snapshot' &&
      ['late', 'lost'].every((id) => {
        const write = named(id);
        return (
          write?.call.input.kind === 'reserve' &&
          write.output.kind === 'unknown' &&
          final.outcomes.some(
            (o) =>
              write.call.input.kind === 'reserve' &&
              o.intentId === write.call.input.key &&
              o.command.quantity === write.call.input.quantity &&
              o.status === 'confirmed',
          )
        );
      }),
    acknowledgedReadAnchor:
      anchor?.call.input.kind === 'reserve' &&
      anchor.output.kind === 'outcome' &&
      anchor.output.outcome.status === 'confirmed' &&
      anchorRead?.call.input.kind === 'lookup' &&
      anchorRead.call.input.key === anchor.call.input.key &&
      anchorRead.output.kind === 'outcome' &&
      anchor.observation.sequence < anchorRead.call.sequence,
  };
  return { complete: Object.values(checks).every(Boolean), checks };
}
export function staleReadControl(original: History) {
  if (
    checkHistory(original).status !== 'witness' ||
    !coverage(original).checks.acknowledgedReadAnchor
  )
    return {
      established: false,
      reason:
        'A witnessed baseline and a matching acknowledged reservation/read pair are required.',
    };
  const history = structuredClone(original);
  const call = history.events.find((e) => e.kind === 'invoke' && e.attemptId === 'anchor-read');
  const response = history.events.find((e) => e.kind === 'http' && e.attemptId === 'anchor-read');
  if (
    call?.kind !== 'invoke' ||
    call.input.kind !== 'lookup' ||
    response?.kind !== 'http' ||
    response.status !== 200
  )
    return { established: false, reason: 'No acknowledged anchor read available for the control.' };
  response.status = 404;
  response.body = { intentId: call.input.key, status: 'unseen' };
  const originalLedger = original.events.find((e) => e.kind === 'http' && e.attemptId === 'final');
  const changedLedger = history.events.find((e) => e.kind === 'http' && e.attemptId === 'final');
  const finalLedgerUnchanged = JSON.stringify(originalLedger) === JSON.stringify(changedLedger);
  const verdict = checkHistory(history);
  return {
    established: finalLedgerUnchanged && verdict.status === 'counterexample',
    description:
      'Synthetic observer mutation: one acknowledged GET changed to unseen; the final ledger and every other event remain unchanged.',
    finalLedgerUnchanged,
    verdict,
    history,
  };
}
