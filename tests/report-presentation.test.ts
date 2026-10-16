import assert from 'node:assert/strict';
import test from 'node:test';
import { renderReport, type ExperimentReport } from '../scripts/report.ts';

test('failed evidence cannot inherit the successful narrative in a shareable report', () => {
  const source = { sha256: '0'.repeat(64), files: [], git: { state: 'uninitialized' as const } };
  const report: ExperimentReport = {
    schemaVersion: 1,
    runId: 'synthetic-failed-presentation',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    runtime: { node: 'test', platform: 'test', architecture: 'test', sqlite: 'test' },
    sourceBefore: source,
    sourceAfter: source,
    sourceStable: true,
    passed: false,
    scenarios: [
      {
        id: 'same-intent',
        role: 'recovery',
        passed: false,
        observations: [
          {
            sequence: 1,
            at: '2026-01-01T00:00:00Z',
            elapsedMs: 0,
            kind: 'http',
            request: { method: 'GET', path: '/api/ledger' },
            status: 200,
            body: { effects: [{ receipt: 'one' }, { receipt: 'unexpected-two' }] },
          },
        ],
        checks: [{ id: 'one-effect', passed: false, actual: 2, expected: 1 }],
      },
    ],
  };
  const html = renderReport(report);
  assert.match(html, /Verification failed · unverified observations/);
  assert.match(html, /검증 실패 · 확인되지 않은 관측값/);
  assert.match(html, /not an established result of this failed execution/);
  assert.match(html, /<div class="count">2<span>/);
  assert.doesNotMatch(html, /The original reservation remains the only effect/);
  assert.doesNotMatch(html, /예약은 한 건만 남습니다/);
  assert.doesNotMatch(html, /This execution reproduced every scenario/);
});
