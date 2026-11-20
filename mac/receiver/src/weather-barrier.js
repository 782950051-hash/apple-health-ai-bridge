import { createHash, randomUUID } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateV33Payload } from './v33.js';
import { buildV33HealthReport } from './health-report.js';
import { ReportOutbox } from './report-outbox.js';
import { icloudAccessHelper } from './icloud-file.js';

const execFile = promisify(nodeExecFile);
const digest = b => createHash('sha256').update(b).digest('hex');
const validHash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const dateRE = /^\d{4}-\d{2}-\d{2}$/;
export const reportId = date => digest(`health-report-v1|automatic|${date}`);
const offset = stamp => stamp.endsWith('Z') ? '+00:00' : stamp.slice(-6);
function localDayAt(stamp, instant) {
  const tail = offset(stamp), sign = tail[0] === '-' ? -1 : 1;
  const minutes = sign * (Number(tail.slice(1,3)) * 60 + Number(tail.slice(4,6)));
  if (!Number.isFinite(minutes) || Math.abs(minutes) > 14 * 60) throw Error('invalid_offset');
  return new Date(instant + minutes * 60000).toISOString().slice(0,10);
}
async function readJson(path, missing) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return missing; throw e; }
}
// fsync data before atomic rename. A crash never leaves a partial state document.
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = await open(temporary, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, path);
    const directory = await open(join(path, '..'), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
async function acquire(path) {
  try { await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return true; }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const owner = await readJson(path, {});
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try { process.kill(owner.pid, 0); return false; }
    catch (failure) { if (failure.code !== 'ESRCH') return false; }
    // Serialize stale-owner recovery and recheck the owner. Another process may
    // already have recovered the old file and acquired a new live lock.
    const recovery = `${path}.recovery`;
    try { await writeFile(recovery, String(process.pid), { flag:'wx', mode:0o600 }); }
    catch (failure) { if (failure.code === 'EEXIST') return false; throw failure; }
    try {
      const current = await readJson(path, {});
      if (!Number.isSafeInteger(current.pid) || current.pid < 1) return false;
      try { process.kill(current.pid,0); return false; }
      catch (failure) { if (failure.code !== 'ESRCH') return false; }
      await unlink(path).catch(failure=>{if(failure.code!=='ENOENT')throw failure;});
      return false; // The next cycle may acquire; it must reconcile saved intent first.
    } finally { await unlink(recovery).catch(failure=>{if(failure.code!=='ENOENT')throw failure;}); }
  }
}

/** Adapter only. No HTTP, iCloud mutation, model or sender. */
export function createWeatherReader({ directory, helper, python = process.env.PYTHON_BIN ?? 'python3', execFileFn = execFile }) {
  return async ({ now }) => {
    const { stdout } = await execFileFn(python, [icloudAccessHelper, '--weather-reader', helper,
      '--directory', directory, '--now', now.toISOString()],
      { timeout: 30000, maxBuffer: 512 * 1024 });
    const value = JSON.parse(stdout);
    if (!Array.isArray(value.records)) throw Error('invalid_weather_adapter');
    return value;
  };
}

