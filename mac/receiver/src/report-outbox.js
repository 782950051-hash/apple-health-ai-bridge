import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WeChatDeliveryError } from './wechat-self.js';

const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

export function reportClientId(id) {
  if (!validId(id)) throw new Error('invalid report ID');
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const hash = createHash('sha1').update(namespace).update(`apple-health-report:${id}`).digest().subarray(0, 16);
  hash[6] = (hash[6] & 15) | 80; hash[8] = (hash[8] & 63) | 128;
  const value = hash.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** A durable send ledger. Unknown remote outcomes deliberately require review. */
export class ReportOutbox {
  constructor(root, { now = () => new Date() } = {}) {
    this.directory = join(root, 'report-outbox'); this.now = now;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
  }
  path(id) {
    if (!validId(id)) throw new Error('invalid report ID');
    return join(this.directory, `${id}.json`);
  }
  async get(id) { return JSON.parse(await readFile(this.path(id), 'utf8')); }
  async list() {
    await this.init();
    const files = await readdir(this.directory);
    const result = [];
    for (const file of files) if (/^[a-f0-9]{64}\.json$/.test(file)) result.push(await this.get(file.slice(0, -5)));
    return result;
  }
  async write(job, createOnly = false) {
    const path = this.path(job.id), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(job, null, 2), { flag: 'wx', mode: 0o600 });
      if (createOnly) {
        try { await link(temporary, path); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } else await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async enqueue({ exportId, report }) {
    if (!validId(exportId) || !/^\d{4}-\d{2}-\d{2}$/.test(report?.date ?? '') ||
        typeof report.manual !== 'boolean' || typeof report.text !== 'string' || !report.text || report.text.length > 4000) {
      throw new Error('invalid report');
    }
    await this.init();
    const channel = report.channel ?? 'health';
    if (!['health', 'weather'].includes(channel)) throw new Error('invalid report channel');
    const scope = report.manual ? `manual|${exportId}` : `automatic|${report.date}`;
    const namespace = channel === 'health' ? 'health-report-v1' : 'weather-report-v1';
    const id = createHash('sha256').update(`${namespace}|${scope}`).digest('hex');
    await this.write({ id, client_id: reportClientId(id), export_id: exportId, report_date: report.date,
      channel, manual: report.manual, text: report.text, status: 'queued', attempts: 0,
      created_at: this.now().toISOString() }, true);
    return this.get(id);
  }
  async deliver(id, sender) {
    await this.init();
    const lock = `${this.path(id)}.lock`;
    try { await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lock, 'utf8')); } catch { return this.get(id); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return this.get(id);
      try { process.kill(owner.pid, 0); return this.get(id); }
      catch (failure) { if (failure.code !== 'ESRCH') return this.get(id); }
      // A prior process may have sent before it died. Never retry that unknown
      // result automatically, even when the remote client_id is unchanged.
      const interrupted = await this.get(id);
      if (interrupted.status === 'sending') {
        interrupted.status = 'delivery_uncertain'; interrupted.error = 'process_interrupted';
        await this.write(interrupted);
      }
      await unlink(lock);
      return this.get(id);
    }
    try {
      const job = await this.get(id);
      if (['sent', 'blocked', 'delivery_uncertain'].includes(job.status)) return job;
      if (job.status === 'sending') {
        job.status = 'delivery_uncertain'; job.error = 'process_interrupted';
        await this.write(job); return job;
      }
      if (job.next_attempt_at && Date.parse(job.next_attempt_at) > this.now().valueOf()) return job;
      job.status = 'sending'; job.attempts++; job.last_attempt_at = this.now().toISOString();
      await this.write(job);
      try {
        if (sender.revision) { job.delivery_revision = await sender.revision(); await this.write(job); }
        const result = await sender.send(job.text, { clientId: job.client_id });
        if (result?.accepted !== true) throw new WeChatDeliveryError('delivery_uncertain', { uncertain: true });
        job.status = 'sent'; job.sent_at = this.now().toISOString(); delete job.error; delete job.next_attempt_at;
        if (typeof result.message_id === 'string' || typeof result.message_id === 'number') job.message_id = result.message_id;
        delete job.api_ret; delete job.api_errcode;
      } catch (error) {
        const known = error instanceof WeChatDeliveryError;
        job.status = !known || error.uncertain ? 'delivery_uncertain' : error.blocked ? 'blocked' : 'retry';
        job.error = known ? error.code : 'delivery_uncertain';
        if (known && error.api_ret !== undefined) job.api_ret = error.api_ret;
        if (known && error.api_errcode !== undefined) job.api_errcode = error.api_errcode;
        if (job.status === 'retry') job.next_attempt_at = new Date(this.now().valueOf() + 5 * 60000).toISOString();
      }
      await this.write(job); return job;
    } finally { await unlink(lock).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
