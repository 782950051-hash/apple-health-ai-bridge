import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const validPayload = JSON.parse(await readFile(resolve(here, 'fixtures/complete-payload.json'), 'utf8'));

describe('status endpoint', () => {
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
    dataDir = await mkdtemp(join(tmpdir(), 'health-upload-status-'));
    server = createServer({ token: 'test-token', dataDir });
    await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }

  it('reports readiness and latest stored date without exposing health values', async () => {
    const baseUrl = await startServer();
    const before = await fetch(`${baseUrl}/status`);
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { ok: true, latest_date: null });

    const upload = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'X-Upload-Key': 'test-token' },
      body: JSON.stringify(validPayload),
    });
    assert.equal(upload.status, 200);

    const after = await fetch(`${baseUrl}/status`);
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.deepEqual(body, { ok: true, latest_date: '2026-10-20' });
    assert.equal(Object.hasOwn(body, 'metrics'), false);
    assert.equal(Object.hasOwn(body, 'sleep'), false);
  });

  it('includes the latest date from automatic wake uploads', async () => {
    const baseUrl = await startServer();
    await mkdir(join(dataDir, 'wake-uploads'), { recursive: true });
    await writeFile(join(dataDir, 'wake-uploads', '2026-10-22.json'), '{}');
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, latest_date: '2026-10-22' });
  });

  it('includes the latest date from v3.3 iCloud imports', async () => {
    const baseUrl = await startServer();
    await mkdir(join(dataDir, 'v33-health'), { recursive: true });
    await writeFile(join(dataDir, 'v33-health', '2026-11-01.json'), '{}');
    const response = await fetch(`${baseUrl}/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, latest_date: '2026-11-01' });
  });
});
