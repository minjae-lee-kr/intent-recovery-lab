import type { SourceEvidence } from '../provenance.ts';
import type { History, Verdict } from './types.ts';

interface ReportTextInput {
  passed: boolean;
  sourceStable: boolean;
  sourceBefore: SourceEvidence;
  runs: ReadonlyArray<{
    seed: number;
    verdict: Pick<Verdict, 'status' | 'exploredStates'>;
    coverage: { complete: boolean };
    staleReadControl: { established: boolean; history?: History };
  }>;
}

export function historyReportText(report: ReportTextInput): string {
  const { passed, runs, sourceBefore, sourceStable } = report;
  const controls = runs.filter((run) => 'history' in run.staleReadControl);
  const establishedControls = controls.filter((run) => run.staleReadControl.established).length;
  return [
    'A valid ledger is not the whole history.',
    '장부가 맞아도, 사용자가 본 결과는 틀릴 수 있습니다.',
    '',
    `Run result / 실행 결과: ${passed ? 'Expected observations established / 예상 관측 확인' : 'Not established / 확인되지 않음'}`,
    ...runs.map(
      (run) =>
        `Seed ${run.seed}: history=${run.verdict.status}; coverage=${run.coverage.complete}; stale-read control=${run.staleReadControl.established}; states visited=${run.verdict.exploredStates}`,
    ),
    '',
    'The experiment uses real HTTP against two owned processes sharing one local SQLite file. A separately specified whole-capacity model searches for a legal order respecting observed response-before-invocation precedence. Transport-unknown writes can remain pending past the local timeout.',
    '이 실험은 하나의 로컬 SQLite 파일을 공유하는 두 프로세스에 실제 HTTP 요청을 보냅니다. 별도 순차 모델로 호출·응답의 선후 관계를 지키는 실행 순서를 찾으며, 타임아웃을 쓰기 실패로 단정하지 않습니다.',
    ...(passed
      ? [
          'For every seed in this run, both writers acknowledged drain and exited before a fresh reader recorded the final ledger. The required workload coverage and source-consistency checks were established.',
          '이번 실행의 모든 시드에서 두 서버의 처리 완료와 정상 종료를 확인한 뒤 최종 장부를 조회했습니다. 필수 요청 구성과 실행 전후 소스 일치도 확인했습니다.',
        ]
      : [
          'This run did not establish every required observation or source-consistency check. The intended procedure alone does not confirm writer drain, a final snapshot or a sensitivity control; inspect the recorded per-seed results and source comparison.',
          '이번 실행은 필수 관측 또는 소스 일치 조건을 모두 충족하지 못했습니다. 예정된 절차만으로 서버 처리 완료, 최종 장부 조회나 반례 검증이 끝났다고 볼 수 없습니다. 시드별 기록과 실행 전후 소스 비교를 확인하세요.',
        ]),
    '',
    `Stale-read control files generated / 생성한 조회 반례 파일: ${controls.length}/${runs.length}; rejection with unchanged final ledger established / 최종 장부 유지 및 거부 확인: ${establishedControls}/${controls.length}`,
    ...(controls.length === 0
      ? [
          'No stale-read control file was generated: no recorded baseline met the control prerequisites. Sensitivity to this mutation was not established.',
          '반례 생성 조건을 충족한 원본 기록이 없어 stale-control 파일을 만들지 않았습니다. 이 변형을 탐지하는지는 확인되지 않았습니다.',
        ]
      : [
          'Generated stale-read files are deliberately mutated observer evidence, not naturally occurring server defects: one acknowledged GET becomes unseen. A control is established only when the final ledger is unchanged and the checker rejects the mutation as a counterexample. A generated file alone does not establish that result.',
          '생성한 stale-control 파일은 조회 응답 한 건을 의도적으로 바꾼 반례이며 실제 서버에서 발견한 장애가 아닙니다. 최종 장부가 유지되고 검사기가 모순을 반례로 거부해야 검증이 성립합니다. 파일 생성만으로 검증이 완료된 것은 아닙니다.',
        ]),
    '',
    'A witness is one explanation for this finite trace, not the actual commit order or proof of all executions. Search/fence/coverage uncertainty never counts as pass. The seed repeats workload choices, not OS scheduling. No replicated storage, throughput benchmark, power-loss test, external payment, or employer implementation is claimed.',
    '가능한 실행 순서는 유한한 관측 기록의 한 가지 설명이며, 실제 커밋 순서나 모든 실행의 정확성을 증명하지 않습니다. 검사 한도·종료 확인·실행 범위가 충족되지 않으면 통과로 처리하지 않습니다. 합성 데이터 기반 개인 실험이며 회사 내부 정보는 포함하지 않습니다.',
    '',
    `Source SHA-256: ${sourceBefore.sha256}`,
    `Git: ${sourceBefore.git.head ?? sourceBefore.git.state}; dirty=${String(sourceBefore.git.dirty)}`,
    `Source before/after identical: ${sourceStable}`,
    'Source hashes are local before/after observations, not attestation or signatures; reverted intermediate edits are not detected. This command does not run the test suite.',
    'Replay a raw trace from the repository root: pnpm history:check reports/<run-id>/seed-<seed>.json',
    'See docs/history-check.md and docs/history-check.ko.md for the model, limits and controls.',
    '',
  ].join('\n');
}
