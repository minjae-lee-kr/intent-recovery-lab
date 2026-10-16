// Owned experiment process. No new administration endpoint is added to the app.
import { isAbsolute } from 'node:path';
import { startServer } from '../../src/server/server.ts';
const {
  HISTORY_DB: databasePath,
  HISTORY_RUN: runId,
  HISTORY_INSTANCE: instanceId,
  HISTORY_TARGET: target,
} = process.env;
if (
  !databasePath ||
  !isAbsolute(databasePath) ||
  !runId ||
  !instanceId ||
  !['a', 'b', 'reader'].includes(target ?? '')
)
  throw new Error('Invalid history fixture configuration.');
const server = await startServer({ databasePath, port: 0 });
const identity = { runId, instanceId, target, pid: process.pid };
process.send?.({ type: 'ready', ...identity, url: server.url });
let stopping = false;
process.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const message = value as Record<string, unknown>;
  if (
    stopping ||
    message.type !== 'stop' ||
    message.runId !== runId ||
    message.instanceId !== instanceId
  )
    return;
  stopping = true;
  void server
    .close()
    .then(() => {
      process.send?.({ type: 'drained', ...identity }, (error) => {
        if (error) process.exitCode = 1;
        process.disconnect?.();
      });
    })
    .catch(() => {
      process.exitCode = 1;
      process.disconnect?.();
    });
});
// A vanished controller must not leave an unowned listener running.
process.once('disconnect', () => {
  void server.close().catch(() => {
    process.exitCode = 1;
  });
});
