import { HEALTH_PAYLOAD_SCHEMA_VERSION } from './types.js';

const COLLECTION_STATUSES = new Set(['complete', 'partial', 'no_data']);
const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * Error thrown when an uploaded health payload does not match its versioned
 * contract. `issues` contains paths that make malformed client payloads
 * actionable without echoing any health values.
 */
export class HealthPayloadValidationError extends TypeError {
  /** @param {string[]} issues */
  constructor(issues) {
    super(`Invalid health payload: ${issues.join('; ')}`);
    this.name = 'HealthPayloadValidationError';
    this.issues = issues;
  }
}

/** @param {unknown} value */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {number} year */
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** @param {string} value */
function isValidCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

/** @param {unknown} value */
function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match || !isValidCalendarDate(match[1])) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Validate and return a version 1 Apple Health Shortcut payload.
 *
 * Validation intentionally does not fill missing values. A metric with a
 * missing or non-numeric `value` is rejected so that an absent sample cannot
 * be confused with a real zero.
 *
 * @param {unknown} input
 * @returns {import('./types.js').HealthPayload}
 */
export function parseHealthPayload(input) {
  const issues = [];
  if (!isRecord(input)) {
    throw new HealthPayloadValidationError(['payload must be an object']);
  }

  if (input.schema_version !== HEALTH_PAYLOAD_SCHEMA_VERSION) {
    issues.push(`schema_version must be ${HEALTH_PAYLOAD_SCHEMA_VERSION}`);
  }

  if (typeof input.date !== 'string' || !isValidCalendarDate(input.date)) {
    issues.push('date must use YYYY-MM-DD');
  }

  if (typeof input.timezone !== 'string' || input.timezone.length === 0) {
    issues.push('timezone is required');
  }

  if (!isIsoTimestamp(input.collected_at)) {
    issues.push('collected_at must be an ISO timestamp');
  }

  if (typeof input.collection_status !== 'string' || !COLLECTION_STATUSES.has(input.collection_status)) {
    issues.push('collection_status must be complete, partial, or no_data');
  }

  if (!Array.isArray(input.missing)) {
    issues.push('missing must be an array');
  } else {
    input.missing.forEach((entry, index) => {
      if (typeof entry !== 'string') issues.push(`missing[${index}] must be a string`);
    });
  }

  if (!Array.isArray(input.metrics)) {
    issues.push('metrics must be an array');
  } else {
    input.metrics.forEach((record, index) => validateMetric(record, `metrics[${index}]`, issues));
  }

  if (!Array.isArray(input.sleep)) {
    issues.push('sleep must be an array');
  } else {
    input.sleep.forEach((record, index) => validateSleep(record, `sleep[${index}]`, issues));
  }

  if (!Array.isArray(input.workouts)) {
    issues.push('workouts must be an array');
  } else {
    input.workouts.forEach((record, index) => validateWorkout(record, `workouts[${index}]`, issues));
  }

  if (issues.length > 0) throw new HealthPayloadValidationError(issues);
  return /** @type {import('./types.js').HealthPayload} */ (input);
}

/** @param {unknown} record @param {string} path @param {string[]} issues */
function validateMetric(record, path, issues) {
  if (!isRecord(record)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireString(record.type, `${path}.type`, issues);
  requireFiniteNumber(record.value, `${path}.value`, issues);
  requireString(record.unit, `${path}.unit`, issues);
  requireTimestamp(record.start, `${path}.start`, issues);
  requireTimestamp(record.end, `${path}.end`, issues);
  requireString(record.source, `${path}.source`, issues);
}

/** @param {unknown} record @param {string} path @param {string[]} issues */
function validateSleep(record, path, issues) {
  if (!isRecord(record)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireString(record.stage, `${path}.stage`, issues);
  requireTimestamp(record.start, `${path}.start`, issues);
  requireTimestamp(record.end, `${path}.end`, issues);
  requireString(record.source, `${path}.source`, issues);
}

/** @param {unknown} record @param {string} path @param {string[]} issues */
function validateWorkout(record, path, issues) {
  if (!isRecord(record)) {
    issues.push(`${path} must be an object`);
    return;
  }
  requireTimestamp(record.start, `${path}.start`, issues);
  requireTimestamp(record.end, `${path}.end`, issues);
  requireString(record.type, `${path}.type`, issues);
  requireString(record.source, `${path}.source`, issues);
}

/** @param {unknown} value @param {string} path @param {string[]} issues */
function requireString(value, path, issues) {
  if (typeof value !== 'string' || value.length === 0) issues.push(`${path} is required`);
}

/** @param {unknown} value @param {string} path @param {string[]} issues */
function requireTimestamp(value, path, issues) {
  if (!isIsoTimestamp(value)) issues.push(`${path} must be an ISO timestamp`);
}

/** @param {unknown} value @param {string} path @param {string[]} issues */
function requireFiniteNumber(value, path, issues) {
  if (typeof value !== 'number' || !Number.isFinite(value)) issues.push(`${path} must be a finite number`);
}
