import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), 'Library/Application Support/AppleHealthUpload');
const data = join(root, 'data');
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

const inputDir = process.env.HEALTH_ICLOUD_DIR ?? join(homedir(), 'Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/Shortcuts/AppleHealth-HealthData');
const ledger = await readJson(join(data, 'v33-import', 'ledger.json'));
const outboxDir = join(root, 'report-outbox');
let outbox = [];
if (await exists(outboxDir)) {
  for (const name of await readdir(outboxDir)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
    const value = await readJson(join(outboxDir, name)); if (value) outbox.push(value);
  }
}
let files = [];
if (await exists(inputDir)) files = (await readdir(inputDir)).filter(name => /^health-.*\.json$/.test(name)).sort();
const v33Files = await exists(join(data, 'v33-health')) ? (await readdir(join(data, 'v33-health'))).filter(name => name.endsWith('.json')).sort() : [];
const counts = Object.fromEntries(outbox.reduce((map, job) => map.set(job.status, (map.get(job.status) ?? 0) + 1), new Map()));
console.log(JSON.stringify({ input_dir: inputDir, input_json_files: files.length, stored_v33_reports: v33Files, imported_hashes: Object.keys(ledger?.imported ?? {}).length, failed_hashes: Object.keys(ledger?.failures ?? {}).length, report_outbox: counts }, null, 2));
