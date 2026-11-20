import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

// Synthetic data only. The real application's format is deliberately opaque:
// this endpoint must preserve every field rather than guess its schema.
const original = Buffer.from('{\n  "metrics": [{"name":"test_metric","unit":"count","data":[{"qty":12,"source":"测试手表"}]}],\n  "sleep": [{"stage":"REM","start":"2026-10-23T23:50:00+08:00","end":"2026-10-24T00:30:00+08:00"}],\n  "future_field": {"keep":true}\n}\n');
const id = createHash('sha256').update(original).digest('hex');
const headers = { 'X-Upload-Key': 'test-token', 'Content-Type': 'application/json' };

describe('original JSON export upload', () => {
  let server;
  let dataDir;
  afterEach(async () => {
    if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    server = undefined;
    dataDir = undefined;
  });
  async function start() {
    dataDir = await mkdtemp(join(tmpdir(), 'health-export-'));
    server = createServer({ token: 'test-token', dataDir });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('preserves the complete UTF-8 file and makes duplicate retries idempotent', async () => {
    const base = await start();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/exports`, { method: 'POST', headers, body: original });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, export_id: id, bytes: original.length, format: 'raw_json' });
    }
    const directory = join(dataDir, 'exports');
    const path = join(directory, `${id}.json`);
    assert.deepEqual(await readdir(directory), [`${id}.json`]);
    assert.deepEqual(await readFile(path), original);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    // Original exports do not pretend to be normalized daily reports.
    assert.deepEqual(await (await fetch(`${base}/status`)).json(), { ok: true, latest_date: null });
    assert.equal((await fetch(`${base}/exports/${id}.json`)).status, 404);
  });

  it('does not accept missing, wrong, or query-string upload keys', async () => {
    const base = await start();
    for (const [url, requestHeaders] of [
      [`${base}/exports`, {}],
      [`${base}/exports?key=test-token`, {}],
      [`${base}/exports`, { 'X-Upload-Key': 'wrong' }],
    ]) {
      const response = await fetch(url, { method: 'POST', headers: requestHeaders, body: original });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: 'invalid_request' });
    }
    assert.deepEqual(await readdir(dataDir), []);
  });

  it('accepts a multi-megabyte raw export without truncation', async () => {
    const base = await start();
    const body = Buffer.from(JSON.stringify({ synthetic_raw_samples: 'x'.repeat(2 * 1024 * 1024) }));
    const digest = createHash('sha256').update(body).digest('hex');
    const response = await fetch(`${base}/exports`, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bytes, body.length);
    assert.deepEqual(await readFile(join(dataDir, 'exports', `${digest}.json`)), body);
  });

  it('rejects malformed JSON, invalid UTF-8, primitive roots, and oversized bodies without storing them', async () => {
    const base = await start();
    for (const body of [Buffer.from('{'), Buffer.from([123,34,120,34,58,34,255,34,125]), 'null', '123', '"text"', JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) })]) {
      const response = await fetch(`${base}/exports`, { method: 'POST', headers, body });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: 'invalid_request' });
    }
    assert.deepEqual(await readdir(dataDir), []);
  });
});
