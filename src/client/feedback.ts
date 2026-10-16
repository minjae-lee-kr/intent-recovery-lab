import type { Snapshot } from './model.ts';

// A return to the same intent is still a new screen lifetime. Intent identity
// alone cannot tell whether a pending clipboard completion belongs to it.
export function createCopyFeedback(initialIntent: string | null) {
  let intentId = initialIntent;
  let intentRevision = 0;
  let sequence = 0;
  let current: Readonly<{ intentRevision: number; sequence: number }> | null = null;
  const observeIntent = (next: string | null) => {
    if (next === intentId) return false;
    intentId = next;
    ++intentRevision;
    current = null;
    return true;
  };
  return {
    observeIntent,
    begin(next: string | null) {
      observeIntent(next);
      current = Object.freeze({ intentRevision, sequence: ++sequence });
      return current;
    },
    isCurrent(token: NonNullable<typeof current>, next: string | null) {
      observeIntent(next);
      return token === current && token.intentRevision === intentRevision;
    },
    invalidate() {
      current = null;
    },
  };
}

export function visibleQuantity(
  state: Pick<Snapshot, 'intentId' | 'context'>,
  draftQuantity: number,
): number | null {
  return state.intentId ? (state.context?.command.quantity ?? null) : draftQuantity;
}
