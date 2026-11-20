import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildHealthReport } from './health-report.js';
import { ReportOutbox } from './report-outbox.js';
import { validateWakeUpload } from './wake-upload.js';

/** Reconcile saved automatic receipts, never scan fixture/manual exports as jobs. */
export async function runHealthReportCycle({ root, dataDir, sender, now = () => new Date() }) {
  const outbox = new ReportOutbox(root, { now });
  const stats = { queued: 0, sent: 0, blocked: 0, uncertain: 0, invalid_receipts: 0 };
  let names;
  try { names = await readdir(join(dataDir, 'wake-uploads')); }
  catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  for (const name of names.filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort()) {
    try {
      const receipt = JSON.parse(await readFile(join(dataDir, 'wake-uploads', name), 'utf8'));
      if (receipt.manual !== false || !/^[a-f0-9]{64}$/.test(receipt.export_id) || receipt.date !== name.slice(0, -5)) throw new Error('invalid receipt');
      const bytes = await readFile(join(dataDir, 'exports', `${receipt.export_id}.json`));
      if (createHash('sha256').update(bytes).digest('hex') !== receipt.export_id || bytes.length !== receipt.bytes) throw new Error('changed export');
      const payload = JSON.parse(bytes);
      const admitted = validateWakeUpload(payload, new Date(payload.captured_at));
      if (admitted.manual || admitted.date !== receipt.date || !/^[a-f0-9]{64}$/.test(payload.event_id)) throw new Error('manual or unbound upload');
      const eventBytes = await readFile(join(dataDir, 'wake-events', 'exports', `${payload.event_id}.json`));
      if (createHash('sha256').update(eventBytes).digest('hex') !== payload.event_id) throw new Error('changed event');
      const event = JSON.parse(eventBytes);
      if (event.kind !== 'shortcuts_wake_event_v1' || event.driver !== 'Apple Shortcuts' ||
          event.trigger !== payload.trigger || event.received_at !== payload.event_received_at) throw new Error('unbound event');
      const job = await outbox.enqueue({ exportId: receipt.export_id, report: buildHealthReport(payload) });
      if (job.status === 'queued') stats.queued++;
    } catch { stats.invalid_receipts++; }
  }
  if (!sender) return stats;
  for (const job of await outbox.list()) {
    if (job.manual || job.stage_d3 || job.channel === 'weather') continue;
    if (job.status === 'blocked' && job.delivery_revision && sender.revision &&
        ['wechat_rejected', 'wechat_session_expired', 'wechat_context_expired'].includes(job.error)) {
      try {
        if (await sender.revision() !== job.delivery_revision) {
          job.status = 'queued'; delete job.next_attempt_at; await outbox.write(job);
        }
      } catch { continue; }
    }
    if (!['queued', 'retry', 'sending'].includes(job.status)) continue;
    const result = await outbox.deliver(job.id, sender);
    if (result.status === 'sent') stats.sent++;
    if (result.status === 'blocked') stats.blocked++;
    if (result.status === 'delivery_uncertain') stats.uncertain++;
    break; // Bounded delivery: one job per cycle, no burst of old reports.
  }
  return stats;
}
