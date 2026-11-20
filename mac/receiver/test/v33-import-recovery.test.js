import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V33HealthImporter } from '../src/v33-import.js';

const bytes = await readFile(new URL('./fixtures/apple-health-v33.json', import.meta.url));
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'receiver-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = join(root, 'input'), dataDir = join(root, 'data'), events = [];
  await mkdir(inputDir);
  const opts = { inputDir, dataDir, settleMs: 0, now: () => Date.now() + 1000, retryMs: 20, maxRetryMs: 40,
    onEvent: e => events.push(e), ...options };
  return { root, inputDir, dataDir, events, opts,
    source: join(inputDir, 'health-2026-11-01.json'),
    importer: () => new V33HealthImporter(opts) };
}
const ledger = async s => JSON.parse(await readFile(join(s.dataDir, 'v33-import/ledger.json')));
const pending = async s => JSON.parse(await readFile(join(s.dataDir, 'v33-import/retry-state.json')));
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
const transient = () => Object.assign(new Error('private raw health /secret/token=NEVER_LOG_THIS'), { code: 'EDEADLK' });

test('a temporary unreadable file does not abort healthy files or poison the content ledger', async t => {
  const s = await setup(t, { readInput: async path => {
    if (path.endsWith('health-0000.json')) throw transient();
    return readFile(path);
  } });
  await writeFile(join(s.inputDir, 'health-0000.json'), bytes);
  await writeFile(s.source, bytes);
  const result = await s.importer().scanOnce();
  assert.equal(result.imported, 1);
  assert.equal(result.deferred, 1);
  assert.equal(Object.keys((await ledger(s)).failures).length, 0);
  assert.equal((await pending(s)).files['health-0000.json'].status, 'retry');
  const e = s.events.find(e => e.event === 'icloud_file_retry');
  assert.equal(e.code, 'EDEADLK'); assert.equal(e.operation, 'read_input');
  assert.equal(e.attempt, 1); assert.ok(e.scan_id); assert.ok(e.next_retry_at);
  assert.doesNotMatch(JSON.stringify(s.events), /NEVER_LOG_THIS|private raw health|\/secret/);
});

test('automatic timer retries recover an unreadable file with no manual read or rescan', async t => {
  let unreadable = true, calls = 0;
  const s = await setup(t, { readInput: async path => {
    calls++; if (unreadable) throw transient(); return readFile(path);
  } });
  await writeFile(s.source, bytes);
  const importer = s.importer();
  const first = await importer.scanOnce(); assert.equal(first.imported, 0);
  unreadable = false;
  let busy = false, failure;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try { await importer.scanOnce(); } catch (e) { failure = e; }
    finally { busy = false; }
  }, 15);
  try {
    const limit = Date.now() + 2000;
    while (Date.now() < limit) {
      const recovered = s.events.some(e => e.event === 'icloud_file_recovered');
      const retryState = await pending(s);
      if (recovered && !retryState.files['health-2026-11-01.json']) break;
      await tick();
    }
    assert.equal(failure, undefined);
    assert.ok(s.events.some(e => e.event === 'icloud_file_recovered'));
    assert.equal(Object.keys((await ledger(s)).imported).length, 1);
    assert.equal((await pending(s)).files['health-2026-11-01.json'], undefined);
    assert.ok(calls >= 2);
  } finally { clearInterval(timer); while (busy) await tick(); }
});

test('a fresh importer recovers persisted retry state and preserves attempt history', async t => {
  let unreadable = true;
  const s = await setup(t, { readInput: async path => {
    if (unreadable) throw Object.assign(new Error('temporary'), { code: 'ETIMEDOUT' });
    return readFile(path);
  } });
  await writeFile(s.source, bytes);
  await s.importer().scanOnce(); await tick(); await s.importer().scanOnce();
  assert.equal((await pending(s)).files['health-2026-11-01.json'].attempts, 2);
  unreadable = false; await tick();
  assert.equal((await s.importer().scanOnce()).imported, 1);
  assert.equal(Object.keys((await ledger(s)).imported).length, 1);
});

