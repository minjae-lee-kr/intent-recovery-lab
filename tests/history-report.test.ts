import assert from 'node:assert/strict';
import test from 'node:test';
import { checkHistory } from '../scripts/history/checker.ts';
import { coverage, staleReadControl } from '../scripts/history/assessment.ts';
import { historyReportText } from '../scripts/history/report-text.ts';
import type { SourceEvidence } from '../scripts/provenance.ts';
import { fixture, result } from './helpers/history-fixtures.ts';

const sourceBefore: SourceEvidence = {
  sha256: 'fixture-source',
  files: [],
  git: { state: 'available', head: 'fixture-head', dirty: false },
};

function baseline() {
  const f = fixture();
  const outcome = result('purchase-report');
  f.invoke('anchor', { kind: 'reserve', key: outcome.intentId, quantity: 1 });
  f.http('anchor', 200, outcome);
  f.invoke('anchor-read', { kind: 'lookup', key: outcome.intentId }, 'b');
  f.http('anchor-read', 200, outcome);
  return f;
}

test('a missing drain cannot produce a success narrative or imply a stale-control file exists', () => {
  const history = baseline().history;
  const run = {
    seed: history.seed,
    verdict: checkHistory(history),
    coverage: coverage(history),
    staleReadControl: staleReadControl(history),
  };
  assert.equal(run.verdict.status, 'inconclusive');
  assert.equal('history' in run.staleReadControl, false);
  const text = historyReportText({ passed: false, sourceStable: true, sourceBefore, runs: [run] });
  assert.match(text, /Not established \/ 확인되지 않음/);
  assert.match(text, /No stale-read control file was generated/);
  assert.match(text, /stale-control 파일을 만들지 않았습니다/);
  assert.match(text, /생성한 조회 반례 파일: 0\/1/);
  assert.doesNotMatch(
    text,
    /both writers acknowledged drain|두 서버의 처리 완료와 정상 종료를 확인한 뒤/,
  );
});

test('failure text distinguishes partial controls from established rejections without inventing a cause', () => {
  const f = baseline();
  const history = f.finish([result('purchase-report')]);
  const control = staleReadControl(history);
  assert.equal(control.established, true);
  const run = {
    seed: 1,
    verdict: checkHistory(history),
    coverage: { complete: true },
    staleReadControl: control,
  };
  // Presentation fixture: one established control, one unestablished generated control,
  // and one absent control. This does not claim full workload coverage for the hand fixture.
  const text = historyReportText({
    passed: false,
    sourceStable: false,
    sourceBefore,
    runs: [
      run,
      { ...run, seed: 2, staleReadControl: { ...control, established: false } },
      { ...run, seed: 3, staleReadControl: { established: false } },
    ],
  });
  assert.match(text, /생성한 조회 반례 파일: 2\/3;.*거부 확인: 1\/2/);
  assert.match(text, /Source before\/after identical: false/);
  assert.match(text, /required observation or source-consistency check/);
  assert.doesNotMatch(text, /No stale-read control file was generated/);
  assert.doesNotMatch(text, /For every seed in this run/);
  assert.match(text, /A generated file alone does not establish that result/);
});

test('only an established run receives the completed procedure narrative', () => {
  const text = historyReportText({
    passed: true,
    sourceStable: true,
    sourceBefore,
    runs: [
      {
        seed: 1,
        verdict: { status: 'witness', exploredStates: 1 },
        coverage: { complete: true },
        staleReadControl: { established: true, history: fixture().finish([]) },
      },
    ],
  });
  assert.match(text, /Expected observations established \/ 예상 관측 확인/);
  assert.match(text, /both writers acknowledged drain and exited/);
  assert.match(text, /두 서버의 처리 완료와 정상 종료를 확인한 뒤/);
  assert.match(text, /생성한 조회 반례 파일: 1\/1;.*거부 확인: 1\/1/);
});
