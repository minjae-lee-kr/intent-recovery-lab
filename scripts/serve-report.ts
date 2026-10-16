import { createServer } from 'node:http';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './provenance.ts';

const types: Record<string, string> = {
  '/': 'text/html; charset=utf-8',
  '/index.html': 'text/html; charset=utf-8',
  '/report.css': 'text/css; charset=utf-8',
  '/report.js': 'text/javascript; charset=utf-8',
  '/evidence.json': 'application/json; charset=utf-8',
};
export async function serveReport(directory: string, port = 4324) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Use a valid report port.');
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
    throw new Error('Use a regular generated report directory.');
  // Load only four generated public files. No request path is used as a filesystem path.
  const files = new Map<string, Buffer>();
  for (const route of Object.keys(types)) {
    const file = join(directory, route === '/' ? 'index.html' : route.slice(1));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5_000_000)
      throw new Error('Invalid generated report file.');
    files.set(route, await readFile(file));
  }
  const server = createServer(
    { requestTimeout: 5000, headersTimeout: 4000 },
    (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      const address = server.address();
      const host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
      if (
        request.headers.host !== host &&
        request.headers.host !== host.replace('127.0.0.1', 'localhost')
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
      const route = request.url;
      if (!route || !files.has(route)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const data = files.get(route)!;
      response.writeHead(200, { 'Content-Type': types[route]!, 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
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
  if (!address || typeof address === 'string') throw new Error('Report listener unavailable.');
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2)
    throw new Error('Run without arguments to view the latest generated report.');
  const root = join(projectRoot, 'reports');
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const names = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        /^\d{4}-\d{2}-\d{2}T[0-9TZ-]+-[a-f0-9]{8}$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const latest = names.at(-1);
  if (!latest) throw new Error('Run pnpm experiment first to generate a report.');
  const server = await serveReport(join(root, latest));
  process.stdout.write(`Experiment report: ${server.url}\nRun: ${latest}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void server.close();
    });
}
