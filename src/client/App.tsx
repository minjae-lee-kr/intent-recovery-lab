import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Fault, LedgerView } from '../protocol.ts';
import { createClient, isLedger } from './model.ts';
import type { Client, StoragePort } from './model.ts';
import { createCopyFeedback, visibleQuantity } from './feedback.ts';
import { en, ko, events, issues, initialLanguage, LANGUAGE_KEY, phaseLabel } from './i18n.ts';
import type { Language } from './i18n.ts';

const browserStorage: StoragePort = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
function fromUrl() {
  return new URL(location.href).searchParams.get('intent');
}
function browserClient() {
  return createClient({
    storage: browserStorage,
    http: (path, init) => fetch(path, init),
    intentId: fromUrl(),
    createId: () => crypto.randomUUID(),
    onIntent: (id) => {
      const url = new URL(location.href);
      url.searchParams.set('intent', id);
      history.pushState(null, '', url);
    },
  });
}
function useLedger(refreshKey: string) {
  const [view, setView] = useState<LedgerView | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(() => {
    const id = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    // Diagnostic reads are independent of the intentionally short product deadline.
    const timer = setTimeout(() => abort.abort(), 3_000);
    void fetch('/api/ledger', { cache: 'no-store', signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('ledger');
        const body: unknown = await response.json();
        if (!isLedger(body)) throw new Error('ledger');
        if (latest.current === id) {
          setView(body);
          setFailed(false);
        }
      })
      .catch(() => {
        if (latest.current === id) setFailed(true);
      })
      .finally(() => {
        clearTimeout(timer);
        if (latest.current === id) setLoading(false);
      });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);
  useEffect(
    () => () => {
      ++latest.current;
      controller.current?.abort();
    },
    [],
  );
  return { view, failed, loading, refresh };
}
function Arrow() {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">
      <path
        d="M4 10h11M10 5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Mark() {
  return (
    <svg width="29" height="29" viewBox="0 0 29 29" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="27" height="27" rx="8" stroke="currentColor" />
      <path
        d="M8 14.5h5m3 0h5M14.5 8v5m0 3v5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Artwork() {
  return (
    <svg className="workshop-art" viewBox="0 0 152 128" fill="none" aria-hidden="true">
      <path d="m36 100 40-18 40 18-40 19-40-19Z" fill="#DDE7F6" />
      <path d="M43 37 76 20l33 17v45L76 99 43 82V37Z" fill="#EEF3FB" stroke="#91ACD0" />
      <path d="m43 37 33 17 33-17M76 54v45" stroke="#91ACD0" />
      <path d="m54 31 33 17M65 25l33 17M54 42v45M65 48v45M87 48v45M98 42v45" stroke="#BCD0E8" />
      <circle cx="115" cy="22" r="5" fill="#1C5EE0" />
      <path d="M114 67v13m-5-7h11" stroke="#1C5EE0" strokeWidth="1.5" />
    </svg>
  );
}
function Quantity({
  value,
  onChange,
  disabled,
  label,
  id,
  language,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label: string;
  id: string;
  language: Language;
}) {
  return (
    <label className="quantity" htmlFor={id}>
      <span>{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {[1, 2, 3].map((number) => (
          <option key={number} value={number}>
            {language === 'ko' ? `${number}명` : `${number} ${number === 1 ? 'place' : 'places'}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export function App({ suppliedClient }: { suppliedClient?: Client }) {
  const [client] = useState(() => suppliedClient ?? browserClient());
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [language, setLanguage] = useState<Language>(() =>
    initialLanguage(browserStorage, navigator.language),
  );
  const [quantity, setQuantity] = useState(1);
  const [fault, setFault] = useState<Fault>(() =>
    state.context?.attempted || state.phase === 'unknown' ? 'none' : 'drop-after-commit',
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copyFeedback] = useState(() => createCopyFeedback(client.getSnapshot().intentId));
  const primaryButton = useRef<HTMLButtonElement | null>(null);
  const outcomeHeading = useRef<HTMLHeadingElement | null>(null);
  const focusHandoff = useRef<HTMLButtonElement | null>(null);
  const t = language === 'ko' ? ko : en;
  const shownQuantity = visibleQuantity(state, quantity);
  const busy = state.phase === 'sending' || state.phase === 'reconciling';
  const ledger = useLedger(
    `${state.intentId ?? ''}:${state.phase}:${state.outcome?.journalSequence ?? ''}`,
  );
  const saved = ledger.view?.intents.find((outcome) => outcome.intentId === state.intentId);
  const effectCount = ledger.view?.effects.filter(
    (effect) => effect.intentId === state.intentId,
  ).length;
  const faultLabel = {
    none: t.faultNone,
    'drop-before-commit': t.faultBefore,
    'drop-after-commit': t.faultAfter,
    'delay-before-commit': t.faultDelay,
  };
  const explanations = {
    idle: state.intentId ? t.readyExplanation : t.createExplanation,
    sending: t.sendingExplanation,
    unknown: t.unknownExplanation,
    reconciling: t.checkingExplanation,
    confirmed: t.confirmedExplanation,
    rejected: t.rejectedExplanation,
  };
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = `${t.brand} — ${language === 'ko' ? '응답 이후의 결과' : 'Beyond the response'}`;
    try {
      browserStorage.setItem(LANGUAGE_KEY, language);
    } catch {
      /* Keep the current tab's choice. */
    }
  }, [language, t.brand]);
  useEffect(() => {
    const onPop = () => {
      const intentId = fromUrl();
      // In-page anchors also produce history events. They must not erase a
      // confirmed outcome or an in-flight request for the same recovery handle.
      if (intentId !== client.getSnapshot().intentId) client.load(intentId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [client]);
  useEffect(() => {
    // Observe every model transition, including A → B → A within one React batch.
    const syncIntent = () => {
      if (copyFeedback.observeIntent(client.getSnapshot().intentId)) setCopyState('idle');
    };
    syncIntent();
    const unsubscribe = client.subscribe(syncIntent);
    return () => {
      unsubscribe();
      copyFeedback.invalidate();
    };
  }, [client, copyFeedback]);
  useEffect(() => {
    // Disabling/removing an action can drop focus to body. Keep continuity only
    // while the user has not deliberately moved to another control or surface.
    const moved = (event: Event) => {
      const origin = focusHandoff.current;
      const target = event.target;
      if (!origin || !(target instanceof Node)) return;
      if (event.type === 'focusin' && target === document.body) return;
      if (!origin.contains(target)) focusHandoff.current = null;
    };
    document.addEventListener('focusin', moved, true);
    document.addEventListener('pointerdown', moved, true);
    return () => {
      document.removeEventListener('focusin', moved, true);
      document.removeEventListener('pointerdown', moved, true);
    };
  }, []);
  useEffect(() => {
    if (busy || !focusHandoff.current) return;
    const origin = focusHandoff.current;
    focusHandoff.current = null;
    const current = document.activeElement;
    if (current !== document.body && current !== null && !origin.contains(current)) return;
    const next = state.outcome ? outcomeHeading.current : primaryButton.current;
    next?.focus({ preventScroll: true });
  }, [busy, state.phase, state.intentId, state.outcome]);
  const act = (origin: HTMLButtonElement, action: () => void) => {
    focusHandoff.current = origin;
    action();
  };
  const create = () => {
    client.createIntent(quantity);
  };
  const send = () => {
    client.submit(fault);
    setFault('none');
  };
  // The first fault resets to none. Only an explicit new selection injects a
  // fault into a later retry; ordinary recovery never repeats it automatically.
  const retry = send;
  const primary = !state.intentId
    ? create
    : state.phase === 'idle'
      ? send
      : state.issue === 'unseen' && state.context
        ? retry
        : client.reconcile;
  const primaryLabel = !state.intentId
    ? t.create
    : state.phase === 'idle'
      ? t.submit
      : state.phase === 'sending'
        ? t.waiting
        : state.phase === 'reconciling'
          ? t.checking
          : state.issue === 'unseen' && state.context
            ? t.retry
            : t.recover;
  const copy = async () => {
    const attempt = copyFeedback.begin(client.getSnapshot().intentId);
    setCopyState('idle');
    try {
      await navigator.clipboard.writeText(location.href);
      if (copyFeedback.isCurrent(attempt, client.getSnapshot().intentId)) setCopyState('copied');
    } catch {
      if (copyFeedback.isCurrent(attempt, client.getSnapshot().intentId)) setCopyState('failed');
    }
  };
  return (
    <>
      <a className="skip-link" href="#experiment">
        {t.skip}
      </a>
      <header className="site-header">
        <a className="wordmark" href="#top">
          <Mark />
          <span>{t.brand}</span>
        </a>
        <div className="language-switch" role="group" aria-label={t.language}>
          <button
            type="button"
            lang="ko"
            aria-pressed={language === 'ko'}
            onClick={() => setLanguage('ko')}
          >
            한국어
          </button>
          <button
            type="button"
            lang="en"
            aria-pressed={language === 'en'}
            onClick={() => setLanguage('en')}
          >
            EN
          </button>
        </div>
      </header>
      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1 id="hero-title">
            {t.headlineA}
            <br />
            <span>{t.headlineB}</span>
          </h1>
          <p className="intro">{t.intro}</p>
        </section>
        <section className="experiment-grid" id="experiment" aria-label={t.step}>
          <div className="journey-card">
            <div className="offer">
              <div>
                <p className="eyebrow">{t.step}</p>
                <h2>{t.offer}</h2>
                <p>{t.offerDetail}</p>
              </div>
              <Artwork />
            </div>
            {shownQuantity === null ? (
              <div className="quantity">
                <span>{t.quantity}</span>
                <span>{t.quantityUnknown}</span>
              </div>
            ) : (
              <Quantity
                value={shownQuantity}
                onChange={setQuantity}
                disabled={Boolean(state.intentId)}
                label={t.quantity}
                id="quantity"
                language={language}
              />
            )}
            {state.context && <p className="quiet-note command-note">{t.quantityLocked}</p>}
            <div className="client-observation">
              <p className="eyebrow">{t.clientLabel}</p>
              <h3>{t.clientTitle}</h3>
              <div role="status" aria-live="polite" aria-atomic="true">
                <h4 className={`outcome-state ${state.phase}`} ref={outcomeHeading} tabIndex={-1}>
                  <span className="state-dot" aria-hidden="true" />
                  <strong>{state.intentId ? phaseLabel(state.phase, language) : t.noIntent}</strong>
                </h4>
              </div>
              <p className="explanation">{explanations[state.phase]}</p>
              {state.issue && (
                <p className="notice" role="status">
                  {issues[language][state.issue]}
                </p>
              )}
              {!state.context && state.intentId && (
                <p className="quiet-note">{t.unavailableCommand}</p>
              )}
              {!state.outcome && (
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    ref={primaryButton}
                    onClick={(event) => act(event.currentTarget, primary)}
                    disabled={busy}
                  >
                    <span>{primaryLabel}</span>
                    {busy ? <span className="spinner" aria-hidden="true" /> : <Arrow />}
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      className="text-button"
                      onClick={(event) => act(event.currentTarget, client.stopWaiting)}
                    >
                      {t.stop}
                    </button>
                  ) : (
                    state.phase === 'unknown' &&
                    state.context &&
                    state.issue !== 'unseen' && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={(event) => act(event.currentTarget, retry)}
                      >
                        {t.retry}
                      </button>
                    )
                  )}
                </div>
              )}
              {state.phase === 'idle' && state.intentId && (
                <p className="quiet-note selected-fault">
                  {t.fault}: {faultLabel[fault]}
                </p>
              )}
              {state.outcome && (
                <p className="preserved">
                  <span aria-hidden="true">✓</span> {t.preserved}
                </p>
              )}
            </div>
          </div>
          <aside className="evidence-card" aria-labelledby="server-heading">
            <div className="evidence-heading">
              <p className="eyebrow">{t.serverLabel}</p>
              <button
                className="refresh"
                type="button"
                onClick={ledger.refresh}
                disabled={ledger.loading}
              >
                {t.refresh}
                <span aria-hidden="true">↻</span>
              </button>
            </div>
            <h2 id="server-heading">{t.serverTitle}</h2>
            <div className={`server-state ${saved?.status ?? ''}`}>
              <div className="journal-symbol" aria-hidden="true">
                <span />
                <span />
                <span />
                <i />
              </div>
              <p>
                {!ledger.view
                  ? ledger.failed
                    ? t.serverUnavailable
                    : t.serverLoading
                  : !state.intentId
                    ? t.noServerIntent
                    : saved?.status === 'confirmed'
                      ? t.serverConfirmed
                      : saved?.status === 'rejected'
                        ? t.serverRejected
                        : t.noRecord}
              </p>
            </div>
            <dl className="metrics">
              <div>
                <dt>{t.effect}</dt>
                <dd>{ledger.view && state.intentId ? effectCount : '—'}</dd>
              </div>
              <div>
                <dt>{t.remaining}</dt>
                <dd>
                  {ledger.view ? ledger.view.remainingCapacity : '—'}
                  {ledger.view && <small> / {ledger.view.initialCapacity}</small>}
                </dd>
              </div>
            </dl>
            {saved && (
              <dl className="server-detail">
                <div>
                  <dt>{t.sequence}</dt>
                  <dd>#{saved.journalSequence}</dd>
                </div>
                {saved.receiptId && (
                  <div>
                    <dt>{t.receipt}</dt>
                    <dd className="mono">{saved.receiptId}</dd>
                  </div>
                )}
              </dl>
            )}
            <p className="quiet-note">{t.serverExplanation}</p>
            {ledger.failed && ledger.view && (
              <p className="ledger-warning" role="status">
                {t.staleLedger}
              </p>
            )}
          </aside>
        </section>
        <section className="under-grid" aria-label={t.experiment}>
          <div className="details-column">
            {state.intentId && (
              <details className="disclosure">
                <summary>{t.metadata}</summary>
                <dl className="intent-details">
                  <dt>{t.intent}</dt>
                  <dd className="mono">{state.intentId}</dd>
                  {state.outcome?.receiptId && (
                    <>
                      <dt>{t.receipt}</dt>
                      <dd className="mono">{state.outcome.receiptId}</dd>
                    </>
                  )}
                </dl>
                <p className="quiet-note">{t.identityNote}</p>
                <p className="quiet-note">{t.restoreNote}</p>
                <div className="share-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      void copy();
                    }}
                  >
                    {copyState === 'copied' ? t.copied : t.copy}
                  </button>
                  <a href={location.href} target="_blank" rel="noopener noreferrer">
                    {t.openTab}
                    <span aria-hidden="true"> ↗</span>
                  </a>
                </div>
                {copyState === 'failed' && (
                  <p className="quiet-note" role="status">
                    {t.copyFailed}
                  </p>
                )}
              </details>
            )}
            <details className="disclosure">
              <summary>{t.experiment}</summary>
              <label className="field-label" htmlFor="fault">
                {t.fault}
              </label>
              <select
                id="fault"
                className="fault-select"
                value={fault}
                onChange={(event) => setFault(event.target.value as Fault)}
                disabled={busy}
              >
                {(
                  [
                    'drop-after-commit',
                    'drop-before-commit',
                    'delay-before-commit',
                    'none',
                  ] as const
                ).map((value) => (
                  <option value={value} key={value}>
                    {faultLabel[value]}
                  </option>
                ))}
              </select>
              <p className="quiet-note">{t.faultNote}</p>
              <p className="quiet-note">{t.timeoutNote}</p>
              <button
                type="button"
                className="secondary"
                disabled={!state.intentId || Boolean(state.outcome)}
                onClick={(event) =>
                  act(event.currentTarget, () => {
                    if (state.intentId) client.appReturn(state.intentId);
                  })
                }
              >
                {t.appReturn}
                <Arrow />
              </button>
              <p className="quiet-note">{t.appReturnNote}</p>
            </details>
            {state.intentId && (
              <details className="disclosure separate-intent">
                <summary>{t.startOver}</summary>
                <p className="quiet-note">{state.outcome ? t.separateReady : t.separateWarning}</p>
                <Quantity
                  value={quantity}
                  onChange={setQuantity}
                  label={t.quantity}
                  id="separate-quantity"
                  language={language}
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={(event) => act(event.currentTarget, create)}
                >
                  {t.separate}
                  <Arrow />
                </button>
              </details>
            )}
          </div>
          <details className="disclosure trace-disclosure">
            <summary>{t.trace}</summary>
            {state.trace.length ? (
              <ol className="trace" aria-label={t.traceLabel}>
                {[...state.trace].reverse().map((entry) => (
                  <li key={entry.sequence}>
                    <span className="trace-number">{String(entry.sequence).padStart(2, '0')}</span>
                    <span>
                      {events[language][entry.event]}
                      {entry.request !== null && (
                        <small>
                          {t.request} {entry.request}
                        </small>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="quiet-note">{t.traceEmpty}</p>
            )}
          </details>
        </section>
        <footer className="site-footer">
          <p>{t.original}</p>
          <p>{t.limits}</p>
        </footer>
      </main>
    </>
  );
}
