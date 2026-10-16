import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { launchFixture } from '../tests/helpers/fixture-process.ts';
import { checkLedger, checkRetention } from './check-ledger.ts';
import { isOutcome } from '../src/protocol.ts';
import type { Fault, LedgerView, Outcome, ReservationCommand } from '../src/protocol.ts';

export type ScenarioId =
  | 'fresh-key'
  | 'same-intent'
  | 'late-commit'
  | 'conflicting-command'
  | 'crash-before'
  | 'crash-after'
  | 'two-processes';
export interface Observation {
  sequence: number;
  at: string;
  elapsedMs: number;
  kind: 'http' | 'transport-error' | 'process-checkpoint' | 'process-killed';
  request?: {
    method: string;
    path: string;
    intentId?: string;
    fault?: Fault;
    command?: ReservationCommand;
  };
  status?: number;
  body?: unknown;
  error?: { name: string; code?: string };
}
export interface Assertion {
  id: string;
  passed: boolean;
  actual: unknown;
  expected: unknown;
}
export interface ScenarioEvidence {
  id: ScenarioId;
  role: 'counterexample' | 'recovery';
  passed: boolean;
  observations: Observation[];
  checks: Assertion[];
}
type Fixture = Awaited<ReturnType<typeof launchFixture>>;
const command: ReservationCommand = { offerId: 'workshop', quantity: 1 };

class Recorder {
  readonly observations: Observation[] = [];
  readonly checks: Assertion[] = [];
  private readonly start = performance.now();
  add(value: Omit<Observation, 'sequence' | 'at' | 'elapsedMs'>): Observation {
    const record = {
      sequence: this.observations.length + 1,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - this.start),
      ...value,
    };
    this.observations.push(record);
    return record;
  }
  check(id: string, actual: unknown, expected: unknown): void {
    let passed = true;
    try {
      assert.deepEqual(actual, expected);
    } catch {
      passed = false;
    }
    this.checks.push({ id, passed, actual, expected });
  }
  async request(
    url: string,
    path: string,
    options: {
      intentId?: string;
      fault?: Fault;
      command?: ReservationCommand;
      timeoutMs?: number;
    } = {},
  ): Promise<Observation> {
    const method = options.command ? 'POST' : 'GET';
    const request = {
      method,
      path,
      ...(options.intentId ? { intentId: options.intentId } : {}),
      ...(options.fault ? { fault: options.fault } : {}),
      ...(options.command ? { command: options.command } : {}),
    };
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
        ...(options.command
          ? {
              headers: {
                'content-type': 'application/json',
                'Idempotency-Key': options.intentId!,
                ...(options.fault ? { 'X-Lab-Fault': options.fault } : {}),
              },
              body: JSON.stringify(options.command),
            }
          : {}),
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparseableJson: true };
      }
      return this.add({ kind: 'http', request, status: response.status, body });
    } catch (error) {
      // Portable classification only; absolute paths and platform diagnostics do not belong in a public report.
      const value = error as { name?: unknown; cause?: { code?: unknown } };
      return this.add({
        kind: 'transport-error',
        request,
        error: {
          name: typeof value.name === 'string' ? value.name : 'Error',
          ...(typeof value.cause?.code === 'string' ? { code: value.cause.code } : {}),
        },
      });
    }
  }
  post(url: string, intentId: string, fault: Fault = 'none', input = command, timeoutMs?: number) {
    return this.request(url, '/api/reservations', {
      intentId,
      command: input,
      fault,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }
  async ledger(url: string): Promise<LedgerView> {
    const record = await this.request(url, '/api/ledger');
    this.check('ledger-response', record.status, 200);
    const check = checkLedger(record.body);
    this.check('ledger-invariants', check, { ok: true, violations: [] });
    // A malformed response cannot safely support downstream assertions.
    assert.equal(record.status, 200);
    assert.equal(check.ok, true, check.violations.join('; '));
    return record.body as LedgerView;
  }
  outcome(record: Observation): Outcome {
    this.check('terminal-response', record.status === 200 && isOutcome(record.body), true);
    assert.ok(
      record.status === 200 && isOutcome(record.body),
      'Expected a terminal outcome from the actual server.',
    );
    const requestedId = record.request?.intentId ?? record.request?.path.split('/api/intents/')[1];
    this.check('outcome-belongs-to-requested-intent', record.body.intentId, requestedId);
    if (record.request?.command)
      this.check(
        'outcome-belongs-to-requested-command',
        record.body.command,
        record.request.command,
      );
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          offerId: record.body.command.offerId,
          quantity: record.body.command.quantity,
        }),
      )
      .digest('hex');
    this.check('outcome-command-digest', record.body.commandHash, digest);
    return record.body;
  }
  result(id: ScenarioId): ScenarioEvidence {
    return {
      id,
      role: id === 'fresh-key' ? 'counterexample' : 'recovery',
      passed: this.checks.length > 0 && this.checks.every((check) => check.passed),
      observations: this.observations,
      checks: this.checks,
    };
  }
}

