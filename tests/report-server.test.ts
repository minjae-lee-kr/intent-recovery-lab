import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { request } from 'node:http';
import { serveReport } from '../scripts/serve-report.ts';

test('report preview exposes only the four generated assets over a read-only loopback boundary', async () => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'intent-report-preview-'));
  let server: Awaited<ReturnType<typeof serveReport>> | undefined;
  try {
    for (const file of ['index.html', 'report.js', 'report.css', 'evidence.json', 'private.txt'])
      await writeFile(join(directory, file), file);
    server = await serveReport(directory, 0);
    const response = await fetch(server.url);
    assert.equal(await response.text(), 'index.html');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy')!, /connect-src 'none'/);
    assert.equal(await (await fetch(`${server.url}/evidence.json`, { method: 'HEAD' })).text(), '');
    for (const route of [
      '/private.txt',
      '/%2e%2e/private.txt',
      '/.env',
      '/api/ledger',
      '//index.html',
    ])
      assert.equal((await fetch(`${server.url}${route}`)).status, 404);
    assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);
    const foreignHost = await new Promise<number | undefined>((resolveStatus, reject) => {
      const pending = request(server!.url, { headers: { Host: 'foreign.invalid' } }, (actual) => {
        actual.resume();
        actual.on('end', () => resolveStatus(actual.statusCode));
      });
      pending.on('error', reject);
      pending.end();
    });
    assert.equal(foreignHost, 403);
  } finally {
    await server?.close();
    assert.equal(dirname(directory), parent);
    await rm(directory, { recursive: true, force: true });
  }
});
