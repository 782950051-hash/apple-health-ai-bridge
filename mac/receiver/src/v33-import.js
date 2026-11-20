import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonExportStore } from './export-store.js';
import { normalizeV33 } from './v33.js';
import { readICloudFile, importDiagnostic } from './icloud-file.js';

const LEDGER_VERSION = 1;

async function loadLedger(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.version === LEDGER_VERSION && value.imported && value.failures &&
        typeof value.imported === 'object' && !Array.isArray(value.imported) &&
        typeof value.failures === 'object' && !Array.isArray(value.failures)) return value;
    throw Object.assign(new Error('invalid_ledger'), { code: 'INVALID_LEDGER' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { version: LEDGER_VERSION, imported: {}, failures: {} };
}

async function saveJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(`${JSON.stringify(value)}\n`); await fd.sync(); }
    finally { await fd.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

function stable(first, second) { return first.size === second.size && first.mtimeMs === second.mtimeMs; }

/** Import B1 v3.3 JSON from the verified iCloud directory. */
export class V33HealthImporter {
  constructor({ inputDir, dataDir, settleMs = 10000, now = () => Date.now(), timeZone = 'Asia/Shanghai', exportStore,
      readInput = readICloudFile, onEvent = () => {}, retryMs = 60000, maxRetryMs = 300000 } = {}) {
    if (!inputDir || !dataDir) throw new TypeError('inputDir and dataDir are required');
    this.inputDir = inputDir; this.dataDir = dataDir; this.settleMs = settleMs; this.now = now; this.timeZone = timeZone;
    this.exportStore = exportStore ?? new JsonExportStore(dataDir);
    this.ledgerPath = join(dataDir, 'v33-import', 'ledger.json');
    this.healthDir = join(dataDir, 'v33-health');
    this.retryPath = join(dataDir, 'v33-import', 'retry-state.json');
    this.readInput = readInput; this.onEvent = onEvent; this.retryMs = retryMs; this.maxRetryMs = maxRetryMs;
  }

  async scanOnce() {
    const scanId = randomUUID(), started = this.now();
    const emit = value => this.onEvent({ time: new Date(this.now()).toISOString(), scan_id: scanId,
      module: 'v33-import', ...value });
    let names;
    try { names = await readdir(this.inputDir); }
    catch (error) { error.importStage = 'list_input'; throw error; }
    let ledger, retries;
    try { ledger = await loadLedger(this.ledgerPath); }
    catch (error) { error.importStage = 'load_ledger'; throw error; }
    try {
      retries = JSON.parse(await readFile(this.retryPath, 'utf8'));
      if (retries.version !== 1 || !retries.files || typeof retries.files !== 'object' || Array.isArray(retries.files))
        throw Object.assign(new Error('invalid_retry_state'), { code: 'INVALID_RETRY_STATE' });
    } catch (error) {
      if (error.code === 'ENOENT') retries = { version: 1, files: {} };
      else { error.importStage = 'load_retry_state'; throw error; }
    }
    const result = { imported: 0, skipped: 0, deferred: 0, failed: 0 };
    // The formal B1 channel uses health-* names. Ignore unrelated iCloud
    // temporary/export JSON files in the same directory.
    for (const name of names.filter(value => /^health-.*\.json$/.test(value)).sort()) {
      const path = join(this.inputDir, name);
      const previous = retries.files[name];
      const source = /^health-\d{4}-\d{2}-\d{2}(?:-\d+)?\.json$/.test(name) ? name : 'redacted_filename';
      let operation = 'stat_input', hash, signature;
      try {
        const first = await stat(path);
        signature = `${first.size}:${first.mtimeMs}`;
        if (!first.isFile() || this.now() - first.mtimeMs < this.settleMs) { result.deferred++; continue; }
        if (previous?.signature === signature && Date.parse(previous.next_retry_at) > this.now()) { result.deferred++; continue; }
        operation = 'read_input';
        const bytes = await this.readInput(path);
        operation = 'restat_input';
        const second = await stat(path);
        if (!stable(first, second) || bytes.length !== second.size) {
          throw Object.assign(new Error('file_changed'), { code: 'EAGAIN' });
        }
        hash = createHash('sha256').update(bytes).digest('hex');
        if (ledger.imported[hash] || ledger.failures[hash]) {
          delete retries.files[name]; result.skipped++; continue;
        }
        operation = 'parse_json';
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' }); }
        operation = 'validate_v33';
        let payload;
        try { payload = normalizeV33(parsed, this.timeZone); }
        catch { throw Object.assign(new Error('invalid_v33'), { code: 'INVALID_V33' }); }
        operation = 'save_export';
        const raw = await this.exportStore.save(bytes);
        operation = 'save_health';
        await saveJson(join(this.healthDir, `${payload.report_date}.json`), {
          ...payload, source_name: name, source_hash: hash, export_id: raw.export_id,
          imported_at: new Date(this.now()).toISOString(),
        });
        operation = 'save_ledger';
        ledger.imported[hash] = { source: name, report_date: payload.report_date, export_id: raw.export_id,
          imported_at: new Date(this.now()).toISOString() };
        // Commit each successful import; a later bad file must not erase progress.
        try { await saveJson(this.ledgerPath, ledger); }
        catch (error) { delete ledger.imported[hash]; throw error; }
        result.imported++;
        delete retries.files[name];
        emit({ event: previous ? 'icloud_file_recovered' : 'icloud_file_imported', source,
          attempts: (previous?.attempts ?? 0) + 1, report_date: payload.report_date });
      } catch (error) {
        const details = importDiagnostic(error), attempts = (previous?.attempts ?? 0) + 1;
        const validation = ['INVALID_JSON', 'INVALID_V33'].includes(details.code);
        const validationAttempts = validation && previous?.hash === hash ? (previous.validation_attempts ?? 0) + 1 : 1;
        const terminal = validation && validationAttempts >= 3;
        const next = new Date(this.now() + Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(attempts - 1, 8))).toISOString();
        const requiresAttention = ['EACCES', 'EPERM', 'EFBIG', 'UNKNOWN_ERROR'].includes(details.code) || attempts >= 10;
        retries.files[name] = { status: terminal ? 'rejected' : requiresAttention ? 'blocked_retry' : 'retry',
          attempts, validation_attempts: validation ? validationAttempts : 0, signature, hash,
          operation, code: details.code, last_attempt_at: new Date(this.now()).toISOString(),
          next_retry_at: terminal ? null : next };
        if (terminal) {
          ledger.failures[hash] = { source: name, reason: 'invalid_v33_payload', code: details.code,
            failed_at: new Date(this.now()).toISOString() };
          await saveJson(this.ledgerPath, ledger); result.failed++;
        } else { result.deferred++; }
        emit({ event: terminal ? 'icloud_file_rejected' : 'icloud_file_retry', source, operation,
          ...details, attempt: attempts, next_retry_at: terminal ? null : next,
          requires_attention: terminal || requiresAttention });
      }
    }
    try { await saveJson(this.ledgerPath, ledger); await saveJson(this.retryPath, retries); }
    catch (error) { error.importStage = 'save_scan_state'; throw error; }
    emit({ event: 'icloud_scan', ...result, pending: Object.values(retries.files).filter(v => v.status !== 'rejected').length,
      rejected: Object.values(retries.files).filter(v => v.status === 'rejected').length, duration_ms: this.now() - started });
    return result;
  }
}
