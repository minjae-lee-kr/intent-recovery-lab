export const OFFER_ID = 'workshop' as const;
export const INITIAL_CAPACITY = 12;
export const FAULTS = [
  'none',
  'drop-before-commit',
  'drop-after-commit',
  'delay-before-commit',
] as const;
export type Fault = (typeof FAULTS)[number];
export interface ReservationCommand {
  offerId: typeof OFFER_ID;
  quantity: number;
}
export interface Outcome {
  intentId: string;
  command: ReservationCommand;
  commandHash: string;
  status: 'confirmed' | 'rejected';
  receiptId: string | null;
  reason: 'capacity-unavailable' | null;
  journalSequence: number;
}
export interface UnseenObservation {
  intentId: string;
  status: 'unseen';
}
export interface ApiError {
  error: { code: string; message: string; retryable: boolean };
}
export interface Effect {
  receiptId: string;
  intentId: string;
  offerId: typeof OFFER_ID;
  quantity: number;
}
export interface LedgerView {
  initialCapacity: number;
  remainingCapacity: number;
  effects: Effect[];
  intents: Outcome[];
}
export function isIntentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(value);
}
export function isCommand(value: unknown): value is ReservationCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 2 &&
    input.offerId === OFFER_ID &&
    Number.isSafeInteger(input.quantity) &&
    Number(input.quantity) >= 1 &&
    Number(input.quantity) <= 3
  );
}
export function isOutcome(value: unknown): value is Outcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    isIntentId(input.intentId) &&
    isCommand(input.command) &&
    typeof input.commandHash === 'string' &&
    /^[a-f0-9]{64}$/.test(input.commandHash) &&
    Number.isSafeInteger(input.journalSequence) &&
    Number(input.journalSequence) > 0 &&
    ((input.status === 'confirmed' &&
      typeof input.receiptId === 'string' &&
      input.receiptId.length > 0 &&
      input.reason === null) ||
      (input.status === 'rejected' &&
        input.receiptId === null &&
        input.reason === 'capacity-unavailable'))
  );
}
