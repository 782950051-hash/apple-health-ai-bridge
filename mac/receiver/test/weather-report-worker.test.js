import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { runWeatherReportCycle } from '../src/weather-report-worker.js';
import { runV33HealthReportCycle } from '../src/v33-report-worker.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'independent-reports-')); roots.push(root);
  const dataDir = join(root, 'data');
  await mkdir(join(dataDir, 'v33-health'), { recursive: true });
  await mkdir(join(dataDir, 'exports'), { recursive: true });
  return { root, dataDir };
}
const now = () => new Date('2026-11-01T09:00:00+08:00');
function weatherRecord(at = '2026-11-01T08:55:00+08:00') {
  const weather = { forecast_date: '2026-11-01', observed_at: at, location_name: '测试地区',
    condition: '小雨', temperature_max_c: 22, temperature_min_c: 16 };
  return { weather, sha256: 'a'.repeat(64) };
}
async function addHealth({ dataDir }, capturedAt = '2026-11-01T08:30:00+08:00') {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/apple-health-v33.json', import.meta.url), 'utf8'));
  fixture.captured_at = capturedAt;
  const bytes = Buffer.from(JSON.stringify(fixture));
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(dataDir, 'exports', `${id}.json`), bytes);
  await writeFile(join(dataDir, 'v33-health', '2026-11-01.json'), JSON.stringify({ schema: 'apple-health-v3.3',
    report_date: '2026-11-01', timezone: 'Asia/Shanghai', export_id: id, payload: fixture }));
}

it('sends weather without health and keeps daily weather idempotent', async () => {
  const s = await setup(); let calls = 0;
  const options = { root: s.root, now, readWeather: async () => ({ records: [weatherRecord()] }),
    sender: { send: async text => { calls++; assert.match(text, /今日天气/); return { accepted: true }; } } };
  assert.equal((await runWeatherReportCycle(options)).sent, 1);
  await runWeatherReportCycle(options);
  assert.equal(calls, 1);
});

it('queues one current fixed-name weather report and ignores old timestamp snapshots', async () => {
  const s = await setup(); let sends = 0;
  const current = weatherRecord('2026-11-01T08:55:00+08:00');
  current.weather = { ...current.weather, forecast_date: '2026-11-01' };
  const oldSameDay = { ...weatherRecord('2026-11-01T00:02:00+08:00'), sha256: 'b'.repeat(64) };
  const previousDay = { ...weatherRecord('2026-10-31T08:55:00+08:00'), sha256: 'c'.repeat(64),
    weather: { ...weatherRecord('2026-10-31T08:55:00+08:00').weather, forecast_date: '2026-10-31' } };
  const options = { root: s.root, now, readWeather: async () => ({ records: [current, oldSameDay, previousDay] }),
    sender: { send: async () => { sends++; return { accepted: true }; } } };
  const first = await runWeatherReportCycle(options);
  const second = await runWeatherReportCycle(options);
  const jobs = await new (await import('../src/report-outbox.js')).ReportOutbox(s.root).list();
  assert.equal(first.queued, 1);
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.equal(sends, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].channel, 'weather');
  assert.match(jobs[0].text, /今日天气 2026-11-01/);
});

it('renders available current, feels-like, daily precipitation data and dynamic advice', async () => {
  const s = await setup();
  const weather = { ...weatherRecord().weather, temperature_current_c: 21.2,
    temperature_feels_like_c: 8.6, precipitation_probability_pct: 75 };
  const options = { root: s.root, now, readWeather: async () => ({ records: [{ weather, sha256: 'd'.repeat(64) }] }),
    sender: { send: async () => ({ accepted: true }) } };
  await runWeatherReportCycle(options);
  const jobs = await new (await import('../src/report-outbox.js')).ReportOutbox(s.root).list();
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].text, /当前温度：21℃/);
  assert.match(jobs[0].text, /体感温度：9℃/);
  assert.match(jobs[0].text, /今日降水概率：75%/);
  assert.match(jobs[0].text, /体感较凉/);
  assert.match(jobs[0].text, /出门建议带伞/);
});

it('keeps old JSON compatible and omits unavailable optional values', async () => {
  const s = await setup();
  const weather = { ...weatherRecord().weather, temperature_current_c: null,
    temperature_feels_like_c: null, precipitation_probability_pct: null };
  const options = { root: s.root, now, readWeather: async () => ({ records: [{ weather, sha256: 'e'.repeat(64) }] }),
    sender: { send: async () => ({ accepted: true }) } };
  await runWeatherReportCycle(options);
  const jobs = await new (await import('../src/report-outbox.js')).ReportOutbox(s.root).list();
  assert.equal(jobs.length, 1);
  assert.doesNotMatch(jobs[0].text, /当前温度|体感温度|今日降水概率|undefined|null/);
  assert.match(jobs[0].text, /建议带伞|暂不必特意带伞|无降水概率/);
});

