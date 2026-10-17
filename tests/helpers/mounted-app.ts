import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createClient } from '../../src/client/model.ts';
import { LANGUAGE_KEY } from '../../src/client/i18n.ts';
import type { Language } from '../../src/client/i18n.ts';
import type { LedgerView, Outcome } from '../../src/protocol.ts';

const require = createRequire(import.meta.url);
const project = fileURLToPath(new URL('../../', import.meta.url));
export const emptyLedger: LedgerView = {
  initialCapacity: 12,
  remainingCapacity: 12,
  intents: [],
  effects: [],
};
export const confirmedOutcome: Outcome = {
  intentId: 'intent-mounted-test',
  command: { offerId: 'workshop', quantity: 1 },
  commandHash: 'a'.repeat(64),
  status: 'confirmed',
  receiptId: 'receipt-mounted-test',
  reason: null,
  journalSequence: 1,
};
export const committedLedger: LedgerView = {
  initialCapacity: 12,
  remainingCapacity: 11,
  intents: [confirmedOutcome],
  effects: [
    {
      receiptId: confirmedOutcome.receiptId!,
      intentId: confirmedOutcome.intentId,
      offerId: 'workshop',
      quantity: 1,
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Node's TypeScript loader does not compile TSX. Compile the actual App and its
// imports with the repository's pinned compiler; do not substitute a test view.
export async function compileApp() {
  await mkdir(join(project, '.local'), { recursive: true });
  const directory = await mkdtemp(join(project, '.local', 'mounted-app-'));
  assert.equal(dirname(directory), join(project, '.local'));
  try {
    execFileSync(
      process.execPath,
      [
        join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc'),
        '--ignoreConfig',
        '--target',
        'ES2023',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--jsx',
        'react-jsx',
        '--strict',
        '--skipLibCheck',
        '--rewriteRelativeImportExtensions',
        '--outDir',
        directory,
        'src/client/App.tsx',
      ],
      { cwd: project, stdio: 'pipe', timeout: 30_000 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    url: pathToFileURL(join(directory, 'client', 'App.js')).href,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function mountApp(url: string, language: Language) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/' });
  dom.window.localStorage.setItem(LANGUAGE_KEY, language);
  const ledgerRequests: { body: ReturnType<typeof deferred<unknown>>; signal: AbortSignal }[] = [];
  const productRequests: ReturnType<typeof deferred<Response>>[] = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    location: dom.window.location,
    history: dom.window.history,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: string, init: RequestInit) => {
      assert.equal(path, '/api/ledger');
      const body = deferred<unknown>();
      ledgerRequests.push({ body, signal: init.signal as AbortSignal });
      // Deliberately ignore abort while decoding a body, to exercise the existing
      // generation guard when an obsolete response completes after a newer one.
      return Promise.resolve({ ok: true, json: () => body.promise } as Response);
    },
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App } = (await import(url)) as typeof import('../../src/client/App.tsx');
  const client = createClient({
    storage: dom.window.localStorage,
    createId: () => confirmedOutcome.intentId,
    onIntent: () => {},
    http: () => {
      const response = deferred<Response>();
      productRequests.push(response);
      return response.promise;
    },
    schedule: () => () => {},
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  await act(async () => {
    root.render(createElement(App, { suppliedClient: client }));
  });
  const query = (selector: string) => {
    const element = dom.window.document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    return element;
  };
  return {
    client,
    ledgerRequests,
    productRequests,
    document: dom.window.document,
    query,
    act,
    click: async (selector: string) => {
      await act(async () => {
        query(selector).click();
      });
    },
    ledger: async (index: number, body: unknown) => {
      await act(async () => {
        ledgerRequests[index]!.body.resolve(body);
      });
    },
    failLedger: async (index: number) => {
      await act(async () => {
        ledgerRequests[index]!.body.reject(new Error('synthetic read failure'));
      });
    },
    confirm: async () => {
      await act(async () => {
        productRequests
          .at(-1)!
          .resolve(new Response(JSON.stringify(confirmedOutcome), { status: 200 }));
      });
    },
    close: async () => {
      await act(async () => {
        root.unmount();
        for (const request of ledgerRequests) request.body.resolve(emptyLedger);
        client.dispose();
      });
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
