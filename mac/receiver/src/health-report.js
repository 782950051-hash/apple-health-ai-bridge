import { instant } from './wake-upload.js';
import { metricCoverage } from './metric-coverage.js';

const HOUR = 3600000;
const asleep = new Set(['核心睡眠', '深度睡眠', '快速动眼睡眠', 'Core', 'Deep', 'REM', 'Asleep', '睡眠']);
const day = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
const clock = time => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(time);
const lines = value => typeof value === 'string' && value ? value.split(/\r?\n/).map(x => x.trim()) : [];

function rows(columns, properties) {
  const all = properties.map(name => lines(columns?.[`${name}_text`]));
  if (!all[0].length || all.some(column => column.length !== all[0].length)) throw new Error('invalid report columns');
  return all[0].map((_, i) => Object.fromEntries(properties.map((name, j) => [name, all[j][i]])));
}

function merge(intervals) {
  const merged = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function vitalSummary(payload, coverage, session) {
  if (!session.length) return [];
  const acceptedUnits = {
    heart_rate: ['count/min', 'bpm', '次/分', '次/分钟'],
    hrv_sdnn: ['ms', '毫秒'], respiratory_rate: ['count/min', 'breaths/min', '次/分', '次/分钟'],
    oxygen_saturation: ['%'], sleeping_wrist_temperature: ['°C', 'degC', '℃', '°F', 'degF'],
  };
  const output = [];
  for (const check of coverage) {
    if (check.status !== 'valid' || !acceptedUnits[check.id]) continue;
    const metric = payload.metrics[check.id];
    const sources = lines(metric.sources_text);
    let samples = rows(metric, ['starts', 'ends', 'values', 'units']).map((row, i) => ({
      ...row, source: sources[i] ?? '', start: instant(row.starts), end: instant(row.ends),
    })).filter(row => row.start >= session[0][0] && row.end <= session.at(-1)[1]);
    if (samples.some(row => /watch/i.test(row.source))) samples = samples.filter(row => /watch/i.test(row.source));
    if (new Set(samples.map(row => row.source)).size > 1) continue;
    samples = [...new Map(samples.map(row => [JSON.stringify([row.start, row.end, row.values, row.units, row.source]), row])).values()];
    const units = [...new Set(samples.map(row => row.units))];
    if (!samples.length || units.length !== 1 || !acceptedUnits[check.id].includes(units[0])) continue;
    const values = samples.map(row => Number(row.values)).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    const value = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(median);
    output.push(`${check.label}：睡眠时段样本中位数${value} ${units[0]}（${values.length}条，${/watch/i.test(samples[0].source) ? '手表来源' : '来源未确认'}）。`);
  }
  return output;
}

/** Factual local summary only. Never infer diagnosis, recovery, baseline or units. */
export function buildHealthReport(payload) {
  if (payload?.kind !== 'shortcuts_wake_v1' || payload.driver !== 'Apple Shortcuts' ||
      !['manual_test', 'health_sleep_score_notification'].includes(payload.trigger)) throw new Error('unsupported report input');
  const anchor = instant(payload.event_received_at || payload.captured_at);
  const captured = instant(payload.captured_at);
  const date = day(anchor);
  const midnight = instant(`${date}T00:00:00+08:00`);
  const activityDate = day(midnight - 1);
  const records = rows(payload.sleep, ['starts', 'ends', 'values']);
  const intervals = records.map(row => {
    const start = instant(row.starts), end = instant(row.ends);
    if (end <= start || end > captured + 30000 || end - start > 48 * HOUR) throw new Error('invalid sleep interval');
    return { start, end, asleep: asleep.has(row.values) };
  }).filter(row => row.asleep && row.end <= anchor + 120000 && row.end >= anchor - 18 * HOUR);
  let latest = intervals.length ? Math.max(...intervals.map(row => row.end)) : null;
  // Retain the latest connected session; a later afternoon nap is excluded by
  // the event boundary, and unrelated older nights cannot inflate duration.
  const sorted = merge(intervals.map(row => [Math.max(row.start, anchor - 18 * HOUR), row.end]));
  const session = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (session.length && session[0][0] - sorted[i][1] > 90 * 60000) break;
    session.unshift(sorted[i]);
  }
  const sleepMinutes = session.length ? Math.round(session.reduce((sum, [start, end]) => sum + end - start, 0) / 60000) : null;
  let watchSteps = null;
  let otherSources = false;
  let ambiguousSteps = false;
  let crossDay = false;
  if (payload.metrics?.step_count) {
    const steps = rows(payload.metrics.step_count, ['starts', 'ends', 'values', 'units', 'sources']);
    const groups = new Map();
    const seen = new Set();
    let invalidWatch = false;
    for (const row of steps) {
      const start = instant(row.starts), end = instant(row.ends);
      if (end < start || end > captured + 30000) throw new Error('invalid step interval');
      if (start >= midnight || end <= midnight - 24 * HOUR) continue;
      if (start < midnight - 24 * HOUR || end > midnight) { crossDay = true; continue; }
      if (!/watch/i.test(row.sources)) { otherSources = true; continue; }
      if (!['count', '步', 'steps'].includes(row.units) || !/^\d+(?:\.\d+)?$/.test(row.values)) { invalidWatch = true; continue; }
      const value = Number(row.values);
      if (!Number.isFinite(value)) { invalidWatch = true; continue; }
      const identity = JSON.stringify([row.sources, start, end, value, row.units]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const group = groups.get(row.sources) ?? [];
      group.push({ start, end, value }); groups.set(row.sources, group);
    }
    if (groups.size === 1 && !invalidWatch) {
      const values = [...groups.values()][0].sort((a, b) => a.start - b.start);
      let lastEnd = -Infinity;
      for (const row of values) {
        if (row.start < lastEnd) ambiguousSteps = true;
        lastEnd = Math.max(lastEnd, row.end);
      }
      if (!ambiguousSteps) watchSteps = values.reduce((sum, row) => sum + row.value, 0);
    } else if (groups.size > 1) ambiguousSteps = true;
  }
  const manual = payload.trigger === 'manual_test';
  const output = [`${date} 健康数据简报${manual ? '（手动测试）' : ''}`, ''];
  if (sleepMinutes === null) output.push('睡眠：没有可汇总的近期睡眠样本。');
  else output.push(`最近一组睡眠样本：${Math.floor(sleepMinutes / 60)}小时${sleepMinutes % 60}分，覆盖${clock(session[0][0])}至${clock(latest)}（北京时间）。重叠时段已合并，清醒阶段不计入。`);
  output.push(`昨日（${activityDate}）步数：${watchSteps === null ? '暂不能可靠汇总' : `手表来源${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(watchSteps)}步`}。`);
  const coverage = metricCoverage(payload.metrics, payload.captured_at);
  output.push(...vitalSummary(payload, coverage, session));
  if (otherSources) output.push('其他来源步数未合并，以上不等同于健康 App 的综合总步数。');
  if (crossDay || ambiguousSteps) output.push('存在跨日或来源/重叠歧义，相关步数未折算。');
  if (!payload.sleep.sources_text) output.push('睡眠来源未返回，尚未逐条确认来自手表。');
  const extras = coverage.filter(item => item.id !== 'step_count' && item.status === 'valid');
  output.push(extras.length ? `额外通过类型核验：${extras.map(item => `${item.label}${item.samples}条`).join('、')}；仍不代表全部请求指标已接齐。` : '指标覆盖：当前仅睡眠和步数；其余指标尚未接齐。');
  output.push('数据不足，暂不评价恢复状态，也未计算个人历史趋势。');
  if (manual) output.push('这是实际健康数据的上传链路测试，不代表真实睡醒触发已验证。');
  return { date, activity_date: activityDate, sleep_minutes: sleepMinutes,
    watch_steps: watchSteps, manual, metric_coverage: coverage, text: output.join('\n') };
}

const v33MetricLabels = {
  heart_rate: '睡眠心率', resting_heart_rate: '静息心率', heart_rate_variability: 'HRV SDNN', oxygen_saturation: '血氧',
};

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function durationMinutes(start, end) { return Math.max(0, Math.round((end - start) / 60000)); }

function v33Session(payload) {
  const anchor = instant(payload.event_received_at || payload.captured_at);
  const samples = payload.sleep.samples.map(sample => ({
    stage: sample.stage, start: instant(sample.start_date), end: instant(sample.end_date),
  })).filter(sample => sample.end > sample.start && sample.end <= anchor + 120000 && sample.end >= anchor - 18 * HOUR);
  const asleepSamples = samples.filter(sample => sample.stage === 'core' || sample.stage === 'deep' || sample.stage === 'rem');
  const all = merge(asleepSamples.map(sample => [sample.start, sample.end]));
  const session = [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (session.length && session[0][0] - all[i][1] > 90 * 60000) break;
    session.unshift(all[i]);
  }
  return { anchor, samples, asleepSamples, session };
}

function v33StageMinutes(samples, session) {
  if (!session.length) return { core: 0, deep: 0, rem: 0, awake: 0, awakeCount: 0 };
  const start = session[0][0], end = session.at(-1)[1];
  const boundaries = new Set([start, end]);
  for (const sample of samples) {
    boundaries.add(Math.max(start, sample.start)); boundaries.add(Math.min(end, sample.end));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const totals = { core: 0, deep: 0, rem: 0, awake: 0, awakeCount: 0 };
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i], b = sorted[i + 1]; if (b <= a) continue;
    const covering = samples.filter(sample => sample.start <= a && sample.end >= b);
    const stage = covering.length === 1 ? covering[0].stage : covering.length > 1 ? 'unknown' : null;
    if (stage && stage in totals) totals[stage] += b - a;
  }
  totals.awakeCount = samples.filter(sample => sample.stage === 'awake' && sample.end > start && sample.start < end).length;
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, key === 'awakeCount' ? value : Math.round(value / 60000)]));
}

