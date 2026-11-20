import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHermesAnalyzer } from '../src/hermes-analyzer.js';

it('uses the installed Hermes one-shot interface without logging credentials', async () => {
  let call;
  const analyzer = createHermesAnalyzer({ execFileFn: async (...args) => { call = args; return { stdout: '中文晨报' }; } });
  assert.equal(await analyzer.analyze({ factualReport: '事实报告' }), '中文晨报');
  assert.equal(call[0], 'hermes');
  assert.equal(call[1][0], '-z'); assert.match(call[1][1], /事实报告/);
});
