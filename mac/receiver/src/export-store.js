import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Preserve original exports without interpreting or dropping health fields. */
export class JsonExportStore {
  constructor(dataDir) {
    this.directory = join(dataDir, 'exports');
  }

  /** @param {Buffer} bytes */
  async save(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new TypeError('export must be a JSON object or array');
    }
    const export_id = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const destination = join(this.directory, `${export_id}.json`);
    const temporary = join(this.directory, `${export_id}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } finally {
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    return { export_id, bytes: bytes.length };
  }
}
