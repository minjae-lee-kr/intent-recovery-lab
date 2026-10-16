import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FAULTS, isCommand, isIntentId } from '../protocol.ts';
import type { ApiError, Fault } from '../protocol.ts';
import {
  InjectedDropBeforeCommit,
  IntentConflict,
  InvalidReservation,
  ReservationStore,
} from './store.ts';
import type { Checkpoint } from './store.ts';

export const DELAY_BEFORE_COMMIT_MS = 1_500;
export const MAX_BODY_BYTES = 4_096;
export const SHUTDOWN_GRACE_MS = 1_000;
const BODY_DEADLINE_MS = 3_000;

class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function headers(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function problem(response: ServerResponse, error: unknown): void {
  let status = 503;
  let code = 'TEMPORARY_UNAVAILABLE';
  let message = 'The outcome could not be returned. Keep the same intent and reconcile or retry.';
  if (error instanceof HttpProblem) {
    ({ status, code, message } = error);
  } else if (error instanceof IntentConflict) {
    status = 409;
    code = 'INTENT_CONFLICT';
    message = error.message;
  } else if (error instanceof InvalidReservation) {
    status = 400;
    code = 'INVALID_REQUEST';
    message = error.message;
  }
  // Do not leak SQL, absolute paths or injected fixture exception text.
  response.setHeader('Connection', 'close');
  json(response, status, { error: { code, message, retryable: status >= 500 } } satisfies ApiError);
}

function singletonHeader(request: IncomingMessage, name: string): string | undefined {
  const matches = request.rawHeaders.filter(
    (_, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === name,
  ).length;
  if (matches > 1) throw new HttpProblem(400, 'INVALID_HEADER', `Send a single ${name} header.`);
  const value = request.headers[name];
  if (Array.isArray(value))
    throw new HttpProblem(400, 'INVALID_HEADER', `Send a single ${name} header.`);
  return value;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const type = singletonHeader(request, 'content-type');
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type))
    throw new HttpProblem(415, 'JSON_REQUIRED', 'Use application/json with UTF-8 encoding.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')
    throw new HttpProblem(
      415,
      'ENCODING_UNSUPPORTED',
      'Compressed request bodies are not accepted.',
    );
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new HttpProblem(413, 'BODY_TOO_LARGE', 'The request body exceeds the local lab limit.');
  const bytes = await new Promise<Buffer>((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(
      () =>
        finish(new HttpProblem(408, 'BODY_TIMEOUT', 'The request body did not arrive in time.')),
      BODY_DEADLINE_MS,
    );
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) {
        request.pause();
        reject(error);
      } else resolveBody(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES)
        finish(
          new HttpProblem(413, 'BODY_TOO_LARGE', 'The request body exceeds the local lab limit.'),
        );
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const onAborted = () =>
      finish(new HttpProblem(400, 'BODY_ABORTED', 'The request body was interrupted.'));
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpProblem(400, 'INVALID_JSON', 'The request body must be valid UTF-8 JSON.');
  }
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function staticFile(
  root: string | undefined,
  path: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!root) throw new HttpProblem(404, 'NOT_FOUND', 'No static client is configured.');
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new HttpProblem(400, 'INVALID_PATH', 'The request path is invalid.');
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((segment) => segment.startsWith('.'))
  )
    throw new HttpProblem(404, 'NOT_FOUND', 'The requested file is unavailable.');
  const local = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
  const type = contentTypes[extname(local)];
  if (!type || !contained(root, local))
    throw new HttpProblem(404, 'NOT_FOUND', 'The requested file is unavailable.');
  try {
    const actual = await realpath(local);
    if (!contained(root, actual))
      throw new HttpProblem(404, 'NOT_FOUND', 'The requested file is unavailable.');
    const info = await stat(actual);
    if (!info.isFile() || info.size > 2_000_000)
      throw new HttpProblem(404, 'NOT_FOUND', 'The requested file is unavailable.');
    const data = await readFile(actual);
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error instanceof HttpProblem) throw error;
    throw new HttpProblem(404, 'NOT_FOUND', 'The requested file is unavailable.');
  }
}

