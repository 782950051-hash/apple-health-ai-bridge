/**
 * The versioned payload shape emitted by the iPhone Shortcut. Runtime
 * validation is added in the ingestion task; these typedefs document the
 * contract for the dependency-free scaffold.
 *
 * @typedef {object} HealthMetric
 * @property {string} type
 * @property {number} value
 * @property {string} unit
 * @property {string} start
 * @property {string} end
 * @property {string} source
 *
 * @typedef {object} SleepRecord
 * @property {string} stage
 * @property {string} start
 * @property {string} end
 * @property {string} source
 *
 * @typedef {object} WorkoutRecord
 * @property {string} start
 * @property {string} end
 * @property {string} type
 * @property {string} source
 *
 * @typedef {object} HealthPayload
 * @property {1} schema_version
 * @property {string} date
 * @property {string} timezone
 * @property {string} collected_at
 * @property {'complete'|'partial'|'no_data'} collection_status
 * @property {string[]} missing
 * @property {HealthMetric[]} metrics
 * @property {SleepRecord[]} sleep
 * @property {WorkoutRecord[]} workouts
 */

export const HEALTH_PAYLOAD_SCHEMA_VERSION = 1;
