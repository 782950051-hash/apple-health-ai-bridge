import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const icloudAccessHelper = fileURLToPath(new URL('../../scripts/icloud_file_access.py', import.meta.url));
export const icloudPython = process.env.PYTHON_BIN ?? 'python3';
const execFile = promisify(nodeExecFile);

/** Only child stdout contains file bytes. Errors expose fixed diagnostic codes. */
export async function readICloudFile(path, { timeoutMs = 15000, python = icloudPython,
    helper = icloudAccessHelper } = {}) {
  try {
    const { stdout } = await execFile(python, [helper, '--read', path], {
      timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 + 1024, encoding: 'buffer',
    });
    return stdout;
  } catch (failure) {
    let code = failure.killed ? 'ETIMEDOUT' : 'EIO';
    try {
      const diagnostic = JSON.parse(failure.stderr?.toString());
      if (/^E[A-Z0-9_]{1,30}$/.test(diagnostic.code)) code = diagnostic.code;
    } catch { /* Never propagate child stdout/stderr, including private bytes. */ }
    throw Object.assign(new Error('icloud_read_failed'), { code });
  }
}

/** Do not use raw Error.message: JSON parser messages can quote health data. */
export function importDiagnostic(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,40}$/.test(error.code)
    ? error.code : 'UNKNOWN_ERROR';
  const messages = {
    EDEADLK: 'FileProvider content not materialized; retry pending',
    ETIMEDOUT: 'Bounded iCloud read timed out; retry pending',
    EACCES: 'File access denied; check permissions; automatic recheck pending',
    EPERM: 'File access denied; check permissions; automatic recheck pending',
    ENOENT: 'File or directory not present; automatic recheck pending',
    EAGAIN: 'File changed or temporarily unavailable; retry pending',
    INVALID_JSON: 'Incomplete or invalid JSON; unchanged content receives bounded validation retries',
    INVALID_V33: 'Health payload failed schema validation',
    INVALID_LEDGER: 'Deduplication ledger invalid; fail closed without resetting it',
    INVALID_RETRY_STATE: 'Retry state invalid; fail closed without resetting it',
    EFBIG: 'Input exceeds the 32 MiB safety limit',
    EIO: 'File I/O failed; automatic retry pending',
  };
  return { code, error_type: ['TypeError', 'SyntaxError', 'Error'].includes(error?.name) ? error.name : 'Error',
    message: messages[code] ?? 'File operation failed; see operation and code; automatic recheck pending' };
}
