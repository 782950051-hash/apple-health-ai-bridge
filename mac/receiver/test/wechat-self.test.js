import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, it } from 'node:test';
import { createSelfWeChatSender } from '../src/wechat-self.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(fetchFn) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-self-test-')); roots.push(root);
  const settings = { weixinConnectBaseUrl: 'https://ilinkai.weixin.qq.com', weixinConnectToken: 'synthetic-secret',
    weixinConnectAccountId: 'abc123@im.bot', weixinConnectAllowFrom: 'owner@im.wechat' };
  const settingsPath = join(root, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(settings));
  await writeFile(join(root, 'weixin-connect-state-abc123@im.bot.json'), JSON.stringify({ contextTokens: { 'owner@im.wechat': 'synthetic-context' } }));
  const sender = createSelfWeChatSender({ settingsPath, stateDirectory: root, accountId: settings.weixinConnectAccountId,
    recipientId: 'owner@im.wechat', fetchFn });
  return { sender, settings, settingsPath };
}

it('sends a summary only to the pinned self peer using existing credentials/context and a stable client ID', async () => {
  let request;
  const { sender } = await setup(async (url, options) => { request = { url, ...options }; return new Response('{"ret":0}'); });
  assert.deepEqual(await sender.send('健康摘要', { clientId: 'stable-report-id' }), { accepted: true, client_id: 'stable-report-id' });
  assert.equal(request.url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
  const body = JSON.parse(request.body);
  assert.equal(body.msg.to_user_id, 'owner@im.wechat');
  assert.equal(body.msg.client_id, 'stable-report-id');
  assert.equal(body.msg.context_token, 'synthetic-context');
  assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: '健康摘要' } }]);
  assert.equal(request.headers.Authorization, 'Bearer synthetic-secret');
  assert.equal('get_updates_buf' in body, false);
});

it('rejects a changed recipient/account, multiple peers, unapproved host, and raw JSON without a network call', async () => {
  let calls = 0;
  const { sender, settings, settingsPath } = await setup(async () => { calls++; return new Response('{"ret":0}'); });
  await assert.rejects(sender.send('{"sleep": []}', { clientId: 'id' }));
  for (const change of [ { weixinConnectAllowFrom: 'other@im.wechat' }, { weixinConnectAllowFrom: 'owner@im.wechat,other@im.wechat' },
    { weixinConnectBaseUrl: 'http://ilinkai.weixin.qq.com' }, { weixinConnectBaseUrl: 'https://example.com' },
    { weixinConnectAccountId: '../elsewhere' } ]) {
    await writeFile(settingsPath, JSON.stringify({ ...settings, ...change }));
    await assert.rejects(sender.send('健康摘要', { clientId: 'id' }));
  }
  assert.equal(calls, 0);
});

it('does not confuse HTTP 200 with business success; credential expiry is blocked and secrets stay out of errors', async () => {
  const { sender } = await setup(async () => new Response('{"ret":-14,"errmsg":"synthetic-secret synthetic-context"}'));
  await assert.rejects(sender.send('健康摘要', { clientId: 'id' }), e => e.blocked === true && !/synthetic/.test(e.message));
});

it('retains numeric rejection evidence and classifies an expired context without logging its contents', async () => {
  const { sender } = await setup(async () => new Response('{"ret":-2,"errcode":40001,"errmsg":"context token expired synthetic-context"}'));
  await assert.rejects(sender.send('健康摘要', { clientId: 'id' }), e => e.code === 'wechat_context_expired' &&
    e.api_ret === -2 && e.api_errcode === 40001 && !/synthetic/.test(e.message));
});

it('marks transport failure and malformed/missing acknowledgements as uncertain rather than safely retryable', async () => {
  for (const fetchFn of [ async () => { throw new Error('token must not leak'); },
    async () => new Response('bad'), async () => new Response('{}'), async () => new Response('failed', { status: 503 }) ]) {
    const { sender } = await setup(fetchFn);
    await assert.rejects(sender.send('健康摘要', { clientId: 'id' }), e => e.uncertain === true && !/token/.test(e.message));
  }
});

it('uses a privately refreshed test context only when it matches the pinned account and recipient', async () => {
  let context;
  const { settingsPath } = await setup(async () => new Response('{"ret":0}'));
  const contextPath = settingsPath + '.context';
  const sender = createSelfWeChatSender({ settingsPath, stateDirectory: dirname(settingsPath), accountId: 'abc123@im.bot', recipientId: 'owner@im.wechat', contextPath,
    fetchFn: async (_, options) => { context = JSON.parse(options.body).msg.context_token; return new Response('{"ret":0}'); } });
  await writeFile(contextPath, JSON.stringify({ account_id: 'abc123@im.bot', recipient_id: 'owner@im.wechat', context_token: 'fresh-test-context' }));
  await sender.send('健康摘要', { clientId: 'id' });
  assert.equal(context, 'fresh-test-context');
  await writeFile(contextPath, JSON.stringify({ account_id: 'abc123@im.bot', recipient_id: 'someone-else', context_token: 'wrong-context' }));
  await assert.rejects(sender.send('健康摘要', { clientId: 'id' }));
  await writeFile(contextPath, JSON.stringify({ account_id: 'abc123@im.bot', recipient_id: 'owner@im.wechat', context_token: 'fresh-test-context' }));
  const statePath = join(dirname(settingsPath), 'weixin-connect-state-abc123@im.bot.json');
  await writeFile(statePath, JSON.stringify({ contextTokens: { 'owner@im.wechat': 'newer-existing-bridge-context' } }));
  const future = new Date(Date.now() + 5000); await utimes(statePath, future, future);
  await sender.send('健康摘要', { clientId: 'id' });
  assert.equal(context, 'newer-existing-bridge-context');
});
