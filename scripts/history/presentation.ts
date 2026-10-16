import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHistory } from './checker.ts';
import { replayWitness } from './replay.ts';
import { coverage } from './assessment.ts';
import { checkLedger } from '../check-ledger.ts';
import { projectRoot, sourceEvidence } from '../provenance.ts';
import type { SourceEvidence } from '../provenance.ts';
import type { History, Verdict } from './types.ts';

export interface HistoryReportRun {
  seed: number;
  history: History;
  verdict: Verdict;
  coverage: ReturnType<typeof coverage>;
  staleReadControl: {
    established: boolean;
    history?: History;
    verdict?: Verdict;
    finalLedgerUnchanged?: boolean;
    reason?: string;
  };
  passed: boolean;
  executionError?: string;
}
export interface HistoryReport {
  schemaVersion: number;
  modelVersion: string;
  runId: string;
  completedAt: string;
  sourceBefore: SourceEvidence;
  sourceAfter: SourceEvidence;
  sourceStable: boolean;
  passed: boolean;
  runtime: { node: string; sqlite: string; platform: string; architecture: string };
  runs: HistoryReportRun[];
}
const seeds = [104729, 130363, 155921];
const ids = [
  'anchor',
  'anchor-read',
  'late',
  'early-read',
  'lost',
  'retry',
  'changed',
  'fill-0',
  'fill-1',
  'fill-2',
  'fill-3',
  'fill-4',
  'final',
];
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const end = (history: History, id: string) =>
  history.events.find((e) => (e.kind === 'http' || e.kind === 'unknown') && e.attemptId === id);
const terminal = (history: History) => {
  const event = end(history, 'final');
  return event?.kind === 'http' ? event : undefined;
};
export function sourceAgreement(report: HistoryReport): boolean {
  const before = report.sourceBefore,
    after = report.sourceAfter;
  const valid = (s: SourceEvidence) =>
    Array.isArray(s?.files) &&
    /^[a-f0-9]{64}$/.test(s.sha256) &&
    sha(JSON.stringify(s.files)) === s.sha256;
  return (
    report.sourceStable === true &&
    valid(before) &&
    valid(after) &&
    before.sha256 === after.sha256 &&
    JSON.stringify(before.files) === JSON.stringify(after.files) &&
    before.git?.head === after.git?.head
  );
}

export function inspectReport(report: HistoryReport) {
  assert.equal(report.schemaVersion, 1, 'Unsupported report schema');
  assert.equal(report.modelVersion, 'reservation-history-v1', 'Unsupported history model');
  assert.deepEqual(
    report.runs.map((r) => r.seed).sort((a, b) => a - b),
    seeds,
    'Expected exactly the declared three seeds',
  );
  assert.ok(Number.isFinite(Date.parse(report.completedAt)), 'Invalid recording time');
  return report.runs.map((run) => {
    assert.deepEqual(
      [...run.history.plannedAttemptIds].sort(),
      [...ids].sort(),
      'Incomplete operation inventory',
    );
    assert.equal(run.history.seed, run.seed, 'Seed identity mismatch');
    const checked = checkHistory(run.history);
    assert.equal(checked.status, run.verdict.status, 'Recorded baseline verdict does not replay');
    if (run.verdict.status === 'witness')
      assert.equal(
        replayWitness(run.history, run.verdict.witness).ok,
        true,
        'Invalid recorded witness',
      );
    const exercised = coverage(run.history);
    assert.deepEqual(exercised, run.coverage, 'Recorded coverage differs from trace');
    const control = run.staleReadControl;
    const originalFinal = terminal(run.history);
    const originalLedger = checkLedger(originalFinal?.body);
    let controlLedger = { ok: false, violations: ['No control history was established.'] };
    let ledgerUnchanged = false;
    let changedEventSequence: number | undefined;
    if (control.history) {
      const expected = structuredClone(run.history);
      const response = end(expected, 'anchor-read');
      const call = expected.events.find(
        (e) => e.kind === 'invoke' && e.attemptId === 'anchor-read',
      );
      assert.ok(
        response?.kind === 'http' && call?.kind === 'invoke' && call.input.kind === 'lookup',
        'Control lacks the declared GET',
      );
      response.status = 404;
      response.body = { intentId: call.input.key, status: 'unseen' };
      assert.deepEqual(
        control.history,
        expected,
        'Control changes more than the declared GET response',
      );
      assert.equal(
        checkHistory(control.history).status,
        control.verdict?.status,
        'Control verdict does not replay',
      );
      const changedFinal = terminal(control.history);
      ledgerUnchanged =
        !!originalFinal && JSON.stringify(originalFinal) === JSON.stringify(changedFinal);
      assert.equal(
        ledgerUnchanged,
        control.finalLedgerUnchanged,
        'Recorded ledger equality is inaccurate',
      );
      controlLedger = checkLedger(changedFinal?.body);
      changedEventSequence = response.sequence;
    } else assert.equal(control.established, false, 'Missing control cannot be established');
    const established =
      !run.executionError &&
      checked.status === 'witness' &&
      exercised.complete &&
      control.established === true &&
      control.verdict?.status === 'counterexample' &&
      ledgerUnchanged &&
      originalLedger.ok &&
      controlLedger.ok;
    return {
      seed: run.seed,
      operationCount: run.history.plannedAttemptIds.length,
      eventCount: run.history.events.length,
      originalLedger,
      controlLedger,
      ledgerUnchanged,
      established,
      claimedPassed: run.passed,
      changedEventSequence,
    };
  });
}

