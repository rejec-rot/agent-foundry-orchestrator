// Local authorization is held in an HttpOnly cookie. Only the optional advanced
// bearer login reads the legacy session token; local authorization never exposes it.
export function createAccess() {
  let legacyToken = '';
  try { legacyToken = sessionStorage.getItem('af-write-token') ?? ''; } catch {}
  let revision = 0, refreshing = null;
  const listeners = new Set();
  const state = { known: false, authorized: false, available: false, reason: '', pending: false, action: '', error: '' };
  const emit = () => { for (const listener of listeners) listener(state); };
  const headers = () => legacyToken ? { authorization: 'Bearer ' + legacyToken } : {};
  const forgetLegacy = () => {
    legacyToken = '';
    try { sessionStorage.removeItem('af-write-token'); } catch {}
  };

  async function read(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      const model = payload?.model ?? payload;
      if (!response.ok) throw new Error(model?.reason ?? model?.error ?? ('HTTP ' + response.status));
      if (!model || typeof model !== 'object') throw new Error('授权状态格式无效。');
      return model;
    } finally { clearTimeout(timer); }
  }
  function applyStatus(model) {
    if(typeof model.authorized!=='boolean'||typeof model.local_authorization_available!=='boolean')throw new Error('授权状态格式无效。');
    state.known = true;
    state.authorized = model.authorized === true;
    state.available = model.local_authorization_available === true || model.local_authorization?.available === true;
    const reason = model.local_authorization_reason ?? model.local_authorization?.reason ?? model.reason ?? '';
    state.reason = model.reason_code === 'write_routes_disabled' || /restart.*--allow-write|started read-only|writes.disabled/i.test(reason) ? '当前服务仅允许查看，尚未开启操作权限。' :
      model.reason_code === 'server_credentials_missing' || /no write token|no token.*configured/i.test(reason) ? '当前服务未配置操作权限，本机授权暂不可用。' :
      model.reason_code === 'local_connection_required' || /only available from localhost|only available from loopback|only valid from loopback/i.test(reason) ? '本机授权仅支持从 localhost、127.0.0.1 或 ::1 访问本服务。远程访问可使用高级连接。' : reason;
    emit();
  }
  async function refresh() {
    if (state.pending) return;
    if (refreshing) return refreshing;
    const expected = revision;
    refreshing = (async () => {
      try {
        const model = await read('/api/v2/access/status', { headers: headers() });
        if (revision === expected) { state.error = ''; applyStatus(model); }
      } catch (error) {
        if (revision === expected) {
          state.known = false; state.authorized = false; state.available = false;
          state.error = error.name === 'AbortError' ? '授权状态读取超时，请重试。' : '无法确认操作权限：' + error.message;
          emit();
        }
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function change(action, suppliedToken) {
    if (state.pending) return false;
    const legacyLogout = action === 'revoke' && Boolean(legacyToken) && !state.available;
    state.pending = true; state.action = action; state.error = ''; revision++; emit();
    if (action === 'revoke') forgetLegacy();
    try {
      if (action === 'legacy') {
        const candidate = String(suppliedToken ?? '').trim();
        if (!candidate) throw new Error('填写操作令牌后再连接。');
        const model = await read('/api/v2/access/status', { credentials: 'omit', headers: { authorization: 'Bearer ' + candidate } });
        if (model.authorized !== true) throw new Error('操作令牌无效，请检查后重试。');
        legacyToken = candidate;
        try { sessionStorage.setItem('af-write-token', legacyToken); } catch {}
        applyStatus(model);
      } else {
        if (action === 'authorize' && !state.available) throw new Error(state.reason || '当前连接无法使用本机授权。');
        if (!legacyLogout) await read('/api/v2/access/' + action, { method: 'POST', headers: { 'content-type': 'application/json', 'x-af-csrf': '1', ...headers() }, body: '{}' });
        forgetLegacy();
        state.authorized = false;
        // Verify the server state after the cookie has been set or cleared.
        applyStatus(await read('/api/v2/access/status', legacyLogout ? { credentials: 'omit' } : {}));
        if (action === 'authorize' && !state.authorized) throw new Error('授权未生效，请重试。');
      }
      return true;
    } catch (error) {
      state.error = (error.name === 'AbortError' ? '授权请求超时，请重试。' : error.message) + ' 已保留当前草稿。';
      // A failed/revoked or unverified session must never leave write controls enabled.
      if (action !== 'legacy') { state.authorized = false; state.known = false; }
      throw new Error(state.error);
    } finally { state.pending = false; state.action = ''; emit(); }
  }
  return {
    state, headers, refresh,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    authorize: () => change('authorize'), revoke: () => change('revoke'),
    connectLegacy: candidate => change('legacy', candidate),
    invalidate() { revision++; state.authorized = false; state.known = false; emit(); void refresh(); },
  };
}

export function renderAccess(access, { writeAvailable = false, busy = false } = {}) {
  const state = access.state;
  const get = id => document.getElementById(id);
  const locked = state.pending || busy;
  const label = state.pending ? (state.action === 'revoke' ? '正在取消授权…' : state.action === 'legacy' ? '正在连接…' : '正在授权…') :
    !state.known ? (state.error ? '重试权限检查' : '正在确认权限') :
    state.authorized ? '取消授权' : !writeAvailable ? '只读模式' : state.available ? '一键授权' : '高级连接';
  const reason = state.error || (!state.known ? '正在确认操作权限…' : state.authorized ?
    '此浏览器已获操作权限。取消授权后，所有页面会恢复只读，当前草稿继续保留。' :
    state.available ? '点击一键授权，即可在此浏览器启动团队、发送消息和管理任务。' :
    state.reason || '当前连接无法使用本机授权。');
  const primary = get('authorize-access');
  if (primary) {
    primary.disabled = locked || (!state.known && !state.error) || (state.known && !state.authorized && !writeAvailable);
    primary.title = reason;
    primary.dataset.authorized = String(state.authorized);
    primary.setAttribute('aria-busy', String(state.pending));
  }
  if (get('access-label')) get('access-label').textContent = label;
  if (get('access-status')) get('access-status').textContent = !state.known ? '权限尚未确认' : state.authorized ? '已授权' : !writeAvailable ? '只读模式' : '尚未授权';
  if (get('access-description')) get('access-description').textContent = reason;
  const panel = get('access-panel-action');
  if (panel) {
    panel.hidden = state.known && !state.authorized && !state.available;
    panel.disabled = locked || (!state.known && !state.error) || (state.known && !state.authorized && !writeAvailable);
    panel.textContent = label + ' ↗';
    panel.setAttribute('aria-busy', String(state.pending));
  }
  const feedback = get('access-feedback');
  if (feedback) { feedback.hidden = !state.error; feedback.textContent = state.error; }
  const advanced = get('access-advanced');
  if (advanced) advanced.hidden = state.known && !writeAvailable && !state.authorized;
  if (get('save-token')) get('save-token').disabled = locked;
  if (get('token-save')) get('token-save').disabled = locked;
}
