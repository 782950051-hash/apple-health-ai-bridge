import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { PendingWakeStore } from '../src/pending-wake.js';
import { createServer } from '../src/server.js';

const temporary = [];
afterEach(async () => { for (const p of temporary.splice(0)) await rm(p, { recursive: true, force: true }); });
const now = new Date('2026-10-25T10:00:00+08:00');
function event(trigger = 'health_sleep_score_notification') {
  return { kind: 'shortcuts_wake_event_v1', driver: 'Apple Shortcuts', trigger,
    received_at: '2026-10-25T09:58:00+08:00' };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pending-wake-test-')); temporary.push(root);
  return { root, store: new PendingWakeStore(root, { now: () => now }) };
}

it('records a result event without reading any Health samples, and survives receiver restart', async () => {
  const { root, store } = await setup();
  const first = await store.save(event());
  assert.equal((await store.save(event())).event_id, first.event_id);
  assert.deepEqual(await new PendingWakeStore(root, { now: () => now }).latest(), first);
  const path = join(root, 'wake-events', 'exports', `${first.event_id}.json`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'wake-events'))).mode & 0o777, 0o700);
});

it('only clears the acknowledged event and never clears a newer pending event', async () => {
  const { store } = await setup();
  const first = await store.save(event());
  const second = await store.save({ ...event(), received_at: '2026-10-25T09:59:00+08:00' });
  await store.acknowledge(first.event_id);
  assert.equal((await store.latest()).event_id, second.event_id);
  await store.acknowledge(second.event_id);
  await store.acknowledge(second.event_id);
  assert.equal(await store.latest(), null);
  await store.save(event()); // Phone may replay its saved event after losing the HTTP acknowledgement.
  assert.equal(await store.isAcknowledged(first.event_id), true);
  assert.equal(await store.latest(), null);
});

it('keeps manual testing explicit and expires pending events instead of inventing a later wake', async () => {
  const { root, store } = await setup();
  assert.equal((await store.save(event('manual_test'))).trigger, 'manual_test');
  const later = new PendingWakeStore(root, { now: () => new Date('2026-10-27T10:00:00+08:00') });
  assert.equal(await later.latest(), null);
});

it('rejects timer/alarm/reminder events, extra data, malformed times and arbitrary IDs', async () => {
  const { root, store } = await setup();
  for (const data of [event('09:00'), event('sleep_reminder'), { ...event(), received_at: 'bad' },
    { ...event(), received_at: '2026-10-26T10:00:00+08:00' }, { ...event(), samples: ['not allowed'] }]) {
    await assert.rejects(store.save(data));
  }
  await assert.rejects(store.get('../elsewhere'));
  assert.deepEqual(await readdir(root), []);
});

it('authenticates event creation and lookup, binds upload to the pending event, and acknowledges only success', async () => {
  const { root } = await setup();
  const server = createServer({ token: 'test-only', dataDir: root, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Upload-Key': 'test-only', 'Content-Type': 'application/json' };
  const post = (path, data) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(`${base}/pending-wake`)).status, 401);
    assert.equal((await fetch(`${base}/wake-event`, { method: 'POST', body: JSON.stringify(event()) })).status, 401);
    assert.equal((await post('/wake-event', { ...event(), samples: [] })).status, 400);
    assert.equal((await (await fetch(`${base}/pending-wake`, { headers })).json()).pending, null);
    const registered = await (await post('/wake-event', event())).json();
    assert.equal(registered.ok, true);
    assert.equal(registered.completed, false);
    const payload = {
      kind: 'shortcuts_wake_v1', driver: 'Apple Shortcuts', trigger: event().trigger,
      event_id: registered.event.event_id, event_received_at: event().received_at,
      captured_at: now.toISOString(), sleep_source_status: 'unavailable_in_shortcuts',
      sleep: { starts_text: '2026-10-24T23:00:00+08:00', ends_text: '2026-10-25T08:00:00+08:00', values_text: '核心睡眠', sources_text: '' },
    };
    assert.equal((await post('/wake-upload', { ...payload, event_id: 'a'.repeat(64) })).status, 400);
    assert.equal((await post('/wake-upload', { ...payload, event_received_at: '2026-10-25T09:59:00+08:00' })).status, 400);
    assert.equal((await post('/wake-upload', { ...payload, sleep: {} })).status, 400);
    assert.equal((await (await fetch(`${base}/pending-wake`, { headers })).json()).pending.event_id, registered.event.event_id);
    assert.equal((await post('/wake-upload', payload)).status, 200);
    assert.equal((await (await fetch(`${base}/pending-wake`, { headers })).json()).pending, null);
    assert.equal((await (await post('/wake-event', event())).json()).completed, true);
    assert.equal((await (await post('/wake-upload', payload)).json()).duplicate, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