async function workspace<T>(
  run: (directory: string, children: Fixture[]) => Promise<T>,
): Promise<T> {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'intent-experiment-'));
  const children: Fixture[] = [];
  try {
    return await run(directory, children);
  } finally {
    await Promise.all(children.map((child) => child.kill()));
    // Refuse recursive cleanup if an unexpected path ever escapes the owned temporary directory.
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
}

async function retryScenario(sameIntent: boolean): Promise<ScenarioEvidence> {
  return workspace(async (directory, children) => {
    const server = await launchFixture(join(directory, 'lab.sqlite'));
    children.push(server);
    const r = new Recorder();
    const first = await r.post(server.url, 'purchase-original', 'drop-after-commit');
    r.check('acknowledgement-lost', first.kind, 'transport-error');
    const committed = await r.ledger(server.url);
    r.check('first-effect-exists-despite-no-response', committed.effects.length, 1);
    const second = r.outcome(
      await r.post(server.url, sameIntent ? 'purchase-original' : 'purchase-fresh-key'),
    );
    const final = await r.ledger(server.url);
    r.check('observed-effect-count', final.effects.length, sameIntent ? 1 : 2);
    r.check('observed-capacity', final.remainingCapacity, sameIntent ? 11 : 10);
    r.check('committed-history-retained', checkRetention(committed, final), {
      ok: true,
      violations: [],
    });
    if (sameIntent) r.check('exact-outcome-recovered', second, committed.intents[0]);
    else
      r.check(
        'different-intents-are-distinct-purchases',
        second.intentId !== committed.intents[0]?.intentId,
        true,
      );
    return r.result(sameIntent ? 'same-intent' : 'fresh-key');
  });
}

async function lateCommit(): Promise<ScenarioEvidence> {
  return workspace(async (directory, children) => {
    const server = await launchFixture(join(directory, 'lab.sqlite'));
    children.push(server);
    const r = new Recorder();
    const interrupted = await r.post(
      server.url,
      'purchase-late-commit',
      'delay-before-commit',
      command,
      450,
    );
    r.check('caller-stopped-waiting', interrupted.kind, 'transport-error');
    const unseen = await r.request(server.url, '/api/intents/purchase-late-commit');
    r.check(
      'unseen-is-observed-before-commit',
      { status: unseen.status, body: unseen.body },
      { status: 404, body: { intentId: 'purchase-late-commit', status: 'unseen' } },
    );
    const before = await r.ledger(server.url);
    r.check('no-effect-at-earlier-observation', before.effects.length, 0);
    // This wait is for the deliberately injected 1.5 s delay, never a performance benchmark.
    await delay(1600);
    const later = r.outcome(await r.request(server.url, '/api/intents/purchase-late-commit'));
    const after = await r.ledger(server.url);
    r.check('earlier-404-did-not-prevent-late-commit', after.effects.length, 1);
    r.check('late-outcome-is-confirmed', later.status, 'confirmed');
    r.check(
      'same-intent-after-late-commit',
      r.outcome(await r.post(server.url, 'purchase-late-commit')),
      later,
    );
    r.check('retry-does-not-create-another-effect', (await r.ledger(server.url)).effects.length, 1);
    return r.result('late-commit');
  });
}

