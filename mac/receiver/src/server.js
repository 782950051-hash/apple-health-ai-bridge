import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { JsonHealthStore } from './store.js';
import { JsonExportStore } from './export-store.js';
import { InvalidWakeUpload, WakeUploadStore } from './wake-upload.js';
import { PendingWakeStore } from './pending-wake.js';
import { metricCoverage } from './metric-coverage.js';
import { getLatestStoredDate } from './status.js';
import { parseHealthPayload } from './validation.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;

/**
 * @typedef {object} ServerOptions
 * @property {number} [port]
 * @property {string} [token]
 * @property {string} [dataDir]
 * @property {() => Date} [now] Clock for deterministic wake-admission tests.
 */

/**
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** @param {import('node:http').IncomingMessage} request */
function readRequestBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    request.resume();
    return Promise.reject(new Error('request body too large'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        request.resume();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {import('./config.js').GatewayConfig} config
 * @param {JsonHealthStore} store
 */
async function handleIngest(request, response, config, store) {
  if (request.headers['x-upload-key'] !== config.token) {
    sendJson(response, 401, { ok: false, error: 'invalid_request' });
    request.resume();
    return;
  }

  try {
    const body = await readRequestBody(request);
    const payload = parseHealthPayload(JSON.parse(body));
    await store.save(payload);
    sendJson(response, 200, {
      ok: true,
      date: payload.date,
      collection_status: payload.collection_status,
    });
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid_request' });
  }
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {import('./config.js').GatewayConfig} config
 */
async function handleStatus(response, config) {
  try {
    const latestDate = await getLatestStoredDate(config.dataDir);
    sendJson(response, 200, { ok: true, latest_date: latestDate });
  } catch {
    sendJson(response, 500, { ok: false, error: 'status_unavailable' });
  }
}

/** Store an opaque original export; the receipt does not claim completeness. */
async function handleExport(request, response, config, store) {
  if (request.headers['x-upload-key'] !== config.token) {
    sendJson(response, 401, { ok: false, error: 'invalid_request' });
    request.resume();
    return;
  }
  try {
    const bytes = await readRequestBody(request, MAX_EXPORT_BYTES);
    const receipt = await store.save(bytes);
    sendJson(response, 200, { ok: true, ...receipt, format: 'raw_json' });
  } catch {
    sendJson(response, 400, { ok: false, error: 'invalid_request' });
  }
}

async function handleWakeUpload(request, response, config, store, pending) {
  if (request.headers['x-upload-key'] !== config.token) {
    sendJson(response, 401, { ok: false, error: 'invalid_request' });
    request.resume();
    return;
  }
  let body;
  try { body = await readRequestBody(request, MAX_EXPORT_BYTES); }
  catch { sendJson(response, 400, { ok: false, error: 'invalid_request' }); return; }
  try {
    let payload;
    try { payload = JSON.parse(body); }
    catch { throw new InvalidWakeUpload('invalid request'); }
    if (!payload || typeof payload !== 'object') throw new InvalidWakeUpload('invalid request');
    let event;
    if (payload.event_id || payload.trigger !== 'manual_test') {
      event = await pending.get(payload.event_id);
      if (!event || event.trigger !== payload.trigger || event.received_at !== payload.event_received_at) {
        throw new InvalidWakeUpload('invalid event binding');
      }
    }
    const receipt = await store.save(body);
    const savedPayload = receipt.duplicate ? JSON.parse(await readFile(join(config.dataDir, 'exports', `${receipt.export_id}.json`), 'utf8')) : payload;
    const metricsValidation = metricCoverage(savedPayload.metrics, savedPayload.captured_at);
    if (event) await pending.acknowledge(event.event_id);
    sendJson(response, 200, { ok: true, ...receipt, metrics_validation: metricsValidation });
  } catch (error) {
    sendJson(response, error instanceof InvalidWakeUpload ? 400 : 500,
      { ok: false, error: error instanceof InvalidWakeUpload ? 'invalid_request' : 'save_unavailable' });
  }
}

async function handlePendingWake(request, response, config, pending) {
  if (request.headers['x-upload-key'] !== config.token) {
    sendJson(response, 401, { ok: false, error: 'invalid_request' });
    request.resume();
    return;
  }
  try {
    if (request.method === 'GET') {
      sendJson(response, 200, { ok: true, pending: await pending.latest() });
    } else {
      let data;
      try { data = JSON.parse(await readRequestBody(request, 4096)); }
      catch { throw new InvalidWakeUpload('invalid event'); }
      const event = await pending.save(data);
      sendJson(response, 200, { ok: true, event, completed: await pending.isAcknowledged(event.event_id) });
    }
  } catch (error) {
    sendJson(response, error instanceof InvalidWakeUpload ? 400 : 500,
      { ok: false, error: error instanceof InvalidWakeUpload ? 'invalid_request' : 'save_unavailable' });
  }
}

/**
 * Create the HTTP server without starting it. Callers can bind it to an
 * ephemeral port in tests or to the configured port in the CLI entrypoint.
 *
 * @param {ServerOptions} [options]
 * @returns {import('node:http').Server}
 */
export function createServer(options = {}) {
  const env = { ...process.env };
  if (options.port !== undefined) env.HEALTH_UPLOAD_PORT = String(options.port);
  if (options.token !== undefined) env.HEALTH_UPLOAD_TOKEN = options.token;
  if (options.dataDir !== undefined) env.HEALTH_DATA_DIR = options.dataDir;
  const config = loadConfig(env);
  const store = new JsonHealthStore(config.dataDir);
  const exportStore = new JsonExportStore(config.dataDir);
  const wakeStore = new WakeUploadStore(config.dataDir, { now: options.now });
  const pending = new PendingWakeStore(config.dataDir, { now: options.now });

  return createHttpServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/status') {
      void handleStatus(response, config);
      return;
    }

    if (request.method === 'POST' && pathname === '/ingest') {
      void handleIngest(request, response, config, store);
      return;
    }

    if (request.method === 'POST' && pathname === '/exports') {
      void handleExport(request, response, config, exportStore);
      return;
    }

    if (request.method === 'POST' && pathname === '/wake-upload') {
      void handleWakeUpload(request, response, config, wakeStore, pending);
      return;
    }

    if ((request.method === 'POST' && pathname === '/wake-event') ||
        (request.method === 'GET' && pathname === '/pending-wake')) {
      void handlePendingWake(request, response, config, pending);
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not_found' });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = loadConfig();
  createServer(config).listen(config.port, () => {
    console.log(`health upload gateway listening on ${config.port}`);
  });
}
