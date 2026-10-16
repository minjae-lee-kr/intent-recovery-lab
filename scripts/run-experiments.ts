import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runExperiments } from './experiments.ts';
import type { ScenarioEvidence } from './experiments.ts';
import { projectRoot, sourceEvidence } from './provenance.ts';
import { renderReport } from './report.ts';
import type { ExperimentReport } from './report.ts';

if (process.argv.length > 2)
  throw new Error('Run without arguments; output is confined to reports/<run-id>.');
const startedAt = new Date().toISOString();
const runId = `${startedAt.replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
const output = join(projectRoot, 'reports', runId);
const sourceBefore = await sourceEvidence();
const sqlite = new DatabaseSync(':memory:');
const version = String(sqlite.prepare('SELECT sqlite_version() AS version').get()!.version);
sqlite.close();
let scenarios: ScenarioEvidence[] = [];
let executionError: string | undefined;
try {
  scenarios = await runExperiments((id) => process.stdout.write(`Observed ${id}\n`));
} catch (error) {
  executionError = 'HARNESS_ERROR: execution did not complete; inspect the terminal diagnostic.';
  console.error(error);
}
const sourceAfter = await sourceEvidence();
const sourceStable = sourceBefore.sha256 === sourceAfter.sha256;
const expected = [
  'fresh-key',
  'same-intent',
  'late-commit',
  'conflicting-command',
  'crash-before',
  'crash-after',
  'two-processes',
];
const inventoryMatches =
  JSON.stringify(scenarios.map((scenario) => scenario.id)) === JSON.stringify(expected);
const report: ExperimentReport = {
  schemaVersion: 1,
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  runtime: {
    node: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    sqlite: version,
  },
  sourceBefore,
  sourceAfter,
  sourceStable,
  passed:
    !executionError &&
    sourceStable &&
    inventoryMatches &&
    scenarios.every((scenario) => scenario.passed),
  scenarios,
  ...(executionError ? { executionError } : {}),
};
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(join(output, 'evidence.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }),
  writeFile(join(output, 'index.html'), renderReport(report), { flag: 'wx' }),
  writeFile(join(output, 'report.js'), await readFile(join(projectRoot, 'src/report/report.js')), {
    flag: 'wx',
  }),
  writeFile(
    join(output, 'report.css'),
    await readFile(join(projectRoot, 'src/report/report.css')),
    { flag: 'wx' },
  ),
]);
process.stdout.write(
  `${report.passed ? 'Verified' : 'FAILED'} experiment execution\nReport: ${output}\n`,
);
if (!report.passed) process.exitCode = 1;
