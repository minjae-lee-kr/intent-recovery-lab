import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { launch } from './process.ts';
import { MODEL_VERSION } from './types.ts';
import type { Event, History, Input, Target } from './types.ts';
type WithoutClock<T> = T extends Event ? Omit<T, 'sequence' | 'elapsedMs'> : never;
export const SEEDS = [104_729, 130_363, 155_921] as const;
function shuffled<T>(values: T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const j = (state >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
export async function collectHistory(
  seed: number,
): Promise<{ history: History; executionError?: string }> {
  const runId = randomUUID();
  const history: History = {
    schemaVersion: 1,
    modelVersion: MODEL_VERSION,
    runId,
    seed,
    plannedAttemptIds: [
      'anchor',
      'anchor-read',
      'late',
      'early-read',
      'lost',
      'retry',
      'changed',
      ...Array.from({ length: 5 }, (_, i) => `fill-${i}`),
      'final',
    ],
    writers: [],
    events: [],
  };
  const start = performance.now();
  const add = (value: WithoutClock<Event>) => {
    history.events.push({
      ...value,
      sequence: history.events.length + 1,
      elapsedMs: performance.now() - start,
    } as Event);
  };
  const directory = await mkdtemp(join(resolve(tmpdir()), 'observed-history-'));
  const owned: Awaited<ReturnType<typeof launch>>[] = [];
  let executionError: string | undefined;
  try {
    const database = join(directory, 'history.sqlite');
    const onLifecycle = (
      kind: 'drained' | 'exited',
      identity: Awaited<ReturnType<typeof launch>>['identity'],
    ) => {
      if (identity.target !== 'reader') add({ kind, ...identity, target: identity.target });
    };
    const a = await launch(database, runId, 'a', onLifecycle);
    owned.push(a);
    const b = await launch(database, runId, 'b', onLifecycle);
    owned.push(b);
    history.writers = [a, b].map(({ identity }) => ({
      target: identity.target as 'a' | 'b',
      instanceId: identity.instanceId,
      pid: identity.pid,
    }));
    const request = async (
      id: string,
      server: typeof a,
      input: Input,
      fault = 'none',
      timeoutMs = 5_000,
    ) => {
      const target: Target = server.identity.target;
      add({ kind: 'invoke', attemptId: id, target, input: structuredClone(input), fault });
      const path =
        input.kind === 'reserve'
          ? '/api/reservations'
          : input.kind === 'lookup'
            ? `/api/intents/${input.key}`
            : '/api/ledger';
      try {
        const response = await fetch(`${server.url}${path}`, {
          method: input.kind === 'reserve' ? 'POST' : 'GET',
          signal: AbortSignal.timeout(timeoutMs),
          ...(input.kind === 'reserve'
            ? {
                headers: {
                  'content-type': 'application/json',
                  'Idempotency-Key': input.key,
                  'X-Lab-Fault': fault,
                },
                body: JSON.stringify({ offerId: 'workshop', quantity: input.quantity }),
              }
            : {}),
        });
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { malformedJson: text.slice(0, 512) };
        }
        add({ kind: 'http', attemptId: id, status: response.status, body });
      } catch (error) {
        add({
          kind: 'unknown',
          attemptId: id,
          error: error instanceof Error ? error.name : 'TransportError',
        });
      }
    };
    const key = (suffix: string) => `history-${seed}-${suffix}`;
    await request('anchor', a, { kind: 'reserve', key: key('anchor'), quantity: 1 });
    await request('anchor-read', b, { kind: 'lookup', key: key('anchor') });
    await request(
      'late',
      a,
      { kind: 'reserve', key: key('late'), quantity: 1 },
      'delay-before-commit',
      100,
    );
    await request('early-read', b, { kind: 'lookup', key: key('late') });
    await request(
      'lost',
      b,
      { kind: 'reserve', key: key('lost'), quantity: 1 },
      'drop-after-commit',
    );
    const jobs = [
      { id: 'retry', input: { kind: 'reserve', key: key('anchor'), quantity: 1 } as Input },
      { id: 'changed', input: { kind: 'reserve', key: key('anchor'), quantity: 2 } as Input },
      ...shuffled([3, 3, 3, 3, 2], seed).map((quantity, i) => ({
        id: `fill-${i}`,
        input: { kind: 'reserve', key: key(`fill-${i}`), quantity } as Input,
      })),
    ];
    // All invocations are recorded before awaiting the batch. Actual interval overlap
    // is checked afterward; the seed does not claim to replay OS scheduling.
    await Promise.all(
      shuffled(jobs, seed + 1).map((job, i) => request(job.id, i % 2 ? a : b, job.input)),
    );
    await Promise.all([a.stop(), b.stop()]);
    add({ kind: 'fence' });
    const reader = await launch(database, runId, 'reader');
    owned.push(reader);
    await request('final', reader, { kind: 'snapshot' });
    await reader.stop();
  } catch (error) {
    console.error('History fixture diagnostic:', error);
    executionError =
      'HARNESS_ERROR: the owned-process experiment did not complete; inspect local terminal diagnostics.';
  } finally {
    const cleanup = await Promise.allSettled(owned.map((child) => child.kill()));
    if (cleanup.some((row) => row.status === 'rejected'))
      executionError = 'Owned-process cleanup was not confirmed.';
    assert.equal(dirname(directory), resolve(tmpdir()));
    if (!cleanup.some((row) => row.status === 'rejected'))
      await rm(directory, { recursive: true, force: true });
  }
  return { history, ...(executionError ? { executionError } : {}) };
}
