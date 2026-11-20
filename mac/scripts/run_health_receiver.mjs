import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../receiver/src/server.js';
import { V33HealthImporter } from '../receiver/src/v33-import.js';
import { createWeatherReader } from '../receiver/src/weather-barrier.js';
import { runWeatherReportCycle } from '../receiver/src/weather-report-worker.js';
import { runV33HealthReportCycle } from '../receiver/src/v33-report-worker.js';
import { runIndependentReportCycles } from '../receiver/src/independent-report-cycle.js';
import { createHermesMorningAnalyzer } from '../receiver/src/hermes-morning-analyzer.js';
import { stageD3Mode } from '../receiver/src/stage-d3-mode.js';
import { createSelfWeChatSender } from '../receiver/src/wechat-self.js';
import { importDiagnostic } from '../receiver/src/icloud-file.js';

const root = resolve(process.env.APPLE_HEALTH_DATA_HOME ??
  join(homedir(), 'Library/Application Support/AppleHealthUpload'));
const token = process.env.HEALTH_UPLOAD_TOKEN;
if (!token) throw new Error('HEALTH_UPLOAD_TOKEN is required');
const port = Number(process.env.HEALTH_UPLOAD_PORT ?? 18787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid receiver port');
const server = createServer({ port, token, dataDir: join(root, 'data') });
const icloudDir = process.env.HEALTH_ICLOUD_DIR;
const importEnabled = process.env.HEALTH_STAGE_C_IMPORT !== 'off';
const d3Mode = stageD3Mode();
const icloudImporter = icloudDir && importEnabled
  ? new V33HealthImporter({ inputDir: icloudDir, dataDir: join(root, 'data'),
    onEvent: event => console.log(JSON.stringify(event)) })
  : null;
const hermesAnalyzer = d3Mode !== 'prepare' ? createHermesMorningAnalyzer() : null;
const weatherHelper = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/weather_d3_reader.py');
const readWeather = createWeatherReader({ directory: icloudDir ?? '', helper: weatherHelper });
let closing = false;
let reportBusy = false;
let importBusy = false;
let importFailures = 0;
let lastReportStatus = '';
async function imports() {
  if (!icloudImporter || closing || importBusy) return;
  importBusy = true;
  try {
    const status = await icloudImporter.scanOnce();
    importFailures = 0;
    if (status.imported || status.failed) {
      console.log(JSON.stringify({ time: new Date().toISOString(), event: 'icloud_import', ...status }));
    }
  } catch (error) {
    importFailures++;
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'icloud_import_unavailable',
      scan_id: `${process.pid}-${Date.now()}`, module: 'v33-import', operation: error.importStage ?? 'scan',
      ...importDiagnostic(error), attempt: importFailures, retry_status: 'automatic_next_scan',
      next_retry_at: new Date(Date.now() + 60000).toISOString(), requires_attention: importFailures >= 10 }));
  } finally { importBusy = false; }
}
async function reports() {
  if (closing || reportBusy) return;
  reportBusy = true;
  try {
    let sender;
    if (d3Mode === 'delivery') {
      try { sender = createSelfWeChatSender(JSON.parse(await readFile(join(root, 'wechat-self.json'), 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') console.log(JSON.stringify({ time: new Date().toISOString(), event: 'sender_unavailable' }));
      }
    }
    const status = await runIndependentReportCycles({
      weather: () => runWeatherReportCycle({ root, readWeather, sender }),
      health: () => runV33HealthReportCycle({ root, dataDir: join(root, 'data'), sender, analyzer: hermesAnalyzer }),
    });
    const signature = JSON.stringify(status);
    if (signature !== lastReportStatus && Object.values(status).some(channel => Object.values(channel).some(Boolean))) {
      console.log(JSON.stringify({ time: new Date().toISOString(), event: 'independent_report_queues', ...status }));
    }
    lastReportStatus = signature;
  } catch { console.log(JSON.stringify({ time: new Date().toISOString(), event: 'report_queue_unavailable' })); }
  finally { reportBusy = false; }
}
server.on('request', (request, response) => {
  let bytes = 0;
  request.on('data', chunk => { bytes += chunk.length; });
  response.on('finish', () => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    console.log(JSON.stringify({ time: new Date().toISOString(), method: request.method, path,
      status: response.statusCode, bytes }));
    if (path === '/wake-upload' && response.statusCode === 200) void reports();
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Private health receiver listening on loopback:${port}; Stage D3 mode=${d3Mode}`);
  console.log(JSON.stringify({ time: new Date().toISOString(), event: 'receiver_started', pid: process.pid,
    importer_revision: 'icloud-recovery-v1', scan_interval_ms: 60000,
    stage_c_automation: process.env.HEALTH_STAGE_C_AUTOMATION ?? 'unset', stage_d3_mode: d3Mode,
    input_reader: 'bounded_process_with_dataless_materialization' }));
  void imports();
  void reports();
});
// Delivery reconciliation only; this never queries Health or declares a wake.
const reportTimer = setInterval(() => void reports(), 60000);
reportTimer.unref();
const importTimer = icloudImporter ? setInterval(() => void imports(), 60000) : undefined;
importTimer?.unref();
const stop = () => { closing = true; clearInterval(reportTimer); if (importTimer) clearInterval(importTimer); server.close(); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
