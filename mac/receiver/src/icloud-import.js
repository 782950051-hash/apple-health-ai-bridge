import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JsonExportStore } from './export-store.js';
import { JsonHealthStore } from './store.js';
import { parseHealthPayload } from './validation.js';

const LEDGER_VERSION = 1;

function emptyLedger() {
  return { version: LEDGER_VERSION, imported: {}, failures: {} };
}

async function loadLedger(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (value?.version === LEDGER_VERSION && value.imported && value.failures) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return emptyLedger();
}

async function saveLedger(path, ledger) {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function stableRecord(first, second) {
  return first.size === second.size && first.mtimeMs === second.mtimeMs;
}

/**
 * Import normalized Apple Health JSON files that have finished syncing into
 * an iCloud Drive directory. No health values are written to logs or the
 * ledger; the raw payload is retained only in the private export store.
 */
export class ICloudHealthImporter {
  constructor({ inputDir, dataDir, settleMs = 10_000, now = () => Date.now(), healthStore, exportStore } = {}) {
    if (!inputDir || !dataDir) throw new TypeError('inputDir and dataDir are required');
    this.inputDir = inputDir;
    this.dataDir = dataDir;
    this.settleMs = settleMs;
    this.now = now;
    this.healthStore = healthStore ?? new JsonHealthStore(dataDir);
    this.exportStore = exportStore ?? new JsonExportStore(dataDir);
    this.ledgerPath = join(dataDir, 'icloud-import', 'ledger.json');
  }

  async scanOnce() {
    let names;
    try { names = await readdir(this.inputDir); }
    catch (error) {
      if (error.code === 'ENOENT') return { imported: 0, skipped: 0, deferred: 0, failed: 0 };
      throw error;
    }

    const ledger = await loadLedger(this.ledgerPath);
    const result = { imported: 0, skipped: 0, deferred: 0, failed: 0 };
    for (const name of names.filter(value => value.endsWith('.json') && !value.startsWith('.')).sort()) {
      const path = join(this.inputDir, name);
      let first;
      try { first = await stat(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!first.isFile() || this.now() - first.mtimeMs < this.settleMs) {
        result.deferred += 1;
        continue;
      }

      const bytes = await readFile(path);
      const second = await stat(path).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!second || !stableRecord(first, second)) {
        result.deferred += 1;
        continue;
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (ledger.imported[hash] || ledger.failures[hash]) {
        result.skipped += 1;
        continue;
      }

      let payload;
      try {
        payload = parseHealthPayload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      } catch {
        ledger.failures[hash] = { source: name, reason: 'invalid_payload', failed_at: new Date(this.now()).toISOString() };
        result.failed += 1;
        continue;
      }

      const raw = await this.exportStore.save(bytes);
      await this.healthStore.save(payload);
      ledger.imported[hash] = {
        source: name,
        date: payload.date,
        export_id: raw.export_id,
        imported_at: new Date(this.now()).toISOString(),
      };
      result.imported += 1;
    }
    await saveLedger(this.ledgerPath, ledger);
    return result;
  }
}
