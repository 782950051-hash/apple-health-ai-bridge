import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const STORED_DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Return the latest local date with a stored health payload.
 *
 * The status surface intentionally reads only dated filenames. It never
 * opens a payload, so metric and sleep values cannot appear in the response.
 *
 * @param {string} dataDir
 * @returns {Promise<string | null>}
 */
export async function getLatestStoredDate(dataDir) {
  const dates = [];
  for (const directory of [dataDir, join(dataDir, 'wake-uploads'), join(dataDir, 'v33-health')]) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    dates.push(...entries
      .filter(entry => entry.isFile())
      .map(entry => STORED_DATE_FILE_RE.exec(entry.name)?.[1])
      .filter(date => date !== undefined));
  }

  return dates.length > 0 ? dates.sort().at(-1) : null;
}
