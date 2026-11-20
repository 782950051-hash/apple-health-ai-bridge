import { readFileSync } from 'node:fs';
import { instant } from './wake-upload.js';

const catalog = JSON.parse(readFileSync(new URL('./metric-catalog.json', import.meta.url), 'utf8'));

const lines = value => typeof value === 'string' && value ? value.split(/\r?\n/).map(row => row.trim()) : [];
const normalize = value => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/** Validate identity and alignment, without converting units or inventing values. */
export function metricCoverage(metrics, capturedAt) {
  return catalog.map(definition => {
    const base = { id: definition.id, label: definition.label_zh };
    const metric = metrics?.[definition.id];
    if (!metric) return { ...base, status: 'uncollected', samples: 0 };
    const values = lines(metric.values_text), starts = lines(metric.starts_text), ends = lines(metric.ends_text);
    const units = lines(metric.units_text), types = lines(metric.types_text), sources = lines(metric.sources_text);
    const columns = [values, starts, ends, units];
    if (columns.every(column => column.length === 0) && !types.length && !sources.length) return { ...base, status: 'empty', samples: 0 };
    const invalid = () => ({ ...base, status: 'invalid_columns', samples: values.length });
    if (!values.length || columns.some(column => column.length !== values.length) ||
        (sources.length && sources.length !== values.length) || types.length && types.length !== values.length) return invalid();
    try {
      const captured = capturedAt ? instant(capturedAt) : Infinity;
      for (let i = 0; i < values.length; i++) {
        const start = instant(starts[i]), end = instant(ends[i]);
        if (start > end || end > captured + 30000 || !/^[+-]?\d+(?:\.\d+)?$/.test(values[i]) ||
            !Number.isFinite(Number(values[i])) || !units[i]) return invalid();
      }
    } catch { return invalid(); }
    if (!types.length) return { ...base, status: 'unverified_type', samples: values.length };
    const expected = new Set([...definition.type_labels, definition.hk_identifier].map(normalize));
    if (types.some(type => !expected.has(normalize(type)))) return { ...base, status: 'type_mismatch', samples: values.length };
    return { ...base, status: 'valid', samples: values.length,
      sources_available: !!sources.length, units: [...new Set(units)] };
  });
}
