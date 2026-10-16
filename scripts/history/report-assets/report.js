(() => {
  'use strict';
  const localeKey = 'minjae.portfolio.language',
    stateKey = 'minjae.history.presentation';
  let lang = navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
  try {
    const saved = localStorage.getItem(localeKey);
    if (saved === 'ko' || saved === 'en') lang = saved;
  } catch {}
  const data = window.HISTORY_RECORDING;
  const state = {
    seed: data?.report?.runs?.[0]?.seed,
    view: 'comparison',
    open: [],
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(stateKey));
    if (saved && data?.report.runs.some((r) => r.seed === saved.seed)) state.seed = saved.seed;
    if (saved?.view === 'uncertainty') state.view = saved.view;
    if (Array.isArray(saved?.open)) state.open = saved.open.filter((x) => typeof x === 'string');
  } catch {}
  const copy = {
    ko: {
      skip: '결과로 바로가기',
      historyLabel: '관측 기록',
      eyebrow: '하나의 장부 · 서로 다른 관측',
      title: '장부가 맞아도,\n조회는 틀릴 수 있습니다.',
      intro:
        '예약 완료 뒤의 조회가 ‘없음’이라고 답한다면? 최종 상태가 같아도, 사용자가 본 기록은 다릅니다.',
      resultHeading: '같은 기록을 두 가지로 읽기',
      seed: '실행 시드',
      comparisonTab: '완료된 예약의 조회',
      uncertaintyTab: '타임아웃 뒤의 조회',
      seedNote:
        '시드는 요청 구성과 발송 순서를 반복합니다. OS 스케줄과 실제 커밋 순서를 재생하지 않습니다.',
      footer: '가상 데이터로 실행한 로컬 실험입니다. 현재 시스템에 연결하지 않습니다.',
      rawReport: '전체 원본 JSON',
      recordingSource: '기록 출처',
      loading: '저장된 실행 기록을 읽고 있습니다.',
      language: '언어',
      viewLabel: '설명 선택',
      clean: '기록된 로컬 실행 · 소스 변경 없음',
      dirty: '설계 검토용 기록 · 커밋되지 않은 소스',
      unstable: '실행 중 소스가 변경됨 · 결과 확정 불가',
      originalLabel: '실제 HTTP 관측',
      originalTitle: '확인된 예약을 다시 찾음',
      originalLead: '서로 다른 서버 프로세스가 같은 SQLite 파일을 사용합니다.',
      controlLabel: '의도적으로 바꾼 대조군',
      controlTitle: '같은 조회를 ‘없음’으로 변경',
      controlLead: '서버를 다시 실행한 결과가 아닙니다. 기록된 GET 응답 한 건만 바꿨습니다.',
      confirmed: '예약 완료 응답',
      lookupStart: '그 응답 뒤, 같은 예약 조회',
      found: '같은 예약이 확인됨',
      unseen: '예약이 없다고 응답',
      ledgerGood: '최종 장부 검사는 정상',
      ledgerBad: '최종 장부 검사 미충족',
      ledgerDetail: '보존된 요청 {intents}건 · 남은 정원 {remaining}',
      event: '관측 #{n}',
      injected: '의도적으로 바꾼 응답',
      witness: '가능한 실행 순서 있음',
      counterexample: '기록의 모순 발견',
      inconclusive: '판정에 필요한 근거 부족',
      invalid: '기록 형식·연결 확인 필요',
      originalMeaning: '이 유한한 기록에서 모델과 관측을 만족하는 순서가 하나 이상 있습니다.',
      controlMeaning: '예약 완료 뒤에 시작된 조회를 ‘없음’으로 설명할 수 없습니다.',
      unestablishedMeaning:
        '이 기록에서 예상한 검증 결과가 성립하지 않았습니다. 원본 판정을 확인하세요.',
      principleTitle: '같은 최종 장부. 서로 다른 결론.',
      principleBody:
        '상태 검사는 무엇이 남았는지 확인합니다. 관측 순서 검사는 사용자가 본 응답이 앞선 완료 결과와 양립하는지 확인합니다.',
      notEstablished: '이 대조군의 예상 결과가 확인되지 않았습니다.',
      mutationNote:
        '대조군은 검사기가 모순을 검출하는지 확인하기 위한 관측 변조입니다. 실제 서버에서 stale read 장애를 발견했다는 뜻이 아닙니다.',
      timelineLabel: '실제로 기록한 순서',
      timelineTitle: '대기가 끝나도, 쓰기는 끝나지 않을 수 있습니다.',
      timelineLead: '타임아웃은 실패한 예약이라는 응답이 아닙니다.',
      writeSent: '예약 요청 발송',
      waitEnded: '로컬 대기 종료 · 결과 미확정',
      unseenNow: '조회 시점에는 예약 없음',
      drained: '두 서버의 처리 완료와 종료 확인',
      closed: '최종 장부에서 예약 결과 확인',
      pending: '열린 구간: 이때 커밋 여부를 아직 단정할 수 없음',
      timeNote:
        '번호·시간은 관측 기록입니다. 점선은 불확실성을 설명하며 실제 커밋 시점을 나타내지 않습니다.',
      witnessLabel: '모델이 찾은 한 가지 설명',
      witnessTitle: '이런 순서라면 양립합니다.',
      witnessLead: '관측 시간선을 다시 재생한 것이 아닙니다.',
      possibleRead: '조회가 ‘없음’을 관측',
      possibleFound: '조회가 저장된 예약을 확인',
      possibleWrite: '이 위치에서 예약이 저장됐다고 가정',
      possibleOmit: '이 시도의 효과를 제외한다고 가정',
      possibleFinal: '마지막 장부와 일치',
      position: '가능한 순서의 {n}번째',
      witnessNote: '제시한 순서는 실제 커밋 순서나 어느 재시도가 저장했는지를 확정하지 않습니다.',
      timeoutPrinciple: '404는 그 순간의 관측입니다.',
      observedPatternTitle: '이 실행에서 실제로 관측한 응답',
      observedPatternBody:
        '이 시드에서는 필요한 ‘타임아웃 뒤 없음’ 패턴이 성립하지 않았습니다. 표시된 응답과 필수 실행 범위를 함께 확인하세요.',
      noWitness: '가능한 순서가 확정되지 않았습니다.',
      sparse:
        '이 기록에는 설명에 필요한 관측이 부족합니다. 결과를 확정할 수 없습니다. 원본 JSON을 확인하세요.',
      timeoutBody:
        '앞서 보낸 미확정 쓰기가 나중에 저장될 수 있습니다. 반대로, 완료된 조회 뒤에 호출한 쓰기로 과거 응답을 설명할 수는 없습니다.',
      allOps: '원본의 전체 {n}개 연산 펼치기',
      allOpsNote: '호출 순서로 정렬한 실제 기록입니다. 이 목록의 순서가 저장 순서는 아닙니다.',
      inspect: '검사 결과와 대조군 원본 보기',
      source: '소스·모델과 검증 범위',
      sourceNote:
        '기록된 결과이며 현재 저장소 상태를 실시간으로 확인하지 않습니다. 해시는 로컬 출처 정보이며 서명이나 실행 인증이 아닙니다.',
      originalRaw: '원본 기록 JSON',
      controlRaw: '의도적으로 바꾼 기록 JSON',
      checksHeading: '필수 실행 범위',
      reserve: '예약',
      lookup: '조회',
      snapshot: '최종 장부',
      quantity: '수량 {n}',
      unknown: '결과 미확정',
      conflict: '변경한 요청 충돌',
      rejected: '정원 부족 거절',
      confirmedStatus: '예약 확인',
      finalStatus: '장부 응답',
      anchor: '기준 예약',
      anchorRead: '완료 뒤 조회',
      late: '지연시킨 예약',
      earlyRead: '타임아웃 뒤 조회',
      lost: '응답을 잃은 예약',
      retry: '동일 요청 재시도',
      changed: '요청 내용 변경',
      fill: '정원 경쟁 요청 {n}',
      runTime: '기록 시각',
      sourceCommit: '소스 커밋',
      rendererRevision: '표시 코드 버전',
      rendererFingerprint: '표시 코드 SHA-256',
      rendererNote:
        '이 화면은 기존 기록을 나중에 표시한 결과입니다. 원래 실행한 소스와 화면을 만든 코드의 버전은 별도이며, 커밋되지 않은 표시 코드는 검토 중인 상태로 표기합니다.',
      rendererDraft: '커밋되지 않은 표시 코드',
      sourceDigest: '소스 SHA-256',
      evidenceDigest: '근거 SHA-256',
      model: '순차 모델',
      checker: '검사기',
      runtime: '실행 환경',
      stateGood: '확인됨',
      stateMissing: '미충족',
      coverageBoth: '두 서버 참여',
      coverageOverlap: '서버 간 요청 구간 중첩',
      coverageRetry: '동일 요청 재시도',
      coverageConflict: '변경 요청 충돌',
      coverageCapacity: '정원 부족 거절',
      coverageUnknown: '미확정 쓰기 두 건',
      coverageEarly: '동일 예약의 이른 조회',
      coverageRetained: '미확정 요청 결과 보존',
      coverageAnchor: '완료 뒤 동일 예약 조회',
      limits:
        '이 검사는 유한한 관측 기록의 가능한 설명을 찾습니다. 모든 실행, 진행 가능성, 정전 안전성, 외부 결제나 정확히 한 번의 효과를 증명하지 않습니다. 순서 재검증기는 별도로 순서·누락을 확인하되 같은 모델을 사용합니다. 작은 순열 비교기는 별도 모델입니다.',
      error:
        '저장된 실행 기록을 읽을 수 없습니다. 이 페이지는 읽기 전용이며 새 실험을 실행하지 않습니다. 배포된 JSON과 표시 파일을 확인해 주세요.',
    },
    en: {
      skip: 'Skip to results',
      historyLabel: 'Observed history',
      eyebrow: 'ONE LEDGER · DIFFERENT OBSERVATIONS',
      title: 'The ledger can balance.\nThe read can still be wrong.',
      intro:
        'A reservation is confirmed. A later lookup says it does not exist. The final state can match while the observed history does not.',
      resultHeading: 'Read the same record two ways',
      seed: 'Recorded seed',
      comparisonTab: 'A read after confirmation',
      uncertaintyTab: 'A read after timeout',
      seedNote:
        'A seed repeats workload choices and dispatch order. It does not replay OS scheduling or actual commit order.',
      footer: 'A recorded local experiment with synthetic data. No connection to a live system.',
      rawReport: 'Complete raw JSON',
      recordingSource: 'Recording source',
      loading: 'Reading the saved execution record.',
      language: 'Language',
      viewLabel: 'Choose an explanation',
      clean: 'Recorded local run · source unchanged',
      dirty: 'Design-review recording · uncommitted source',
      unstable: 'Source changed during execution · result not established',
      originalLabel: 'ACTUAL HTTP OBSERVATIONS',
      originalTitle: 'A confirmed reservation is found',
      originalLead: 'Two server processes share one local SQLite file.',
      controlLabel: 'DELIBERATELY MUTATED CONTROL',
      controlTitle: 'The same lookup becomes “unseen”',
      controlLead: 'This is not another server run. Only one recorded GET response was changed.',
      confirmed: 'Reservation confirmed',
      lookupStart: 'Then, look up that reservation',
      found: 'The same reservation is found',
      unseen: 'The response says it is absent',
      ledgerGood: 'Final ledger checks hold',
      ledgerBad: 'Final ledger checks do not hold',
      ledgerDetail: '{intents} retained intents · {remaining} places left',
      event: 'Observation #{n}',
      injected: 'Deliberately changed response',
      witness: 'A legal explanation exists',
      counterexample: 'The observations conflict',
      inconclusive: 'Evidence is insufficient',
      invalid: 'Evidence structure needs attention',
      originalMeaning: 'At least one legal order explains this finite recorded history.',
      controlMeaning:
        'A lookup invoked after confirmation cannot return “unseen” for that reservation.',
      unestablishedMeaning:
        'The expected result was not established in this record. Inspect the raw verdict.',
      principleTitle: 'The same final ledger. A different conclusion.',
      principleBody:
        'State checks ask what remains. History checks ask whether the observed responses can coexist with previously completed operations.',
      notEstablished: 'This control did not establish the expected result.',
      mutationNote:
        'The control tests whether the checker detects a contradiction in altered observer evidence. It is not a stale-read defect observed in the server.',
      timelineLabel: 'THE RECORDED OBSERVER ORDER',
      timelineTitle: 'The wait ends. The write may not.',
      timelineLead: 'A timeout is not a reservation-failed response.',
      writeSent: 'Reservation request sent',
      waitEnded: 'Local wait ends · outcome unknown',
      unseenNow: 'Lookup observes no reservation yet',
      drained: 'Both writers drained and exited',
      closed: 'Final ledger reveals the retained outcome',
      pending: 'Open interval: the commit outcome is not yet established',
      timeNote:
        'Numbers and times come from the observer. The dashed interval explains uncertainty; it does not locate the actual commit.',
      witnessLabel: 'ONE EXPLANATION FROM THE MODEL',
      witnessTitle: 'This order can explain it.',
      witnessLead: 'This is not a replay of the observed timeline.',
      possibleRead: 'The lookup observes absence',
      possibleFound: 'The lookup observes the retained reservation',
      possibleWrite: 'Assume the reservation takes effect here',
      possibleOmit: 'Assume this attempt has no effect',
      possibleFinal: 'The final snapshot agrees',
      position: 'Position {n} in a possible order',
      witnessNote:
        'This order does not establish the actual commit order or which overlapping retry created an effect.',
      timeoutPrinciple: 'A 404 is an observation at that moment.',
      observedPatternTitle: 'What this execution actually observed',
      observedPatternBody:
        'This seed did not establish the required unseen-after-timeout pattern. Read the recorded response together with workload coverage.',
      noWitness: 'No possible order was established.',
      sparse:
        'This record lacks observations needed for the explanation. The result is not established. Inspect the raw JSON.',
      timeoutBody:
        'An earlier pending write may take effect later. A write invoked after a completed read cannot explain that past response.',
      allOps: 'Expand all {n} original operations',
      allOpsNote: 'Actual records in invocation order. This list does not claim storage order.',
      inspect: 'Inspect verdicts and the raw control',
      source: 'Source, model and proof scope',
      sourceNote:
        'These are recorded results, not a live repository check. Hashes are local provenance observations, not signatures or execution attestation.',
      originalRaw: 'Original history JSON',
      controlRaw: 'Mutated observer history JSON',
      checksHeading: 'Required workload coverage',
      reserve: 'Reserve',
      lookup: 'Lookup',
      snapshot: 'Final ledger',
      quantity: 'Quantity {n}',
      unknown: 'Outcome unknown',
      conflict: 'Changed-command conflict',
      rejected: 'Capacity rejection',
      confirmedStatus: 'Confirmed',
      finalStatus: 'Ledger response',
      anchor: 'Anchor reservation',
      anchorRead: 'Read after confirmation',
      late: 'Delayed reservation',
      earlyRead: 'Read after timeout',
      lost: 'Reservation with a lost response',
      retry: 'Same-command retry',
      changed: 'Changed command',
      fill: 'Capacity contender {n}',
      runTime: 'Recorded at',
      sourceCommit: 'Source commit',
      rendererRevision: 'Renderer revision',
      rendererFingerprint: 'Renderer SHA-256',
      rendererNote:
        'This is a later rendering of an existing recording. The execution source and renderer have separate identities; uncommitted renderer code is explicitly marked as a draft.',
      rendererDraft: 'Uncommitted renderer',
      sourceDigest: 'Source SHA-256',
      evidenceDigest: 'Evidence SHA-256',
      model: 'Sequential model',
      checker: 'Checker',
      runtime: 'Runtime',
      stateGood: 'Observed',
      stateMissing: 'Missing',
      coverageBoth: 'Both writers',
      coverageOverlap: 'Cross-writer overlap',
      coverageRetry: 'Same-command retry',
      coverageConflict: 'Changed-command conflict',
      coverageCapacity: 'Capacity rejection',
      coverageUnknown: 'Two unknown writes',
      coverageEarly: 'Early read of the same intent',
      coverageRetained: 'Unknown intents retained',
      coverageAnchor: 'Read after acknowledged write',
      limits:
        'This checks possible explanations for finite observed histories. It does not prove all executions, liveness, power-loss safety, external payments or exactly-once effects. Witness replay separately checks order and coverage using the same model. The tiny permutation oracle has a separate model.',
      error:
        'The saved execution record could not be read. This page is read-only and does not run a new experiment. Check the packaged JSON and display files.',
    },
  };
  const t = (key, args = {}) =>
    Object.entries(args).reduce(
      (s, [k, v]) => s.replaceAll('{' + k + '}', String(v)),
      copy[lang][key] ?? key,
    );
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const append = (parent, ...children) => {
    parent.append(...children.filter(Boolean));
    return parent;
  };
  const getCall = (h, id) => h.events.find((e) => e.kind === 'invoke' && e.attemptId === id);
  const getEnd = (h, id) =>
    h.events.find((e) => ['http', 'unknown'].includes(e.kind) && e.attemptId === id);
  const eventText = (e) => `${t('event', { n: e.sequence })} · ${e.elapsedMs.toFixed(1)} ms`;
  const isUnknown = (e) => e.kind === 'unknown' || (e.kind === 'http' && e.status === 503);
  const resultLabel = (e) =>
    isUnknown(e)
      ? t('unknown')
      : e.status === 409
        ? t('conflict')
        : e.status === 404
          ? t('unseen')
          : e.body?.status === 'confirmed'
            ? t('confirmedStatus')
            : e.body?.status === 'rejected'
              ? t('rejected')
              : e.body?.intents
                ? t('finalStatus')
                : `HTTP ${e.status}`;
  function save() {
    try {
      sessionStorage.setItem(stateKey, JSON.stringify(state));
    } catch {}
  }
  function capture() {
    state.open = [
      ...document.querySelectorAll('#content details[open],#appendix details[open]'),
    ].map((x) => x.id);
    save();
  }
  function disclosure(id, title) {
    const d = el('details');
    d.id = id;
    d.open = state.open.includes(id);
    d.append(el('summary', '', title));
    d.addEventListener('toggle', () => {
      state.open = [
        ...document.querySelectorAll('#content details[open],#appendix details[open]'),
      ].map((x) => x.id);
      save();
    });
    return d;
  }
  function observeRow(event, title, detail, changed = false) {
    const li = el('li', changed ? 'changed' : '');
    const n = el('span', 'event-number', event.sequence);
    n.setAttribute('aria-hidden', 'true');
    return append(li, n, append(el('div'), el('strong', '', title), el('small', '', detail)));
  }
  function comparison(run, derived) {
    const section = el('div');
    const grid = el('div', 'comparison');
    for (const control of [false, true]) {
      const h = control ? run.staleReadControl.history : run.history,
        v = control ? run.staleReadControl.verdict : run.verdict;
      const card = el('article', 'card' + (control ? ' control' : ''));
      append(
        card,
        el('p', 'card-label', t(control ? 'controlLabel' : 'originalLabel')),
        el('h3', '', t(control ? 'controlTitle' : 'originalTitle')),
        el('p', 'card-lead', t(control ? 'controlLead' : 'originalLead')),
      );
      const first = getEnd(h, 'anchor'),
        query = getCall(h, 'anchor-read'),
        read = getEnd(h, 'anchor-read'),
        last = getEnd(h, 'final');
      const rows = el('ol', 'observations');
      rows.append(
        observeRow(
          first,
          first.body?.status === 'confirmed' ? t('confirmed') : resultLabel(first),
          `${eventText(first)} · HTTP ${first.status}`,
        ),
        observeRow(query, t('lookupStart'), eventText(query)),
        observeRow(
          read,
          resultLabel(read) === t('confirmedStatus') ? t('found') : resultLabel(read),
          `${eventText(read)} · HTTP ${read.status}${control ? ' · ' + t('injected') : ''}`,
          control,
        ),
        observeRow(
          last,
          t(
            (control ? derived.controlLedger : derived.originalLedger).ok
              ? 'ledgerGood'
              : 'ledgerBad',
          ),
          t('ledgerDetail', {
            intents: last.body.intents.length,
            remaining: last.body.remainingCapacity,
          }),
        ),
      );
      const meaning =
        v.status === 'witness' && !control
          ? 'originalMeaning'
          : v.status === 'counterexample' && control && run.verdict.status === 'witness'
            ? 'controlMeaning'
            : 'unestablishedMeaning';
      append(
        card,
        rows,
        append(el('div', 'verdict'), el('span', 'result', t(v.status)), el('p', '', t(meaning))),
      );
      grid.append(card);
    }
    const established =
      run.verdict.status === 'witness' &&
      run.staleReadControl.established &&
      derived.ledgerUnchanged &&
      derived.originalLedger.ok &&
      derived.controlLedger.ok;
    append(
      section,
      grid,
      append(
        el('div', 'principle'),
        el('strong', '', t(established ? 'principleTitle' : 'notEstablished')),
        el('p', '', t(established ? 'principleBody' : 'unestablishedMeaning')),
      ),
      el('p', 'scope-note', t('mutationNote')),
    );
    return section;
  }
  function uncertainty(run) {
    const section = el('div'),
      grid = el('div', 'uncertainty-grid'),
      observed = el('article', 'card'),
      hypothesis = el('article', 'card');
    const h = run.history,
      call = getCall(h, 'late'),
      end = getEnd(h, 'late'),
      read = getEnd(h, 'early-read'),
      fence = h.events.find((e) => e.kind === 'fence'),
      last = getEnd(h, 'final');
    const unseen = read.kind === 'http' && read.status === 404 && read.body?.status === 'unseen';
    const pending = isUnknown(end);
    const pattern = pending && unseen && run.coverage?.checks?.earlyUnseen === true;
    const retained = last.body?.intents?.find((row) => row.intentId === call.input.key);
    const hasWitness =
      run.verdict.status === 'witness' &&
      Array.isArray(run.verdict.witness) &&
      run.verdict.witness.length > 0;
    append(
      observed,
      el('p', 'card-label', t('timelineLabel')),
      el('h3', '', t(pending ? 'timelineTitle' : 'observedPatternTitle')),
      el('p', 'card-lead', t(pending ? 'timelineLead' : 'observedPatternBody')),
    );
    const timeline = el('ol', 'timeline');
    for (const [e, label, open] of [
      [call, t('writeSent'), false],
      [end, pending ? t('waitEnded') : resultLabel(end), pending],
      [read, unseen ? t('unseenNow') : resultLabel(read), pending && unseen],
      [fence, t('drained'), false],
      [last, retained ? t('closed') : resultLabel(last), false],
    ]) {
      const li = append(
        el('li', open ? 'pending' : ''),
        el('strong', '', label),
        el('small', '', eventText(e)),
      );
      if (e === end && pending) li.append(el('p', 'open-caption', t('pending')));
      timeline.append(li);
    }
    append(observed, timeline, el('p', 'scope-note', t('timeNote')));
    append(
      hypothesis,
      el('p', 'card-label', t('witnessLabel')),
      el('h3', '', t(hasWitness ? 'witnessTitle' : 'noWitness')),
      el('p', 'card-lead', t(hasWitness ? 'witnessLead' : 'unestablishedMeaning')),
    );
    const list = el('ol', 'witness');
    for (const [i, item] of (hasWitness ? run.verdict.witness : []).entries())
      if (['early-read', 'late', 'final'].includes(item.attemptId)) {
        const label =
          item.attemptId === 'early-read'
            ? unseen
              ? 'possibleRead'
              : read.body?.status === 'confirmed'
                ? 'possibleFound'
                : null
            : item.attemptId === 'late'
              ? item.decision === 'omit'
                ? 'possibleOmit'
                : 'possibleWrite'
              : 'possibleFinal';
        list.append(
          append(
            el('li', item.attemptId === 'late' ? 'hypothesis' : ''),
            el('small', '', t('position', { n: i + 1 })),
            el('strong', '', label ? t(label) : resultLabel(read)),
          ),
        );
      }
    if (!list.children.length) list.append(el('li', '', t(run.verdict.status)));
    append(hypothesis, list, el('p', 'scope-note', t('witnessNote')));
    append(grid, observed, hypothesis);
    return append(
      section,
      grid,
      append(
        el('div', 'principle'),
        el('strong', '', t(pattern ? 'timeoutPrinciple' : 'observedPatternTitle')),
        el('p', '', t(pattern ? 'timeoutBody' : 'observedPatternBody')),
      ),
    );
  }
  function opName(id) {
    const names = {
      anchor: 'anchor',
      'anchor-read': 'anchorRead',
      late: 'late',
      'early-read': 'earlyRead',
      lost: 'lost',
      retry: 'retry',
      changed: 'changed',
      final: 'snapshot',
    };
    return names[id] ? t(names[id]) : t('fill', { n: Number(id.split('-')[1]) + 1 });
  }
  function appendix(run, derived) {
    const box = el('div');
    const all = disclosure('all-operations', t('allOps', { n: derived.operationCount }));
    all.append(el('p', '', t('allOpsNote')));
    const list = el('ol', 'operation-list');
    for (const call of run.history.events.filter((e) => e.kind === 'invoke')) {
      const end = getEnd(run.history, call.attemptId);
      list.append(
        append(
          el('li'),
          el('strong', '', opName(call.attemptId)),
          el(
            'small',
            '',
            `${t(call.input.kind)}${call.input.quantity ? ' · ' + t('quantity', { n: call.input.quantity }) : ''} · ${resultLabel(end)}`,
          ),
          el(
            'code',
            '',
            `${call.attemptId} · #${call.sequence} → #${end.sequence} · ${call.target}`,
          ),
        ),
      );
    }
    all.append(list);
    box.append(all);
    const inspect = disclosure('raw-evidence', t('inspect')),
      links = el('div', 'raw-links');
    for (const [suffix, label] of [
      ['', 'originalRaw'],
      ['-stale-control', 'controlRaw'],
    ]) {
      const a = el('a', '', t(label));
      a.href = `seed-${run.seed}${suffix}.json`;
      links.append(a);
    }
    append(inspect, el('p', '', t('mutationNote')), links);
    const checks = el('div', 'checks');
    checks.setAttribute('aria-label', t('checksHeading'));
    const checkNames = {
      bothWritersObserved: 'coverageBoth',
      overlappingKnownWritesAcrossWriters: 'coverageOverlap',
      sameKeyRetry: 'coverageRetry',
      changedCommandConflict: 'coverageConflict',
      capacityRejection: 'coverageCapacity',
      twoUnknownWrites: 'coverageUnknown',
      earlyUnseen: 'coverageEarly',
      bothUnknownIntentsRetained: 'coverageRetained',
      acknowledgedReadAnchor: 'coverageAnchor',
    };
    for (const [key, value] of Object.entries(run.coverage.checks))
      checks.append(
        el(
          'span',
          value ? '' : 'missing',
          `${t(checkNames[key] ?? key)} · ${t(value ? 'stateGood' : 'stateMissing')}`,
        ),
      );
    const pre = el(
      'pre',
      '',
      JSON.stringify(
        {
          original: run.verdict,
          control: run.staleReadControl.verdict,
          controlEstablished: run.staleReadControl.established,
          finalLedgerUnchanged: derived.ledgerUnchanged,
          ledgerChecks: {
            original: derived.originalLedger,
            control: derived.controlLedger,
          },
          coverage: run.coverage,
        },
        null,
        2,
      ),
    );
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', t('inspect'));
    append(inspect, checks, pre);
    box.append(inspect);
    const source = disclosure('provenance', t('source'));
    append(source, el('p', '', t('sourceNote')));
    const metadata = el('dl', 'metadata'),
      r = data.recording;
    for (const [key, value, code] of [
      ['runTime', r.recordedAt],
      ['sourceCommit', r.sourceRevision, true],
      ['sourceDigest', r.sourceFingerprint, true],
      ['evidenceDigest', r.evidenceSha256, true],
      ['model', r.modelVersion],
      ['checker', r.checker],
      [
        'runtime',
        `Node ${data.report.runtime.node} · SQLite ${data.report.runtime.sqlite} · ${data.report.runtime.platform}/${data.report.runtime.architecture}`,
      ],
    ])
      append(
        metadata,
        el('dt', '', t(key)),
        code ? append(el('dd'), el('code', '', value)) : el('dd', '', value),
      );
    if (r.renderer) {
      append(
        metadata,
        el('dt', '', t('rendererRevision')),
        el(
          'dd',
          '',
          `${r.renderer.git?.head ?? '—'}${r.renderer.git?.dirty ? ' · ' + t('rendererDraft') : ''}`,
        ),
        el('dt', '', t('rendererFingerprint')),
        append(el('dd'), el('code', '', r.renderer.sha256)),
      );
      source.append(el('p', '', t('rendererNote')));
    }
    append(source, metadata, el('p', '', t('limits')));
    box.append(source);
    return box;
  }
  function render() {
    document.documentElement.lang = lang;
    document.title =
      lang === 'ko' ? 'Intent / Recovery — 관측 기록' : 'Intent / Recovery — Observed history';
    document.querySelectorAll('[data-copy]').forEach((n) => (n.textContent = t(n.dataset.copy)));
    document.getElementById('languages').setAttribute('aria-label', t('language'));
    document.getElementById('views').setAttribute('aria-label', t('viewLabel'));
    document
      .querySelectorAll('[data-language]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.language === lang)));
    document
      .querySelectorAll('[data-view]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    const warning = document.getElementById('run-warning');
    warning.hidden = false;
    warning.textContent = t('unestablishedMeaning');
    if (!Array.isArray(data?.report?.runs) || !data.report.runs.length) {
      document.getElementById('content').replaceChildren(el('p', 'error', t('error')));
      return;
    }
    const before = data.report.sourceBefore,
      after = data.report.sourceAfter;
    const sourceStable =
      data.recording?.sourceStable === true &&
      data.report.sourceStable === true &&
      typeof before?.sha256 === 'string' &&
      before.sha256 === after?.sha256 &&
      Array.isArray(before.files) &&
      JSON.stringify(before.files) === JSON.stringify(after.files) &&
      before.git?.head === after.git?.head;
    document.getElementById('recording-state').textContent = t(
      !sourceStable ? 'unstable' : data.recording.gitDirty ? 'dirty' : 'clean',
    );
    const time = document.getElementById('recording-date');
    time.dateTime = data.recording.recordedAt;
    time.textContent = new Date(data.recording.recordedAt).toLocaleString(
      lang === 'ko' ? 'ko-KR' : 'en-US',
      {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      },
    );
    const select = document.getElementById('seed');
    if (!select.options.length)
      for (const run of data.report.runs) {
        const option = el('option', '', run.seed);
        option.value = run.seed;
        select.append(option);
      }
    select.value = state.seed;
    const run = data.report.runs.find((r) => r.seed === state.seed),
      derived = data.derived?.find((r) => r.seed === state.seed);
    const complete = (r) => {
      const checks = Object.values(r.coverage?.checks ?? {});
      const evidence = data.derived?.find((row) => row.seed === r.seed);
      return (
        r.passed === true &&
        !r.executionError &&
        r.verdict?.status === 'witness' &&
        r.coverage?.complete === true &&
        checks.length > 0 &&
        checks.every((value) => value === true) &&
        r.staleReadControl?.established === true &&
        r.staleReadControl.verdict?.status === 'counterexample' &&
        evidence?.ledgerUnchanged === true &&
        evidence.originalLedger?.ok === true &&
        evidence.controlLedger?.ok === true
      );
    };
    warning.hidden =
      sourceStable && data.report.passed === true && data.report.runs.every(complete);
    const displayReady =
      run &&
      derived &&
      Array.isArray(run.history?.events) &&
      Array.isArray(run.staleReadControl?.history?.events) &&
      ['anchor', 'anchor-read', 'late', 'early-read', 'final'].every(
        (id) => getCall(run.history, id) && getEnd(run.history, id),
      ) &&
      run.history.events.some((e) => e.kind === 'fence') &&
      getEnd(run.history, 'final').body?.intents;
    if (!displayReady || run.verdict?.status === 'invalid') {
      warning.hidden = false;
      document
        .getElementById('content')
        .replaceChildren(
          el(
            'p',
            'error',
            run.verdict?.status === 'invalid'
              ? `${t('invalid')} ${t('unestablishedMeaning')}`
              : t('sparse'),
          ),
        );
      document.getElementById('appendix').replaceChildren();
      return;
    }
    document
      .getElementById('content')
      .replaceChildren(state.view === 'comparison' ? comparison(run, derived) : uncertainty(run));
    document.getElementById('appendix').replaceChildren(appendix(run, derived));
  }
  function safeRender() {
    try {
      render();
    } catch {
      const warning = document.getElementById('run-warning');
      warning.hidden = false;
      warning.textContent = t('unestablishedMeaning');
      document.getElementById('content').replaceChildren(el('p', 'error', t('sparse')));
      document.getElementById('appendix').replaceChildren();
    }
  }
  document.querySelectorAll('[data-language]').forEach((b) =>
    b.addEventListener('click', () => {
      capture();
      lang = b.dataset.language;
      try {
        localStorage.setItem(localeKey, lang);
      } catch {}
      safeRender();
    }),
  );
  document.querySelectorAll('[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      capture();
      state.view = b.dataset.view;
      save();
      safeRender();
    }),
  );
  document.getElementById('seed').addEventListener('change', (e) => {
    capture();
    state.seed = Number(e.target.value);
    save();
    safeRender();
  });
  window.addEventListener('pageshow', () => {
    try {
      const saved = localStorage.getItem(localeKey);
      if ((saved === 'ko' || saved === 'en') && saved !== lang) {
        capture();
        lang = saved;
        safeRender();
      }
    } catch {}
  });
  safeRender();
})();
