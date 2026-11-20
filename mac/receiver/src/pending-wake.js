import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonExportStore } from './export-store.js';
import { instant, InvalidWakeUpload } from './wake-upload.js';

const HOUR = 3600000;
const invalid = () => { throw new InvalidWakeUpload('invalid wake event'); };
const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

/** Metadata only: no notification body, score or Health samples enter this queue. */
export class PendingWakeStore {
  constructor(root, { now = () => new Date() } = {}) {
    this.directory = join(root, 'wake-events');
    this.exports = new JsonExportStore(this.directory);
    this.now = now;
  }

  validate(data) {
    if (!data || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'driver,kind,received_at,trigger' ||
        data.kind !== 'shortcuts_wake_event_v1' || data.driver !== 'Apple Shortcuts' ||
        !['manual_test', 'health_sleep_score_notification'].includes(data.trigger)) return invalid();
    const time = instant(data.received_at);
    const current = this.now().valueOf();
    if (!Number.isFinite(current) || time > current + 120000 || time < current - 36 * HOUR) return invalid();
    return data;
  }

  async save(data) {
    this.validate(data);
    const canonical = { kind: data.kind, driver: data.driver, trigger: data.trigger, received_at: data.received_at };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const result = await this.exports.save(Buffer.from(JSON.stringify(canonical)));
    return { ...canonical, event_id: result.export_id };
  }

  async get(id) {
    if (!validId(id)) return invalid();
    let data;
    try { data = JSON.parse(await readFile(join(this.directory, 'exports', `${id}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try { this.validate(data); }
    catch (error) { if (error instanceof InvalidWakeUpload) return null; throw error; }
    return { ...data, event_id: id };
  }

  async latest() {
    let files;
    try { files = await readdir(join(this.directory, 'exports')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const pending = [];
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      if (!file.endsWith('.json') || !validId(id)) continue;
      try { await stat(join(this.directory, 'done', id)); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const data = await this.get(id);
      if (data) pending.push(data);
    }
    pending.sort((a, b) => instant(b.received_at) - instant(a.received_at) || a.event_id.localeCompare(b.event_id));
    return pending[0] ?? null;
  }

  async acknowledge(id) {
    if (!validId(id) || !await this.get(id)) return invalid();
    const directory = join(this.directory, 'done');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    try { await writeFile(join(directory, id), '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  async isAcknowledged(id) {
    if (!validId(id) || !await this.get(id)) return invalid();
    try { await stat(join(this.directory, 'done', id)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
}
