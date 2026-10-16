import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Target } from './types.ts';
export interface Identity {
  runId: string;
  instanceId: string;
  target: Target;
  pid: number;
}
export function belongs(
  value: unknown,
  identity: Identity,
  type: 'ready' | 'drained',
): value is Identity & { type: string; url?: string } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === type &&
    v.runId === identity.runId &&
    v.instanceId === identity.instanceId &&
    v.target === identity.target &&
    v.pid === identity.pid
  );
}
async function bounded<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function launch(
  databasePath: string,
  runId: string,
  target: Target,
  lifecycle: (kind: 'drained' | 'exited', identity: Identity) => void = () => {},
) {
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.ts', import.meta.url))], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: {
      ...process.env,
      HISTORY_DB: databasePath,
      HISTORY_RUN: runId,
      HISTORY_INSTANCE: instanceId,
      HISTORY_TARGET: target,
    },
  });
  if (!child.pid) {
    child.once('error', () => {});
    throw new Error('History fixture did not spawn.');
  }
  const identity: Identity = { runId, instanceId, target, pid: child.pid };
  let closed = false;
  let requestedStop = false;
  let acknowledged = false;
  let stderr = '';
  child.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-8_192);
  });
  const exit = new Promise<{ code: number | null }>((resolve) =>
    child.once('close', (code) => {
      closed = true;
      resolve({ code });
    }),
  );
  let readyResolve!: (url: string) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let drainResolve!: () => void;
  const drain = new Promise<void>((resolve) => {
    drainResolve = resolve;
  });
  child.once('error', readyReject);
  child.on('message', (value: unknown) => {
    if (
      belongs(value, identity, 'ready') &&
      typeof value.url === 'string' &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(value.url)
    )
      readyResolve(value.url);
    if (requestedStop && !acknowledged && belongs(value, identity, 'drained')) {
      acknowledged = true;
      lifecycle('drained', identity);
      drainResolve();
    }
  });
  const kill = async () => {
    if (!closed) child.kill('SIGKILL');
    await bounded(exit, 5_000, 'Owned fixture did not exit after cleanup.');
  };
  const failedExit = exit.then(() => {
    throw new Error(`History fixture exited before readiness. ${stderr}`);
  });
  let url: string;
  try {
    url = await bounded(
      Promise.race([ready, failedExit]),
      6_000,
      'History fixture readiness timed out.',
    );
  } catch (error) {
    await kill();
    throw error;
  }
  return {
    url,
    identity,
    kill,
    async stop() {
      if (requestedStop) throw new Error('History drain can only be requested once.');
      requestedStop = true;
      if (closed || !child.connected)
        throw new Error('Writer exited without a drain acknowledgement.');
      await new Promise<void>((resolveSend, reject) =>
        child.send({ type: 'stop', runId, instanceId }, (error) =>
          error ? reject(error) : resolveSend(),
        ),
      );
      await bounded(
        Promise.race([
          drain,
          exit.then(() => {
            if (!acknowledged) throw new Error('Writer exited before acknowledging drain.');
          }),
        ]),
        6_000,
        'Writer drain timed out.',
      );
      const ended = await bounded(exit, 6_000, 'Drained writer did not exit.');
      if (!acknowledged || ended.code !== 0)
        throw new Error('Writer failed to exit normally after drain.');
      lifecycle('exited', identity);
    },
  };
}
