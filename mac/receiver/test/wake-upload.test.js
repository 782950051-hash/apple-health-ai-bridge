import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { WakeUploadStore, validateWakeUpload } from '../src/wake-upload.js';
import { createServer } from '../src/server.js';

const now = new Date('2026-10-25T10:00:00+08:00');
function fixture(trigger = 'health_sleep_score_notification') {
  return {
    kind: 'shortcuts_wake_v1', driver: 'Apple Shortcuts', trigger,
    captured_at: '2026-10-25T09:58:00+08:00',
    event_received_at: '2026-10-25T09:58:00+08:00',
    sleep_source_status: 'unavailable_in_shortcuts',
    sleep: {
      starts_text: '2026-10-24T23:00:00+08:00\n2026-10-25T03:00:00+08:00\n2026-10-25T08:00:00+08:00',
      ends_text: '2026-10-25T03:00:00+08:00\n2026-10-25T08:00:00+08:00\n2026-10-25T08:01:00+08:00',
      values_text: '核心睡眠\n快速动眼睡眠\n清醒时间',
      sources_text: '',
    },
    metrics: { synthetic_future_metric: { unit: 'count', values_text: '12' } },
  };
}

it('accepts fresh sleep with the specific result event and derives count from aligned native columns', () => {
  assert.deepEqual(validateWakeUpload(fixture(), now), { date: '2026-10-25', samples: 3, manual: false });
});

it('never turns a manual run into evidence of an actual wake event', () => {
  assert.equal(validateWakeUpload(fixture('manual_test'), now).manual, true);
  for (const trigger of ['09:00', 'waking_up_alarm', 'health_notification', 'sleep_reminder']) {
    assert.throws(() => validateWakeUpload(fixture(trigger), now));
  }
});

it('allows delayed unlock but binds sleep evidence to the earlier event, including across midnight', () => {
  const data = fixture();
  data.captured_at = '2026-10-26T00:30:00+08:00';
  const later = new Date(data.captured_at);
  assert.equal(validateWakeUpload(data, later).date, '2026-10-25');
  const freshNap = structuredClone(data);
  freshNap.sleep.starts_text = '2026-10-25T21:00:00+08:00';
  freshNap.sleep.ends_text = '2026-10-25T22:00:00+08:00';
  freshNap.sleep.values_text = '核心睡眠';
  assert.throws(() => validateWakeUpload(freshNap, later));
  data.event_received_at = '2026-10-24T09:58:00+08:00';
  assert.throws(() => validateWakeUpload(data, later));
});

it('rejects stale, future, unzoned and malformed dates, unequal columns and awake-only data', () => {
  const variants = [
    d => { d.captured_at = 'bad'; },
    d => { d.sleep.ends_text = d.sleep.ends_text.replace('08:01:00+08:00', '11:01:00+08:00'); },
    d => { d.sleep.starts_text = d.sleep.starts_text.replace('+08:00', ''); },
    d => { d.sleep.values_text = '核心睡眠'; },
    d => { d.sleep.values_text = '清醒时间\n清醒时间\n清醒时间'; },
    d => { d.sleep.starts_text = d.sleep.starts_text.replace('2026-10-24T23:00', '2026-10-25T04:00'); },
  ];
  for (const mutate of variants) {
    const data = fixture(); mutate(data);
    assert.throws(() => validateWakeUpload(data, now));
  }
  assert.throws(() => validateWakeUpload(fixture(), new Date('2026-10-25T18:00:00+08:00')));
});

it('rejects explicitly non-Watch sleep sources and preserves unavailable source status honestly', () => {
  const data = fixture(); data.sleep.sources_text = 'iPhone\niPhone\niPhone';
  assert.throws(() => validateWakeUpload(data, now));
  data.sleep.sources_text = 'Apple Watch\nApple Watch\nApple Watch';
  assert.equal(validateWakeUpload(data, now).samples, 3);
  data.sleep.sources_text = ''; delete data.sleep_source_status;
  assert.throws(() => validateWakeUpload(data, now));
});

const temporary = [];
afterEach(async () => { for (const p of temporary.splice(0)) await rm(p, { recursive: true, force: true }); });
async function directory() { const p = await mkdtemp(join(tmpdir(), 'wake-upload-test-')); temporary.push(p); return p; }

it('deduplicates same-day and concurrent event retries, with private atomic records', async () => {
  const root = await directory();
  const store = new WakeUploadStore(root, { now: () => now });
  const body = Buffer.from(JSON.stringify(fixture()));
  const results = await Promise.all([store.save(body), store.save(body)]);
  assert.equal(results.filter(r => r.duplicate).length, 1);
  assert.equal(results[0].export_id, results[1].export_id);
  const ledger = join(root, 'wake-uploads');
  assert.deepEqual(await readdir(ledger), ['2026-10-25.json']);
  assert.equal((await stat(ledger)).mode & 0o777, 0o700);
  assert.equal((await stat(join(ledger, '2026-10-25.json'))).mode & 0o777, 0o600);
  const raw = await readFile(join(root, 'exports', `${results[0].export_id}.json`));
  assert.deepEqual(raw, body); // Retain all fields, original units and missing-source status.
});

it('manual tests preserve raw data but never consume the automatic daily slot', async () => {
  const root = await directory(); const store = new WakeUploadStore(root, { now: () => now });
  const receipt = await store.save(Buffer.from(JSON.stringify(fixture('manual_test'))));
  assert.equal(receipt.manual, true);
  assert.deepEqual(await readdir(root), ['exports']);
});

it('a failed raw save cannot create a success record; retry can still succeed', async () => {
  const root = await directory();
  const failed = new WakeUploadStore(root, { now: () => now, exportStore: { save: async () => { throw new Error('synthetic disk failure'); } } });
  const body = Buffer.from(JSON.stringify(fixture()));
  await assert.rejects(failed.save(body));
  assert.deepEqual(await readdir(root), []);
  assert.equal((await new WakeUploadStore(root, { now: () => now }).save(body)).duplicate, false);
});

it('exposes only an authenticated upload route, with generic errors and a confirmed receipt', async () => {
  const root = await directory();
  const server = createServer({ token: 'synthetic-wake-key', dataDir: root, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const data = fixture();
    const body = JSON.stringify(data);
    assert.equal((await fetch(`${base}/wake-upload`, { method: 'POST', body })).status, 401);
    const headers = { 'X-Upload-Key': 'synthetic-wake-key', 'Content-Type': 'application/json' };
    const invalid = await fetch(`${base}/wake-upload`, { method: 'POST', headers, body: '{' });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_request' });
    const registered = await (await fetch(`${base}/wake-event`, { method: 'POST', headers,
      body: JSON.stringify({ kind: 'shortcuts_wake_event_v1', driver: 'Apple Shortcuts', trigger: data.trigger, received_at: data.event_received_at }) })).json();
    data.event_id = registered.event.event_id;
    const response = await fetch(`${base}/wake-upload`, { method: 'POST', headers, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.ok, true);
    assert.equal(receipt.samples, 3);
    assert.equal(receipt.manual, false);
    assert.equal(receipt.metrics_validation.find(item => item.id === 'heart_rate').status, 'uncollected');
    assert.equal((await fetch(`${base}/wake-upload/${receipt.date}.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
