import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readICloudFile, importDiagnostic, icloudAccessHelper, icloudPython } from '../src/icloud-file.js';

async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'icloud-reader-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('native reader preserves bytes and explicitly permits process-local materialization', async t => {
  const root = await temp(t), source = join(root, 'health-isolated.json');
  await writeFile(source, '{"isolated":"测试"}');
  assert.deepEqual(await readICloudFile(source), await readFile(source));
  const { stdout } = await promisify(execFile)(icloudPython, [icloudAccessHelper, '--probe-policy']);
  if (process.platform === 'darwin') assert.equal(JSON.parse(stdout).materialization_policy & 3, 2);
});
test('bounded reader times out instead of wedging subsequent scans and never leaks child output', async t => {
  const root = await temp(t), helper = join(root, 'hung.py');
  await writeFile(helper, 'import time\nprint("PRIVATE_DATA_MUST_NOT_ESCAPE", flush=True)\ntime.sleep(30)\n');
  await assert.rejects(readICloudFile('unused', { helper, timeoutMs: 80 }), e => {
    assert.equal(e.code, 'ETIMEDOUT'); assert.doesNotMatch(e.message, /PRIVATE_DATA/); return true;
  });
});
test('missing files and symlinks return a safe concrete error without source paths', async t => {
  const root = await temp(t), missing = join(root, 'missing-secret.json');
  await assert.rejects(readICloudFile(missing), e => e.code === 'ENOENT' && !e.message.includes(root));
  const real = join(root, 'real.json'); await writeFile(real, '{}');
  const link = join(root, 'link.json'); await symlink(real, link);
  await assert.rejects(readICloudFile(link), e => e.code === 'ELOOP');
});
test('diagnostics do not copy exception messages or unknown unsafe error names', () => {
  const d = importDiagnostic(Object.assign(new Error('TOKEN=secret HEALTH=private'), { code: 'EDEADLK' }));
  assert.equal(d.code, 'EDEADLK'); assert.doesNotMatch(JSON.stringify(d), /TOKEN|HEALTH|secret|private/);
});
