import assert from 'node:assert/strict';
import { it } from 'node:test';
import { metricCoverage } from '../src/metric-coverage.js';

const metric = (type = '心率') => ({ types_text: type, values_text: '63', units_text: 'count/min',
  starts_text: '2026-10-25T08:00:00+08:00', ends_text: '2026-10-25T08:00:01+08:00', sources_text: 'Apple Watch' });
const status = (data, name = 'heart_rate') => metricCoverage(data).find(item => item.id === name);

it('verifies actual returned sample type rather than trusting the query label or client metric name', () => {
  assert.equal(status({ heart_rate: metric() }).status, 'valid');
  assert.equal(status({ heart_rate: metric('步数') }).status, 'type_mismatch');
  assert.equal(status({ heart_rate: metric('HKQuantityTypeIdentifierHeartRate') }).status, 'valid');
});

it('keeps empty, uncollected and missing type evidence distinct and never calls them zero-valued results', () => {
  assert.equal(status({}).status, 'uncollected');
  assert.equal(status({ heart_rate: { types_text: '', values_text: '', units_text: '', starts_text: '', ends_text: '', sources_text: '' } }).status, 'empty');
  const data = metric(); delete data.types_text;
  assert.equal(status({ heart_rate: data }).status, 'unverified_type');
  assert.equal('value' in status({}), false);
});

it('rejects unequal columns, invalid dates, nonnumeric values and future sample endings for the capture', () => {
  for (const change of [{ ends_text: '' }, { starts_text: '2026-02-30T08:00:00+08:00' },
    { values_text: 'NaN' }, { starts_text: '2026-10-25T08:01:00+08:00' }]) {
    assert.equal(status({ heart_rate: { ...metric(), ...change } }).status, 'invalid_columns');
  }
  assert.equal(metricCoverage({ heart_rate: metric() }, '2026-10-25T07:59:00+08:00').find(item => item.id === 'heart_rate').status, 'invalid_columns');
});

it('allows legitimately missing per-sample sources and preserves original units without conversion', () => {
  const result = status({ heart_rate: { ...metric(), sources_text: '' } });
  assert.equal(result.status, 'valid'); assert.equal(result.sources_available, false);
  assert.deepEqual(result.units, ['count/min']);
});
