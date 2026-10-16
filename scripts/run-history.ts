import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectHistory, SEEDS } from './history/harness.ts';
import { checkHistory } from './history/checker.ts';
import { coverage, staleReadControl } from './history/assessment.ts';
import { MODEL_VERSION } from './history/types.ts';
import { historyReportText } from './history/report-text.ts';
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
  await writeFile(join(output, 'report.txt'), historyReportText(report), { flag: 'wx' });
  process.stdout.write(
    `${passed ? 'Established' : 'NOT ESTABLISHED'} bounded history experiment\nEvidence: ${output}\n`,
  );
  if (!passed) process.exitCode = 1;
}
