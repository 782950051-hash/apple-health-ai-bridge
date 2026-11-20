import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { ReportOutbox } from '../src/report-outbox.js';
import { WeChatDeliveryError } from '../src/wechat-self.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'health-outbox-test-')); roots.push(root);
  return { root, outbox: new ReportOutbox(root) };
}
const input = (manual = true) => ({ exportId: 'a'.repeat(64),
  report: { date: '2026-10-25', manual, text: '健康数据简报（手动测试）\n当前数据不足。' } });

it('persists a private report, deduplicates retries across restart, and keeps manual and automatic reports distinct', async () => {
  const { root, outbox } = await setup();
  const first = await outbox.enqueue(input());
  assert.match(first.client_id, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal((await new ReportOutbox(root).enqueue(input())).id, first.id);
  assert.notEqual((await outbox.enqueue(input(false))).id, first.id);
  assert.equal((await stat(join(root, 'report-outbox', `${first.id}.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'report-outbox'))).mode & 0o777, 0o700);
});

it('keeps weather and health daily delivery IDs independent', async () => {
  const { root, outbox } = await setup();
  const health = await outbox.enqueue({ ...input(), report: { ...input().report, channel: 'health' } });
  const weather = await outbox.enqueue({ ...input(), report: { ...input().report, channel: 'weather', text: 'weather' } });
  assert.notEqual(weather.id, health.id);
  assert.equal((await outbox.enqueue({ ...input(), report: { ...input().report, channel: 'weather', text: 'weather' } })).id, weather.id);
});

it('sends once under concurrent attempts and records only a confirmed acknowledgement as sent', async () => {
  const { outbox } = await setup(); const job = await outbox.enqueue(input()); let calls = 0;
  const sender = { send: async (_, options) => { calls++; assert.equal(options.clientId, job.client_id); return { accepted: true }; } };
  await Promise.all([outbox.deliver(job.id, sender), outbox.deliver(job.id, sender)]);
  await outbox.deliver(job.id, sender);
  assert.equal(calls, 1);
  assert.equal((await outbox.get(job.id)).status, 'sent');
});

it('retains a definitely rejected task for retry but stops on expired credentials', async () => {
  const { root } = await setup(); let time = new Date('2026-10-25T15:00:00+08:00');
  const outbox = new ReportOutbox(root, { now: () => time }); const job = await outbox.enqueue(input());
  await outbox.deliver(job.id, { send: async () => { throw new WeChatDeliveryError('rate_limited'); } });
  assert.equal((await outbox.get(job.id)).status, 'retry');
  time = new Date(time.valueOf() + 5 * 60000);
  await outbox.deliver(job.id, { send: async () => { throw new WeChatDeliveryError('wechat_session_expired', { blocked: true }); } });
  assert.equal((await outbox.get(job.id)).status, 'blocked');
  let calls = 0; await outbox.deliver(job.id, { send: async () => { calls++; } }); assert.equal(calls, 0);
});

it('does not blindly resend after an unknown network outcome or interrupted sending state', async () => {
  const { root, outbox } = await setup(); const job = await outbox.enqueue(input());
  await outbox.deliver(job.id, { send: async () => { throw new WeChatDeliveryError('delivery_uncertain', { uncertain: true }); } });
  assert.equal((await outbox.get(job.id)).status, 'delivery_uncertain');
  const second = await outbox.enqueue({ ...input(), exportId: 'b'.repeat(64) });
  await writeFile(join(root, 'report-outbox', `${second.id}.json`), JSON.stringify({ ...second, status: 'sending' }));
  let calls = 0; await outbox.deliver(second.id, { send: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal((await outbox.get(second.id)).status, 'delivery_uncertain');
  assert.ok(JSON.parse(await readFile(join(root, 'report-outbox', `${job.id}.json`))).text);
});
