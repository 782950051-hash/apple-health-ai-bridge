import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { V33HealthImporter } from '../src/v33-import.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/apple-health-v33.json', import.meta.url), 'utf8'));

describe('v3.3 iCloud importer', () => {
  it('waits for stable files, validates by content, stores raw bytes and deduplicates hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v33-import-'));
    const input = join(root, 'input'); const source = join(input, 'health-2026-11-01-12.json');
    try {
      await mkdir(input, { recursive: true }); await writeFile(source, JSON.stringify(fixture));
      const old = new Date('2026-11-01T01:00:00Z'); await utimes(source, old, old);
      const importer = new V33HealthImporter({ inputDir: input, dataDir: join(root, 'data'), settleMs: 1000, now: () => Date.parse('2026-11-01T04:00:00Z') });
      assert.deepEqual(await importer.scanOnce(), { imported: 1, skipped: 0, deferred: 0, failed: 0 });
      const stored = JSON.parse(await readFile(join(root, 'data', 'v33-health', '2026-11-01.json')));
      assert.equal(stored.payload.exporter_version, '3.3.0'); assert.match(stored.source_hash, /^[a-f0-9]{64}$/);
      assert.deepEqual(await importer.scanOnce(), { imported: 0, skipped: 1, deferred: 0, failed: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
