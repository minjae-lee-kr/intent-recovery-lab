import type { EventName, Issue, Phase, StoragePort } from './model.ts';
export type Language = 'ko' | 'en';
export const LANGUAGE_KEY = 'intent-recovery.language.v1';
export function initialLanguage(storage: StoragePort, browserLanguage: string): Language {
  try {
    const saved = storage.getItem(LANGUAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    /* The current tab remains usable without storage access. */
  }
  return browserLanguage.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}
export const en = {
  brand: 'Intent / Recovery',
  skip: 'Skip to the experiment',
  language: 'Display language',
  eyebrow: 'A small experiment in uncertain outcomes',
  headlineA: 'The response disappeared.',
  headlineB: 'The reservation didn’t.',
  intro:
    'Lose a response after the server saves a reservation. Recover the same intent—and inspect why retrying does not create another one.',
  original:
    'An original, synthetic personal lab. No real bookings, payments, or employer implementation.',
  step: 'THE RESERVATION',
  offer: 'A little room to make something.',
  offerDetail:
    'An imaginary creative workshop. One offer, limited places, a real local transaction.',
  quantity: 'Places',
  quantityUnknown: 'Not known yet',
  place: 'place',
  places: 'places',
  quantityLocked: 'The command stays bound to this intent.',
  create: 'Prepare reservation',
  submit: 'Send reservation',
  retry: 'Retry this reservation',
  recover: 'Check saved outcome',
  waiting: 'Waiting for a response…',
  checking: 'Checking saved outcome…',
  stop: 'Stop waiting',
  separate: 'Start a separate reservation',
  separateWarning:
    'The earlier reservation may still complete. A separate intent can create another reservation; it will not replace or cancel the earlier one.',
  separateReady:
    'A new intent represents a separate reservation. The saved result stays in the journal.',
  createExplanation:
    'First, save a recovery key and the reservation details in this browser. Then send the request.',
  readyExplanation: 'This intent is saved locally. This page has not submitted it yet.',
  sendingExplanation:
    'The server may finish even if the connection ends. This screen waits for evidence.',
  unknownExplanation:
    'The connection did not establish an outcome. Keep this intent and ask the server what it saved.',
  checkingExplanation:
    'Reading the outcome for this exact intent. A lookup never creates a reservation.',
  confirmedExplanation:
    'A matching server outcome confirms this reservation. Recovering it does not create another effect.',
  rejectedExplanation:
    'The server saved a terminal capacity rejection. Retrying this intent cannot turn it into a new reservation.',
  clientTitle: 'What this browser knows',
  serverTitle: 'What the server saved',
  clientLabel: 'CLIENT OBSERVATION',
  serverLabel: 'DURABLE JOURNAL',
  noIntent: 'Start a reservation',
  noServerIntent: 'No reservation request yet',
  noRecord: 'No saved outcome observed',
  serverConfirmed: 'Reservation committed',
  serverRejected: 'Rejection recorded',
  serverUnavailable: 'Journal unavailable',
  serverLoading: 'Reading the journal…',
  serverExplanation:
    'This diagnostic view is separate from recovery. Refreshing it does not change what the client has confirmed.',
  staleLedger: 'Last readable snapshot. The latest refresh did not succeed.',
  refresh: 'Refresh journal',
  effect: 'Effects for this intent',
  remaining: 'Places remaining',
  receipt: 'Receipt',
  sequence: 'Journal entry',
  intent: 'Stable intent key',
  request: 'HTTP attempt',
  copy: 'Copy recovery link',
  copied: 'Link copied',
  copyFailed: 'Copy unavailable. Use the link below.',
  openTab: 'Open this reservation in another tab',
  restoreNote:
    'Reloading or sharing this link preserves the intent. It does not submit a new reservation.',
  identityNote:
    'The intent key stays the same across retries. Each HTTP attempt gets a new request number; it does not represent a separate reservation.',
  experiment: 'Experiment controls',
  fault: 'Fault for the next submission',
  faultNone: 'No injected fault',
  faultBefore: 'Lose connection before commit',
  faultAfter: 'Lose response after commit',
  faultDelay: 'Delay commit beyond client timeout',
  faultNote:
    'The selected fault applies to one submission, then resets to none. Ordinary retries do not repeat it. Outcome lookups never inject a submission fault.',
  timeoutNote:
    'The client timeout is 450 ms, a deliberate fixture setting—not a performance result.',
  appReturn: 'Simulate an app return',
  appReturnNote:
    'A correlated return only triggers a lookup. The callback never creates or confirms a reservation.',
  trace: 'Inspect the decision trail',
  traceEmpty: 'Create an intent to begin.',
  traceLabel: 'Decision trail',
  preserved: 'One reservation request. One saved outcome.',
  limits:
    'One local SQLite transaction, retained intent history. Different intent keys may create separate reservations. This is not exactly-once network delivery or a payment system.',
  unavailableCommand:
    'No usable local command is available. Read the existing outcome first; submitting is disabled.',
  stateReady: 'Ready to send',
  stateSending: 'Awaiting evidence',
  stateUnknown: 'Outcome unknown',
  stateReconciling: 'Looking up the outcome',
  stateConfirmed: 'Reservation confirmed',
  stateRejected: 'No capacity available',
  startOver: 'A separate reservation',
  metadata: 'Technical details and recovery link',
};
export const ko: Record<keyof typeof en, string> = {
  brand: 'Intent / Recovery',
  skip: '실험으로 바로가기',
  language: '표시 언어',
  eyebrow: '불확실한 결과를 다루는 작은 실험',
  headlineA: '응답은 사라졌지만,',
  headlineB: '예약은 남아 있습니다.',
  intro:
    '서버가 예약을 저장한 직후 응답을 끊어 보세요. 같은 예약 요청으로 결과를 복구하고, 재시도가 예약을 하나 더 만들지 않는 이유를 확인합니다.',
  original:
    '직접 설계한 합성 데이터 기반 개인 프로젝트입니다. 실제 예약·결제나 회사의 구현을 포함하지 않습니다.',
  step: '하나의 예약',
  offer: '무언가를 만드는 작은 시간.',
  offerDetail: '가상의 창작 워크숍. 하나의 상품과 제한된 정원, 실제 로컬 트랜잭션으로 진행합니다.',
  quantity: '예약 인원',
  quantityUnknown: '아직 확인되지 않음',
  place: '명',
  places: '명',
  quantityLocked: '이 예약 요청에 연결된 인원은 바뀌지 않습니다.',
  create: '예약 준비하기',
  submit: '예약 요청 보내기',
  retry: '같은 예약 요청으로 재시도',
  recover: '저장된 결과 확인',
  waiting: '응답을 기다리고 있습니다…',
  checking: '저장된 결과를 확인하고 있습니다…',
  stop: '기다리기 중단',
  separate: '별도의 예약 시작',
  separateWarning:
    '이전 예약이 아직 완료될 수 있습니다. 별도로 시작하면 예약이 하나 더 만들어질 수 있으며, 이전 예약을 대체하거나 취소하지 않습니다.',
  separateReady: '새 예약 요청은 별도의 예약을 뜻합니다. 이미 저장된 결과는 기록에 남습니다.',
  createExplanation:
    '먼저 복구에 필요한 식별자와 예약 내용을 이 브라우저에 저장합니다. 그다음 서버로 전송합니다.',
  readyExplanation:
    '예약 요청이 이 브라우저에 저장되었습니다. 이 화면에서는 아직 예약을 전송하지 않았습니다.',
  sendingExplanation:
    '연결이 끊겨도 서버 처리는 완료될 수 있습니다. 이 화면은 결과를 확인할 근거를 기다립니다.',
  unknownExplanation:
    '연결 상태만으로는 결과를 알 수 없습니다. 같은 예약 요청을 유지하고 서버에 저장된 결과를 확인하세요.',
  checkingExplanation:
    '이 예약 요청에 해당하는 결과를 읽고 있습니다. 조회는 새 예약을 만들지 않습니다.',
  confirmedExplanation:
    '이 예약 요청과 일치하는 서버 결과를 확인했습니다. 같은 결과를 복구해도 예약은 추가되지 않습니다.',
  rejectedExplanation:
    '서버에 정원 부족 결과가 저장되었습니다. 같은 예약 요청을 재시도해도 새로운 예약으로 바뀌지 않습니다.',
  clientTitle: '브라우저가 아는 결과',
  serverTitle: '서버에 저장된 결과',
  clientLabel: '클라이언트의 관측',
  serverLabel: '영속 기록',
  noIntent: '예약을 시작해 보세요',
  noServerIntent: '아직 예약 요청이 없습니다',
  noRecord: '저장된 결과가 아직 보이지 않습니다',
  serverConfirmed: '예약이 저장되었습니다',
  serverRejected: '거절 결과가 기록되었습니다',
  serverUnavailable: '기록을 읽을 수 없습니다',
  serverLoading: '기록을 읽고 있습니다…',
  serverExplanation:
    '복구와 별개인 진단 화면입니다. 이 기록을 새로 읽어도 클라이언트가 확인한 결과는 바뀌지 않습니다.',
  staleLedger: '마지막으로 읽은 기록입니다. 최근 갱신에는 실패했습니다.',
  refresh: '기록 새로 읽기',
  effect: '이 예약 요청으로 생성된 예약',
  remaining: '남은 정원',
  receipt: '예약 확인 번호',
  sequence: '기록 순번',
  intent: '예약 의도(intent) 키',
  request: 'HTTP 요청',
  copy: '예약 복구 링크 복사',
  copied: '링크를 복사했습니다',
  copyFailed: '복사할 수 없습니다. 아래 링크를 이용하세요.',
  openTab: '다른 탭에서 같은 예약 열기',
  restoreNote:
    '새로고침하거나 링크를 공유해도 같은 예약 요청을 유지합니다. 새 예약을 전송하지 않습니다.',
  identityNote:
    '재시도해도 예약 의도(intent) 키는 유지됩니다. HTTP 요청 번호는 새로 생기지만, 별도의 예약을 뜻하지 않습니다.',
  experiment: '실험 설정',
  fault: '다음 전송에 적용할 장애',
  faultNone: '장애 주입 없음',
  faultBefore: '커밋 전에 연결 끊기',
  faultAfter: '커밋 후 응답 유실',
  faultDelay: '클라이언트 제한 시간보다 늦게 커밋',
  faultNote:
    '선택한 장애는 한 번 전송한 뒤 해제됩니다. 재시도에 자동으로 반복되지 않으며, 결과 조회에는 전송 장애를 주입하지 않습니다.',
  timeoutNote: '클라이언트 제한 시간 450ms는 실험을 위한 설정이며, 성능 측정 결과가 아닙니다.',
  appReturn: '앱에서 돌아오기 재현',
  appReturnNote:
    '현재 예약 요청과 연결된 복귀는 조회만 실행합니다. 복귀 신호로 예약을 생성하거나 확정하지 않습니다.',
  trace: '판단 과정 펼쳐보기',
  traceEmpty: '예약을 준비하면 기록이 시작됩니다.',
  traceLabel: '판단 과정',
  preserved: '하나의 예약 요청, 달라지지 않는 결과.',
  limits:
    '로컬 SQLite 트랜잭션과 보존된 예약 요청 기록 안에서 동작합니다. 서로 다른 키는 별도 예약을 만들 수 있습니다. 네트워크의 정확히 한 번 전달이나 결제 시스템을 구현한 것은 아닙니다.',
  unavailableCommand:
    '사용할 수 있는 로컬 요청 내용이 없습니다. 먼저 기존 결과를 조회하세요. 전송은 비활성화됩니다.',
  stateReady: '전송할 준비가 되었습니다',
  stateSending: '결과 확인을 기다립니다',
  stateUnknown: '아직 결과를 알 수 없습니다',
  stateReconciling: '결과를 조회하고 있습니다',
  stateConfirmed: '예약을 확인했습니다',
  stateRejected: '예약 가능한 정원이 없습니다',
  startOver: '별도의 예약 시작',
  metadata: '기술 정보와 복구 링크',
};
export const issues: Record<Language, Record<Issue, string>> = {
  en: {
    transport:
      'The response was not received. The server may already have committed. Check the saved outcome or retry the same intent.',
    timeout:
      'The client stopped waiting after 450 ms. The server may still complete; a timeout is not a rejection.',
    stopped: 'You stopped waiting, not the server transaction. The reservation may still complete.',
    unseen:
      'No outcome was visible at lookup time. An earlier request may still commit. Keep this intent when you retry.',
    'invalid-response':
      'The response could not be validated for this intent and command. No outcome has been inferred.',
    conflict:
      'The server already knows this key with a different command. Do not replace the key to disguise the conflict; inspect the existing outcome.',
    'server-unavailable':
      'The server could not establish an outcome. Preserve this intent and check again.',
    'request-refused':
      'The request was refused. This does not establish what an earlier request did; preserve the intent and inspect its outcome.',
    'context-missing':
      'This link identifies an intent, but this browser has no saved command. You can read its server outcome; no new request will be submitted.',
    'context-corrupt':
      'The saved command cannot be validated. Read the existing outcome; do not silently replace this intent.',
    'storage-unavailable':
      'This browser could not save the recovery context. No new submission was sent. Existing outcomes can still be read.',
    'invalid-link': 'This link does not contain a valid intent key. No request has been sent.',
    'restore-unpersisted':
      'The server outcome is confirmed, but this browser could not save the recovery context. Keep the intent link to read it again.',
  },
  ko: {
    transport:
      '응답을 받지 못했습니다. 서버에는 이미 저장되었을 수 있습니다. 저장된 결과를 확인하거나 같은 예약 요청으로 재시도하세요.',
    timeout:
      '클라이언트가 450ms 후 기다리기를 멈췄습니다. 서버는 계속 처리할 수 있으며, 시간 초과는 거절을 뜻하지 않습니다.',
    stopped: '서버 트랜잭션이 아니라 기다리기만 중단했습니다. 예약은 계속 진행될 수 있습니다.',
    unseen:
      '조회 시점에 저장된 결과가 보이지 않았습니다. 앞선 요청이 아직 완료될 수 있으므로 재시도할 때도 같은 예약 요청을 유지하세요.',
    'invalid-response':
      '응답이 이 예약 요청과 요청 내용에 맞는지 검증할 수 없습니다. 결과를 추정하지 않았습니다.',
    conflict:
      '서버에 같은 키로 다른 요청 내용이 등록되어 있습니다. 새 키로 충돌을 숨기지 말고 기존 결과를 확인하세요.',
    'server-unavailable':
      '서버에서 결과를 확인할 수 없습니다. 예약 요청을 유지하고 다시 조회하세요.',
    'request-refused':
      '요청이 거부되었습니다. 앞선 요청의 처리 결과까지 알 수 있는 것은 아닙니다. 같은 예약 요청을 유지하고 결과를 조회하세요.',
    'context-missing':
      '링크에 예약 식별자가 있지만 이 브라우저에는 요청 내용이 없습니다. 기존 서버 결과를 조회할 수 있으며 새 예약 요청은 전송하지 않습니다.',
    'context-corrupt':
      '저장된 요청 내용을 검증할 수 없습니다. 기존 결과를 조회하세요. 예약 요청을 자동으로 바꾸지 않습니다.',
    'storage-unavailable':
      '이 브라우저에 복구 정보를 저장할 수 없어 새 예약 요청은 전송하지 않았습니다. 기존 결과는 조회할 수 있습니다.',
    'invalid-link': '유효한 예약 요청 키가 없는 링크입니다. 요청을 전송하지 않았습니다.',
    'restore-unpersisted':
      '서버 결과는 확인했지만 복구 정보를 브라우저에 저장하지 못했습니다. 링크를 보관하면 다시 조회할 수 있습니다.',
  },
};
export const events: Record<Language, Record<EventName, string>> = {
  en: {
    created: 'Intent and command saved locally',
    submitted: 'Same intent sent to the server',
    lookup: 'Read-only outcome lookup started',
    confirmed: 'Matching committed outcome accepted',
    rejected: 'Matching capacity rejection accepted',
    unknown: 'Outcome remains unknown',
    unseen: 'No outcome observed at lookup time',
    stopped: 'Local waiting stopped; server unchanged',
    timeout: 'Client deadline reached; server outcome unknown',
    stale: 'Older response ignored',
    hint: 'App-return hint received; lookup only',
    'ignored-hint': 'Unrelated or redundant return ignored',
    restored: 'Command recovered from server outcome',
  },
  ko: {
    created: '예약 요청과 요청 내용을 로컬에 저장',
    submitted: '같은 예약 요청으로 서버에 전송',
    lookup: '읽기 전용 결과 조회 시작',
    confirmed: '일치하는 예약 확정 결과 확인',
    rejected: '일치하는 정원 부족 결과 확인',
    unknown: '결과를 아직 알 수 없음',
    unseen: '조회 시점에 저장된 결과가 없음',
    stopped: '기다리기 중단 · 서버 처리는 취소하지 않음',
    timeout: '클라이언트 제한 시간 도달 · 서버 결과는 미확인',
    stale: '오래된 응답을 반영하지 않음',
    hint: '앱 복귀 신호 수신 · 조회만 실행',
    'ignored-hint': '관계없거나 중복된 복귀 신호 무시',
    restored: '서버 결과에서 요청 내용 복구',
  },
};
export function phaseLabel(phase: Phase, language: Language) {
  const t = language === 'ko' ? ko : en;
  return {
    idle: t.stateReady,
    sending: t.stateSending,
    unknown: t.stateUnknown,
    reconciling: t.stateReconciling,
    confirmed: t.stateConfirmed,
    rejected: t.stateRejected,
  }[phase];
}
