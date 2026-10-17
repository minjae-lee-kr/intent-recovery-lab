const scenarios = new Set([
  'retained-positive',
  'naive-expired',
  'guarded-postcommit',
  'guarded-precommit',
  'guarded-delayed-arrival',
]);
const phases = new Set([
  'setup',
  'launch',
  'control',
  'fetch',
  'body',
  'assertion',
  'restart',
  'audit',
  'cleanup',
]);
const codes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOENT',
  'EACCES',
  'ABORT_ERR',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const signals = new Set(['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGABRT', 'SIGSEGV']);

function code(error) {
  for (const value of [error?.code, error?.cause?.code]) if (codes.has(value)) return value;
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.name === 'AbortError') return 'ABORTED';
  return 'OTHER';
}

function snapshot(error, state) {
  const request = state.request;
  return Object.freeze({
    scenario: scenarios.has(state.scenario) ? state.scenario : null,
    phase: phases.has(state.phase) ? state.phase : 'setup',
    request:
      request && ['execute', 'reconcile'].includes(request.action)
        ? Object.freeze({
            ordinal:
              Number.isSafeInteger(request.ordinal) && request.ordinal > 0 ? request.ordinal : null,
            action: request.action,
            status:
              Number.isInteger(request.status) && request.status >= 100 && request.status <= 599
                ? request.status
                : null,
          })
        : null,
    code: code(error),
    workers: Object.freeze(
      (state.workers ?? []).slice(0, 3).map((worker) =>
        Object.freeze({
          instance:
            Number.isSafeInteger(worker.instance) && worker.instance > 0 ? worker.instance : null,
          role: ['local', 'downstream'].includes(worker.role) ? worker.role : 'unknown',
          readyObserved: worker.readyObserved === true,
          closeObserved: worker.closeObserved === true,
          ...(worker.closeObserved === true
            ? {
                code: Number.isSafeInteger(worker.code) ? worker.code : null,
                signal:
                  worker.signal === null
                    ? null
                    : signals.has(worker.signal)
                      ? worker.signal
                      : 'OTHER',
              }
            : {}),
        }),
      ),
    ),
  });
}

export class RetentionFixtureFailure extends Error {
  constructor(error, state) {
    super('The bounded fixture did not establish its expected result.');
    this.name = 'RetentionFixtureFailure';
    Object.defineProperty(this, 'context', { value: snapshot(error, state), enumerable: true });
  }
}

export function captureFailure(error, state) {
  return error instanceof RetentionFixtureFailure
    ? error
    : new RetentionFixtureFailure(error, state);
}

export function failureContext(error) {
  return error instanceof RetentionFixtureFailure ? error.context : undefined;
}