it('does not read or send weather before 05:00 Beijing time', async () => {
  const s = await setup(); let reads = 0; let sends = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runWeatherReportCycle({ root: s.root, now: () => new Date('2026-11-05T04:59:00+08:00'),
      readWeather: async () => { reads++; return { records: [weatherRecord('2026-11-05T04:58:00+08:00')] }; },
      sender: { send: async () => { sends++; return { accepted: true }; } } });
    assert.equal(result.too_early, 1);
  }
  assert.equal(reads, 0);
  assert.equal(sends, 0);
});

it('allows a fresh 05:00 report, rejects pre-05:00 backlog, and preserves the next day slot', async () => {
  const s = await setup(); let sends = 0;
  const sender = { send: async () => { sends++; return { accepted: true }; } };
  const record = at => ({ ...weatherRecord(at), weather: { ...weatherRecord(at).weather, forecast_date: '2026-11-05' } });
  const options = { root: s.root, now: () => new Date('2026-11-05T05:00:00+08:00'), sender };
  const beforeCutoff = await runWeatherReportCycle({ ...options, readWeather: async () => ({ records: [record('2026-11-05T04:59:00+08:00')] }) });
  assert.equal(beforeCutoff.sent, 0);
  assert.equal(sends, 0);

  const atCutoff = await runWeatherReportCycle({ ...options, readWeather: async () => ({ records: [record('2026-11-05T05:00:00+08:00')] }) });
  assert.equal(atCutoff.sent, 1);
  const duplicate = await runWeatherReportCycle({ ...options, readWeather: async () => ({ records: [record('2026-11-05T05:00:00+08:00')] }) });
  assert.equal(duplicate.sent, 0);
  assert.equal(sends, 1);

  const nextDay = await runWeatherReportCycle({ root: s.root, now: () => new Date('2026-11-06T05:00:00+08:00'),
    readWeather: async () => ({ records: [{ ...record('2026-11-06T05:00:00+08:00'), weather: {
      ...record('2026-11-06T05:00:00+08:00').weather, forecast_date: '2026-11-06' } }] }), sender });
  assert.equal(nextDay.sent, 1);
  assert.equal(sends, 2);
});

it('sends weather at 09:00 and health at 11:00 without a rendezvous', async () => {
  const s = await setup(); let sends = 0;
  const sender = { send: async () => { sends++; return { accepted: true }; } };
  const weather = await runWeatherReportCycle({ root: s.root, now, readWeather: async () => ({ records: [weatherRecord()] }), sender });
  assert.equal(weather.sent, 1);
  await addHealth(s);
  const health = await runV33HealthReportCycle({ root: s.root, dataDir: s.dataDir, now: () => new Date('2026-11-01T11:00:00+08:00'),
    analyzer: { analyze: async () => ({ analysis: '独立健康分析内容。'.repeat(14), suggestions: ['建议一。', '建议二。'] }) }, sender });
  assert.equal(health.sent, 1);
  assert.equal(sends, 2);
});

it('rejects stale weather and suppresses dates already delivered by the legacy merge', async () => {
  const s = await setup(); let sends = 0;
  const options = { root: s.root, now, readWeather: async () => ({ records: [weatherRecord('2026-11-01T01:00:00+08:00')] }),
    sender: { send: async () => { sends++; return { accepted: true }; } } };
  assert.equal((await runWeatherReportCycle(options)).sent, 0);
  await mkdir(join(s.root, 'stage-d3'), { recursive: true });
  await writeFile(join(s.root, 'stage-d3', '2026-11-01.json'), JSON.stringify({ date: '2026-11-01', status: 'sent' }));
  options.readWeather = async () => ({ records: [weatherRecord()] });
  assert.equal((await runWeatherReportCycle(options)).legacy_suppressed, 1);
  assert.equal(sends, 0);
});

it('enforces 30-minute and 8-hour sleep-age boundaries without accepting old sleep', async () => {
  const s = await setup(); await addHealth(s, '2026-11-01T07:10:00+08:00'); let analyses = 0;
  const analyzer = { analyze: async () => { analyses++; return { analysis: '基于本次健康数据的分析内容。'.repeat(8), suggestions: ['建议一。', '建议二。'] }; } };
  const early = await runV33HealthReportCycle({ root: s.root, dataDir: s.dataDir,
    now: () => new Date('2026-11-01T07:11:00+08:00'), analyzer });
  assert.equal(early.sleep_not_ready, 1); assert.equal(analyses, 0);
  await addHealth(s, '2026-11-01T07:30:00+08:00');
  const boundary = await runV33HealthReportCycle({ root: s.root, dataDir: s.dataDir,
    now: () => new Date('2026-11-01T07:30:00+08:00'), analyzer });
  assert.equal(boundary.queued, 1); assert.equal(analyses, 1);
  await rm(join(s.root, 'report-outbox'), { recursive: true, force: true });
  await addHealth(s, '2026-11-01T15:01:00+08:00');
  const old = await runV33HealthReportCycle({ root: s.root, dataDir: s.dataDir,
    now: () => new Date('2026-11-01T15:01:00+08:00'), analyzer });
  assert.equal(old.sleep_not_ready, 1); assert.equal(analyses, 1);
});
