import { isCommand, isIntentId, isOutcome, OFFER_ID } from '../protocol.ts';
import type { Fault, LedgerView, Outcome, ReservationCommand } from '../protocol.ts';

export type Phase = 'idle' | 'sending' | 'unknown' | 'reconciling' | 'confirmed' | 'rejected';
export type Issue =
  | 'transport'
  | 'timeout'
  | 'stopped'
  | 'unseen'
  | 'invalid-response'
  | 'conflict'
  | 'server-unavailable'
  | 'request-refused'
  | 'context-missing'
  | 'context-corrupt'
  | 'storage-unavailable'
  | 'invalid-link'
  | 'restore-unpersisted';
export type EventName =
  | 'created'
  | 'submitted'
  | 'lookup'
  | 'confirmed'
  | 'rejected'
  | 'unknown'
  | 'unseen'
  | 'stopped'
  | 'timeout'
  | 'stale'
  | 'hint'
  | 'ignored-hint'
  | 'restored';
export interface TraceEntry {
  sequence: number;
  event: EventName;
  request: number | null;
}
export interface Context {
  readonly version: 1;
  readonly intentId: string;
  readonly command: Readonly<ReservationCommand>;
  readonly attempted: boolean;
}
export interface Snapshot {
  readonly phase: Phase;
  readonly intentId: string | null;
  readonly context: Context | null;
  readonly outcome: Outcome | null;
  readonly issue: Issue | null;
  readonly trace: readonly TraceEntry[];
}
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type Http = (path: string, init: RequestInit) => Promise<Response>;
export const CLIENT_TIMEOUT_MS = 450;
export const contextKey = (intentId: string) => `intent-recovery.context.v1.${intentId}`;
export function sameCommand(a: Readonly<ReservationCommand>, b: Readonly<ReservationCommand>) {
  return a.offerId === b.offerId && a.quantity === b.quantity;
}
function freezeContext(context: Context): Context {
  return Object.freeze({ ...context, command: Object.freeze({ ...context.command }) });
}
function parseContext(raw: string, intentId: string): Context | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      record.version !== 1 ||
      record.intentId !== intentId ||
      !isCommand(record.command) ||
      typeof record.attempted !== 'boolean'
    )
      return null;
    return freezeContext({
      version: 1,
      intentId,
      command: record.command,
      attempted: record.attempted,
    });
  } catch {
    return null;
  }
}
function freezeOutcome(outcome: Outcome): Outcome {
  return Object.freeze({ ...outcome, command: Object.freeze({ ...outcome.command }) });
}
export interface ClientOptions {
  storage: StoragePort;
  http: Http;
  intentId?: string | null;
  createId: () => string;
  onIntent: (id: string) => void;
  timeoutMs?: number;
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}

