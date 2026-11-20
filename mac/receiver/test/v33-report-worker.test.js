import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { buildV33HealthReport } from '../src/health-report.js';
import { runV33HealthReportCycle } from '../src/v33-report-worker.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/apple-health-v33.json', import.meta.url), 'utf8'));

it('builds a factual v3.3 report and calls Hermes once per report date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v33-report-')); const data = join(root, 'data');
  try {
    await mkdir(join(data, 'v33-health'), { recursive: true });
    await writeFile(join(data, 'v33-health', '2026-11-01.json'), JSON.stringify({ schema: 'apple-health-v3.3', report_date: '2026-11-01', export_id: 'a'.repeat(64), payload: fixture }));
    const factual = buildV33HealthReport(fixture, { includeWeather: false });
    assert.match(factual.text, /睡眠心率：睡眠时段中位数67/); assert.doesNotMatch(factual.text, /天气/);
    let analyzed = 0; let sent = 0;
    const analyzer = { analyze: async ({ factualReport }) => { analyzed++; assert.match(factualReport, /核心/); return { analysis: 'Hermes版睡眠分析内容。'.repeat(10), suggestions: ['保持规律作息。', '醒后记录精神状态。'] }; } };
    const sender = { revision: async () => 'rev-1', send: async text => { sent++; assert.match(text, /Hermes版/); assert.doesNotMatch(text, /今日天气/); return { accepted: true }; } };
    const now = () => new Date('2026-11-01T08:30:00+08:00');
    const first = await runV33HealthReportCycle({ root, dataDir: data, analyzer, sender, now });
    assert.equal(first.analyzed, 1); assert.equal(first.sent, 1); assert.equal(analyzed, 1); assert.equal(sent, 1);
    const second = await runV33HealthReportCycle({ root, dataDir: data, analyzer, sender, now });
    assert.equal(second.analyzed, 0); assert.equal(analyzed, 1); assert.equal(sent, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