export async function resolveReportDirectory(input: string): Promise<string> {
  const reports = resolve(projectRoot, 'reports');
  const requested = resolve(projectRoot, input);
  assert.equal(dirname(requested), reports, 'Use one generated directory directly inside reports/');
  assert.match(basename(requested), /^history-[A-Za-z0-9-]+$/, 'Use a generated history report');
  for (const path of [reports, requested]) {
    const info = await lstat(path);
    assert.ok(
      info.isDirectory() && !info.isSymbolicLink(),
      'Report directories must be regular directories',
    );
    assert.equal(
      await realpath(path),
      path,
      'Report directory must not resolve outside its declared path',
    );
  }
  return requested;
}
async function regularFile(directory: string, name: string, limit = 2_000_000) {
  const path = join(directory, name),
    info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= limit,
    'Use bounded regular report files',
  );
  assert.equal(
    dirname(await realpath(path)),
    await realpath(directory),
    'File escaped the report directory',
  );
  return readFile(path);
}

export async function prepareRecording(input: string) {
  const directory = await resolveReportDirectory(input);
  const bytes = await regularFile(directory, 'evidence.json');
  const report = JSON.parse(bytes.toString('utf8')) as HistoryReport;
  const derived = inspectReport(report);
  const stable = sourceAgreement(report);
  const outputs = new Map<string, Buffer | string>([['evidence.json', bytes]]);
  for (const run of report.runs)
    for (const suffix of ['', '-stale-control']) {
      if (suffix && !run.staleReadControl.history) continue;
      const name = `seed-${run.seed}${suffix}.json`,
        source = await regularFile(directory, name);
      assert.deepEqual(
        JSON.parse(source.toString('utf8')),
        suffix ? run.staleReadControl.history : run.history,
        'Standalone trace differs from the report',
      );
      outputs.set(name, source);
    }
  const assetRoot = fileURLToPath(new URL('./report-assets/', import.meta.url));
  for (const name of ['index.html', 'report.css', 'report.js'])
    outputs.set(name, await regularFile(assetRoot, name));
  const rendererSource = await sourceEvidence();
  const rendererFiles = rendererSource.files.filter(
    (file) =>
      file.path.startsWith('scripts/history/report-assets/') ||
      ['scripts/history/presentation.ts', 'scripts/serve-history-report.ts'].includes(file.path),
  );
  const recording = {
    schemaVersion: 1,
    kind: 'recorded-local-history-experiment',
    recordedAt: report.completedAt,
    preparedAt: new Date().toISOString(),
    sourceReport: basename(directory),
    evidenceSha256: sha(bytes),
    sourceRevision: report.sourceBefore.git.head,
    sourceFingerprint: report.sourceBefore.sha256,
    sourceStable: stable,
    declaredSourceStable: report.sourceStable,
    established: stable && report.passed === true && derived.every((row) => row.established),
    gitDirty: report.sourceBefore.git.dirty || report.sourceAfter.git.dirty,
    modelVersion: report.modelVersion,
    checker: 'scripts/history/checker.ts',
    renderer: {
      git: rendererSource.git,
      sha256: sha(JSON.stringify(rendererFiles)),
      files: rendererFiles,
    },
    adaptations: [
      'Later read-only rendering of an existing raw run. Renderer identity is separate from the recorded source.',
      'Actual observer order and a possible witness order are separate. Dashed uncertainty is conceptual, not measured commit time.',
    ],
    validation:
      'Verdicts, witness, workload coverage, exact inventory and GET-only mutation rechecked locally. Unsigned provenance, not attestation.',
  };
  outputs.set('recording.json', JSON.stringify(recording, null, 2) + '\n');
  const json = JSON.stringify({ report, derived, recording })
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  outputs.set('report-data.js', `window.HISTORY_RECORDING = ${json};\n`);
  outputs.set(
    'assets.json',
    JSON.stringify(
      [...outputs].map(([name, value]) => ({ name, sha256: sha(value) })),
      null,
      2,
    ) + '\n',
  );
  // A fresh ignored view avoids replacing a previously reviewed recording in place.
  const output = join(directory, `view-${randomUUID().slice(0, 8)}`);
  await mkdir(output);
  for (const [name, value] of outputs) await writeFile(join(output, name), value, { flag: 'wx' });
  return { directory: output, recording };
}
