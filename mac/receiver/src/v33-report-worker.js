import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildV33HealthReport } from './health-report.js';
import { ReportOutbox } from './report-outbox.js';
import { renderMorning41 } from './weather-barrier.js';

function reportId(date) { return createHash('sha256').update(`health-report-v1|automatic|${date}`).digest('hex'); }
function sleepReady(payload, instant) {
  const captured = Date.parse(payload?.captured_at ?? '');
  if (!Number.isFinite(captured)) return false;
  const latestEnd = Math.max(...(payload.sleep?.samples ?? [])
    .filter(sample => ['core', 'deep', 'rem'].includes(sample.stage))
    .map(sample => Date.parse(sample.end_date ?? ''))
    .filter(Number.isFinite));
  const age = captured - latestEnd;
  return Number.isFinite(latestEnd) && age >= 30 * 60 * 1000 && age <= 8 * 60 * 60 * 1000 &&
    captured <= instant.valueOf() + 120000 && instant.valueOf() - captured <= 8 * 60 * 60 * 1000;
}

/** Reconcile one daily v3.3 report. Hermes is called only for a new daily job. */
export async function runV33HealthReportCycle({ root, dataDir, sender, analyzer, now = () => new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const instant = now();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  const outbox = new ReportOutbox(root, { now });
  const stats = { discovered: 0, analyzed: 0, queued: 0, sent: 0, blocked: 0, uncertain: 0, analysis_failed: 0, sleep_not_ready: 0 };
  let names;
  try { names = await readdir(join(dataDir, 'v33-health')); }
  catch (error) { if (error.code === 'ENOENT') return stats; throw error; }
  for (const name of names.filter(value => /^\d{4}-\d{2}-\d{2}\.json$/.test(value)).sort()) {
    if (name.slice(0, -5) !== today) continue;
    stats.discovered++;
    const envelope = JSON.parse(await readFile(join(dataDir, 'v33-health', name), 'utf8'));
    const date = name.slice(0, -5), id = reportId(date);
    if (envelope.report_date !== date ||
        new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(envelope.payload?.captured_at ?? '')) !== today) {
      stats.sleep_not_ready++;
      continue;
    }
    let existing;
    try { existing = await outbox.get(id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      if (!sleepReady(envelope.payload, instant)) { stats.sleep_not_ready++; continue; }
      const factual = buildV33HealthReport(envelope.payload, { includeWeather: false });
      if (factual.sleep_minutes <= 0) { stats.sleep_not_ready++; continue; }
      let analysis = null;
      if (analyzer) {
        try { analysis = await analyzer.analyze({ payload: envelope.payload, factualReport: factual.text }); stats.analyzed++; }
        catch { stats.analysis_failed++; continue; }
      } else continue;
      const text = renderMorning41({ date, payload: envelope.payload, analysis });
      const job = await outbox.enqueue({ exportId: envelope.export_id, report: { ...factual, date, text, manual: false, channel: 'health' } });
      if (job.status === 'queued') stats.queued++;
    }
  }
  if (!sender) return stats;
  for (const job of await outbox.list()) {
    if (job.manual || job.stage_d3 || job.channel === 'weather' || job.report_date !== today || !['queued', 'retry', 'sending'].includes(job.status)) continue;
    const result = await outbox.deliver(job.id, sender);
    if (result.status === 'sent') stats.sent++;
    if (result.status === 'blocked') stats.blocked++;
    if (result.status === 'delivery_uncertain') stats.uncertain++;
    break;
  }
  return stats;
}
