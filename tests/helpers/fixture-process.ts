import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CheckpointPhase } from '../../src/server/store.ts';

const worker = fileURLToPath(new URL('../../scripts/crash-worker.ts', import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function launchFixture(
  databasePath: string,
  checkpoint?: { phase: CheckpointPhase; marker: string },
) {
  const runToken = randomUUID();
  if (checkpoint) {
    for (const path of [checkpoint.marker, `${checkpoint.marker}.tmp`]) {
      try {
        await access(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error('Checkpoint evidence requires a fresh marker path.');
    }
  }
  const child = spawn(process.execPath, [worker], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      LAB_DB: databasePath,
      LAB_CHECKPOINT: checkpoint?.phase ?? '',
      LAB_CHECKPOINT_MARKER: checkpoint?.marker ?? '',
      LAB_RUN_TOKEN: runToken,
    },
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString()).slice(-65536);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const exit = new Promise<void>((resolve) => {
    child.once('close', () => {
      closed = true;
      resolve();
    });
  });
  const kill = async () => {
    if (!closed) child.kill('SIGKILL');
    await exit;
  };
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fixture start timed out\n${stderr}`)), 6000);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      child.once('error', fail);
      child.once('exit', () => fail(new Error(`fixture exited before ready\n${stderr}`)));
      child.on('message', (message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'ready' &&
          'url' in message &&
          typeof message.url === 'string'
        ) {
          clearTimeout(timer);
          resolve(message.url);
        }
      });
    });
  } catch (error) {
    await kill();
    throw error;
  }
  return {
    url,
    pid: child.pid,
    kill,
    logs: () => ({ stdout, stderr }),
    async waitForCheckpoint() {
      if (!checkpoint) throw new Error('fixture has no checkpoint configured');
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (closed) throw new Error(`fixture exited before checkpoint\n${stderr}`);
        try {
          const value = JSON.parse(await readFile(checkpoint.marker, 'utf8')) as Record<
            string,
            unknown
          >;
          if (
            value.runToken !== runToken ||
            value.pid !== child.pid ||
            value.phase !== checkpoint.phase
          )
            throw new Error('Checkpoint marker does not belong to this child and run.');
          return value;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
        await pause(20);
      }
      throw new Error(`fixture checkpoint timed out\n${stderr}`);
    },
  };
}
