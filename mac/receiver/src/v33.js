const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const STAGE_NAMES = new Set(['core', 'deep', 'rem', 'awake', 'unknown']);
const METRIC_NAMES = new Set(['heart_rate', 'resting_heart_rate', 'heart_rate_variability', 'oxygen_saturation']);

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validTimestamp(value) { return typeof value === 'string' && ISO_TS_RE.test(value) && Number.isFinite(Date.parse(value)); }
function localDate(value, timeZone = 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issue(list, path) { list.push(path); }

/** Validate the actual Apple Health v3.3 object emitted by the B1 shortcut. */
export function validateV33Payload(input) {
  const issues = [];
  if (!isObject(input)) throw new TypeError('invalid v3.3 payload');
  if (input.exporter_version !== '3.3.0') issue(issues, 'exporter_version');
  if (typeof input.run_id !== 'string' || !input.run_id) issue(issues, 'run_id');
  if (typeof input.trigger !== 'string' || !input.trigger) issue(issues, 'trigger');
  if (!validTimestamp(input.captured_at)) issue(issues, 'captured_at');
  if (input.event_received_at !== undefined && input.event_received_at !== null && !validTimestamp(input.event_received_at)) issue(issues, 'event_received_at');
  if (!['complete', 'partial', 'failed', 'permission_denied', 'unsupported'].includes(input.collection_status)) issue(issues, 'collection_status');
  if (typeof input.collection_status_reason !== 'string' || !input.collection_status_reason) issue(issues, 'collection_status_reason');
  if (typeof input.time_precision_policy !== 'string' || !input.time_precision_policy) issue(issues, 'time_precision_policy');

  const sleep = input.sleep;
  if (!isObject(sleep) || !Array.isArray(sleep.samples)) issue(issues, 'sleep.samples');
  else for (const [index, sample] of sleep.samples.entries()) {
    if (!isObject(sample) || !STAGE_NAMES.has(sample.stage)) { issue(issues, `sleep.samples[${index}]`); continue; }
    for (const key of ['start_date', 'end_date']) if (!validTimestamp(sample[key])) issue(issues, `sleep.samples[${index}].${key}`);
    if (typeof sample.stage_text !== 'string' || typeof sample.stage_code !== 'string') issue(issues, `sleep.samples[${index}].stage_text`);
  }

  if (!isObject(input.metrics)) issue(issues, 'metrics');
  else for (const name of METRIC_NAMES) {
    const metric = input.metrics[name];
    if (!isObject(metric) || !Array.isArray(metric.samples)) { issue(issues, `metrics.${name}.samples`); continue; }
    for (const [index, sample] of metric.samples.entries()) {
      if (!isObject(sample) || typeof sample.value !== 'number' || !Number.isFinite(sample.value)) issue(issues, `metrics.${name}.samples[${index}].value`);
      for (const key of ['start_date', 'end_date']) if (!validTimestamp(sample[key])) issue(issues, `metrics.${name}.samples[${index}].${key}`);
      if (sample.unit !== null && typeof sample.unit !== 'string') issue(issues, `metrics.${name}.samples[${index}].unit`);
    }
  }
  if (issues.length) throw new TypeError(`invalid v3.3 payload: ${issues.join(', ')}`);
  return input;
}

function asleep(sample) { return sample.stage === 'core' || sample.stage === 'deep' || sample.stage === 'rem'; }

/** Resolve the report day from the latest main sleep interval, never from the filename. */
export function reportDateForV33(input, timeZone = 'Asia/Shanghai') {
  const anchor = Date.parse(input.event_received_at || input.captured_at);
  const sleep = input.sleep.samples
    .filter(asleep)
    .map(sample => ({ start: Date.parse(sample.start_date), end: Date.parse(sample.end_date) }))
    .filter(sample => sample.end > sample.start && sample.end <= anchor + 120000 && sample.end >= anchor - 18 * 3600000)
    .sort((a, b) => a.end - b.end);
  return localDate(sleep.at(-1)?.end ?? anchor, timeZone);
}

export function normalizeV33(input, timeZone = 'Asia/Shanghai') {
  validateV33Payload(input);
  return { schema: 'apple-health-v3.3', report_date: reportDateForV33(input, timeZone), timezone: timeZone, payload: input };
}
