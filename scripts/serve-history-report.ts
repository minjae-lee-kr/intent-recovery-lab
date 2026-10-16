import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRecording, resolveReportDirectory } from './history/presentation.ts';

const required = [
  'index.html',
  'report.css',
  'report.js',
  'report-data.js',
  'recording.json',
  'evidence.json',
];
const allowed = (name: string) =>
  required.includes(name) || /^seed-(104729|130363|155921)(-stale-control)?\.json$/.test(name);
export async function serveHistoryReport(directory: string, port = 4341) {
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, 'Use a valid port');
  const root = resolve(directory);
  await resolveReportDirectory(dirname(root));
  assert.match(basename(root), /^view-[a-f0-9]{8}$/, 'Use a generated view directory');
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Use a regular view directory');
  assert.equal(await realpath(root), root, 'View escaped its directory');
  async function capture(name: string) {
    const path = join(root, name),
      stat = await lstat(path);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2_000_000,
      'Invalid view asset',
    );
    assert.equal(dirname(await realpath(path)), root, 'Asset escaped view directory');
    return readFile(path);
  }
  const manifestBytes = await capture('assets.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Array<{
    name: string;
    sha256: string;
  }>;
  assert.ok(Array.isArray(manifest) && manifest.length <= 12, 'Invalid asset manifest');
  assert.equal(new Set(manifest.map((row) => row.name)).size, manifest.length, 'Duplicate asset');
  assert.ok(
    required.every((name) => manifest.some((row) => row.name === name)),
    'Missing required asset',
  );
  const files = new Map<string, Buffer>();
  for (const row of manifest) {
    assert.ok(allowed(row.name) && /^[a-f0-9]{64}$/.test(row.sha256), 'Unexpected view asset');
    const bytes = await capture(row.name);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      row.sha256,
      'Mixed or modified view assets',
    );
    files.set('/' + row.name, bytes);
  }
  files.set('/assets.json', manifestBytes);
  files.set('/', files.get('/index.html')!);
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 4000 },
    (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      const address = server.address(),
        port = address && typeof address !== 'string' ? address.port : 0;
      const host = request.headers.host,
        origin = request.headers.origin;
      if (
        (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) ||
        (origin !== undefined && origin !== `http://${host}`) ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const route = request.url ?? '',
        body = files.get(route);
      if (!body) {
        response.writeHead(404);
        response.end();
        return;
      }
      const type = route.endsWith('.js')
        ? 'text/javascript'
        : route.endsWith('.css')
          ? 'text/css'
          : route.endsWith('.json')
            ? 'application/json'
            : 'text/html';
      response.writeHead(200, {
        'Content-Type': type + '; charset=utf-8',
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      closing ??= new Promise<void>((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), 500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2]!.startsWith('-')) {
    process.stderr.write('Usage: pnpm history:report reports/<history-run-id>\n');
    process.exitCode = 64;
  } else
    try {
      const prepared = await prepareRecording(process.argv[2]!);
      const server = await serveHistoryReport(prepared.directory);
      process.stdout.write(
        `Recorded history: ${server.url}\nRaw run: ${prepared.recording.sourceReport}\nRenderer Git: ${prepared.recording.renderer.git.head ?? 'unavailable'}; dirty=${String(prepared.recording.renderer.git.dirty)}\n`,
      );
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => {
          void server.close();
        });
    } catch (error) {
      process.stderr.write(
        `History report unavailable: ${error instanceof Error ? error.message : 'Unknown error'}\n`,
      );
      process.exitCode = 1;
    }
}
