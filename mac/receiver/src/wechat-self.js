import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export class WeChatDeliveryError extends Error {
  constructor(code, { uncertain = false, blocked = false, apiRet, apiErrcode } = {}) {
    super(code); this.code = code; this.uncertain = uncertain; this.blocked = blocked;
    if (typeof apiRet === 'number') this.api_ret = apiRet;
    if (typeof apiErrcode === 'number') this.api_errcode = apiErrcode;
  }
}
const fail = (code, options) => { throw new WeChatDeliveryError(code, options); };

/** No inbound poller and no caller-selectable recipient. Credentials stay in the existing store. */
export function createSelfWeChatSender({ settingsPath, stateDirectory, accountId, recipientId, contextPath, fetchFn = fetch }) {
  if (!/^[a-z0-9]+@im\.bot$/i.test(accountId ?? '') || typeof recipientId !== 'string' || !recipientId || /[\s,]/.test(recipientId)) {
    fail('self_configuration_required', { blocked: true });
  }
  async function configuration() {
    let settings, state;
    try {
      settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      state = JSON.parse(await readFile(join(stateDirectory, `weixin-connect-state-${accountId}.json`), 'utf8'));
    } catch { fail('self_configuration_unavailable', { blocked: true }); }
    const allowed = String(settings.weixinConnectAllowFrom ?? '').split(/[\s,]+/).filter(Boolean);
    if (allowed.length !== 1 || allowed[0] !== recipientId || settings.weixinConnectAccountId !== accountId) {
      fail('self_recipient_changed', { blocked: true });
    }
    let url;
    try { url = new URL(settings.weixinConnectBaseUrl); } catch { fail('unapproved_wechat_host', { blocked: true }); }
    if (url.origin !== 'https://ilinkai.weixin.qq.com' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) fail('unapproved_wechat_host', { blocked: true });
    const token = settings.weixinConnectToken;
    let context = state.contextTokens?.[recipientId];
    if (contextPath) {
      try {
        const refreshed = JSON.parse(await readFile(contextPath, 'utf8'));
        if (refreshed.account_id !== accountId || refreshed.recipient_id !== recipientId ||
            typeof refreshed.context_token !== 'string' || !refreshed.context_token) fail('self_context_mismatch', { blocked: true });
        const [originalTime, refreshedTime] = await Promise.all([
          stat(join(stateDirectory, `weixin-connect-state-${accountId}.json`)), stat(contextPath),
        ]);
        if (refreshedTime.mtimeMs >= originalTime.mtimeMs || !context) context = refreshed.context_token;
      } catch (error) {
        if (error instanceof WeChatDeliveryError) throw error;
        if (error.code !== 'ENOENT') fail('self_context_unavailable', { blocked: true });
      }
    }
    if (typeof token !== 'string' || !token || typeof context !== 'string' || !context) fail('wechat_context_required', { blocked: true });
    const headers = {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}`,
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(2 * 65536 + 4 * 256 + 8),
    };
    if (settings.weixinConnectRouteTag) headers.SKRouteTag = settings.weixinConnectRouteTag;
    return { url, headers, context, revision: createHash('sha256').update(token).update('\0').update(context).digest('hex') };
  }

  return {
    async revision() { return (await configuration()).revision; },
    async send(text, { clientId } = {}) {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000 || /^[\s]*[\[{]/.test(text) ||
          typeof clientId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(clientId)) fail('invalid_summary', { blocked: true });
      const { url, headers, context } = await configuration();
      let response;
      try {
        response = await fetchFn(new URL('/ilink/bot/sendmessage', url).href, {
          method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(20000),
          body: JSON.stringify({ msg: { client_id: clientId, from_user_id: '', to_user_id: recipientId,
            message_type: 2, message_state: 2, context_token: context,
            item_list: [{ type: 1, text_item: { text } }] },
          base_info: { channel_version: '2.4.8', bot_agent: 'AppleHealthReport/1.0.0' } }),
        });
      } catch { fail('delivery_uncertain', { uncertain: true }); }
      if (!response.ok) fail(response.status === 429 ? 'rate_limited' : 'delivery_uncertain', { uncertain: response.status !== 429 });
      let result;
      try { result = await response.json(); } catch { fail('delivery_uncertain', { uncertain: true }); }
      // Hermes' current iLink endpoint returns {message_id} on success;
      // older Codex-WeChat responses returned {ret: 0}. Accept both forms.
      if (result && (typeof result.message_id === 'string' || typeof result.message_id === 'number')) {
        return { accepted: true, client_id: clientId, message_id: result.message_id };
      }
      if (!result || typeof result.ret !== 'number') fail('delivery_uncertain', { uncertain: true });
      if (result.ret !== 0 || (result.errcode !== undefined && result.errcode !== 0)) {
        const code = result.ret === -14 || result.errcode === -14 ? 'wechat_session_expired' :
          /context|上下文/i.test(String(result.errmsg ?? '')) ? 'wechat_context_expired' : 'wechat_rejected';
        fail(code, { blocked: true, apiRet: result.ret, apiErrcode: result.errcode });
      }
      return { accepted: true, client_id: clientId,
        ...(typeof result.message_id === 'string' || typeof result.message_id === 'number' ? { message_id: result.message_id } : {}) };
    },
  };
}
