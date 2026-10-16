import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { runExperiments } from '../scripts/experiments.ts';
import { launchFixture } from './helpers/fixture-process.ts';

test(
  'report rejects correlated-response mutations and distinguishes an HTTP error from a lost response',
  { timeout: 25_000 },
  async () => {
    // Real child processes, HTTP requests and SQLite effects still run. This wrapper
    // mutates only what the report observes, to check that its own oracle is sensitive.
    const originalFetch = globalThis.fetch;
    let alteredResponses = 0;
    let substitutedHttpErrors = 0;
    globalThis.fetch = async (input, init) => {
      const intentId = new Headers(init?.headers).get('Idempotency-Key');
      let response: Response;
      try {
        response = await originalFetch(input, init);
      } catch (error) {
        if (!intentId?.startsWith('purchase-crash-')) throw error;
        substitutedHttpErrors++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'TEMPORARY_UNAVAILABLE',
              message: 'Synthetic HTTP response for evidence sensitivity.',
              retryable: true,
            },
          }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (intentId !== 'purchase-shared-intent' || response.status !== 200) return response;
      const value = await response.json();
      value.intentId = 'wrong-intent-response';
      value.command.quantity = 2;
      value.commandHash = '0'.repeat(64);
      alteredResponses++;
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      return new Response(JSON.stringify(value), { status: response.status, headers });
    };
    try {
      const scenarios = await runExperiments();
      assert.equal(alteredResponses, 4);
      assert.equal(substitutedHttpErrors, 2);
      const concurrent = scenarios.find((scenario) => scenario.id === 'two-processes')!;
      assert.equal(concurrent.passed, false);
      for (const id of [
        'outcome-belongs-to-requested-intent',
        'outcome-belongs-to-requested-command',
        'outcome-command-digest',
        'response-matches-authoritative-outcome',
      ]) {
        const checks = concurrent.checks.filter((check) => check.id === id);
        assert.equal(checks.length, 4, `Expected a check for each actual HTTP response: ${id}`);
        assert.ok(
          checks.every((check) => !check.passed),
          `${id} must detect the independent mutation`,
        );
      }
      // A consistent durable ledger cannot make a mismatched client response safe.
      assert.ok(
        concurrent.checks
          .filter((check) => check.id === 'ledger-invariants')
          .every((check) => check.passed),
      );
      for (const scenario of scenarios.filter(
        (value) => value.id === 'crash-before' || value.id === 'crash-after',
      )) {
        assert.equal(scenario.passed, false);
        const observation = scenario.observations.find(
          (value) => value.request?.method === 'POST',
        )!;
        assert.equal(observation.kind, 'http');
        assert.equal(observation.status, 503);
        assert.equal(
          scenario.checks.find((check) => check.id === 'acknowledgement-not-observed')?.passed,
          false,
        );
      }
      assert.ok(
        scenarios
          .filter((value) => !['two-processes', 'crash-before', 'crash-after'].includes(value.id))
          .every((value) => value.passed),
        'Unmodified positive controls must still pass.',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  'checkpoint evidence rejects both preexisting markers and a foreign run marker',
  { timeout: 10_000 },
  async () => {
    const parent = resolve(tmpdir());
    const directory = await mkdtemp(join(parent, 'intent-marker-review-'));
    const marker = join(directory, 'checkpoint.json');
    const database = join(directory, 'lab.sqlite');
    let child: Awaited<ReturnType<typeof launchFixture>> | undefined;
    try {
      await writeFile(
        marker,
        JSON.stringify({
          phase: 'after-commit',
          intentId: 'stale-intent',
          outcome: { status: 'confirmed' },
        }),
      );
      await assert.rejects(
        launchFixture(database, { phase: 'after-commit', marker }),
        /fresh marker path/,
      );
      await rm(marker);
      child = await launchFixture(database, { phase: 'after-commit', marker });
      // No reservation is submitted. A file from elsewhere must not fabricate the
      // observation that this child reached a transaction checkpoint.
      await writeFile(
        marker,
        JSON.stringify({
          phase: 'after-commit',
          pid: child.pid,
          runToken: 'another-run',
          outcome: { status: 'confirmed' },
        }),
      );
      await assert.rejects(child.waitForCheckpoint(), /does not belong to this child and run/);
      const actual = await (await fetch(`${child.url}/api/ledger`)).json();
      assert.equal(actual.intents.length, 0);
      assert.equal(actual.effects.length, 0);
    } finally {
      await child?.kill();
      assert.equal(dirname(directory), parent);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
