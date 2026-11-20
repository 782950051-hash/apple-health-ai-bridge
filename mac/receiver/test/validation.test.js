import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthPayload } from '../src/validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures/complete-payload.json');
const validPayload = JSON.parse(readFileSync(fixturePath, 'utf8'));

describe('parseHealthPayload', () => {
  it('accepts the complete version 1 payload fixture', () => {
    const parsed = parseHealthPayload(validPayload);

    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.collection_status, 'complete');
    assert.equal(parsed.metrics[0].value, 4321);
  });

  it('rejects an unsupported schema version', () => {
    assert.throws(() => parseHealthPayload({ ...validPayload, schema_version: 2 }));
  });

  it('rejects a payload with no date or collection status', () => {
    const withoutDate = { ...validPayload };
    delete withoutDate.date;
    assert.throws(() => parseHealthPayload(withoutDate));

    const withoutStatus = { ...validPayload };
    delete withoutStatus.collection_status;
    assert.throws(() => parseHealthPayload(withoutStatus));
  });

  it('preserves partial collection and missing-field metadata', () => {
    const parsed = parseHealthPayload({
      ...validPayload,
      collection_status: 'partial',
      missing: ['sleep.rem'],
    });

    assert.equal(parsed.collection_status, 'partial');
    assert.deepEqual(parsed.missing, ['sleep.rem']);
  });

  it('requires the top-level arrays and timestamp fields', () => {
    for (const field of ['timezone', 'collected_at', 'missing', 'metrics', 'sleep', 'workouts']) {
      const payload = { ...validPayload };
      delete payload[field];
      assert.throws(() => parseHealthPayload(payload), `missing ${field} should be rejected`);
    }
  });

  it('validates the required fields of metric, sleep, and workout records', () => {
    const metric = { ...validPayload.metrics[0] };
    delete metric.value;
    assert.throws(() => parseHealthPayload({ ...validPayload, metrics: [metric] }));

    const sleep = { ...validPayload.sleep[0] };
    delete sleep.source;
    assert.throws(() => parseHealthPayload({ ...validPayload, sleep: [sleep] }));

    const workout = {
      start: '2026-10-20T09:00:00+08:00',
      end: '2026-10-20T09:30:00+08:00',
      type: 'running',
      source: 'Apple Watch',
    };
    assert.deepEqual(
      parseHealthPayload({ ...validPayload, workouts: [workout] }).workouts,
      [workout],
    );
  });

  it('rejects a missing metric value instead of treating it as zero', () => {
    const metric = { ...validPayload.metrics[0] };
    delete metric.value;
    assert.throws(() => parseHealthPayload({ ...validPayload, metrics: [metric] }));
    assert.throws(() => parseHealthPayload({
      ...validPayload,
      metrics: [{ ...validPayload.metrics[0], value: null }],
    }));
  });
});
