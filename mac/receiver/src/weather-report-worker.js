import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReportOutbox } from './report-outbox.js';

const dateInZone = (date, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const round = value => Math.round(value);
const temperature = value => typeof value === 'number' && Number.isFinite(value) && value >= -100 && value <= 65
  ? round(value) : undefined;
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  ? round(value) : undefined;

function renderWeather(weather, date) {
  const weekday = '日一二三四五六'[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const high = round(weather.temperature_max_c), low = round(weather.temperature_min_c);
  const feelsLike = temperature(weather.temperature_feels_like_c);
  const current = temperature(weather.temperature_current_c);
  const probabilityPct = probability(weather.precipitation_probability_pct);
  const clothingBasis = feelsLike ?? current;
  const clothes = clothingBasis !== undefined
    ? clothingBasis < 5 ? '体感偏冷，建议穿厚外套。'
      : clothingBasis < 12 ? '体感较凉，建议加一件外套。'
        : clothingBasis < 19 ? '体感微凉，建议分层穿搭。'
          : clothingBasis <= 26 ? '体感较舒适，轻便穿着即可。'
            : '体感偏热，建议穿透气衣物并注意补水。'
    : low < 10 ? '早晚偏冷，建议加外套。'
      : high >= 28 ? '天气偏热，建议穿透气衣物并注意补水。'
        : '按早晚温差准备衣物。';
  const umbrella = probabilityPct !== undefined
    ? probabilityPct >= 50 ? `今日降水概率：${probabilityPct}%，出门建议带伞。`
      : probabilityPct >= 20 ? `今日降水概率：${probabilityPct}%，建议备一把折叠伞。`
        : `今日降水概率：${probabilityPct}%，暂不必特意带伞。`
    : /雨|雪|雷/.test(weather.condition) ? '天气状况有降水，出门建议带伞。'
      : '当日降水概率暂不可用，出门前留意天气变化。';
  const lines = [
    `今日天气 ${date} 星期${weekday}`,
    `地区：${weather.location_name}`,
    `天气：${weather.condition}`,
  ];
  if (current !== undefined) lines.push(`当前温度：${current}℃`);
  if (feelsLike !== undefined) lines.push(`体感温度：${feelsLike}℃`);
  lines.push(
    `最高温：${high}℃ / 最低温：${low}℃`,
    clothes,
    umbrella,
  );
  return lines.join('\n');
}

async function sentLegacyMergeDates(root) {
  const dates = new Set();
  const stageDir = join(root, 'stage-d3');
  let states = [];
  try { states = await readdir(stageDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of states.filter(value => /^\d{4}-\d{2}-\d{2}\.json$/.test(value))) {
    try {
      const state = JSON.parse(await readFile(join(stageDir, name), 'utf8'));
      if (state.status === 'sent') dates.add(name.slice(0, -5));
    } catch { /* A corrupt historical status cannot authorize a send. */ }
  }
  return dates;
}

/** Process current-day weather independently from every health artifact. */
export async function runWeatherReportCycle({ root, readWeather, sender, now = () => new Date(), timeZone = 'Asia/Shanghai', maxAgeMs = 3 * 60 * 60 * 1000 } = {}) {
  if (typeof readWeather !== 'function') throw new TypeError('readWeather is required');
  const instant = now();
  const date = dateInZone(instant, timeZone);
  const stats = { discovered: 0, queued: 0, sent: 0, stale: 0, rejected: 0, legacy_suppressed: 0, blocked: 0, uncertain: 0 };
  const cutoff = new Date(`${date}T05:00:00+08:00`);
  if (instant < cutoff) return { ...stats, too_early: 1 };
  let result;
  try { result = await readWeather({ now: instant }); }
  catch { return { ...stats, reader_unavailable: 1 }; }
  stats.rejected = result.rejected_count ?? 0;
  if (result.normalization_issues && Object.keys(result.normalization_issues).length) {
    stats.normalization_issues = result.normalization_issues;
  }
  const records = (result.records ?? []).filter(row => row?.weather?.forecast_date === date && typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256));
  stats.discovered = records.length;
  records.sort((a, b) => Date.parse(b.weather.observed_at) - Date.parse(a.weather.observed_at));
  const record = records.find(row => {
    const observed = Date.parse(row.weather.observed_at);
    if (!Number.isFinite(observed) || observed < cutoff.valueOf() || observed > instant.valueOf() + 120000 || instant.valueOf() - observed > maxAgeMs) {
      stats.stale++;
      return false;
    }
    const value = row.weather;
    return typeof value.location_name === 'string' && value.location_name.trim() &&
      typeof value.condition === 'string' && value.condition.trim() &&
      Number.isFinite(value.temperature_max_c) && Number.isFinite(value.temperature_min_c);
  });
  if (!record) return stats;
  if ((await sentLegacyMergeDates(root)).has(date)) { stats.legacy_suppressed++; return stats; }
  const outbox = new ReportOutbox(root, { now });
  const exportId = createHash('sha256').update(JSON.stringify(record.weather)).digest('hex');
  const job = await outbox.enqueue({ exportId, report: {
    date, manual: false, channel: 'weather', text: renderWeather(record.weather, date),
  } });
  if (job.status === 'queued') stats.queued++;
  if (!sender) return stats;
  if (!['queued', 'retry', 'sending'].includes(job.status)) return stats;
  const delivered = await outbox.deliver(job.id, sender);
  if (delivered.status === 'sent') stats.sent++;
  if (delivered.status === 'blocked') stats.blocked++;
  if (delivered.status === 'delivery_uncertain') stats.uncertain++;
  return stats;
}
