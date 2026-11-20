import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMorning41 } from '../src/weather-barrier.js';

// Only test fixtures: never import these simulated values into production.
function input() {
  const sample = (stage, start, end) => ({ stage, start_date: start, end_date: end });
  const metric = (value, unit) => ({ samples: [{ value, unit,
    start_date: '2026-11-02T04:00:00+08:00', end_date: '2026-11-02T04:00:00+08:00' }] });
  return { date: '2026-11-02', payload: {
    exporter_version: '3.3.0', captured_at: '2026-11-02T08:30:00+08:00',
    event_received_at: '2026-11-02T08:30:00+08:00', trigger: 'manual_test',
    collection_status: 'complete', collection_status_reason: 'isolated fixture',
    sleep: { samples: [
      sample('core', '2026-11-01T23:15:00+08:00', '2026-11-02T01:15:00+08:00'),
      sample('deep', '2026-11-02T01:15:00+08:00', '2026-11-02T02:45:00+08:00'),
      sample('awake', '2026-11-02T02:45:00+08:00', '2026-11-02T03:00:00+08:00'),
      sample('core', '2026-11-02T03:00:00+08:00', '2026-11-02T05:30:00+08:00'),
      sample('rem', '2026-11-02T05:30:00+08:00', '2026-11-02T07:00:00+08:00'),
    ] }, metrics: { heart_rate: metric(58, 'count/min'), resting_heart_rate: metric(54, 'count/min'),
      heart_rate_variability: metric(42, 'ms'), oxygen_saturation: metric(97, '%') },
  }, weather: { forecast_date: '2026-11-02', location_name: '浙江 · 台州',
    temperature_max_c: 22.19, temperature_min_c: 16.57, condition: '微雨' }, analysis: {
    analysis: '昨夜睡了7小时30分，中间清醒15分钟，可以先结合今早的精神状态安排节奏。深度睡眠和快速动眼睡眠各1小时30分。睡眠心率58次/分、HRV 42毫秒、血氧97%，这些单晚数值还不足以单独判断恢复好坏。如果起床后感觉清醒，就按平常节奏活动；若仍有困倦，今天适当放缓，今晚继续规律休息。',
    suggestions: ['上午安排20分钟轻松散步，以舒适、不勉强为准。', '今晚尽量固定时间上床，睡前30分钟放下手机。'],
  } };
}

test('production layout equals the phone-accepted message with only the test prefix removed', () => {
  assert.equal(renderMorning41(input()), `私人 AI 健康管家
2026年11月2日 星期一

────────────

🌙 昨夜睡眠

总睡眠：7小时30分钟
入睡：昨晚 23:15
醒来：今早 07:00

核心睡眠：4小时30分钟
深度睡眠：1小时30分钟
REM 快速动眼睡眠：1小时30分钟
清醒时间：15分钟

────────────

❤️ 身体状态

睡眠期间心率：58次/分
HRV（SDNN）：42毫秒
血氧：97%
静息心率：54次/分

────────────

🌤 今日天气

📍 浙江 · 台州
🌡 最高温：22℃
❄️ 最低温：17℃
🌧 天气：微雨

────────────

🧠 Hermes 健康分析

${input().analysis.analysis}

────────────

💡 今日建议

1. 上午安排20分钟轻松散步，以舒适、不勉强为准。

2. 今晚尽量固定时间上床，睡前30分钟放下手机。

────────────

Apple Watch × Hermes
健康信息仅供参考，不作为医疗诊断。`);
});

test('date, factual values, weather, analysis and suggestions remain dynamic', () => {
  const value = input();
  value.date = value.weather.forecast_date = '2026-11-03';
  value.weather.location_name = '另一城市'; value.weather.temperature_max_c = 13.8;
  value.weather.condition = '晴';
  value.payload.metrics.heart_rate.samples[0].value = 63;
  value.analysis.analysis = '这是另一份当天数据对应的分析，内容须由实际模型结果提供，不能复用排版样例。'.repeat(3);
  value.analysis.suggestions = ['今天的动态建议一。', '今天的动态建议二。'];
  const result = renderMorning41(value);
  assert.match(result, /2026年11月3日 星期二/);
  assert.match(result, /睡眠期间心率：63次\/分/);
  assert.match(result, /📍 另一城市\n🌡 最高温：14℃/);
  assert.ok(result.includes(value.analysis.analysis));
  assert.ok(result.includes('1. 今天的动态建议一。\n\n2. 今天的动态建议二。'));
  assert.doesNotMatch(result, /排版测试|模拟数据|浙江 · 台州|昨夜睡了7小时30分/);
  assert.match(result, /醒来：2026-11-02 07:00/);
});

test('missing metrics are not invented and absent resting heart rate is omitted', () => {
  const value = input(); value.payload.metrics = {}; value.payload.sleep.samples = [];
  const result = renderMorning41(value);
  assert.match(result, /总睡眠：暂不可用/);
  assert.match(result, /HRV（SDNN）：暂不可用/);
  assert.doesNotMatch(result, /静息心率：|总睡眠：0|核心睡眠：0/);
});