function v33Vitals(payload, session) {
  if (!session.length) return [];
  const start = session[0][0], end = session.at(-1)[1];
  const units = { heart_rate: new Set(['count/min', 'bpm', '次/分', '次/分钟']), resting_heart_rate: new Set(['count/min', 'bpm', '次/分', '次/分钟']), heart_rate_variability: new Set(['ms', '毫秒']), oxygen_saturation: new Set(['%', 'percent']) };
  const output = [];
  for (const [name, label] of Object.entries(v33MetricLabels)) {
    const metric = payload.metrics?.[name]; if (!metric?.samples?.length) continue;
    const rows = metric.samples.filter(sample => {
      const a = instant(sample.start_date), b = instant(sample.end_date);
      // Apple Health quantity samples may be instantaneous (start_date === end_date).
      return b >= a && a >= start && b <= end && typeof sample.value === 'number' && units[name].has(sample.unit);
    });
    const allowed = [...new Set(rows.map(row => row.unit))];
    if (!rows.length) {
      output.push(`${label}：主要睡眠窗口没有有效样本，未将睡眠外数据代入。`);
      continue;
    }
    if (allowed.length !== 1) {
      output.push(`${label}：睡眠窗口样本单位不一致，未强行换算。`);
      continue;
    }
    output.push(`${label}：睡眠时段中位数${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(median(rows.map(row => row.value)))} ${allowed[0]}（${rows.length}条）。`);
  }
  return output;
}