function cleanProse(value, minimum, maximum) {
  if (typeof value !== 'string' || value.trim().length < minimum || value.length > maximum ||
      /[\x00-\x1f]|[{}]|partial|collection_status|schema_version|```/i.test(value)) throw Error('invalid_analysis');
  return value.trim();
}
export function validateMorningAnalysis(value) {
  if (!value || !Array.isArray(value.suggestions) || value.suggestions.length !== 2) throw Error('invalid_analysis');
  return { analysis: cleanProse(value.analysis, 100, 150), suggestions: value.suggestions.map(s => cleanProse(s, 2, 160)) };
}

/** All metrics/time ranges come from the unchanged, tested Stage C factual calculator. */
export function renderMorning41({ date, payload, weather, analysis }) {
  if (!dateRE.test(date) || (weather && weather.forecast_date !== date)) throw Error('invalid_morning_report');
  const prose = validateMorningAnalysis(analysis);
  const factual = buildV33HealthReport(payload);
  const lines = factual.text.split('\n');
  const find = prefix => lines.find(s => s.startsWith(prefix));
  // Presentation only: reuse the factual calculator's totals, stages and medians.
  const duration = minutes => minutes >= 60
    ? `${Math.floor(minutes / 60)}小时${minutes % 60}分钟` : `${minutes}分钟`;
  const times = find('主要睡眠：')?.match(/，(\d{2}:\d{2})至(\d{2}:\d{2})/);
  const stages = find('睡眠结构：')?.match(/核心(\d+)分，深度(\d+)分，REM (\d+)分；清醒(\d+)分/);
  const previousDay = new Date(`${factual.date}T12:00:00Z`);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const startDay = times && times[1] > times[2] ? previousDay.toISOString().slice(0, 10) : factual.date;
  const relative = factual.date === date && /\+08:00$/.test(payload.captured_at);
  const sleep = [
    `总睡眠：${times ? duration(factual.sleep_minutes) : '暂不可用'}`,
    `入睡：${times ? `${relative ? (startDay === date ? '今早' : '昨晚') : startDay} ${times[1]}` : '暂不可用'}`,
    `醒来：${times ? `${relative ? '今早' : factual.date} ${times[2]}` : '暂不可用'}`,
    '',
    ...['核心睡眠', '深度睡眠', 'REM 快速动眼睡眠', '清醒时间']
      .map((label, i) => `${label}：${stages ? duration(Number(stages[i + 1])) : '暂不可用'}`),
    find('睡眠分期存在'),
  ].filter(s => s !== undefined);
  const vitals = [['睡眠心率', '睡眠期间心率'], ['HRV SDNN', 'HRV（SDNN）'], ['血氧', '血氧'], ['静息心率', '静息心率']]
    .map(([source, label]) => {
      const line = find(`${source}：`);
      const value = line?.match(/：睡眠时段中位数([\d,.]+) (count\/min|bpm|次\/分|次\/分钟|ms|毫秒|%|percent)（/);
      if (source === '静息心率' && !value) return undefined;
      const unit = value?.[2].replace(/^(count\/min|bpm|次\/分钟)$/, '次/分').replace('ms', '毫秒').replace('percent', '%');
      return `${label}：${value ? value[1] + unit : (line?.split('：')[1] ?? '暂不可用')}`;
    }).filter(Boolean);
  const [year, month, day] = date.split('-').map(Number);
  const weekday = '日一二三四五六'[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const degrees = x => (Math.sign(x) * Math.floor(Math.abs(x) + 0.5)) || 0;
  const sections = [
    `私人 AI 健康管家\n${year}年${month}月${day}日 星期${weekday}`,
    `🌙 昨夜睡眠\n\n${sleep.join('\n')}`,
    `❤️ 身体状态\n\n${vitals.join('\n')}`,
    `🧠 Hermes 健康分析\n\n${prose.analysis}`,
    `💡 今日建议\n\n1. ${prose.suggestions[0]}\n\n2. ${prose.suggestions[1]}`,
    'Apple Watch × Hermes\n健康信息仅供参考，不作为医疗诊断。',
  ];
  if (weather) sections.splice(3, 0,
    `🌤 今日天气\n\n📍 ${weather.location_name}\n🌡 最高温：${degrees(weather.temperature_max_c)}℃\n❄️ 最低温：${degrees(weather.temperature_min_c)}℃\n🌧 天气：${weather.condition}`);
  return sections.join('\n\n────────────\n\n');
}

async function healthCandidates(dataDir, now, cutoff, stats) {
  // Read only accepted immutable archives, not health filenames or overwritten daily summaries.
  const ledger = await readJson(join(dataDir, 'v33-import', 'ledger.json'), { imported: {} });
  const rows = [];
  for (const [sha256, entry] of Object.entries(ledger.imported ?? {})) {
    if (entry.baseline || !validHash(entry.export_id)) continue;
    try {
      const bytes = await readFile(join(dataDir, 'exports', `${entry.export_id}.json`));
      if (!validHash(sha256) || digest(bytes) !== sha256 || entry.export_id !== sha256) throw Error('health_hash_mismatch');
      const payload = validateV33Payload(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      const captured = Date.parse(payload.captured_at), date = payload.captured_at.slice(0,10);
      if (!['complete','partial'].includes(payload.collection_status) || !payload.sleep.samples.length) throw Error('no_usable_health');
      if (captured < cutoff) { stats.historical++; continue; }
      if (captured > now.valueOf() + 120000 || date !== localDayAt(payload.captured_at, now.valueOf())) continue;
      if (!(buildV33HealthReport(payload).sleep_minutes > 0)) throw Error('no_recent_sleep');
      rows.push({ payload, sha256, export_id: entry.export_id, captured_at: payload.captured_at, date });
    } catch { stats.invalid_health++; }
  }
  return rows.sort((a,b) => Date.parse(a.captured_at)-Date.parse(b.captured_at) || a.sha256.localeCompare(b.sha256));
}
function matching(health, records) {
  return records.filter(r => r.weather.forecast_date === health.date &&
      r.weather.observed_at.slice(0,10) === health.date && offset(r.weather.observed_at) === offset(health.captured_at) &&
      Date.parse(r.weather.observed_at) <= Date.parse(health.captured_at) &&
      Date.parse(health.captured_at)-Date.parse(r.weather.observed_at) <= 15 * 60000)
    .sort((a,b) => Date.parse(b.weather.observed_at)-Date.parse(a.weather.observed_at) || b.sha256.localeCompare(a.sha256))[0];
}

/** Persisted rendezvous. Default is prepare-only: no analyzer, report, enqueue or send. */
export async function runWeatherBarrierCycle({ root, dataDir, readWeather, now = () => new Date(), activationAt,
    allowAnalysis = false, allowSend = false, analyzer, sender } = {}) {
  const directory = join(root, 'stage-d3');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = { waiting:0, ready:0, analyzed:0, queued:0, sent:0, historical:0, invalid_health:0, rejected_weather:0, locked:0, blocked:0 };
  const lock = join(directory, 'cycle.lock');
  if (!await acquire(lock)) return { ...stats, locked:1 };
  try {
    const instant = now();
    let config = await readJson(join(directory,'activation.json'), null);
    if (!config) {
      config = { version:1, activation_at: activationAt ?? instant.toISOString() };
      if (!Number.isFinite(Date.parse(config.activation_at))) throw Error('invalid_activation');
      await save(join(directory,'activation.json'),config);
    }
    if (config.version !== 1 || !Number.isFinite(Date.parse(config.activation_at))) throw Error('invalid_activation');
    let weatherResult;
    try { weatherResult = await readWeather({ now:instant }); }
    catch { weatherResult = { records:[], rejected_count:0, status:'weather_reader_unavailable' }; }
    stats.rejected_weather = weatherResult.rejected_count ?? 0;
    const records = (weatherResult.records ?? []).filter(r => validHash(r.sha256) &&
      Date.parse(r.weather.observed_at) >= Date.parse(config.activation_at) &&
      r.weather.forecast_date === localDayAt(r.weather.observed_at, instant.valueOf()));
    const health = await healthCandidates(dataDir, instant, Date.parse(config.activation_at), stats);
    const states = new Map();
    for (const name of await readdir(directory)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
      const state = await readJson(join(directory,name));
      if (state.version !== 1 || state.date !== name.slice(0,10)) throw Error('invalid_pending_state');
      states.set(state.date,state);
    }
    const ensure = date => {
      if (!states.has(date)) states.set(date,{ version:1, date, status:'waiting_health', analysis_status:'not_started', created_at:instant.toISOString() });
      return states.get(date);
    };
    for(const r of records) {
      const s=ensure(r.weather.forecast_date);
      if (s.analysis_status !== 'not_started') continue;
      s.weather_candidates=[...new Map([...(s.weather_candidates ?? []),r].map(x=>[x.sha256,x])).values()]
        .sort((a,b)=>Date.parse(b.weather.observed_at)-Date.parse(a.weather.observed_at)).slice(0,32);
    }
    for(const h of health) {
      const s=ensure(h.date);
      if (s.analysis_status === 'not_started' && !['sent','blocked_existing_outbox'].includes(s.status)) {
        // Before analysis starts, prefer the latest valid health acquisition.
        if (!s.health || Date.parse(h.captured_at)>=Date.parse(s.health.captured_at)) {
          if (s.health?.sha256 !== h.sha256) delete s.weather;
          s.health=h;
        }
      }
    }
    const outbox = new ReportOutbox(root, { now });
    for(const s of states.values()) {
      const path=join(directory,`${s.date}.json`), id=reportId(s.date);
      let job=await readJson(outbox.path(id),null);
      if (job?.status === 'sent') { s.status='sent'; s.outbox_id=id; await save(path,s); continue; }
      if (job && (!job.stage_d3 || job.health_sha256 !== s.health?.sha256 || job.weather_sha256 !== s.weather?.sha256)) {
        s.status='blocked_existing_outbox';s.reason='existing_daily_job_requires_review';stats.blocked++;await save(path,s);continue;
      }
      if (s.analysis_status === 'running') { s.analysis_status='uncertain';s.status='analysis_uncertain';s.reason='process_interrupted_no_auto_retry'; }
      if (['uncertain','failed'].includes(s.analysis_status)) { stats.blocked++;await save(path,s);continue; }
      const anchor=s.health?.captured_at ?? s.weather_candidates?.[0]?.weather.observed_at;
      if (!anchor || s.date !== localDayAt(anchor,instant.valueOf())) {
        s.reason='report_day_expired_manual_review';stats.waiting++;await save(path,s);continue;
      }
      if (!s.health) { s.status='waiting_health';s.reason='missing_valid_health';stats.waiting++;await save(path,s);continue; }
      if (s.analysis_status === 'not_started') {
        const candidate=matching(s.health,s.weather_candidates ?? []);
        if (candidate) s.weather=candidate;
      }
      if (!s.weather) {
        s.status='waiting_weather';s.reason=weatherResult.status==='weather_reader_unavailable'?'weather_reader_unavailable':'missing_same_day_weather_within_15_minutes';
        stats.waiting++;await save(path,s);continue;
      }
      delete s.reason;
      if (s.analysis_status === 'not_started') { s.status='ready';stats.ready++;await save(path,s); }
      // Separate switches prevent a queued report from bypassing human acceptance.
      if (!allowAnalysis) continue;
      if (s.analysis_status === 'not_started' && analyzer) {
        s.status='analyzing';s.analysis_status='running';s.analysis_started_at=instant.toISOString();
        await save(path,s); // Durable intent precedes the external call.
        try {
          s.analysis=validateMorningAnalysis(await analyzer.analyze({ factualReport:buildV33HealthReport(s.health.payload).text }));
          s.text=renderMorning41({date:s.date,payload:s.health.payload,weather:s.weather.weather,analysis:s.analysis});
          s.analysis_status='succeeded';s.status='analyzed';s.analysis_completed_at=now().toISOString();stats.analyzed++;
        } catch { s.analysis_status='failed';s.status='analysis_failed';s.reason='analysis_failed_no_auto_retry'; }
        await save(path,s);
      }
      if (s.analysis_status !== 'succeeded') continue;
      if (!job) {
        job=await outbox.enqueue({ exportId:s.health.export_id,report:{date:s.date,manual:false,text:s.text} });
        // A crash between enqueue and tagging is conservatively blocked on recovery.
        job.stage_d3=true;job.health_sha256=s.health.sha256;job.weather_sha256=s.weather.sha256;
        job.analysis_status='succeeded';await outbox.write(job);stats.queued++;
      }
      s.outbox_id=id;s.status=job.status;await save(path,s);
      if (allowSend && sender && ['queued','retry','sending'].includes(job.status)) {
        const result=await outbox.deliver(id,sender);s.status=result.status;
        if(result.status==='sent')stats.sent++;
        await save(path,s);
      }
    }
    await save(join(directory,'status.json'),{ checked_at:instant.toISOString(),mode:allowAnalysis?(allowSend?'delivery_authorized':'analysis_authorized'):'prepare',...stats });
    return stats;
  } finally { await unlink(lock).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
}
