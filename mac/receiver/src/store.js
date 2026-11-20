import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SAMPLE_KEYS = {
  metrics: ['source', 'type', 'start', 'end', 'value'],
  sleep: ['source', 'stage', 'start', 'end', 'value'],
  workouts: ['source', 'type', 'start', 'end', 'value'],
};

/**
 * Remove repeated samples while preserving the first occurrence and all
 * unknown fields on each record and payload.
 * @param {unknown[]} records
 * @param {string[]} fields
 */
function dedupeRecords(records, fields) {
  const seen = new Set();
  return records.filter(record => {
    const key = JSON.stringify(fields.map(field => record?.[field]));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Return a payload with duplicate metric, sleep, and workout samples removed.
 * @param {Record<string, unknown>} payload
 */
export function dedupePayload(payload) {
  return {
    ...payload,
    ...(Array.isArray(payload.metrics)
      ? { metrics: dedupeRecords(payload.metrics, SAMPLE_KEYS.metrics) }
      : {}),
    ...(Array.isArray(payload.sleep)
      ? { sleep: dedupeRecords(payload.sleep, SAMPLE_KEYS.sleep) }
      : {}),
    ...(Array.isArray(payload.workouts)
      ? { workouts: dedupeRecords(payload.workouts, SAMPLE_KEYS.workouts) }
      : {}),
  };
}

/**
 * Store one validated health payload per local date.
 */
export class JsonHealthStore {
  /**
   * @param {string | { dataDir?: string }} [dataDir]
   */
  constructor(dataDir = './data/health') {
    this.dataDir = typeof dataDir === 'string' ? dataDir : dataDir?.dataDir ?? './data/health';
  }

  /**
   * Write a payload through a same-directory temporary file and atomic rename.
   * @param {{ date: string, collection_status: string }} payload
   * @returns {Promise<{path: string, collection_status: string}>}
   */
  async save(payload) {
    await mkdir(this.dataDir, { recursive: true });
    await chmod(this.dataDir, 0o700);
    const filename = `${payload.date}.json`;
    const path = join(this.dataDir, filename);
    const temporaryPath = join(this.dataDir, `${filename}.${process.pid}-${randomUUID()}.tmp`);
    const dedupedPayload = dedupePayload(payload);
    await writeFile(temporaryPath, `${JSON.stringify(dedupedPayload)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    return { path, collection_status: payload.collection_status };
  }
}
