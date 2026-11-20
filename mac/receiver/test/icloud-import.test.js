import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ICloudHealthImporter } from '../src/icloud-import.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/complete-payload.json', import.meta.url), 'utf8'));

async function oldFile(path, value) {
  await writeFile(path, JSON.stringify(value));
  const old = new Date('2026-10-29T00:00:00Z');
  await utimes(path, old, old);
}

describe('iCloud Drive health importer', () => {
  it('waits for stable files, imports by hash, and accepts a later same-date update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'icloud-import-'));
    const inputDir = join(root, 'in');
    const dataDir = join(root, 'data');
    const source = join(inputDir, 'health-2026-10-20.json');
    try {
      await import('node:fs/promises').then(fs => fs.mkdir(inputDir, { recursive: true }));
      const now = Date.parse('2026-10-30T01:00:00+08:00');
      const importer = new ICloudHealthImporter({ inputDir, dataDir, settleMs: 1000, now: () => now });
      await oldFile(source, fixture);

      const first = await importer.scanOnce();
      assert.deepEqual(first, { imported: 1, skipped: 0, deferred: 0, failed: 0 });
      assert.deepEqual(JSON.parse(await readFile(join(dataDir, '2026-10-20.json'))).date, '2026-10-20');

      const repeat = await importer.scanOnce();
      assert.deepEqual(repeat, { imported: 0, skipped: 1, deferred: 0, failed: 0 });

      const updated = { ...fixture, collection_status: 'partial', missing: ['heart_rate'] };
      await oldFile(source, updated);
      const second = await importer.scanOnce();
      assert.deepEqual(second, { imported: 1, skipped: 0, deferred: 0, failed: 0 });
      assert.equal(JSON.parse(await readFile(join(dataDir, '2026-10-20.json'))).collection_status, 'partial');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defers a file that is still inside the settling window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'icloud-import-deferred-'));
    const inputDir = join(root, 'in');
    const source = join(inputDir, 'health.json');
    try {
      await import('node:fs/promises').then(fs => fs.mkdir(inputDir, { recursive: true }));
      await writeFile(source, JSON.stringify(fixture));
      const importer = new ICloudHealthImporter({
        inputDir,
        dataDir: join(root, 'data'),
        settleMs: 60_000,
        now: () => Date.now(),
      });
      assert.deepEqual(await importer.scanOnce(), { imported: 0, skipped: 0, deferred: 1, failed: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('records invalid JSON without copying health values into the failure ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'icloud-import-invalid-'));
    const inputDir = join(root, 'in');
    const source = join(inputDir, 'invalid.json');
    try {
      await import('node:fs/promises').then(fs => fs.mkdir(inputDir, { recursive: true }));
      await oldFile(source, { date: '2026-10-20', secret_metric_value: 123 });
      const importer = new ICloudHealthImporter({ inputDir, dataDir: join(root, 'data'), settleMs: 1000, now: () => Date.parse('2026-10-30T01:00:00+08:00') });
      assert.deepEqual(await importer.scanOnce(), { imported: 0, skipped: 0, deferred: 0, failed: 1 });
      const ledger = JSON.parse(await readFile(join(root, 'data', 'icloud-import', 'ledger.json')));
      assert.equal(Object.keys(ledger.failures).length, 1);
      assert.equal(JSON.stringify(ledger).includes('secret_metric_value'), false);
      assert.equal(JSON.stringify(ledger).includes('123'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
