const names = {
  'retained-positive': ['Retained positive lookup', '보존된 결과를 조회해 복구'],
  'naive-expired': ['Naive retry after pruning', '삭제 이후 단순 재시도'],
  'guarded-postcommit': ['Refuse after cutoff: effect happened', '기한 이후 거절: 효과 있음'],
  'guarded-precommit': ['Refuse after cutoff: no effect', '기한 이후 거절: 효과 없음'],
  'guarded-delayed-arrival': ['Eligible send, late remote arrival', '기한 내 전송, 늦은 도착'],
};
export function retentionReportText(report) {
  const lines = [
    'Retention boundary / 보존 기간의 경계',
    '',
    `Run: ${report.runId}`,
    `Recorded: ${report.completedAt}`,
    `Source: ${report.sourceBefore.git.head ?? report.sourceBefore.git.state}`,
    `Dirty: ${String(report.sourceBefore.git.dirty ?? 'unavailable')}`,
    `Fingerprint: ${report.sourceBefore.sha256}`,
    `Source stable: ${report.sourceStable}`,
    '',
    report.passed
      ? 'Expected fixture results established / 설정한 실험 결과 확인'
      : 'NOT ESTABLISHED / 실험 결과 미확인',
    report.passed
      ? 'This verdict includes two repeated-effect counterexamples. It does not mean all policies prevent duplication.'
      : 'The complete comparison is not established. Read the available evidence and failure state.',
    report.passed
      ? '이 판정에는 효과가 두 번 발생한 반례 두 개가 포함됩니다. 모든 정책이 중복을 막았다는 뜻이 아닙니다.'
      : '전체 비교가 성립하지 않았습니다. 남아 있는 근거와 실패 상태를 확인하세요.',
    '',
    'Case / 사례 | Remote effects / 상대 효과 | Local grants / 로컬 기록 | At most one remote effect / 상대 효과 최대 1건',
  ];
  for (const item of report.cases) {
    const c = item.audit.checks;
    lines.push(
      `${names[item.scenario].join(' / ')} | ${c.remoteEffects} | ${c.localGrants} | ${c.remoteEffectAtMostOnce ? 'yes / 예' : 'NO / 아니오'}`,
    );
  }
  if (report.localObservationsIndistinguishable?.equal === true)
    lines.push(
      '',
      'Absence is not historical non-execution. The two unresolved cases have identical local observations but different remote histories.',
      '조회 결과가 없다고 과거 효과까지 없었다고 할 수는 없습니다. 미확정 두 사례의 로컬 관측은 같지만 상대 시스템의 이력은 다릅니다.',
    );
  if (
    report.cases.some(
      (c) =>
        c.scenario === 'guarded-delayed-arrival' &&
        c.audit.checks.locallyEligibleRetryArrivedAfterPruning,
    )
  )
    lines.push(
      'The delayed request was dispatched at logical 10,020, before local cutoff 10,900, then delivered only after pruning at 12,000.',
      '지연 요청은 논리 시각 10,020에 전송되어 로컬 기한 10,900을 지켰지만, 12,000의 삭제 이후 도착합니다.',
      'Clock values are injected fixtures, not measured transit time. A local refusal policy is not a remote admission fence.',
      '시각은 주입한 설정값이며 통신 지연 측정값이 아닙니다. 로컬 전송 거절 정책은 상대 시스템의 수신 제한이 아닙니다.',
    );
  lines.push('', 'Copied-journal controls / 복사한 기록의 검출 대조군:');
  for (const control of report.mutationControls)
    lines.push(`- ${control.kind}: ${control.accepted ? 'accepted / 수락' : 'rejected / 거절'}`);
  lines.push(
    '',
    'Read evidence.json for attempt identities, logical clocks, HTTP observations, both journals and independent audit results.',
    'evidence.json에서 시도 식별자, 논리 시각, HTTP 관측, 두 시스템의 기록과 독립 감사 결과를 확인하세요.',
    'No production provider, payment integration, global exactly-once guarantee or power-loss claim. Source hashes are observations, not execution attestation.',
    '실제 제공사·결제 연동, 전역 exactly-once 보장이나 정전 내구성을 입증하지 않습니다. 소스 해시는 관측 기록이며 실행 인증이 아닙니다.',
    'The command does not run the complete test suite. No UI or public service is started for the report.',
    '이 명령은 전체 테스트 모음을 실행하지 않습니다. 보고서용 UI나 공개 서비스를 시작하지 않습니다.',
  );
  if (report.executionError) {
    lines.push('', `Failure: ${report.executionError.message}`);
    const context = report.executionError.context;
    if (context) {
      lines.push(
        `Failure context / 실패 위치: ${context.scenario ?? 'run / 전체 실행'} · ${context.phase} · ${context.code}`,
      );
      if (context.request)
        lines.push(
          `Request / 요청: ${context.request.ordinal} · ${context.request.action} · HTTP ${context.request.status ?? 'not observed / 미관측'}`,
        );
      for (const worker of context.workers)
        lines.push(
          `Worker / 프로세스 ${worker.instance} ${worker.role}: ready ${worker.readyObserved ? 'observed / 관측' : 'not observed / 미관측'}; close ${worker.closeObserved ? `observed / 관측 (${worker.code ?? worker.signal})` : 'not observed / 미관측'}`,
        );
      lines.push(
        'Observations are frozen at the first failure; later cleanup is not included. No close observation does not establish that a worker was alive.',
        '최초 실패 시점의 관측이며 이후 정리 결과는 포함하지 않습니다. 종료 미관측이 프로세스의 생존을 보장하지 않습니다.',
      );
    }
  }
  return lines.join('\n') + '\n';
}