async function conflictingCommand(): Promise<ScenarioEvidence> {
  return workspace(async (directory, children) => {
    const server = await launchFixture(join(directory, 'lab.sqlite'));
    children.push(server);
    const r = new Recorder();
    const first = r.outcome(await r.post(server.url, 'purchase-conflict'));
    const original = await r.ledger(server.url);
    const conflict = await r.post(server.url, 'purchase-conflict', 'none', {
      offerId: 'workshop',
      quantity: 2,
    });
    r.check('changed-command-rejected', conflict.status, 409);
    r.check(
      'original-outcome-retained',
      r.outcome(await r.request(server.url, '/api/intents/purchase-conflict')),
      first,
    );
    r.check('ledger-unchanged', await r.ledger(server.url), original);
    return r.result('conflicting-command');
  });
}

async function crash(phase: 'before-commit' | 'after-commit'): Promise<ScenarioEvidence> {
  return workspace(async (directory, children) => {
    const database = join(directory, 'lab.sqlite');
    const server = await launchFixture(database, {
      phase,
      marker: join(directory, 'checkpoint.json'),
    });
    children.push(server);
    const r = new Recorder();
    const intentId = `purchase-crash-${phase}`;
    const pending = r.post(server.url, intentId);
    const checkpoint = (await server.waitForCheckpoint()) as { phase: string; outcome: Outcome };
    r.add({ kind: 'process-checkpoint', body: checkpoint });
    r.check('requested-checkpoint-reached', checkpoint.phase, phase);
    await server.kill();
    r.add({
      kind: 'process-killed',
      body: { mechanism: 'parent child.kill(SIGKILL)', beforeHttpAcknowledgement: true },
    });
    r.check('acknowledgement-not-observed', (await pending).kind, 'transport-error');
    const restart = await launchFixture(database);
    children.push(restart);
    const recovered = await r.ledger(restart.url);
    r.check(
      'restart-recovered-expected-effect-count',
      recovered.effects.length,
      phase === 'before-commit' ? 0 : 1,
    );
    const outcome = r.outcome(await r.post(restart.url, intentId));
    r.check('retry-confirmed', outcome.status, 'confirmed');
    if (phase === 'after-commit')
      r.check('same-durable-receipt-after-restart', outcome, checkpoint.outcome);
    const final = await r.ledger(restart.url);
    r.check('one-effect-after-recovery', final.effects.length, 1);
    r.check('capacity-conserved-after-recovery', final.remainingCapacity, 11);
    r.check('recovered-history-retained', checkRetention(recovered, final), {
      ok: true,
      violations: [],
    });
    return r.result(phase === 'before-commit' ? 'crash-before' : 'crash-after');
  });
}

async function twoProcesses(): Promise<ScenarioEvidence> {
  return workspace(async (directory, children) => {
    const database = join(directory, 'lab.sqlite');
    const first = await launchFixture(database);
    children.push(first);
    const second = await launchFixture(database);
    children.push(second);
    const r = new Recorder();
    const responses = await Promise.all(
      [first, second, first, second].map((server) => r.post(server.url, 'purchase-shared-intent')),
    );
    const outcomes = responses.map((response) => r.outcome(response));
    for (const outcome of outcomes) r.check('concurrent-outcomes-match', outcome, outcomes[0]);
    const ledger = await r.ledger(first.url);
    r.check('one-effect-across-two-processes', ledger.effects.length, 1);
    for (const outcome of outcomes)
      r.check('response-matches-authoritative-outcome', outcome, ledger.intents[0]);
    r.check('both-processes-see-same-ledger', await r.ledger(second.url), ledger);
    return r.result('two-processes');
  });
}

export async function runExperiments(
  onProgress: (id: ScenarioId) => void = () => {},
): Promise<ScenarioEvidence[]> {
  const scenarios: ScenarioEvidence[] = [];
  for (const run of [
    () => retryScenario(false),
    () => retryScenario(true),
    lateCommit,
    conflictingCommand,
    () => crash('before-commit'),
    () => crash('after-commit'),
    twoProcesses,
  ]) {
    const scenario = await run();
    scenarios.push(scenario);
    onProgress(scenario.id);
  }
  return scenarios;
}
