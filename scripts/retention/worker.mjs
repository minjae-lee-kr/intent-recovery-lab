import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const [role, databasePath, providerUrl = ''] = process.argv.slice(2);
if (
  !['local', 'downstream'].includes(role) ||
  typeof process.send !== 'function' ||
  !isAbsolute(databasePath ?? '') ||
  (role === 'local' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(providerUrl))
)
  throw new Error('This fixture requires an owned parent IPC channel and valid configuration.');
const db = new DatabaseSync(databasePath);
db.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000',
);
const TTL = 1000,
  MARGIN = 100,
  CONTRACT = 'synthetic-retention-v1';
let now = 0,
  clockKnown = false,
  nextFault = 'none',
  closing = false;
const active = new Set(),
  locked = new Set();
const command = (units) => JSON.stringify({ units });
const validId = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{7,63}$/.test(value);
const row = (sql, ...args) => db.prepare(sql).get(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const transaction = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
};
const journal = (id, event, detail = {}) =>
  run(
    'INSERT INTO journal (intent_key,event,clock,detail) VALUES (?,?,?,?)',
    id,
    event,
    clockKnown ? now : null,
    JSON.stringify(detail),
  );
db.exec(
  'CREATE TABLE IF NOT EXISTS journal (seq INTEGER PRIMARY KEY, intent_key TEXT NOT NULL, event TEXT NOT NULL, clock INTEGER, detail TEXT NOT NULL) STRICT',
);
db.exec(
  'CREATE TABLE IF NOT EXISTS clock_floor (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL) STRICT; INSERT OR IGNORE INTO clock_floor VALUES(1,0)',
);
if (role === 'downstream')
  db.exec(`
 CREATE TABLE IF NOT EXISTS effects (receipt TEXT PRIMARY KEY, intent_key TEXT NOT NULL, units INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
 CREATE TABLE IF NOT EXISTS dedup (intent_key TEXT PRIMARY KEY, command TEXT NOT NULL, receipt TEXT NOT NULL REFERENCES effects(receipt), expires_at INTEGER NOT NULL) STRICT;
`);
else
  db.exec(`
 CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, intent_key TEXT NOT NULL UNIQUE, units INTEGER NOT NULL, policy TEXT NOT NULL, first_at INTEGER NOT NULL, retry_before INTEGER NOT NULL, contract TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT) STRICT;
 CREATE TABLE IF NOT EXISTS grants (intent_id TEXT PRIMARY KEY REFERENCES intents(id), receipt TEXT NOT NULL UNIQUE, units INTEGER NOT NULL) STRICT;
`);
const json = (res, status, value) => {
  if (!res.destroyed) {
    if (status >= 400) res.setHeader('Connection', 'close');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  }
};
async function body(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > 1024))
    throw new HttpProblem(413, 'BODY_LIMIT');
  const bytes = await new Promise((resolve, reject) => {
    let size = 0,
      finished = false;
    const chunks = [];
    const timer = setTimeout(() => finish(new HttpProblem(408, 'BODY_TIMEOUT')), 1000);
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (error) {
        req.pause();
        reject(error);
      } else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > 1024) finish(new HttpProblem(413, 'BODY_LIMIT'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = () => finish(new HttpProblem(400, 'BODY_INTERRUPTED'));
    const onAborted = () => finish(new HttpProblem(400, 'BODY_INTERRUPTED'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpProblem(400, 'INVALID_JSON');
  }
}
class HttpProblem extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function remoteOutcome(key, receipt, units, createdAt, expiresAt) {
  return {
    key,
    command: { units },
    receipt,
    createdAt,
    retainedUntil: expiresAt,
    contract: CONTRACT,
  };
}
function validOutcome(value, intent) {
  return (
    exact(value, ['key', 'command', 'receipt', 'createdAt', 'retainedUntil', 'contract']) &&
    value.key === intent.intent_key &&
    exact(value.command, ['units']) &&
    value.command.units === intent.units &&
    /^effect_[a-f0-9-]{36}$/.test(value.receipt) &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.retainedUntil) &&
    value.retainedUntil - value.createdAt === TTL &&
    value.contract === intent.contract
  );
}
function localView(intent) {
  return {
    intentId: intent.id,
    key: intent.intent_key,
    command: { units: intent.units },
    status: intent.status,
    receipt: intent.receipt,
    firstDispatchAt: intent.first_at,
    retryBefore: intent.retry_before,
    contract: intent.contract,
  };
}
function complete(intent, outcome, attemptId) {
  transaction(() => {
    run(
      'INSERT INTO grants(intent_id,receipt,units) VALUES(?,?,?)',
      intent.id,
      outcome.receipt,
      intent.units,
    );
    run("UPDATE intents SET status='confirmed',receipt=? WHERE id=?", outcome.receipt, intent.id);
    journal(intent.intent_key, 'local-grant', {
      receipt: outcome.receipt,
      attemptId,
    });
  });
}
async function downstream(req, res, url) {
  if (!clockKnown) return json(res, 503, { error: 'CLOCK_UNKNOWN' });
  const key = url.pathname.startsWith('/keys/')
    ? url.pathname.slice(6)
    : req.headers['idempotency-key'];
  if (!validId(key)) return json(res, 400, { error: 'INVALID_KEY' });
  const attemptId = req.headers['x-research-attempt'];
  if (typeof attemptId !== 'string' || !/^attempt-[1-9][0-9]{0,8}$/.test(attemptId))
    return json(res, 400, { error: 'INVALID_ATTEMPT' });
  if (req.method === 'GET' && url.pathname.startsWith('/keys/')) {
    const result = transaction(() => {
      const found = row(
        'SELECT d.*,e.units,e.created_at FROM dedup d JOIN effects e ON e.receipt=d.receipt WHERE d.intent_key=?',
        key,
      );
      journal(key, found ? 'lookup-retained' : 'lookup-absent', { attemptId });
      return found;
    });
    return result
      ? json(
          res,
          200,
          remoteOutcome(key, result.receipt, result.units, result.created_at, result.expires_at),
        )
      : json(res, 404, {
          key,
          status: 'absent',
          meaning: 'No retained deduplication record; historical execution is unknown.',
        });
  }
  if (req.method !== 'POST' || url.pathname !== '/effects')
    return json(res, 404, { error: 'NOT_FOUND' });
  const value = await body(req);
  if (
    !exact(value, ['units']) ||
    !Number.isInteger(value.units) ||
    value.units < 1 ||
    value.units > 3
  )
    return json(res, 400, { error: 'INVALID_COMMAND' });
  const fault = nextFault;
  nextFault = 'none';
  if (fault === 'before') {
    journal(key, 'post-drop-before-commit', { attemptId });
    res.destroy();
    return;
  }
  const result = transaction(() => {
    const previous = row(
      'SELECT d.*,e.units,e.created_at FROM dedup d JOIN effects e ON e.receipt=d.receipt WHERE d.intent_key=?',
      key,
    );
    if (previous) {
      if (previous.command !== command(value.units)) {
        journal(key, 'post-conflict', { attemptId });
        return { status: 409, body: { error: 'COMMAND_CONFLICT' } };
      }
      journal(key, 'post-replayed', { receipt: previous.receipt, attemptId });
      return {
        status: 200,
        body: remoteOutcome(
          key,
          previous.receipt,
          previous.units,
          previous.created_at,
          previous.expires_at,
        ),
      };
    }
    const receipt = `effect_${randomUUID()}`;
    run('INSERT INTO effects VALUES(?,?,?,?)', receipt, key, value.units, now);
    run('INSERT INTO dedup VALUES(?,?,?,?)', key, command(value.units), receipt, now + TTL);
    journal(key, 'post-new-effect', { receipt, attemptId });
    return {
      status: 200,
      body: remoteOutcome(key, receipt, value.units, now, now + TTL),
    };
  });
  if (fault === 'after') {
    res.destroy();
    return;
  }
  json(res, result.status, result.body);
}
async function local(req, res, url) {
  if (req.method === 'GET' && url.pathname.startsWith('/intents/')) {
    const item = row('SELECT * FROM intents WHERE id=?', url.pathname.slice(9));
    return item ? json(res, 200, localView(item)) : json(res, 404, { error: 'NOT_FOUND' });
  }
  if (req.method !== 'POST' || url.pathname !== '/intents')
    return json(res, 404, { error: 'NOT_FOUND' });
  const value = await body(req);
  if (
    !exact(value, ['intentId', 'units', 'policy', 'action']) ||
    !validId(value.intentId) ||
    !Number.isInteger(value.units) ||
    value.units < 1 ||
    value.units > 3 ||
    !['naive', 'guarded'].includes(value.policy) ||
    !['execute', 'reconcile'].includes(value.action)
  )
    return json(res, 400, { error: 'INVALID_COMMAND' });
  if (locked.has(value.intentId)) return json(res, 409, { error: 'INTENT_BUSY' });
  locked.add(value.intentId);
  try {
    let intent = row('SELECT * FROM intents WHERE id=?', value.intentId);
    if (!intent) {
      if (value.action !== 'execute') return json(res, 404, { error: 'NOT_FOUND' });
      if (!clockKnown) return json(res, 503, { error: 'CLOCK_UNKNOWN' });
      transaction(() => {
        run(
          'INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?)',
          value.intentId,
          `key-${value.intentId}`,
          value.units,
          value.policy,
          now,
          now + TTL - MARGIN,
          CONTRACT,
          'unknown',
          null,
        );
        journal(`key-${value.intentId}`, 'intent-persisted', {
          retention: TTL,
          margin: MARGIN,
        });
      });
      intent = row('SELECT * FROM intents WHERE id=?', value.intentId);
    }
    if (intent.units !== value.units || intent.policy !== value.policy)
      return json(res, 409, { error: 'INTENT_CONFLICT' });
    if (intent.status === 'confirmed') return json(res, 200, localView(intent));
    if (
      value.action === 'execute' &&
      (!clockKnown ||
        (intent.policy === 'guarded' &&
          (now >= intent.retry_before || intent.status === 'needs-reconciliation')))
    ) {
      transaction(() => {
        run("UPDATE intents SET status='needs-reconciliation' WHERE id=?", intent.id);
        journal(intent.intent_key, 'dispatch-refused', {
          reason: !clockKnown
            ? 'CLOCK_UNKNOWN'
            : now >= intent.retry_before
              ? 'RETENTION_HORIZON_REACHED'
              : 'RECONCILIATION_REQUIRED',
          retryBefore: intent.retry_before,
        });
      });
      return json(res, 202, localView(row('SELECT * FROM intents WHERE id=?', intent.id)));
    }
    const lookup = value.action === 'reconcile';
    const attemptId = `attempt-${row("SELECT COUNT(*) AS n FROM journal WHERE intent_key=? AND event IN ('dispatch-post','dispatch-lookup')", intent.intent_key).n + 1}`;
    journal(intent.intent_key, lookup ? 'dispatch-lookup' : 'dispatch-post', {
      retryBefore: intent.retry_before,
      attemptId,
    });
    try {
      const response = await fetch(
        `${providerUrl}${lookup ? `/keys/${intent.intent_key}` : '/effects'}`,
        {
          method: lookup ? 'GET' : 'POST',
          headers: {
            'x-research-attempt': attemptId,
            ...(lookup
              ? {}
              : {
                  'content-type': 'application/json',
                  'idempotency-key': intent.intent_key,
                }),
          },
          ...(lookup
            ? {}
            : {
                body: command(intent.units),
              }),
          signal: AbortSignal.timeout(2000),
        },
      );
      const result = await response.json();
      if (response.status === 200 && validOutcome(result, intent))
        complete(intent, result, attemptId);
      else if (
        lookup &&
        response.status === 404 &&
        exact(result, ['key', 'status', 'meaning']) &&
        result.key === intent.intent_key &&
        result.status === 'absent'
      )
        transaction(() => {
          journal(intent.intent_key, 'observed-absence', {
            attemptId,
            meaning: 'retained-key absence does not prove historical non-execution',
          });
          if (!clockKnown || now >= intent.retry_before)
            run("UPDATE intents SET status='needs-reconciliation' WHERE id=?", intent.id);
        });
      else
        journal(intent.intent_key, 'unresolved-response', {
          attemptId,
          status: response.status,
        });
    } catch (error) {
      journal(intent.intent_key, 'transport-unknown', {
        attemptId,
        name: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    intent = row('SELECT * FROM intents WHERE id=?', intent.id);
    return json(res, intent.status === 'confirmed' ? 200 : 202, localView(intent));
  } finally {
    locked.delete(value.intentId);
  }
}
const server = createServer((req, res) => {
  for (const name of ['host', 'origin', 'content-type', 'idempotency-key', 'x-research-attempt']) {
    if (
      req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
        .length > 1
    )
      return json(res, 400, { error: 'DUPLICATE_HEADER' });
  }
  const address = server.address(),
    host = req.headers.host;
  if (
    !address ||
    host !== `127.0.0.1:${address.port}` ||
    (req.headers.origin && req.headers.origin !== `http://${host}`)
  )
    return json(res, 403, { error: 'LOCAL_ONLY' });
  if (closing) return json(res, 503, { error: 'CLOSING' });
  if (
    req.method === 'POST' &&
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
  )
    return json(res, 415, { error: 'JSON_REQUIRED' });
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    return json(res, 415, { error: 'ENCODING_UNSUPPORTED' });
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${host}`);
  } catch {
    return json(res, 400, { error: 'INVALID_URL' });
  }
  const task = (role === 'downstream' ? downstream : local)(req, res, parsedUrl)
    .catch((error) =>
      json(res, error instanceof HttpProblem ? error.status : 500, {
        error: error instanceof HttpProblem ? error.code : 'FIXTURE_ERROR',
      }),
    )
    .finally(() => active.delete(task));
  active.add(task);
});
server.requestTimeout = 3000;
server.headersTimeout = 2000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}`;
process.send?.({ type: 'ready', role, pid: process.pid, url });
let closePromise;
function close() {
  return (closePromise ??= (async () => {
    closing = true;
    const timer = setTimeout(() => server.closeAllConnections(), 500);
    timer.unref();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(timer);
    await Promise.allSettled([...active]);
    db.close();
  })());
}
process.on('message', (message) => {
  void (async () => {
    const { id, type } = message ?? {};
    if (type === 'clock') {
      if (
        !Number.isSafeInteger(message.value) ||
        message.value < now ||
        message.value < row('SELECT value FROM clock_floor WHERE id=1').value
      )
        throw new Error('Clock must advance monotonically, including across restart');
      run('UPDATE clock_floor SET value=? WHERE id=1', message.value);
      now = message.value;
      clockKnown = true;
    } else if (type === 'prune') {
      if (role !== 'downstream' || !clockKnown) throw new Error('Prune needs downstream clock');
      transaction(() => {
        const expired = db.prepare('SELECT intent_key FROM dedup WHERE expires_at<=?').all(now);
        for (const entry of expired) journal(entry.intent_key, 'dedup-pruned');
        run('DELETE FROM dedup WHERE expires_at<=?', now);
      });
    } else if (type === 'fault') {
      if (role !== 'downstream' || !['before', 'after', 'none'].includes(message.value))
        throw new Error('Invalid fault');
      nextFault = message.value;
    } else if (type === 'stop') {
      await close();
      process.send?.({ id, ok: true }, () => process.disconnect?.());
      return;
    } else throw new Error('Unknown private control');
    process.send?.({ id, ok: true, value: now });
  })().catch((error) => process.send?.({ id: message?.id, ok: false, error: error.message }));
});
process.once('disconnect', () => void close());
