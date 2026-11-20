import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const validPayload = JSON.parse(await readFile(resolve(here, 'fixtures/complete-payload.json'), 'utf8'));

describe('health upload gateway', () => {
  let server;
  let dataDir;

  afterEach(async () => {
    if (server) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    server = undefined;
    dataDir = undefined;
  });

  async function startServer() {
    dataDir = await mkdtemp(join(tmpdir(), 'health-upload-server-'));
    server = createServer({ token: 'test-token', dataDir });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }

  it('reports healthy from the healthz endpoint', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('rejects missing or incorrect upload credentials with 401, including query tokens', async () => {
    const baseUrl = await startServer();
    const body = JSON.stringify(validPayload);

    for (const url of [`${baseUrl}/ingest`, `${baseUrl}/ingest?key=test-token`]) {
      const missing = await fetch(url, { method: 'POST', body });
      assert.equal(missing.status, 401);
      assert.deepEqual(await missing.json(), { ok: false, error: 'invalid_request' });
    }

    const incorrect = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'X-Upload-Key': 'wrong' },
      body,
    });
    assert.equal(incorrect.status, 401);
    assert.deepEqual(await incorrect.json(), { ok: false, error: 'invalid_request' });
  });

  it('accepts a valid upload and returns stored date and collection status', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'X-Upload-Key': 'test-token' },
      body: JSON.stringify(validPayload),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, date: '2026-10-20', collection_status: 'complete' });
    assert.deepEqual(await readdir(dataDir), ['2026-10-20.json']);
  });

  it('rejects malformed JSON and invalid schema with 400 without writing a file', async () => {
    const baseUrl = await startServer();
    const headers = { 'X-Upload-Key': 'test-token' };

    const malformed = await fetch(`${baseUrl}/ingest`, { method: 'POST', headers, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid_request' });

    const invalid = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...validPayload, schema_version: 2 }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_request' });
    assert.deepEqual(await readdir(dataDir), []);
  });

  it('rejects request bodies larger than 1 MiB with a generic 400 error', async () => {
    const baseUrl = await startServer();
    const oversized = JSON.stringify({ ...validPayload, padding: 'x'.repeat(1024 * 1024) });

    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'X-Upload-Key': 'test-token' },
      body: oversized,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'invalid_request' });
    assert.deepEqual(await readdir(dataDir), []);
  });
});
