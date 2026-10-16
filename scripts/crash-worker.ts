// Owned fixture child for reproducible process-death experiments. Never imported by the app.
import { writeFileSync, renameSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { startServer } from '../src/server/server.ts';

const databasePath = process.env.LAB_DB;
const marker = process.env.LAB_CHECKPOINT_MARKER;
const stopAt = process.env.LAB_CHECKPOINT;
const runToken = process.env.LAB_RUN_TOKEN;
if (!databasePath || !isAbsolute(databasePath)) throw new Error('fixture needs an absolute LAB_DB');
if (
  stopAt &&
  (!runToken ||
    !marker ||
    !isAbsolute(marker) ||
    !['before-commit', 'after-commit'].includes(stopAt))
)
  throw new Error('invalid fixture checkpoint');

const server = await startServer({
  databasePath,
  port: 0,
  checkpoint(phase, info) {
    if (phase !== stopAt) return;
    // A sync marker is visible even while the child is blocked inside an open transaction.
    // Parent kills only this spawned child after observing the exact checkpoint.
    writeFileSync(
      `${marker}.tmp`,
      JSON.stringify({
        phase,
        intentId: info.intentId,
        outcome: info.outcome,
        runToken,
        pid: process.pid,
      }),
      { flag: 'wx' },
    );
    renameSync(`${marker}.tmp`, marker!);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  },
});
process.send?.({ type: 'ready', url: server.url });
process.on('message', (message) => {
  if (message === 'stop')
    void server.close().then(() => {
      process.disconnect?.();
    });
});