export function createClient(options: ClientOptions) {
  const timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Invalid request timeout');
  const schedule =
    options.schedule ??
    ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  let state: Snapshot = Object.freeze({
    phase: 'idle',
    intentId: null,
    context: null,
    outcome: null,
    issue: null,
    trace: [],
  });
  let requestSequence = 0;
  let eventSequence = 0;
  let active: { id: number; abort: AbortController; clear: () => void } | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<Snapshot>, event?: EventName, request: number | null = null) => {
    if (disposed) return;
    const trace = event
      ? Object.freeze(
          [
            ...(patch.trace ?? state.trace),
            Object.freeze({ sequence: ++eventSequence, event, request }),
          ].slice(-24),
        )
      : patch.trace
        ? Object.freeze([...patch.trace])
        : state.trace;
    state = Object.freeze({ ...state, ...patch, trace });
    for (const listener of listeners) listener();
  };
  const stopActive = () => {
    if (!active) return;
    const previous = active;
    active = null;
    previous.clear();
    previous.abort.abort();
  };
  const load = (intentId: string | null) => {
    stopActive();
    if (!intentId) {
      publish({
        phase: 'idle',
        intentId: null,
        context: null,
        outcome: null,
        issue: null,
        trace: [],
      });
      return;
    }
    if (!isIntentId(intentId)) {
      publish({
        phase: 'idle',
        intentId: null,
        context: null,
        outcome: null,
        issue: 'invalid-link',
        trace: [],
      });
      return;
    }
    try {
      const raw = options.storage.getItem(contextKey(intentId));
      const context = raw === null ? null : parseContext(raw, intentId);
      publish({
        intentId,
        context,
        outcome: null,
        phase: context && !context.attempted ? 'idle' : 'unknown',
        issue: raw === null ? 'context-missing' : !context ? 'context-corrupt' : null,
        trace: [],
      });
    } catch {
      publish({
        intentId,
        context: null,
        outcome: null,
        phase: 'unknown',
        issue: 'storage-unavailable',
        trace: [],
      });
    }
  };
  const persist = (context: Context) => {
    options.storage.setItem(contextKey(context.intentId), JSON.stringify(context));
  };
  const createIntent = (quantity: number) => {
    if (disposed) return false;
    const command = { offerId: OFFER_ID, quantity };
    if (!isCommand(command)) return false;
    const intentId = options.createId();
    if (!isIntentId(intentId)) throw new TypeError('Invalid generated intent ID');
    const context = freezeContext({ version: 1, intentId, command, attempted: false });
    try {
      persist(context);
    } catch {
      publish({ issue: 'storage-unavailable' });
      return false;
    }
    stopActive();
    options.onIntent(intentId);
    publish({ phase: 'idle', intentId, context, outcome: null, issue: null, trace: [] }, 'created');
    return true;
  };
  const isCurrent = (id: number) => active?.id === id && !disposed;
  const finish = (id: number) => {
    if (!isCurrent(id)) {
      publish({}, 'stale', id);
      return false;
    }
    active!.clear();
    active = null;
    return true;
  };
  const uncertain = (id: number, issue: Issue) => {
    if (!finish(id)) return;
    // A terminal result is authoritative knowledge; later transport observations cannot undo it.
    publish(
      state.outcome ? {} : { phase: 'unknown', issue },
      issue === 'unseen' ? 'unseen' : 'unknown',
      id,
    );
  };
  const accept = (id: number, value: unknown, intentId: string, expected: Context | null) => {
    if (
      !isOutcome(value) ||
      value.intentId !== intentId ||
      (expected && !sameCommand(value.command, expected.command))
    ) {
      uncertain(id, 'invalid-response');
      return;
    }
    if (!finish(id)) return;
    const outcome = freezeOutcome(value);
    const context = freezeContext({
      version: 1,
      intentId,
      command: outcome.command,
      attempted: true,
    });
    let issue: Issue | null = null;
    try {
      persist(context);
    } catch {
      issue = 'restore-unpersisted';
    }
    publish({ phase: outcome.status, outcome, context, issue }, outcome.status, id);
    if (!expected) publish({}, 'restored', id);
  };
  const request = (kind: 'submit' | 'lookup', fault: Fault = 'none') => {
    if (disposed || !state.intentId || state.outcome) return;
    if (state.phase === 'sending' || state.phase === 'reconciling') return;
    const intentId = state.intentId;
    let context = state.context;
    if (kind === 'submit') {
      if (!context) return;
      context = freezeContext({ ...context, attempted: true });
      // No request may escape before its recovery identity and command are persisted.
      try {
        persist(context);
      } catch {
        publish({ issue: 'storage-unavailable' });
        return;
      }
    }
    const id = ++requestSequence;
    const abort = new AbortController();
    const clear = schedule(() => {
      if (!isCurrent(id)) return;
      active = null;
      abort.abort();
      publish({ phase: 'unknown', issue: 'timeout' }, 'timeout', id);
    }, timeoutMs);
    active = { id, abort, clear };
    publish(
      { phase: kind === 'submit' ? 'sending' : 'reconciling', context, issue: null },
      kind === 'submit' ? 'submitted' : 'lookup',
      id,
    );
    const path =
      kind === 'submit' ? '/api/reservations' : `/api/intents/${encodeURIComponent(intentId)}`;
    const init: RequestInit = {
      method: kind === 'submit' ? 'POST' : 'GET',
      signal: abort.signal,
      cache: 'no-store',
    };
    if (kind === 'submit') {
      init.headers = {
        'Content-Type': 'application/json',
        'Idempotency-Key': intentId,
        'X-Lab-Fault': fault,
      };
      init.body = JSON.stringify(context!.command);
    }
    void Promise.resolve()
      .then(() => options.http(path, init))
      .then(async (response) => {
        if (!isCurrent(id)) {
          publish({}, 'stale', id);
          return;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          uncertain(id, 'invalid-response');
          return;
        }
        if (response.status === 200) {
          accept(id, body, intentId, context);
          return;
        }
        if (
          kind === 'lookup' &&
          response.status === 404 &&
          body &&
          typeof body === 'object' &&
          (body as Record<string, unknown>).intentId === intentId &&
          (body as Record<string, unknown>).status === 'unseen'
        ) {
          uncertain(id, 'unseen');
          return;
        }
        uncertain(
          id,
          response.status === 409
            ? 'conflict'
            : response.status === 503
              ? 'server-unavailable'
              : response.status === 400
                ? 'request-refused'
                : 'invalid-response',
        );
      })
      .catch(() => {
        if (!isCurrent(id)) return;
        uncertain(id, 'transport');
      });
  };
  const stopWaiting = () => {
    if (!active) return;
    const id = active.id;
    stopActive();
    publish({ phase: 'unknown', issue: 'stopped' }, 'stopped', id);
  };
  const appReturn = (intentId: string) => {
    if (!state.intentId || intentId !== state.intentId || state.outcome) {
      publish({}, 'ignored-hint');
      return;
    }
    publish({}, 'hint');
    // The callback is a lookup hint, never an outcome or a mutation command.
    if (active) stopWaiting();
    request('lookup');
  };
  load(options.intentId ?? null);
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    createIntent,
    submit: (fault: Fault = 'none') => request('submit', fault),
    reconcile: () => request('lookup'),
    stopWaiting,
    appReturn,
    load,
    dispose: () => {
      stopActive();
      disposed = true;
      listeners.clear();
    },
  };
}
export type Client = ReturnType<typeof createClient>;

export function isLedger(value: unknown): value is LedgerView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.initialCapacity) &&
    Number(record.initialCapacity) >= 0 &&
    Number.isSafeInteger(record.remainingCapacity) &&
    Number(record.remainingCapacity) >= 0 &&
    Number(record.remainingCapacity) <= Number(record.initialCapacity) &&
    Array.isArray(record.intents) &&
    record.intents.every(isOutcome) &&
    Array.isArray(record.effects) &&
    record.effects.every((effect: unknown) => {
      if (!effect || typeof effect !== 'object') return false;
      const entry = effect as Record<string, unknown>;
      return (
        isIntentId(entry.intentId) &&
        typeof entry.receiptId === 'string' &&
        entry.receiptId.length > 0 &&
        entry.offerId === OFFER_ID &&
        Number.isSafeInteger(entry.quantity) &&
        Number(entry.quantity) >= 1 &&
        Number(entry.quantity) <= 3
      );
    })
  );
}
