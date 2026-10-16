import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot, sourceEvidence } from './provenance.ts';
import { collectRetention } from './retention/collect.mjs';
import { retentionReportText } from './retention/report.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('Usage: pnpm retention (no arguments)\n');
  process.exitCode = 64;
} else {
  const startedAt = new Date().toISOString();
  const runId = `retention-${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
  const output = join(projectRoot, 'reports', runId);
  const sourceBefore = await sourceEvidence();
  const db = new DatabaseSync(':memory:');
  const sqlite = String(db.prepare('SELECT sqlite_version() AS version').get().version);
  db.close();
  let result, executionError;
  try {
    result = await collectRetention();
  } catch (error) {
    // Keep machine-specific paths and stack traces out of shareable evidence.
    executionError = {
      name: error instanceof Error ? error.name : 'UnknownError',
      message: 'The bounded fixture did not establish its expected result.',
    };
    process.stderr.write(`${executionError.message}\n`);
  }
  const sourceAfter = await sourceEvidence();
  const sourceStable =
    sourceBefore.sha256 === sourceAfter.sha256 &&
    sourceBefore.git.state === sourceAfter.git.state &&
    sourceBefore.git.head === sourceAfter.git.head;
  const passed = !executionError && sourceStable && result?.expectedResultsEstablished === true;
  const report = {
    schemaVersion: 1,
    modelVersion: 'retention-boundary-v1',
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
    ...(result ?? { cases: [], mutationControls: [] }),
    ...(executionError ? { executionError } : {}),
  };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(join(output, 'report.txt'), retentionReportText(report), { flag: 'wx' });
  process.stdout.write(
    `${passed ? 'Established' : 'NOT ESTABLISHED'} retention-boundary fixture\n`,
  );
  process.stdout.write(
    'Established includes deliberately repeated effects; it is not an exactly-once verdict.\n',
  );
  process.stdout.write(
    `Evidence: reports/${runId}/evidence.json\nReport: reports/${runId}/report.txt\n`,
  );
  if (!passed) process.exitCode = 1;
}