/** Factual report for the actual B1/v3.3 object. No diagnosis or fabricated baseline. */
export function buildV33HealthReport(payload, { includeWeather = true, weather = 'unavailable' } = {}) {
  if (payload?.exporter_version !== '3.3.0' || !payload.sleep?.samples || !payload.metrics) throw new Error('unsupported v3.3 report input');
  const { anchor, samples, asleepSamples, session } = v33Session(payload);
  const date = day(session.at(-1)?.[1] ?? anchor);
  const stages = v33StageMinutes(samples, session);
  const total = session.reduce((sum, [a, b]) => sum + b - a, 0);
  const sleepMinutes = Math.round(total / 60000);
  const manual = payload.trigger === 'manual_test';
  const output = [`${date} 健康晨报${manual ? '（手动测试）' : ''}`, ''];
  output.push(session.length ? `主要睡眠：${Math.floor(sleepMinutes / 60)}小时${sleepMinutes % 60}分，${clock(session[0][0])}至${clock(session.at(-1)[1])}（北京时间）。` : '主要睡眠：没有可汇总的近期睡眠样本。');
  if (session.length) {
    output.push(`睡眠结构：核心${stages.core}分，深度${stages.deep}分，REM ${stages.rem}分；清醒${stages.awake}分、${stages.awakeCount}次。`);
    if (stages.deep + stages.rem + stages.core !== sleepMinutes) output.push('睡眠分期存在重叠或未归类区间，分期合计未强行补齐总时长。');
  }
  output.push(...v33Vitals(payload, session));
  output.push(`采集状态：${payload.collection_status}；${payload.collection_status_reason}`);
  output.push('历史趋势：当前仅按本次数据生成，未计算个人基线或近7/30天趋势。');
  if (includeWeather) output.push(weather === 'unavailable' ? '天气：未配置可靠位置或天气来源，暂不可用；不影响健康数据处理。' : `天气：${weather}`);
  output.push('建议：根据今晚睡前和明早状态安排作息；本报告使用消费级设备数据，不作为疾病诊断。');
  return { date, manual, sleep_minutes: sleepMinutes, text: output.join('\n') };
}
