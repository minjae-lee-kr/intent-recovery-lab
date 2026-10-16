import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.ts';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const portInput = process.env.LAB_PORT ?? '4323';
if (!/^\d+$/.test(portInput)) throw new Error('LAB_PORT must be an integer TCP port.');
const server = await startServer({
  databasePath: process.env.LAB_DB ?? resolve(projectRoot, '.local/lab.sqlite'),
  port: Number(portInput),
  staticRoot: resolve(projectRoot, 'dist/public'),
});
console.log(`Intent Recovery Lab: ${server.url}`);
console.log('Synthetic local data. Stop waiting is not cancellation.');
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void server.close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
