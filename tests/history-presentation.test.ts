import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { checkHistory } from '../scripts/history/checker.ts';
import { coverage, staleReadControl } from '../scripts/history/assessment.ts';
import {
  inspectReport,
  prepareRecording,
  sourceAgreement,
} from '../scripts/history/presentation.ts';
import type { HistoryReport, HistoryReportRun } from '../scripts/history/presentation.ts';
import type { History } from '../scripts/history/types.ts';
import { serveHistoryReport } from '../scripts/serve-history-report.ts';
import { projectRoot } from '../scripts/provenance.ts';
import { fixture, result, conflict } from './helpers/history-fixtures.ts';

const assets = new URL('../scripts/history/report-assets/', import.meta.url);
const html = await readFile(new URL('index.html', assets), 'utf8');
const script = await readFile(new URL('report.js', assets), 'utf8');
// Hand-sized synthetic source identity. It is never presented as a real execution artifact.
const files = [{ path: 'synthetic-fixture.ts', sha256: '0'.repeat(64) }];
const source = {
  sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  files,
  git: { state: 'available' as const, head: 'synthetic-fixture', dirty: false },
};
function history(seed: number): History {
  const f = fixture();
  f.history.seed = seed;
  const anchor = result('history-anchor', 1, 1),
    late = result('history-late', 1, 2),
    lost = result('history-lost', 1, 3);
  f.invoke('anchor', { kind: 'reserve', key: anchor.intentId, quantity: 1 });
  f.http('anchor', 200, anchor);
  f.invoke('anchor-read', { kind: 'lookup', key: anchor.intentId }, 'b');
  f.http('anchor-read', 200, anchor);
  f.invoke('late', { kind: 'reserve', key: late.intentId, quantity: 1 });
  f.unknown('late');
  f.invoke('early-read', { kind: 'lookup', key: late.intentId }, 'b');
  f.http('early-read', 404, { intentId: late.intentId, status: 'unseen' });
  f.invoke('lost', { kind: 'reserve', key: lost.intentId, quantity: 1 }, 'b');
  f.unknown('lost');
  f.invoke('retry', { kind: 'reserve', key: anchor.intentId, quantity: 1 });
  f.invoke('changed', { kind: 'reserve', key: anchor.intentId, quantity: 2 }, 'b');
  const fills = Array.from({ length: 5 }, (_, i) => result(`history-fill-${i}`, 3, i + 4, i >= 3));
  for (const [i, row] of fills.entries())
    f.invoke(`fill-${i}`, { kind: 'reserve', key: row.intentId, quantity: 3 }, i % 2 ? 'a' : 'b');
  f.http('retry', 200, anchor);
  f.http('changed', 409, conflict);
  for (const [i, row] of fills.entries()) f.http(`fill-${i}`, 200, row);
  return f.finish([anchor, late, lost, ...fills]);
}
function update(run: HistoryReportRun) {
  run.verdict = checkHistory(run.history);
  run.coverage = coverage(run.history);
  run.staleReadControl = staleReadControl(run.history);
  run.passed =
    run.verdict.status === 'witness' && run.coverage.complete && run.staleReadControl.established;
}
function report(): HistoryReport {
  const runs = [104729, 130363, 155921].map((seed) => {
    const h = history(seed);
    return {
      seed,
      history: h,
      verdict: checkHistory(h),
      coverage: coverage(h),
      staleReadControl: staleReadControl(h),
      passed: true,
    };
  });
  return {
    schemaVersion: 1,
    modelVersion: 'reservation-history-v1',
    runId: 'synthetic-presentation-fixture',
    completedAt: '2026-10-17T00:00:00.000Z',
    sourceBefore: structuredClone(source),
    sourceAfter: structuredClone(source),
    sourceStable: true,
    passed: true,
    runtime: { node: 'fixture', sqlite: 'fixture', platform: 'fixture', architecture: 'fixture' },
    runs,
  };
}
function display(value: HistoryReport, lang = 'en') {
  const errors: string[] = [],
    virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e: Error) => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:4341/',
    runScripts: 'outside-only',
    virtualConsole,
  });
  const recording = {
    sourceStable: sourceAgreement(value),
    gitDirty: false,
    recordedAt: value.completedAt,
    sourceRevision: value.sourceBefore.git.head,
    sourceFingerprint: value.sourceBefore.sha256,
    evidenceSha256: 'fixture',
    modelVersion: value.modelVersion,
    checker: 'fixture',
  };
  dom.window.localStorage.setItem('minjae.portfolio.language', lang);
  Object.assign(dom.window, {
    HISTORY_RECORDING: { report: value, derived: inspectReport(value), recording },
  });
  dom.window.eval(script);
  return { dom, document: dom.window.document, errors };
}
const click = (document: Document, selector: string) =>
  (document.querySelector(selector) as HTMLButtonElement).click();
function wireStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode!));
    });
    req.once('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Test request timed out')));
    req.end();
  });
}

test('exact inventory, returned witnesses and GET-only mutation are checked before presentation', () => {
  assert.equal(inspectReport(report()).length, 3);
  for (const mutate of [
    (r: HistoryReport) => {
      r.runs = [];
    },
    (r: HistoryReport) => {
      r.runs[0]!.history.plannedAttemptIds.pop();
    },
    (r: HistoryReport) => {
      r.runs[0]!.verdict.witness!.pop();
    },
    (r: HistoryReport) => {
      r.runs[0]!.staleReadControl.history!.events[0]!.elapsedMs += 1;
    },
  ]) {
    const r = report();
    mutate(r);
    assert.throws(() => inspectReport(r));
  }
});
test('actual confirmed early lookup never becomes absent in either narrative, even with forged pass flags', () => {
  const r = report(),
    run = r.runs[0]!,
    read = run.history.events.find((e) => e.kind === 'http' && e.attemptId === 'early-read')!;
  assert.equal(read.kind, 'http');
  if (read.kind === 'http') {
    read.status = 200;
    read.body = result('history-late', 1, 2);
  }
  update(run);
  assert.equal(run.verdict.status, 'witness');
  assert.equal(run.coverage.complete, false);
  run.passed = true;
  r.passed = true;
  for (const lang of ['en', 'ko']) {
    const { dom, document, errors } = display(r, lang);
    click(document, '[data-view="uncertainty"]');
    const text = document.querySelector('#content')!.textContent!;
    assert.doesNotMatch(
      text,
      /Lookup observes no reservation yet|lookup observes absence|조회 시점에는 예약 없음|조회가 ‘없음’을 관측/,
    );
    assert.match(
      text,
      lang === 'en' ? /lookup observes the retained reservation/ : /조회가 저장된 예약을 확인/,
    );
    assert.equal((document.querySelector('#run-warning') as HTMLElement).hidden, false);
    assert.deepEqual(errors, []);
    dom.window.close();
  }
});
test('invalid drain identity and inconclusive final reader never assert closure or reuse stale witness steps', () => {
  for (const invalid of [true, false]) {
    const r = report(),
      run = r.runs[0]!,
      oldWitness = run.verdict.witness;
    if (invalid) {
      const e = run.history.events.find((e) => e.kind === 'drained')!;
      if (e.kind === 'drained') e.instanceId = 'wrong-instance';
    } else {
      const e = run.history.events.at(-1)!;
      if (e.kind === 'http') {
        e.status = 503;
        e.body = {
          error: { code: 'TEMPORARY_UNAVAILABLE', message: 'Reader unavailable', retryable: true },
        };
      }
    }
    update(run);
    run.verdict.witness = oldWitness;
    r.passed = false;
    for (const lang of ['en', 'ko']) {
      const { dom, document, errors } = display(r, lang);
      click(document, '[data-view="uncertainty"]');
      assert.equal(document.querySelectorAll('.witness li small').length, 0);
      assert.doesNotMatch(
        document.querySelector('#content')!.textContent!,
        /Both writers drained and exited|두 서버의 처리 완료와 종료 확인|This order can explain it/,
      );
      assert.equal((document.querySelector('#run-warning') as HTMLElement).hidden, false);
      assert.deepEqual(errors, []);
      dom.window.close();
    }
  }
});
test('declared source stability cannot override actual digest or manifest disagreement', () => {
  for (const manifest of [false, true]) {
    const r = report();
    if (manifest) r.sourceAfter.files[0]!.sha256 = 'f'.repeat(64);
    else r.sourceAfter.sha256 = 'f'.repeat(64);
    assert.equal(sourceAgreement(r), false);
    const { dom, document } = display(r);
    assert.match(document.querySelector('#recording-state')!.textContent!, /Source changed/);
    assert.equal((document.querySelector('#run-warning') as HTMLElement).hidden, false);
    dom.window.close();
  }
});
test('language changes retain seed, explanation and expanded evidence', () => {
  const { dom, document } = display(report());
  const select = document.querySelector('#seed') as HTMLSelectElement;
  select.value = '130363';
  select.dispatchEvent(new dom.window.Event('change'));
  click(document, '[data-view="uncertainty"]');
  (document.querySelector('#provenance') as HTMLDetailsElement).open = true;
  click(document, '[data-language="ko"]');
  assert.equal(select.value, '130363');
  assert.equal(
    document.querySelector('[data-view="uncertainty"]')!.getAttribute('aria-pressed'),
    'true',
  );
  assert.equal((document.querySelector('#provenance') as HTMLDetailsElement).open, true);
  assert.equal(document.documentElement.lang, 'ko');
  dom.window.close();
});
async function savedFixture() {
  const root = resolve(projectRoot, 'reports');
  await mkdir(root, { recursive: true });
  const directory = join(root, `history-test-${randomUUID()}`);
  await mkdir(directory);
  const r = report();
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(r));
  for (const run of r.runs)
    for (const suffix of ['', '-stale-control'])
      await writeFile(
        join(directory, `seed-${run.seed}${suffix}.json`),
        JSON.stringify(suffix ? run.staleReadControl.history : run.history),
      );
  return {
    directory,
    cleanup: async () => {
      assert.equal(dirname(resolve(directory)), root);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('captured loopback view preserves raw bytes, separates renderer identity and rejects hostile requests', async () => {
  const saved = await savedFixture();
  let serving: Awaited<ReturnType<typeof serveHistoryReport>> | undefined;
  try {
    const raw = await readFile(join(saved.directory, 'evidence.json')),
      view = await prepareRecording(saved.directory);
    assert.deepEqual(await readFile(join(view.directory, 'evidence.json')), raw);
    assert.equal(view.recording.sourceRevision, 'synthetic-fixture');
    assert.notEqual(view.recording.renderer.git.head, 'synthetic-fixture');
    serving = await serveHistoryReport(view.directory, 0);
    const page = await (await fetch(serving.url)).text();
    assert.equal((await fetch(serving.url, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(serving.url, { method: 'POST' })).status, 405);
    assert.equal(await wireStatus(serving.url, { Host: 'outside.example' }), 403);
    assert.equal(await wireStatus(serving.url, { Origin: 'https://outside.example' }), 403);
    assert.equal((await fetch(serving.url + '/../package.json')).status, 404);
    await writeFile(join(view.directory, 'index.html'), 'changed after capture');
    assert.equal(await (await fetch(serving.url)).text(), page);
    await assert.rejects(serveHistoryReport(view.directory, 0), /Mixed or modified/);
  } finally {
    await serving?.close();
    await saved.cleanup();
  }
});
test('missing input fails before creating a view and directories outside reports are refused', async () => {
  const saved = await savedFixture();
  try {
    await rm(join(saved.directory, 'seed-155921-stale-control.json'));
    const before = await readdir(saved.directory);
    await assert.rejects(prepareRecording(saved.directory), /ENOENT/);
    assert.deepEqual(await readdir(saved.directory), before);
    await assert.rejects(prepareRecording(projectRoot), /directly inside/);
  } finally {
    await saved.cleanup();
  }
});
