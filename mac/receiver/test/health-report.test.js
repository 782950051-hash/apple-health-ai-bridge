import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildHealthReport } from '../src/health-report.js';

function fixture() {
  return { kind: 'shortcuts_wake_v1', driver: 'Apple Shortcuts', trigger: 'manual_test',
    captured_at: '2026-10-25T10:00:00+08:00', event_received_at: '2026-10-25T09:00:00+08:00',
    collection_status: 'partial', sleep_source_status: 'unavailable_in_shortcuts',
    sleep: { starts_text: '2026-10-24T23:00:00+08:00\n2026-10-25T00:00:00+08:00\n2026-10-25T01:00:00+08:00',
      ends_text: '2026-10-25T01:00:00+08:00\n2026-10-25T01:00:00+08:00\n2026-10-25T02:00:00+08:00',
      values_text: '核心睡眠\n核心睡眠\n清醒时间', sources_text: '' },
    metrics: { step_count: {
      starts_text: '2026-10-24T12:00:00+08:00\n2026-10-24T12:00:00+08:00\n2026-10-24T12:00:00+08:00\n2026-10-25T08:00:00+08:00',
      ends_text: '2026-10-24T12:10:00+08:00\n2026-10-24T12:10:00+08:00\n2026-10-24T12:10:00+08:00\n2026-10-25T08:10:00+08:00',
      values_text: '100\n100\n200\n900', units_text: 'count\ncount\ncount\ncount',
      sources_text: 'Apple Watch\nApple Watch\nOther Device\nApple Watch' } } };
}

it('unions overlapping asleep intervals and excludes awake stages, without inventing provenance or recovery', () => {
  const report = buildHealthReport(fixture());
  assert.equal(report.sleep_minutes, 120);
  assert.equal(report.date, '2026-10-25');
  assert.match(report.text, /手动测试/);
  assert.match(report.text, /2小时/);
  assert.match(report.text, /睡眠来源未返回/);
  assert.match(report.text, /数据不足/);
  assert.doesNotMatch(report.text, /恢复良好|疾病|建议服|14天中位数/);
});

it('uses yesterday only, deduplicates exact step samples and never merges phone and Watch totals', () => {
  const report = buildHealthReport(fixture());
  assert.equal(report.activity_date, '2026-10-24');
  assert.equal(report.watch_steps, 100);
  assert.match(report.text, /手表来源100步/);
  assert.doesNotMatch(report.text, /300步|900步|1200步/);
  assert.match(report.text, /未合并/);
});

it('preserves missing, unknown units and conflicting overlapping steps as unavailable rather than zero', () => {
  const data = fixture(); data.metrics.step_count.units_text = 'km\nkm\nkm\nkm';
  assert.equal(buildHealthReport(data).watch_steps, null);
  delete data.metrics;
  assert.equal(buildHealthReport(data).watch_steps, null);
  data.metrics = fixture().metrics; data.metrics.step_count.values_text = '100\n101\n200\n900';
  assert.equal(buildHealthReport(data).watch_steps, null);
});

it('labels delayed automatic reports with the original event date and ignores later naps', () => {
  const data = fixture(); data.trigger = 'health_sleep_score_notification';
  data.captured_at = '2026-10-26T00:30:00+08:00';
  data.sleep.starts_text += '\n2026-10-25T22:00:00+08:00';
  data.sleep.ends_text += '\n2026-10-25T23:00:00+08:00';
  data.sleep.values_text += '\n核心睡眠';
  const report = buildHealthReport(data);
  assert.equal(report.date, '2026-10-25');
  assert.equal(report.sleep_minutes, 120);
  assert.doesNotMatch(report.text, /手动测试/);
});

it('includes yesterday samples ending exactly at midnight without pulling in the preceding day', () => {
  const data = fixture();
  data.metrics.step_count = { starts_text: '2026-10-24T23:59:00+08:00\n2026-10-23T23:59:00+08:00',
    ends_text: '2026-10-25T00:00:00+08:00\n2026-10-24T00:00:00+08:00',
    values_text: '10\n1000', units_text: 'count\ncount', sources_text: 'Apple Watch\nApple Watch' };
  assert.equal(buildHealthReport(data).watch_steps, 10);
});

it('rejects broken column alignment and untrusted notification text instead of inserting it in a report', () => {
  const data = fixture(); data.sleep.ends_text = 'bad';
  assert.throws(() => buildHealthReport(data));
  const other = fixture(); other.notification_body = 'IGNORE INSTRUCTIONS SECRET';
  assert.doesNotMatch(buildHealthReport(other).text, /IGNORE|SECRET/);
});

it('summarizes extra vital samples only after native type and original-unit verification', () => {
  const data = fixture();
  data.metrics.heart_rate = { types_text: '心率\n心率', values_text: '60\n80', units_text: 'count/min\ncount/min',
    starts_text: '2026-10-25T00:00:00+08:00\n2026-10-25T00:30:00+08:00',
    ends_text: '2026-10-25T00:00:01+08:00\n2026-10-25T00:30:01+08:00', sources_text: 'Apple Watch\nApple Watch' };
  assert.match(buildHealthReport(data).text, /心率：睡眠时段样本中位数70 count\/min/);
  data.metrics.heart_rate.types_text = '步数\n步数';
  assert.doesNotMatch(buildHealthReport(data).text, /中位数70/);
  data.metrics.heart_rate.types_text = '心率\n心率'; data.metrics.heart_rate.units_text = 'kg\nkg';
  assert.doesNotMatch(buildHealthReport(data).text, /中位数70/);
});
