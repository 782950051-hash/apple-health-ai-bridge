import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { WakeUploadStore } from '../src/wake-upload.js';
import { PendingWakeStore } from '../src/pending-wake.js';
import { ReportOutbox } from '../src/report-outbox.js';
import { runHealthReportCycle } from '../src/report-worker.js';
import { WeChatDeliveryError } from '../src/wechat-self.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = new Date('2026-10-25T10:00:00+08:00');
async function setup(trigger = 'health_sleep_score_notification') {
  const root = await mkdtemp(join(tmpdir(), 'report-worker-test-')); roots.push(root);
  const dataDir = join(root, 'data');
  const event = await new PendingWakeStore(dataDir, { now: () => now }).save({
    kind: 'shortcuts_wake_event_v1', driver: 'Apple Shortcuts', trigger, received_at: '2026-10-25T09:00:00+08:00' });
  const payload = { kind: 'shortcuts_wake_v1', driver: 'Apple Shortcuts', trigger,
    captured_at: now.toISOString(), event_id: event.event_id, event_received_at: event.received_at,
    sleep_source_status: 'unavailable_in_shortcuts', collection_status: 'partial',
    sleep: { starts_text: '2026-10-25T00:00:00+08:00', ends_text: '2026-10-25T08:00:00+08:00',
      values_text: '核心睡眠', sources_text: '' } };
  const receipt = await new WakeUploadStore(dataDir, { now: () => now }).save(Buffer.from(JSON.stringify(payload)));
  return { root, dataDir, receipt };
}

it('reconciles a saved automatic wake receipt to exactly one persistent report across receiver restarts', async () => {
  const config = await setup(); let calls = 0;
  const sender = { send: async text => { calls++; assert.doesNotMatch(text, /starts_text|context_token/); return { accepted: true }; } };
  await runHealthReportCycle({ ...config, sender });
  await runHealthReportCycle({ ...config, sender });
  const jobs = await new ReportOutbox(config.root).list();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'sent'); assert.equal(calls, 1);
});

it('never automatically sends a manual export or fixture', async () => {
  const config = await setup('manual_test'); let calls = 0;
  await runHealthReportCycle({ ...config, sender: { send: async () => { calls++; } } });
  assert.equal(calls, 0); assert.deepEqual(await new ReportOutbox(config.root).list(), []);
});

it('retains an offline report and retries a definitely rejected send without resummarizing or duplicating it', async () => {
  const config = await setup(); let time = now; let calls = 0;
  const sender = { send: async () => { calls++; if (calls === 1) throw new WeChatDeliveryError('rate_limited'); return { accepted: true }; } };
  await runHealthReportCycle({ ...config, sender, now: () => time });
  assert.equal((await new ReportOutbox(config.root).list())[0].status, 'retry');
  await runHealthReportCycle({ ...config, sender, now: () => time }); assert.equal(calls, 1);
  time = new Date(time.valueOf() + 5 * 60000);
  await runHealthReportCycle({ ...config, sender, now: () => time });
  assert.equal((await new ReportOutbox(config.root).list())[0].status, 'sent'); assert.equal(calls, 2);
});

it('rejects a changed raw file even when an old success receipt exists', async () => {
  const config = await setup(); let calls = 0;
  await writeFile(join(config.dataDir, 'exports', `${config.receipt.export_id}.json`), '{"changed":true}');
  const result = await runHealthReportCycle({ ...config, sender: { send: async () => { calls++; } } });
  assert.equal(calls, 0); assert.equal(result.invalid_receipts, 1);
  assert.deepEqual(await new ReportOutbox(config.root).list(), []);
});

it('resumes a definite rejection only after the pinned sender context or credentials actually change', async () => {
  const config = await setup(); let calls = 0; let revision = 'old-context';
  const sender = { revision: async () => revision, send: async () => {
    calls++; if (calls === 1) throw new WeChatDeliveryError('wechat_rejected', { blocked: true, apiRet: -2 });
    return { accepted: true };
  } };
  await runHealthReportCycle({ ...config, sender });
  await runHealthReportCycle({ ...config, sender }); assert.equal(calls, 1);
  revision = 'new-authorized-context';
  await runHealthReportCycle({ ...config, sender });
  assert.equal(calls, 2); assert.equal((await new ReportOutbox(config.root).list())[0].status, 'sent');
});
