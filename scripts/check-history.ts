import { readFile, stat } from 'node:fs/promises';
import { checkHistory } from './history/checker.ts';
if (process.argv.length !== 3 || process.argv[2]!.startsWith('-')) {
  process.stderr.write('Usage: pnpm history:check <raw-history.json>\n');
  process.exitCode = 64;
} else {
  try {
    const path = process.argv[2]!;
    if ((await stat(path)).size > 2_000_000) throw new Error('History file exceeds 2 MB.');
    const result = checkHistory(JSON.parse(await readFile(path, 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = { witness: 0, counterexample: 1, inconclusive: 2, invalid: 3 }[
      result.status
    ];
  } catch {
    process.stderr.write(
      'Invalid evidence: could not read or parse a bounded history JSON file.\n',
    );
    process.exitCode = 3;
  }
}
