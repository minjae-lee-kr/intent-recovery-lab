import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectHistory, SEEDS } from './history/harness.ts';
import { checkHistory } from './history/checker.ts';
import { coverage, staleReadControl } from './history/assessment.ts';
import { MODEL_VERSION } from './history/types.ts';
import { projectRoot, sourceEvidence } from './provenance.ts';

if (process.argv.length !== 2) {
  process.stderr.write('Usage: pnpm history (no arguments)\n');
  process.exitCode = 64;
} else {
  const startedAt = new Date().toISOString();
  const runId = `history-${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const output = join(projectRoot, 'reports', runId);
  const sourceBefore = await sourceEvidence();
  const db = new DatabaseSync(':memory:');
  const sqlite = String(db.prepare('SELECT sqlite_version() AS version').get()!.version);
  db.close();
  const runs = [];
  for (const seed of SEEDS) {
    const observed = await collectHistory(seed);
    const verdict = checkHistory(observed.history);
    const exercised = coverage(observed.history);
    const control = staleReadControl(observed.history);
    const passed =
      !observed.executionError &&
      verdict.status === 'witness' &&
      exercised.complete &&
      control.established;
    runs.push({
      seed,
      ...observed,
      verdict,
      coverage: exercised,
      staleReadControl: control,
      passed,
    });
    process.stdout.write(
      `Seed ${seed}: history=${verdict.status}, coverage=${exercised.complete ? 'complete' : 'incomplete'}, stale-read control=${control.established ? 'rejected as expected' : 'not established'}\n`,
    );
  }
  const sourceAfter = await sourceEvidence();
  const sourceStable = sourceBefore.sha256 === sourceAfter.sha256;
  const passed = sourceStable && runs.length === SEEDS.length && runs.every((run) => run.passed);
  const report = {
    schemaVersion: 1,
    modelVersion: MODEL_VERSION,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      sqlite,
      platform: process.platform,
      architecture: process.arch,
    },
    sourceBefore,
    sourceAfter,
    sourceStable,
    passed,
    runs,
  };
  await mkdir(output, { recursive: true });
  const writeJson = (name: string, value: unknown) =>
    writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await writeJson('evidence.json', report);
  for (const run of runs) {
    await writeJson(`seed-${run.seed}.json`, run.history);
    if ('history' in run.staleReadControl)
      await writeJson(`seed-${run.seed}-stale-control.json`, run.staleReadControl.history);
  }
  await writeFile(
    join(output, 'report.txt'),
    [
      'A valid ledger is not the whole history.',
      '장부가 맞아도, 사용자가 본 결과는 틀릴 수 있습니다.',
      '',
      `Run result / 실행 결과: ${passed ? 'Expected observations established / 예상 관측 확인' : 'Not established / 확인되지 않음'}`,
      ...runs.map(
        (run) =>
          `Seed ${run.seed}: history=${run.verdict.status}; coverage=${run.coverage.complete}; stale-read control=${run.staleReadControl.established}; states visited=${run.verdict.exploredStates}`,
      ),
      '',
      'Each original history records real HTTP calls against two owned processes sharing one local SQLite file. A separately specified whole-capacity model searches for a legal order respecting observed response-before-invocation precedence. Transport-unknown writes can remain pending past the local timeout. Both writers acknowledge drain and exit before a fresh reader records the final ledger.',
      '원본 기록은 하나의 로컬 SQLite 파일을 공유하는 두 프로세스에 실제 HTTP 요청을 보낸 결과입니다. 별도 순차 모델로 호출·응답의 선후 관계를 지키는 실행 순서를 찾습니다. 타임아웃을 쓰기 실패로 단정하지 않으며, 두 서버의 처리 완료와 종료를 확인한 뒤 최종 장부를 조회합니다.',
      '',
      'The stale-read files are deliberately mutated observer evidence, not naturally occurring server defects: one acknowledged GET becomes unseen while the recorded final ledger is unchanged. The control must be rejected, not merely time out.',
      'stale-control 파일은 조회 응답 한 건을 의도적으로 바꾼 반례입니다. 실제 서버에서 발견한 장애가 아닙니다. 최종 장부는 유지하며, 검사기가 이 모순을 거부하는지 확인합니다.',
      '',
      'A witness is one explanation for this finite trace, not the actual commit order or proof of all executions. Search/fence/coverage uncertainty never counts as pass. The seed repeats workload choices, not OS scheduling. No replicated storage, throughput benchmark, power-loss test, external payment, or employer implementation is claimed.',
      '가능한 실행 순서는 유한한 관측 기록의 한 가지 설명이며, 실제 커밋 순서나 모든 실행의 정확성을 증명하지 않습니다. 검사 한도·종료 확인·실행 범위가 충족되지 않으면 통과로 처리하지 않습니다. 합성 데이터 기반 개인 실험이며 회사 내부 정보는 포함하지 않습니다.',
      '',
      `Source SHA-256: ${sourceBefore.sha256}`,
      `Git: ${sourceBefore.git.head ?? sourceBefore.git.state}; dirty=${String(sourceBefore.git.dirty)}`,
      `Source before/after identical: ${sourceStable}`,
      'Source hashes are local before/after observations, not attestation or signatures; reverted intermediate edits are not detected. This command does not run the test suite.',
      'Replay a raw trace: pnpm history:check reports/<run-id>/seed-<seed>.json',
      'See docs/history-check.md and docs/history-check.ko.md for the model, limits and controls.',
      '',
    ].join('\n'),
    { flag: 'wx' },
  );
  process.stdout.write(
    `${passed ? 'Established' : 'NOT ESTABLISHED'} bounded history experiment\nEvidence: ${output}\n`,
  );
  if (!passed) process.exitCode = 1;
}
