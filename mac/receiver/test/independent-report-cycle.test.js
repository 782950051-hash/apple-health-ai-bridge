import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runIndependentReportCycles } from '../src/independent-report-cycle.js';

it('runs weather and health concurrently and retains the healthy channel result when the other fails', async () => {
  const started = [];
  const result = await runIndependentReportCycles({
    weather: async () => { started.push('weather'); throw new Error('reader failure'); },
    health: async () => { started.push('health'); return { sent: 1 }; },
  });
  assert.deepEqual(started.sort(), ['health', 'weather']);
  assert.deepEqual(result, { weather: { unavailable: 1 }, health: { sent: 1 } });
});

it('retains weather success when health analysis fails', async () => {
  const result = await runIndependentReportCycles({
    weather: async () => ({ sent: 1 }),
    health: async () => { throw new Error('analyzer failure'); },
  });
  assert.deepEqual(result, { weather: { sent: 1 }, health: { unavailable: 1 } });
});
