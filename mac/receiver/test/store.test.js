import { chmod, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JsonHealthStore } from '../src/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const validPayload = JSON.parse(await readFile(resolve(here, 'fixtures/complete-payload.json'), 'utf8'));

describe('JsonHealthStore', () => {
  const temporaryDirectories = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function makeStore() {
    const directory = await mkdtemp(join(tmpdir(), 'health-upload-store-'));
    temporaryDirectories.push(directory);
    return { directory, store: new JsonHealthStore(directory) };
  }

  it('writes one JSON file named for the payload date with a trailing newline', async () => {
    const { directory, store } = await makeStore();

    const result = await store.save(validPayload);

    assert.match(result.path, /2026-10-20\.json$/);
    assert.equal(result.collection_status, 'complete');
    assert.deepEqual(JSON.parse(await readFile(result.path, 'utf8')), validPayload);
    assert.equal((await readFile(result.path, 'utf8')).endsWith('\n'), true);
    assert.deepEqual(await readdir(directory), ['2026-10-20.json']);
  });

  it('replaces the same-date file instead of creating duplicates', async () => {
    const { directory, store } = await makeStore();
    await store.save(validPayload);
    const updated = { ...validPayload, collected_at: '2026-10-21T08:05:00+08:00' };

    const result = await store.save(updated);

    assert.equal(result.path, join(directory, '2026-10-20.json'));
    assert.deepEqual(await readdir(directory), ['2026-10-20.json']);
    assert.equal(JSON.parse(await readFile(result.path, 'utf8')).collected_at, updated.collected_at);
  });

  it('saves concurrent same-date uploads without temporary-file collisions', async () => {
    const { directory, store } = await makeStore();
    const uploads = Array.from({ length: 20 }, (_, index) => store.save({
      ...validPayload,
      collected_at: `2026-10-21T08:${String(index).padStart(2, '0')}:00+08:00`,
    }));

    const results = await Promise.all(uploads);

    assert.equal(results.length, 20);
    assert.ok(results.every(result => result.path === join(directory, '2026-10-20.json')));
    assert.deepEqual(await readdir(directory), ['2026-10-20.json']);
    const saved = JSON.parse(await readFile(join(directory, '2026-10-20.json'), 'utf8'));
    assert.equal(saved.date, '2026-10-20');
    assert.equal(typeof saved.collected_at, 'string');
    assert.equal(saved.metrics[0].value, 4321);
  });

  it('deduplicates identical samples while retaining source and value variants', async () => {
    const { directory, store } = await makeStore();
    const metric = validPayload.metrics[0];
    const sleep = validPayload.sleep[0];
    const workout = {
      start: '2026-10-20T09:00:00+08:00',
      end: '2026-10-20T09:30:00+08:00',
      type: 'running',
      source: 'Synthetic Watch',
    };
    const payload = {
      ...validPayload,
      extra_metadata: { keep: true },
      metrics: [metric, { ...metric }, { ...metric, source: 'Other Device' }, { ...metric, value: 9000 }],
      sleep: [sleep, { ...sleep }, { ...sleep, source: 'Other Device' }],
      workouts: [workout, { ...workout }, { ...workout, source: 'Other Device' }],
    };

    const result = await store.save(payload);
    const saved = JSON.parse(await readFile(result.path, 'utf8'));

    assert.equal(saved.extra_metadata.keep, true);
    assert.equal(saved.metrics.length, 3);
    assert.equal(saved.sleep.length, 2);
    assert.equal(saved.workouts.length, 2);
    assert.equal(saved.metrics[1].source, 'Other Device');
    assert.equal(saved.metrics[2].value, 9000);
  });

  it('restricts the health directory and saved JSON file permissions', { skip: process.platform === 'win32' }, async () => {
    const { directory, store } = await makeStore();
    await chmod(directory, 0o755);

    const result = await store.save(validPayload);

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  });
});
