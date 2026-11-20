import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonExportStore } from './export-store.js';

export class InvalidWakeUpload extends Error {}
const reject = () => { throw new InvalidWakeUpload('invalid wake upload'); };
const HOUR = 3600000;

export function instant(value) {
  if (typeof value !== 'string') return reject();
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return reject();
  const day = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== match[1]) return reject();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return reject();
  return time;
}

function lines(value) {
  if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) return reject();
  return value ? value.split(/\r?\n/).map(v => v.trim()) : [];
}

/** A result notification is the wake signal; an intranight awake stage is not. */
export function validateWakeUpload(payload, now = new Date()) {
  if (!payload || payload.kind !== 'shortcuts_wake_v1' || payload.driver !== 'Apple Shortcuts') return reject();
  const manual = payload.trigger === 'manual_test';
  if (!manual && payload.trigger !== 'health_sleep_score_notification') return reject();
  const captured = instant(payload.captured_at);
  const current = now.valueOf();
  if (!Number.isFinite(current) || captured > current + 120000 || captured < current - 6 * HOUR) return reject();
  const anchor = manual && !payload.event_id ? current : instant(payload.event_received_at);
  if (anchor > current + 120000 || anchor < current - 36 * HOUR || anchor > captured + 120000) return reject();
  const sleep = payload.sleep;
  if (!sleep || typeof sleep !== 'object') return reject();
  const starts = lines(sleep.starts_text).map(instant);
  const ends = lines(sleep.ends_text).map(instant);
  const stages = lines(sleep.values_text);
  if (!starts.length || starts.length > 10000 || starts.length !== ends.length || starts.length !== stages.length) return reject();
  const asleep = new Set(['核心睡眠', '深度睡眠', '快速动眼睡眠', 'Core', 'Deep', 'REM', 'Asleep', '睡眠']);
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] >= ends[i] || ends[i] > captured + 30000 || ends[i] - starts[i] > 48 * HOUR) return reject();
  }
  const eligible = ends.map((end, i) => ({ end, stage: stages[i] })).filter(row => row.end <= anchor + 120000);
  if (!eligible.some(row => asleep.has(row.stage) && row.end >= anchor - 6 * HOUR)) return reject();
  const latestEnd = Math.max(...eligible.map(row => row.end));
  if (latestEnd < anchor - 6 * HOUR) return reject();

  const sources = lines(sleep.sources_text ?? '');
  if (sources.length) {
    if (sources.length !== starts.length || sources.some(v => !/watch/i.test(v))) return reject();
  } else if (payload.sleep_source_status !== 'unavailable_in_shortcuts') {
    return reject();
  }
  // Missing per-sample source remains missing. The configured Health Sleep
  // Score event supplies wake evidence; this does not label records Watch-only.
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(latestEnd);
  return { date, samples: starts.length, manual };
}

export class WakeUploadStore {
  constructor(dataDir, { now = () => new Date(), exportStore = new JsonExportStore(dataDir) } = {}) {
    this.directory = join(dataDir, 'wake-uploads');
    this.now = now;
    this.exports = exportStore;
  }

  async save(bytes) {
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return reject(); }
    const admission = validateWakeUpload(payload, this.now());
    const destination = join(this.directory, `${admission.date}.json`);
    const previous = async () => JSON.parse(await readFile(destination, 'utf8'));
    if (!admission.manual) {
      try { return { ...await previous(), duplicate: true }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // A receipt and a daily success record only follow an actual durable save.
    const receipt = { ...await this.exports.save(bytes), ...admission };
    if (admission.manual) return { ...receipt, duplicate: false };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        return { ...await previous(), duplicate: true };
      }
      return { ...receipt, duplicate: false };
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