test('partial JSON retries without success, and repaired bytes import without manual state clearing', async t => {
  const s = await setup(t); await writeFile(s.source, '{"sleep":');
  const importer = s.importer();
  assert.equal((await importer.scanOnce()).imported, 0);
  assert.equal(Object.keys((await ledger(s)).failures).length, 0);
  assert.equal((await pending(s)).files['health-2026-11-01.json'].status, 'retry');
  await writeFile(s.source, bytes); await tick();
  assert.equal((await importer.scanOnce()).imported, 1);
});

test('unchanged invalid content reaches a visible terminal failure, new content can still recover', async t => {
  const s = await setup(t); await writeFile(s.source, '{"sleep":');
  for (let i = 0; i < 3; i++) { await s.importer().scanOnce(); await tick(); }
  assert.equal(Object.keys((await ledger(s)).failures).length, 1);
  assert.ok(s.events.some(e => e.event === 'icloud_file_rejected' && e.code === 'INVALID_JSON'));
  assert.equal((await s.importer().scanOnce()).skipped, 1);
  await writeFile(s.source, bytes);
  assert.equal((await s.importer().scanOnce()).imported, 1);
});

test('late arrivals are discovered and duplicate scans keep one immutable import', async t => {
  const s = await setup(t), importer = s.importer();
  assert.equal((await importer.scanOnce()).imported, 0);
  await writeFile(s.source, bytes);
  assert.equal((await importer.scanOnce()).imported, 1);
  assert.equal((await importer.scanOnce()).skipped, 1);
  assert.equal((await s.importer().scanOnce()).skipped, 1);
  assert.equal(Object.keys((await ledger(s)).imported).length, 1);
});

test('committed progress survives a later export error and a new importer retries only unfinished work', async t => {
  let broken = true;
  const { JsonExportStore } = await import('../src/export-store.js');
  const s = await setup(t);
  const store = new JsonExportStore(s.dataDir);
  s.opts.exportStore = { save: async data => {
    if (broken && data.includes(Buffer.from('second-run'))) throw Object.assign(new Error('disk temporarily unavailable'), { code: 'EIO' });
    return store.save(data);
  } };
  await writeFile(s.source, bytes);
  const second = JSON.parse(bytes); second.run_id = 'second-run';
  await writeFile(join(s.inputDir, 'health-z.json'), JSON.stringify(second));
  const first = await s.importer().scanOnce(); assert.equal(first.imported, 1);
  assert.equal(Object.keys((await ledger(s)).imported).length, 1);
  broken = false; await tick();
  const next = await s.importer().scanOnce(); assert.equal(next.imported, 1); assert.equal(next.skipped, 1);
  assert.equal(Object.keys((await ledger(s)).imported).length, 2);
});

test('permission denial remains visible and automatically recovers when access returns', async t => {
  let denied = true;
  const s = await setup(t, { readInput: async path => {
    if (denied) throw Object.assign(new Error('secret'), { code: 'EACCES' }); return readFile(path);
  } });
  await writeFile(s.source, bytes); await s.importer().scanOnce();
  assert.equal((await pending(s)).files['health-2026-11-01.json'].status, 'blocked_retry');
  assert.ok(s.events.some(e => e.code === 'EACCES' && e.requires_attention));
  denied = false; await tick(); assert.equal((await s.importer().scanOnce()).imported, 1);
});

test('corrupt ledger fails closed instead of resetting deduplication', async t => {
  const s = await setup(t); await mkdir(join(s.dataDir, 'v33-import'), { recursive: true });
  await writeFile(join(s.dataDir, 'v33-import/ledger.json'), '{}');
  await writeFile(s.source, bytes);
  await assert.rejects(s.importer().scanOnce(), e => e.code === 'INVALID_LEDGER');
  assert.equal(await readFile(join(s.dataDir, 'v33-import/ledger.json'), 'utf8'), '{}');
});
