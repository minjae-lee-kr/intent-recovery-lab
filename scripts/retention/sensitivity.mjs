import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { audit } from './check.mjs';

// Controls operate on disposable copies after both owners have stopped.
export async function mutationControls(localSource, remoteSource, output) {
  await mkdir(output, { recursive: true });
  const results = [];
  for (const kind of [
    'baseline',
    'missing-attempt-correlation',
    'invented-local-receipt',
    'unacknowledged-existing-receipt',
    'grant-journal-mismatch',
    'premature-pruning',
  ]) {
    const dir = join(output, kind);
    await mkdir(dir);
    const local = join(dir, 'local.sqlite'),
      remote = join(dir, 'downstream.sqlite');
    await copyFile(localSource, local);
    await copyFile(remoteSource, remote);
    const l = new DatabaseSync(local),
      r = new DatabaseSync(remote);
    try {
      const firstReceipt = r
        .prepare('SELECT receipt FROM effects ORDER BY created_at LIMIT 1')
        .get().receipt;
      if (kind === 'missing-attempt-correlation') {
        const row = r
          .prepare(
            "SELECT seq,detail FROM journal WHERE event='post-new-effect' ORDER BY seq LIMIT 1",
          )
          .get();
        r.prepare('UPDATE journal SET detail=? WHERE seq=?').run(
          JSON.stringify({ ...JSON.parse(row.detail), attemptId: 'attempt-999' }),
          row.seq,
        );
      } else if (kind === 'invented-local-receipt') {
        l.exec(
          "UPDATE intents SET receipt='invented-receipt'; UPDATE grants SET receipt='invented-receipt'",
        );
      } else if (['unacknowledged-existing-receipt', 'grant-journal-mismatch'].includes(kind)) {
        l.prepare('UPDATE intents SET receipt=?').run(firstReceipt);
        l.prepare('UPDATE grants SET receipt=?').run(firstReceipt);
        if (kind === 'unacknowledged-existing-receipt') {
          const row = l.prepare("SELECT seq,detail FROM journal WHERE event='local-grant'").get();
          l.prepare('UPDATE journal SET detail=? WHERE seq=?').run(
            JSON.stringify({ ...JSON.parse(row.detail), receipt: firstReceipt }),
            row.seq,
          );
        }
      } else if (kind === 'premature-pruning') {
        // Preserve relative clock/event order while falsely calling pre-expiry pruning valid.
        l.exec(
          'UPDATE journal SET clock=10020 WHERE clock=12000; UPDATE clock_floor SET value=10020',
        );
        r.exec(
          'UPDATE journal SET clock=10020 WHERE clock=12000; UPDATE effects SET created_at=10020 WHERE created_at=12000; UPDATE dedup SET expires_at=11020; UPDATE clock_floor SET value=10020',
        );
      }
    } finally {
      l.close();
      r.close();
    }
    let accepted = false,
      message = '';
    try {
      accepted = audit(local, remote, 'naive-expired').expectedResultEstablished;
    } catch (error) {
      message = error.message;
    }
    assert.equal(accepted, kind === 'baseline', kind);
    results.push({ kind, accepted, rejected: !accepted, message });
  }
  return results;
}