export interface ServerOptions {
  databasePath: string;
  port?: number;
  staticRoot?: string;
  checkpoint?: Checkpoint;
}

export async function startServer(
  options: ServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
  )
    throw new Error('Use a valid TCP port.');
  const staticRoot =
    options.staticRoot === undefined ? undefined : await realpath(resolve(options.staticRoot));
  const store = new ReservationStore(options.databasePath, options.checkpoint);
  const pending = new Set<Promise<void>>();
  let port = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    headers(response);
    const host = singletonHeader(request, 'host');
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!host || !allowedHosts.includes(host))
      throw new HttpProblem(403, 'LOCAL_ONLY', 'Use the loopback address printed by the server.');
    const origin = singletonHeader(request, 'origin');
    if (origin !== undefined && !allowedHosts.map((value) => `http://${value}`).includes(origin))
      throw new HttpProblem(403, 'ORIGIN_FORBIDDEN', 'Use the local lab origin.');
    if (!request.url?.startsWith('/') || request.url.startsWith('//'))
      throw new HttpProblem(400, 'INVALID_PATH', 'Use an origin-form request path.');
    const url = new URL(request.url, `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/api/health')
      return json(response, 200, { status: 'ready' });
    if (request.method === 'GET' && url.pathname === '/api/ledger')
      return json(response, 200, store.ledger());
    if (request.method === 'GET' && url.pathname.startsWith('/api/intents/')) {
      const intentId = url.pathname.slice('/api/intents/'.length);
      if (!isIntentId(intentId)) throw new InvalidReservation();
      const outcome = store.lookup(intentId);
      return outcome
        ? json(response, 200, outcome)
        : json(response, 404, { intentId, status: 'unseen' });
    }
    if (request.method === 'POST' && url.pathname === '/api/reservations') {
      const intentId = singletonHeader(request, 'idempotency-key');
      if (!isIntentId(intentId)) throw new InvalidReservation();
      const fault = singletonHeader(request, 'x-lab-fault') ?? 'none';
      if (!FAULTS.includes(fault as Fault))
        throw new HttpProblem(400, 'INVALID_FAULT', 'Use a documented synthetic fault.');
      const command = await body(request);
      if (!isCommand(command)) throw new InvalidReservation();
      // Deliberately independent of the response socket. Aborting a caller's wait is
      // not cancellation; an unseen GET during this delay says nothing about the future.
      if (fault === 'delay-before-commit') await delay(DELAY_BEFORE_COMMIT_MS);
      let outcome;
      try {
        outcome = store.reserve(intentId, command, {
          rollbackBeforeCommit: fault === 'drop-before-commit',
        });
      } catch (error) {
        if (error instanceof InjectedDropBeforeCommit) {
          response.destroy();
          return;
        }
        throw error;
      }
      if (fault === 'drop-before-commit' || fault === 'drop-after-commit') {
        response.destroy();
        return;
      }
      return json(response, 200, outcome);
    }
    if (url.pathname.startsWith('/api/'))
      throw new HttpProblem(404, 'NOT_FOUND', 'The requested API route is unavailable.');
    if (request.method !== 'GET' && request.method !== 'HEAD')
      throw new HttpProblem(405, 'METHOD_NOT_ALLOWED', 'Use GET or HEAD for static content.');
    await staticFile(staticRoot, url.pathname, request, response);
  }

  const server = createServer((request, response) => {
    const task = handle(request, response)
      .catch((error) => {
        if (!response.destroyed && !response.writableEnded) problem(response, error);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 4_000;
  server.keepAliveTimeout = 1_000;
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    store.close();
    throw new Error('The loopback listener did not start.');
  }
  port = address.port;
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      closing ??= (async () => {
        await new Promise<void>((resolveClose) => {
          const timer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
          server.close(() => {
            clearTimeout(timer);
            resolveClose();
          });
        });
        // Forced socket closure must not race database.close with an already accepted
        // delayed command. The fixed delay is bounded; checkpoint fixtures may block.
        await Promise.allSettled([...pending]);
        store.close();
      })();
      return closing;
    },
  };
}
