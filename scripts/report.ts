import type { ScenarioEvidence, ScenarioId } from './experiments.ts';
import type { SourceEvidence } from './provenance.ts';

export interface ExperimentReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  runtime: { node: string; platform: string; architecture: string; sqlite: string };
  sourceBefore: SourceEvidence;
  sourceAfter: SourceEvidence;
  sourceStable: boolean;
  passed: boolean;
  scenarios: ScenarioEvidence[];
  executionError?: string;
}
type Pair = readonly [string, string];
const text: Record<ScenarioId, { title: Pair; takeaway: Pair }> = {
  'fresh-key': {
    title: ['새 키로 재시도한 경우', 'Retry with a fresh key'],
    takeaway: [
      '응답이 사라진 뒤 새 요청 키로 다시 보내면, 서버는 별도 예약으로 받아들입니다. 예약은 두 건 남습니다.',
      'After the acknowledgement disappears, a fresh key describes another intent. The server correctly creates a second reservation.',
    ],
  },
  'same-intent': {
    title: ['같은 예약 요청을 복구한 경우', 'Recover the same intent'],
    takeaway: [
      '키와 요청 내용을 유지하면 이미 저장한 결과를 돌려받습니다. 예약은 한 건만 남습니다.',
      'Keeping the key and command recovers the recorded outcome. The original reservation remains the only effect.',
    ],
  },
  'late-commit': {
    title: ['조회 시점에는 없었지만, 나중에 저장된다면', 'Unseen now. Committed later.'],
    takeaway: [
      '클라이언트의 대기 종료와 404 조회 뒤에도 먼저 보낸 요청은 저장될 수 있습니다. 조회 결과는 그 시점의 관측입니다.',
      'The original request can commit after the client times out and observes a 404. An unseen observation is not a cancellation guarantee.',
    ],
  },
  'conflicting-command': {
    title: ['같은 키에 다른 요청 내용을 보낸다면', 'One key, a changed command'],
    takeaway: [
      '요청 내용을 바꿔 재사용한 키는 충돌로 처리합니다. 원래 예약 결과와 정원은 바뀌지 않습니다.',
      'Reusing a key with a different command produces a conflict. The original outcome and capacity stay unchanged.',
    ],
  },
  'crash-before': {
    title: ['커밋 직전에 서버를 종료한다면', 'Kill the process before commit'],
    takeaway: [
      '별도 프로세스를 실제로 종료하고 같은 데이터베이스를 다시 엽니다. 완료되지 않은 변경은 남지 않고, 재시도 한 번으로 예약을 복구합니다.',
      'The parent abruptly terminates a separate server process, then reopens its database. Tentative changes do not survive; retry creates one reservation.',
    ],
  },
  'crash-after': {
    title: ['커밋 직후, 응답 전에 서버를 종료한다면', 'Kill after commit, before acknowledgement'],
    takeaway: [
      '완료된 예약은 프로세스 종료 후에도 남습니다. 재시도는 같은 예약 확인 번호와 결과를 돌려줍니다.',
      'The committed reservation survives process death. Retry returns the same receipt and durable outcome.',
    ],
  },
  'two-processes': {
    title: ['서버 두 개가 같은 요청을 함께 받는다면', 'Two processes, one intent'],
    takeaway: [
      '독립된 서버 프로세스 두 개가 같은 SQLite 파일을 사용합니다. 네 개의 동시 요청은 같은 결과로 수렴하고 예약은 한 건만 남습니다.',
      'Two independent server processes share one SQLite file. Four concurrent requests return the same outcome and leave one effect.',
    ],
  },
};
function escape(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
const both = (value: Pair) =>
  `<span data-lang="ko">${escape(value[0])}</span>
<span data-lang="en">${escape(value[1])}</span>`;
function effects(scenario: ScenarioEvidence): string {
  const ledger = [...scenario.observations]
    .reverse()
    .find((row) => row.request?.path === '/api/ledger' && row.status === 200)?.body;
  return ledger &&
    typeof ledger === 'object' &&
    'effects' in ledger &&
    Array.isArray(ledger.effects)
    ? String(ledger.effects.length)
    : '—';
}

export function renderReport(report: ExperimentReport): string {
  const rows = report.scenarios
    .map((scenario) => {
      const copy = text[scenario.id];
      return `<article class="scenario" id="${scenario.id}">
<div class="row">
<h3>${both(copy.title)}</h3>
<span class="result ${scenario.passed ? '' : 'failed'}">${both(scenario.passed ? ['예상 결과 재현', 'Expected result observed'] : ['확인 필요', 'Needs investigation'])}</span>
</div>
<p>${both(copy.takeaway)}</p>
<details>
<summary>${both(['요청·응답과 검증 근거 보기', 'Inspect requests, responses and checks'])}</summary>
<p class="note">${both(['아래는 실제 실행에서 수집한 원본 관측과 검증 결과입니다. 필드명은 코드와 동일하게 유지했습니다.', 'These observations and assertions were collected from this execution. Field names match the code.'])}</p>
<pre tabindex="0">${escape(JSON.stringify({ observations: scenario.observations, checks: scenario.checks }, null, 2))}</pre>
</details>
</article>`;
    })
    .join('');
  const comparison = report.scenarios
    .filter((scenario) => scenario.id === 'fresh-key' || scenario.id === 'same-intent')
    .map(
      (scenario) =>
        `<article class="compare ${scenario.id === 'same-intent' ? 'corrected' : ''}">
<p class="eyebrow">${both(scenario.id === 'fresh-key' ? ['의도적으로 불완전한 재시도', 'Deliberately incomplete retry'] : ['같은 요청을 유지한 복구', 'Recovery with the same intent'])}</p>
<h2>${both(text[scenario.id].title)}</h2>
<div class="count">${escape(effects(scenario))}<span>${both(['건의 예약', effects(scenario) === '1' ? 'reservation effect' : 'reservation effects'])}</span>
</div>
<p>${both(text[scenario.id].takeaway)}</p>
<a href="#${scenario.id}">${both(['실행 근거 보기', 'See the evidence'])} ↗</a>
</article>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Intent / Recovery — Experiment evidence</title>
<link rel="stylesheet" href="report.css">
<script src="report.js" defer>
</script>
</head>
<body>
<a class="skip" href="#results">${both(['결과로 바로가기', 'Skip to results'])}</a>
<header>
<a href="#top" class="brand">Intent / Recovery</a>
<div class="languages">
<button type="button" data-set-lang="ko" lang="ko" aria-pressed="false">한국어</button>
<button type="button" data-set-lang="en" lang="en" aria-pressed="true">EN</button>
</div>
</header>
<main id="top">
<section class="hero">
<p class="eyebrow">${both(['실제 실행으로 확인한 결과', 'Evidence from an actual execution'])}</p>
<h1>${both(['응답의 실패와\n예약의 실패는 다릅니다.', 'A lost response.\nNot necessarily a lost reservation.'])}</h1>
<p>${both(['같은 통신 실패 뒤, 어떤 요청을 다시 보내느냐가 결과를 바꿉니다. 실제 HTTP와 SQLite로 차이를 재현했습니다.', 'After the same transport failure, the identity of the retry changes the result. Real HTTP requests and SQLite records make the distinction observable.'])}</p>
</section>
<section id="results" class="comparison">${comparison}</section>
<p class="verdict ${report.passed ? '' : 'failed'}">${both(report.passed ? ['이번 실행은 모든 시나리오의 예상 결과를 재현했습니다.', 'This execution reproduced every scenario’s expected result.'] : ['이번 실행은 검증을 통과하지 못했습니다. 공개 성과의 근거로 사용하지 마세요.', 'This execution did not pass verification. Do not use it as evidence of success.'])}</p>
<section class="scenarios">
<h2>${both(['결과가 달라지는 경계', 'The boundaries that change the outcome'])}</h2>${rows}</section>
<section class="scope">
<h2>${both(['이 실험이 보장하는 범위', 'What this experiment establishes'])}</h2>
<p>${both(['기록을 보존하는 단일 SQLite 트랜잭션 안에서, 하나의 예약 요청 키는 최대 한 건의 예약만 만듭니다. 서로 다른 키의 의미상 중복 구매, 외부 결제의 원자성, 네트워크의 정확히 한 번 전달을 해결하지는 않습니다.', 'Within one SQLite transaction boundary and retained intent history, one intent creates at most one reservation effect. Different-key semantic duplicates, atomic external payments, and exactly-once network delivery are outside this claim.'])}</p>
<p>${both(['프로세스 종료를 재현했으며, 임의의 디스크 장애나 정전은 주입하지 않았습니다. 시간 값은 실행 순서를 이해하기 위한 관측값이며 성능 벤치마크가 아닙니다.', 'The harness injects process termination, not arbitrary disk failure or power loss. Timings describe this execution and are not performance benchmarks.'])}</p>
<p>${both(['재시도와 원자적 기록은 잘 알려진 패턴입니다. 이 작업의 초점은 클라이언트의 불확실성과 서버의 결과를 연결하고, 그 차이를 직접 재현하는 데 있습니다.', 'Idempotent retries and atomic records are established patterns. This lab focuses on connecting client uncertainty to durable outcomes and making that difference reproducible.'])}</p>
</section>
<section class="provenance">
<h2>${both(['다시 확인할 수 있는 근거', 'Traceable evidence'])}</h2>
<dl>
<dt>${both(['생성 시각', 'Generated'])}</dt>
<dd>
<time>${escape(report.completedAt)}</time>
</dd>
<dt>${both(['실행 환경', 'Runtime'])}</dt>
<dd>Node ${escape(report.runtime.node)} · SQLite ${escape(report.runtime.sqlite)} · ${escape(report.runtime.platform)} ${escape(report.runtime.architecture)}</dd>
<dt>${both(['소스 SHA-256', 'Source SHA-256'])}</dt>
<dd class="hash">${escape(report.sourceBefore.sha256)}</dd>
<dt>${both(['실행 전후 소스', 'Source before / after'])}</dt>
<dd>${both(report.sourceStable ? ['동일한 파일 내용', 'Identical observed file contents'] : ['변경 감지 — 검증 실패', 'Changed — verification failed'])}</dd>
<dt>Git</dt>
<dd class="hash">${escape(report.sourceBefore.git.head ?? report.sourceBefore.git.state)}${report.sourceBefore.git.dirty === undefined ? '' : report.sourceBefore.git.dirty ? ' · dirty' : ' · clean'}</dd>
</dl>
<p class="note">${both(['파일 해시는 실행 전후의 소스 관측입니다. 실행 증명이나 서명이 아니며, 중간에 바뀌었다가 원복된 파일까지 탐지하지 않습니다. 이 명령은 전체 테스트 모음을 실행하지 않습니다.', 'The file digest records source observations before and after the run. It is not execution attestation or a signature; edits reverted between snapshots are not detected. This command does not run the full test suite.'])}</p>
<a href="evidence.json" download>${both(['전체 JSON 근거 다운로드', 'Download complete JSON evidence'])} ↓</a>
</section>
</main>
<footer>${both(['독립적으로 설계한 합성 데이터 기반 개인 실험. 회사 내부 구현이나 실제 고객 데이터는 포함하지 않습니다.', 'An independently designed personal experiment with synthetic data. No employer implementation or real customer data.'])}</footer>
</body>
</html>`;
}
