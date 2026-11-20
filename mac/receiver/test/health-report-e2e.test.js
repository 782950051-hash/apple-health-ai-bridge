import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createServer } from '../src/server.js';
import { runHealthReportCycle } from '../src/report-worker.js';
import { ReportOutbox } from '../src/report-outbox.js';

it('accepts a synthetic expanded HTTP upload, validates all types, delivers once and survives duplicate/restart reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expanded-health-e2e-'));
  const dataDir = join(root, 'data'); const now = new Date('2026-10-25T10:00:00+08:00');
  const server = createServer({ token: 'synthetic-only', dataDir, now: () => now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'X-Upload-Key': 'synthetic-only', 'Content-Type': 'application/json' };
  const post = (path, data) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  try {
    const registered = await (await post('/wake-event', { kind: 'shortcuts_wake_event_v1', driver: 'Apple Shortcuts',
      trigger: 'health_sleep_score_notification', received_at: '2026-10-25T09:00:00+08:00' })).json();
    const catalog = JSON.parse(await readFile(new URL('../src/metric-catalog.json', import.meta.url), 'utf8'));
    const unitOverrides = { heart_rate: 'count/min', resting_heart_rate: 'count/min', hrv_sdnn: 'ms',
      respiratory_rate: 'count/min', oxygen_saturation: '%', sleeping_wrist_temperature: '°C' };
    const metrics = Object.fromEntries(catalog.map(item => [item.id, {
      types_text: `${item.hk_identifier}\n${item.hk_identifier}`, values_text: '60\n80',
      units_text: `${unitOverrides[item.id] ?? 'count'}\n${unitOverrides[item.id] ?? 'count'}`,
      starts_text: '2026-10-25T05:00:00+08:00\n2026-10-25T06:00:00+08:00',
      ends_text: '2026-10-25T05:00:01+08:00\n2026-10-25T06:00:01+08:00', sources_text: 'Apple Watch\nApple Watch',
    }]));
    const payload = { kind: 'shortcuts_wake_v1', driver: 'Apple Shortcuts', trigger: registered.event.trigger,
      event_id: registered.event.event_id, event_received_at: registered.event.received_at,
      captured_at: now.toISOString(), collection_status: 'partial', sleep_source_status: 'unavailable_in_shortcuts',
      sleep: { starts_text: '2026-10-24T23:00:00+08:00', ends_text: '2026-10-25T08:00:00+08:00', values_text: '核心睡眠', sources_text: '' },
      metrics, future_metadata: { preserve: true } };
    const response = await post('/wake-upload', payload); assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.equal(receipt.metrics_validation.length, catalog.length);
    assert.ok(receipt.metrics_validation.every(item => item.status === 'valid'));
    const stored = JSON.parse(await readFile(join(dataDir, 'exports', `${receipt.export_id}.json`), 'utf8'));
    assert.deepEqual(stored.future_metadata, { preserve: true });
    let calls = 0;
    const sender = { send: async text => {
      calls++; assert.match(text, /心率：睡眠时段样本中位数70 count\/min/);
      assert.doesNotMatch(text, /starts_text|context_token|synthetic-only/); return { accepted: true };
    } };
    await runHealthReportCycle({ root, dataDir, sender });
    payload.metrics.heart_rate.types_text = '步数\n步数';
    const duplicate = await (await post('/wake-upload', payload)).json();
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.export_id, receipt.export_id);
    assert.equal(duplicate.metrics_validation.find(item => item.id === 'heart_rate').status, 'valid'); // describes saved original
    await runHealthReportCycle({ root, dataDir, sender });
    assert.equal(calls, 1); assert.equal((await new ReportOutbox(root).list()).length, 1);
    assert.equal((await (await fetch(base + '/pending-wake', { headers })).json()).pending, null);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
