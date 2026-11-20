/**
 * @typedef {object} GatewayConfig
 * @property {number} port
 * @property {string} token
 * @property {string} dataDir
 */

/**
 * Read gateway settings from an environment-like object.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {GatewayConfig}
 */
export function loadConfig(env = process.env) {
  const port = Number(env.HEALTH_UPLOAD_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('HEALTH_UPLOAD_PORT must be a valid TCP port');
  }

  const token = env.HEALTH_UPLOAD_TOKEN ?? '';
  if (!token && env.NODE_ENV !== 'test') {
    throw new Error('HEALTH_UPLOAD_TOKEN is required outside test mode');
  }

  return {
    port,
    token,
    dataDir: env.HEALTH_DATA_DIR ?? './data/health',
  };
}
