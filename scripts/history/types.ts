export const MODEL_VERSION = 'reservation-history-v1' as const;
export type Target = 'a' | 'b' | 'reader';
export type Input =
  | { kind: 'reserve'; key: string; quantity: number }
  | { kind: 'lookup'; key: string }
  | { kind: 'snapshot' };
interface EventBase {
  sequence: number;
  elapsedMs: number;
}
export type Event =
  | (EventBase & { kind: 'invoke'; attemptId: string; target: Target; input: Input; fault: string })
  | (EventBase & { kind: 'http'; attemptId: string; status: number; body: unknown })
  | (EventBase & { kind: 'unknown'; attemptId: string; error: string })
  | (EventBase & {
      kind: 'drained' | 'exited';
      target: 'a' | 'b';
      runId: string;
      instanceId: string;
      pid: number;
    })
  | (EventBase & { kind: 'fence' });
export interface History {
  schemaVersion: 1;
  modelVersion: typeof MODEL_VERSION;
  runId: string;
  seed: number;
  plannedAttemptIds: string[];
  writers: Array<{ target: 'a' | 'b'; instanceId: string; pid: number }>;
  events: Event[];
}
export type Call = Extract<Event, { kind: 'invoke' }>;
export type ObserverResult = Extract<Event, { kind: 'http' | 'unknown' }>;
export interface ObservedOutcome {
  intentId: string;
  command: { offerId: 'workshop'; quantity: number };
  commandHash: string;
  status: 'confirmed' | 'rejected';
  receiptId: string | null;
  reason: 'capacity-unavailable' | null;
  journalSequence: number;
}
export type Output =
  | { kind: 'outcome'; outcome: ObservedOutcome }
  | { kind: 'unseen' }
  | { kind: 'conflict' }
  | { kind: 'unknown' }
  | { kind: 'snapshot'; remaining: number; outcomes: ObservedOutcome[] };
export interface Operation {
  call: Call;
  observation: ObserverResult;
  output: Output;
}
export interface WitnessStep {
  attemptId: string;
  decision: 'apply' | 'omit';
}
export interface Verdict {
  status: 'witness' | 'counterexample' | 'inconclusive' | 'invalid';
  reason: string;
  exploredStates: number;
  witness?: WitnessStep[];
}
export interface Prepared {
  history: History;
  operations: Operation[];
}
