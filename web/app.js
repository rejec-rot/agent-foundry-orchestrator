import { createAccess, renderAccess } from './access.js';

// app.js - V2 delivery workbench. Zero dependencies, offline-capable.
//
// Read projections and authenticated commands keep server capabilities authoritative.
// A block that could not be read is rendered as UNVERIFIABLE/MISSING and never as
// "no data" - the UI must not claim emptiness it cannot prove.

const STAGES = [
  ['投影', 'PROJECTION'], ['编写', 'AUTHOR'], ['写者停止', 'QUIESCE'], ['捕获', 'CAPTURE'],
  ['评审', 'REVIEW'], ['授权', 'AUTHORIZATION'], ['验收', 'ACCEPTANCE'], ['提升', 'PROMOTION'],
];

const state = {
  tasks: [], selected: null, selectionVersion: 0, filter: '', capabilities: null, plan: null,
  pending: false,
};
const access = createAccess();

const $ = (id) => document.getElementById(id);
const submissionKey = () => 'delivery-' + (crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join(''));

/** One time format everywhere: `2026-09-24 02:45:29` (local). Raw ISO stays in the evidence well. */
function fmtTime(value) {
  const raw = String(value ?? '');
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.reason ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function authHeaders() {
  return { 'content-type': 'application/json', 'x-af-csrf': '1', ...access.headers() };
}

/** A write call. Failures are surfaced verbatim: the server's refusal is the useful message. */
async function postWrite(path, body = {}) {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: authHeaders(), body: JSON.stringify(body) });
  const payload = await res.json().catch(() => null);
  const model = payload?.model ?? payload;
  if (!res.ok) {
    if(res.status===401)access.invalidate();
    const err = new Error(model?.reason ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = model;
    throw err;
  }
  return model;
}

const STATUS_LABEL = { queued: '已排队', received: '已被 run 接收', applied: '已落实（有独立证据）' };
/** Counts as chips, because a number without its state word is a riddle. */
const m_count = (status, label, n) => `<span class="chip ${status}">${esc(label)} ${esc(n)}</span>`;

function renderCollab(model) {
  const host = $('collab');
  if (!host) return;
  if (!model || model.ok === false) { host.innerHTML = `<p class="hint">协作信息不可读${model?.reason ? `：${esc(model.reason)}` : ''}</p>`; return; }
  const rows = model.messages.length > 0
    ? model.messages.map((m) => `<li class="msg"><span class="chip ${esc(m.status)}">${esc(STATUS_LABEL[m.status] ?? m.status)}</span>
        <span class="msg-body">${esc(m.message)}</span>
        <span class="claim">${esc(fmtTime(m.created_at))}${m.received_by.length > 0 ? ` · run ${esc(m.received_by.map((r) => r.run_id).join(', '))}` : ''}</span>
        <span class="claim">${esc(m.claim)}</span></li>`).join('')
    : '<li class="msg"><span class="hint">还没有留言。留言会在下一次 run/resume 开始时被收集，不会打断正在运行的进程。</span></li>';
  const acts = model.activity.length > 0
    ? `<ul class="timeline-list">${model.activity.map((a) => `<li><b>${esc(a.executor ?? '?')}</b>${a.role ? `<span class="phase">${esc(a.role)}</span>` : ''}<span class="detail">${esc(a.status ?? '?')} · ${esc(a.run_id)}</span></li>`).join('')}</ul>`
    : '<p class="hint">没有运行记录。</p>';
  host.innerHTML = `<div class="tags">
      ${m_count('queued', '已排队', model.counts.queued)}
      ${m_count('received', '已被接收', model.counts.received)}
      ${m_count('applied', '已落实', model.counts.applied)}
    </div>
    <ul class="timeline-list">${rows}</ul>
    <p class="hint" style="margin-top:8px">当前/近期运行：</p>${acts}`;
}

function renderTimeline(model) {
  const host = $('timeline');
  if (!host) return;
  if (!model || model.ok === false) { host.innerHTML = `<p class="hint">时间线不可读${model?.reason ? `：${esc(model.reason)}` : ''}</p>`; return; }
  const gap = model.gap?.marked === true
    ? `<p class="gap">⚠ 事件与任务快照不一致（以任务文件为准）：${esc(model.gap.reason)}</p>` : '';
  const rows = model.events.length > 0
    ? model.events.slice().reverse().map((e) => `<li><time>${esc(fmtTime(e.at))}</time><b>${esc(e.type)}</b>${e.phase ? `<span class="phase">${esc(e.phase)}</span>` : ''}${e.detail ? `<span class="detail">${esc(JSON.stringify(e.detail).slice(0, 160))}</span>` : ''}</li>`).join('')
    : `<li class="hint">${model.missing ? '没有事件历史（该任务是历史任务或事件写入失败）' : '暂无事件'}</li>`;
  host.innerHTML = `${gap}<ul class="timeline-list">${rows}</ul><p class="hint">共 ${model.total} 条${model.has_more ? '（仅显示最新 20 条）' : ''}</p>`;
}

function refreshWriteControls() {
  const caps = state.capabilities?.write ?? {};
  const can = (name) => caps[name] === true && access.state.authorized && !state.pending && !access.state.pending;
  const reason = access.state.error || (!access.state.known ? '正在确认操作权限…' : !access.state.authorized ?
    (access.state.available ? '点击「一键授权」后可用。' : access.state.reason || '请连接操作权限。') : '服务端未启用此操作。');
  const create = $('s-create');
  const start = $('a-start');
  const cancel = $('a-cancel');
  const record = $('s-record');
  if (create) { create.disabled = !can('create_task'); create.title = can('create_task') ? '创建 V2 任务（幂等键相同则返回原任务）' : reason; }
  if (start) { start.disabled = !can('start_task') || !state.selected; start.title = can('start_task') ? '交给分离的 worker 执行；请求立刻返回' : reason; }
  if (cancel) { cancel.disabled = !can('cancel_task') || !state.selected; cancel.title = can('cancel_task') ? '持久化取消请求；在下一个受信边界生效，ref 更新后只记录为太迟' : reason; }
  if (record) { record.disabled = !can('record_task'); record.title = can('record_task') ? '保存交付草稿，不会启动任务。' : reason; }
  const note = $('detail-actions-note');
  const send = $('msg-send');
  if (send) send.disabled = !can('queue_message') || !state.selected;
  const msgNote = $('msg-note');
  if (msgNote) msgNote.textContent = caps.queue_message === true
    ? (access.state.authorized ? '排队不会打断正在运行的进程' : reason)
    : '服务端未启用写路由';
  if (note) {
    note.textContent = !state.capabilities ? '' : (!state.capabilities.write.create_task
      ? (state.capabilities.note ?? '写操作不可用')
      : (access.state.authorized ? '' : reason));
  }
  renderAccess(access, { writeAvailable: Object.values(caps).some(value => value === true), busy: state.pending });
  setModeBadge();
  const mode = $('mode-line');
  if (mode) mode.textContent = state.capabilities?.write?.create_task === true && access.state.authorized
    ? '操作权限已连接：可创建、启动和取消任务。'
    : reason;
}

async function runWrite(label, fn) {
  if(state.pending||access.state.pending)return;
  state.pending=true;refreshWriteControls();
  const out = $('submit-result');
  if (out) { out.hidden = false; out.className = 'evidence'; out.textContent = `正在${label}…`; }
  try {
    const model = await fn();
    if (out) out.textContent = typeof model === 'string' ? model : JSON.stringify(model, null, 2);
    return model;
  } catch (err) {
    if (out) { out.className = 'evidence bad'; out.textContent = `✖ ${label}失败：${err.message}`; }
    return null;
  } finally {state.pending=false;refreshWriteControls();}
}

function setConn(live, detail) {
  const el = $('conn');
  el.className = `conn ${live ? 'live' : 'dead'}`;
  const label = live ? '已连接' : `连接中断：${detail ?? '未知原因'}`;
  // The pip is part of the indicator, so it is rebuilt rather than wiped by textContent.
  el.innerHTML = `<span class="pip" aria-hidden="true"></span>${esc(label)}`;
}

function tag(text, cls = '') { return `<span class="tag ${cls}">${esc(text)}</span>`; }

const LOCK_GLYPH = '<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 11V8a5 5 0 0110 0v3" fill="none" stroke="currentColor" stroke-width="2.4" /><rect x="4.5" y="11" width="15" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="2.4" /></svg>';

function setModeBadge() {
  const el = $('mode-badge');
  if (!el) return;
  const writable = state.capabilities?.write?.create_task === true;
  const authorized = access.state.authorized;
  const text = !state.capabilities || !access.state.known ? '权限尚未确认' : !writable ? '只读' : (authorized ? '已授权 · 可写' : '尚未授权');
  el.className = `mode badge ${writable && authorized ? 'write' : 'readonly'}`;
  el.title = writable
    ? (authorized ? '操作权限已连接，可创建、启动和取消任务。' : '授权此浏览器后即可使用写操作。')
    : '当前服务未启用写操作。';
  el.innerHTML = `${LOCK_GLYPH}${esc(text)}`;
}

function renderTasks() {
  const q = state.filter.trim().toLowerCase();
  const rows = state.tasks.filter((t) => !q
    || String(t.task_id).toLowerCase().includes(q)
    || String(t.state ?? '').toLowerCase().includes(q)
    || String(t.bottom ?? '').toLowerCase().includes(q));

  if (state.tasks.length === 0) {
    $('tasks').innerHTML = '<p class="empty">当前数据根目录下没有任务记录。</p>';
    return;
  }
  if (rows.length === 0) {
    $('tasks').innerHTML = '<p class="empty">没有符合过滤条件的任务（这是过滤结果，不是"没有任务"）。</p>';
    return;
  }
  $('tasks').innerHTML = rows.map((t) => `
    <button class="row" role="listitem" data-id="${esc(t.task_id)}" aria-current="${state.selected === t.task_id}">
      <div class="id">${esc(t.task_id)}</div>
      ${t.goal ? `<div class="goal">${esc(t.goal)}</div>` : ''}
      <div class="tags">
        ${tag(t.state ?? 'unknown', `state-${esc(t.state ?? '')}`)}
        ${t.phase ? tag(t.phase) : ''}
        ${t.boundary_state ? tag(`边界 ${t.boundary_state}`) : ''}
        ${t.needs_human ? tag('需人工', 'state-WAITING_HUMAN') : ''}
        ${t.lock_stale ? tag('锁疑似陈旧') : ''}
        ${t.read_status && t.read_status !== 'ok' ? tag(`读取 ${t.read_status}`, 'unverifiable') : ''}
      </div>
      <div class="id">${esc(t.author_executor ?? '—')} / ${esc(t.reviewer_executor ?? '—')} · v${esc(t.state_version ?? '—')} · ${esc(fmtTime(t.as_of))}</div>
    </button>`).join('');
  const count = $('task-count');
  if (count) count.textContent = `${rows.length}/${state.tasks.length}`;

  for (const el of $('tasks').querySelectorAll('.row')) {
    el.addEventListener('click', () => selectTask(el.dataset.id));
  }
}

function stageStrip(currentPhase) {
  const phase = ({ PROJECTED: 'PROJECTION', AUTHOR_RUNNING: 'AUTHOR' })[currentPhase] ?? currentPhase;
  const idx = phase === 'PROMOTED' ? STAGES.length : STAGES.findIndex(([, key]) => key === phase);
  return `<div class="runway" role="list" aria-label="受信阶段">${STAGES.map(([label, key], i) => {
    const cls = idx === -1 ? '' : (i < idx ? 'done' : (i === idx ? 'current' : ''));
    const state = cls === 'done' ? '已完成' : (cls === 'current' ? '当前阶段' : '未到达');
    return `<span class="stage ${cls}" role="listitem"${cls === 'current' ? ' aria-current="step"' : ''} title="${esc(key)} · ${state}"><span class="n" aria-hidden="true">${i + 1}</span>${esc(label)}</span>`;
  }).join('')}</div>`;
}

/** A folded panel says how many ROWS it holds. Counting only the populated ones read as "2 项"
 *  above a list of five rows, which is its own small lie. */
const SECONDARY_FACT_ROWS = 5;
function secondaryFactCount() {
  return SECONDARY_FACT_ROWS;
}

function blockValue(block, fallback = '—') {
  if (!block) return `<span class="unverifiable">不可核验（无该数据块）</span>`;
  if (block.read_status === 'unverifiable') return `<span class="unverifiable">不可核验：${esc(block.reason ?? '原因未记录')}</span>`;
  if (block.read_status === 'missing') return `<span class="missing">不存在</span>`;
  return esc(fallback);
}

function taskFromHash() {
  try {
    const id = decodeURIComponent(location.hash.slice(1));
    if (document.getElementById(id)) return null;
    return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
  } catch { return null; }
}

async function selectTask(taskId) {
  state.selected = taskId;
  const selectionVersion = ++state.selectionVersion;
  const isCurrent = () => state.selected === taskId && state.selectionVersion === selectionVersion;
  if (taskFromHash() !== taskId) history.replaceState(null, '', '#' + encodeURIComponent(taskId));
  refreshWriteControls();
  if (state.plan && state.plan.taskId !== taskId) state.plan = null;
  renderTasks();
  const el = $('detail');
  el.innerHTML = `<p class="hint">正在读取 ${esc(taskId)} …</p>`;
  try {
    const [taskPayload, evidencePayload] = await Promise.all([
      getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}`),
      getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}/evidence`).catch((err) => ({ error: err.message })),
    ]);
    if (!isCurrent()) return;
    renderDetail(taskPayload.model ?? taskPayload, evidencePayload.error ? evidencePayload : (evidencePayload.model ?? evidencePayload));
    // §6 G5 timeline: a bounded page of the phase-event projection, and an explicit banner when the
    // projection disagrees with the task snapshot (the task file stays the lifecycle truth).
    getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}/events?limit=20`)
      .then((payload) => { if (isCurrent()) renderTimeline(payload.model ?? payload); })
      .catch(() => { if (isCurrent()) renderTimeline(null); });
    getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}/messages`)
      .then((payload) => { if (isCurrent()) renderCollab(payload.model ?? payload); })
      .catch(() => { if (isCurrent()) renderCollab(null); });
  } catch (err) {
    if (!isCurrent()) return;
    el.innerHTML = `<p class="missing">读取失败：${esc(err.message)}</p>`;
  }
}

/** The plan lives in `state` so a poll re-render cannot wipe it. */
function renderPlanHtml(taskId) {
  const plan = state.plan;
  if (!plan || plan.taskId !== taskId) return '';
  if (plan.status === 409) return `<p class="unverifiable">计划已过期：${esc(plan.reason)}（请刷新任务后重算——旧计划不会被自动复用）</p>`;
  if (!plan.model?.plan) return `<p class="missing">无法生成计划：${esc(plan.reason ?? plan.status)}</p>`;
  const m = plan.model;
  return `
    <dl class="kv">
      <dt>恢复分类</dt><dd>${esc(m.plan.recovery_class)}</dd>
      <dt>可恢复</dt><dd>${esc(String(m.plan.recoverable))}</dd>
      <dt>建议动作</dt><dd>${esc(m.plan.recommended_action)}</dd>
      <dt>可执行</dt><dd>${esc(String(m.executable))} · ${esc(m.note)}</dd>
    </dl>`;
}

/** P3: the plan is READ-ONLY. A stale version is reported, never silently recomputed. */
async function loadRecoveryPlan(taskId, expectedVersion) {
  const target = document.getElementById('recovery-plan');
  if (!target) return;
  target.innerHTML = '<p class="hint">正在计算恢复计划…</p>';
  try {
    const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}/recovery-plan`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_state_version: Number(expectedVersion) }),
    });
    const payload = await res.json();
    const model = payload.model ?? payload;
    state.plan = { taskId, status: res.status, model, reason: model.reason ?? null };
    target.innerHTML = renderPlanHtml(taskId) || '<p class="hint">（计划未生成）</p>';
  } catch (err) {
    state.plan = { taskId, status: 0, model: null, reason: err.message };
    target.innerHTML = `<p class="unverifiable">计划读取失败：${esc(err.message)}</p>`;
  }
}

function renderDetail(model, evidence) {
  const task = model.blocks?.task ?? {};
  const value = task.value ?? {};
  const phase = value.phase ?? value.trusted_import?.phase ?? null;
  const boundary = value.boundary_state ?? (value.trusted_import?.boundary_state ?? null);
  const boundaryAlert = value.boundary_alert ?? null;

  const detailPhase = $('detail-phase');
  if (detailPhase) detailPhase.textContent = phase ? `阶段 ${phase}` : '';
  $('detail').innerHTML = `
    <div class="work-head">
      <h3>${esc(value.goal ?? taskIdSafe(model))}</h3>
      <div class="tags">
        ${tag(value.state ?? 'unknown', `state-${esc(value.state ?? '')}`)}
        ${phase ? tag(`阶段 ${phase}`) : ''}
        ${boundary ? tag(`边界 ${boundary}`) : ''}
        ${value.trusted_import?.promotion?.canonical_oid ? tag(`提升 ${String(value.trusted_import.promotion.canonical_oid).slice(0, 8)}`, 'state-COMPLETED') : ''}
      </div>
      ${stageStrip(phase)}
    </div>
    <div class="block">
      <h2>任务事实</h2>
      <dl class="kv">
        <dt>任务 ID</dt><dd>${esc(value.task_id ?? taskIdSafe(model))}</dd>
        <dt>状态版本</dt><dd>${esc(value.state_version ?? '—')}</dd>
        <dt>作者 / 评审</dt><dd>${esc(value.author_executor ?? '—')} / ${esc(value.reviewer_executor ?? '—')}</dd>
        <dt>更新时间</dt><dd>${esc(fmtTime(value.updated_at))}</dd>
      </dl>
      <details class="disclosure flush" style="margin-top: var(--s3)">
        <summary>更多事实<span class="count">${secondaryFactCount()} 项</span></summary>
        <div class="disclosure-body">
          <dl class="kv">
            <dt>修复循环</dt><dd>${esc(value.trusted_import?.fix_loop ? `${value.trusted_import.fix_loop.attempts}/${value.trusted_import.fix_loop.max_attempts}` : '—')}</dd>
            <dt>待人工</dt><dd>${esc((value.trusted_import?.pending_human_decisions ?? []).map((d) => d.path).join(', ') || '—')}</dd>
            <dt>边界告警</dt><dd>${boundaryAlert ? esc(`${boundaryAlert.severity ?? 'warning'} · occurrences=${boundaryAlert.occurrences ?? 0}`) : '—'}</dd>
            <dt>任务块</dt><dd>${blockValue(task)}</dd>
            <dt>数据时间</dt><dd>${esc(fmtTime(model.generated_at))}</dd>
          </dl>
        </div>
      </details>
    </div>
    <div class="block">
      <h2>恢复</h2>
      <div class="actions">
        <button type="button" class="btn" id="recovery-plan-btn" data-id="${esc(value.task_id ?? taskIdSafe(model))}" data-version="${esc(value.state_version ?? '')}">恢复计划（只读）</button>
      </div>
      <div id="recovery-plan">${renderPlanHtml(value.task_id ?? taskIdSafe(model))}</div>
    </div>
    <details class="disclosure flush">
      <summary>证据<span class="count">原始投影（只读）</span></summary>
      <div class="disclosure-body">
        ${evidence?.error ? `<p class="unverifiable">证据读取失败：${esc(evidence.error)}</p>` : `<pre class="evidence" tabindex="0">${esc(JSON.stringify(evidence, null, 2))}</pre>`}
      </div>
    </details>`;

  const planBtn = document.getElementById('recovery-plan-btn');
  if (planBtn) planBtn.addEventListener('click', () => loadRecoveryPlan(planBtn.dataset.id, planBtn.dataset.version));
}

const taskIdSafe = (model) => model.blocks?.task?.value?.task_id ?? model.task_id ?? '任务';

/** P2: the submission spec as the browser may express it - nothing platform-bound, no limits. */
function submitPayload() {
  return {
    goal: $('s-goal').value.trim(),
    target_path: $('s-target').value.trim(),
    acceptance: { command: $('s-command').value.trim(), args: $('s-args').value.trim().split(/\s+/).filter(Boolean) },
    idempotency_key: $('s-key').value.trim(),
  };
}

/**
 * POST the spec to the preflight or the record route. Both answer with the same envelope; a
 * refusal is shown verbatim (never swallowed) so the operator sees WHY nothing happened.
 */
async function postSubmit(path) {
  const out = $('submit-result');
  if (!out) return;
  out.hidden = false;
  out.className = 'evidence';
  out.textContent = '正在请求…';
  try {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: path.endsWith('/record') ? authHeaders() : { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: submitPayload() }),
    });
    const payload = await res.json();
    const model = payload.model ?? payload;
    out.textContent = JSON.stringify(model, null, 2);
    if (!res.ok) out.className = 'evidence unverifiable';
  } catch (err) {
    out.textContent = `请求失败：${err.message}`;
    out.className = 'evidence missing';
  }
}

async function refreshList() {
  try {
    const payload = await getJson('/api/v2/tasks');
    const model = payload.model ?? payload;
    state.tasks = (model.tasks ?? []).map((t) => ({ ...t, read_status: t.read_status ?? model.blocks?.tasks?.read_status ?? 'ok' }));
    $('asof').textContent = `数据 ${fmtTime(model.generated_at)}`;
    setConn(true);
    renderTasks();
  } catch (err) {
    setConn(false, err.message);
    $('tasks').innerHTML = `<p class="unverifiable">任务列表读取失败：${esc(err.message)}</p>`;
  }
}

async function refreshSide() {
  try {
    const envPayload = await getJson('/api/v2/environment');
    const env = envPayload.model ?? envPayload;
    $('environment').innerHTML = `
      <dt>Node</dt><dd>${esc(env.node)}</dd>
      <dt>平台</dt><dd>${esc(env.platform)}</dd>
      <dt>执行器隔离</dt><dd>${esc(env.executor_isolation?.capable ? '已具备' : '未验证/未配置')}</dd>`;
    const execPayload = await getJson('/api/v2/executors');
    const exec = execPayload.model ?? execPayload;
    $('executors').innerHTML = (exec.executors ?? []).map((e) => {
      const full = `${e.availability}${e.reason ? ` · ${e.reason}` : ''}`;
      const cls = e.availability === 'AVAILABLE' ? 'state-COMPLETED'
        : (e.availability === 'DISABLED_BY_OPERATOR' ? 'state-WAITING_HUMAN' : 'unverifiable');
      return `<dt>${esc(e.id)}</dt><dd><span class="tag ${cls}">${esc(e.availability)}</span>${e.reason ? ` <span class="clamp" title="${esc(full)}">${esc(e.reason)}</span>` : ''}</dd>`;
    }).join('') || '<dt>—</dt><dd>无可读执行器</dd>';
  } catch (err) {
    $('environment').innerHTML = `<dt>环境</dt><dd class="unverifiable">读取失败：${esc(err.message)}</dd>`;
  }
}

async function boot() {
  // Attach the handlers FIRST: a failure in any of the read paths below must never leave the page
  // without its controls (or, worse, with controls that silently do nothing).
  $('filter').addEventListener('input', (e) => { state.filter = e.target.value; renderTasks(); });
  window.addEventListener('hashchange', () => {
    const taskId = taskFromHash();
    if (taskId && taskId !== state.selected) void selectTask(taskId);
  });
  let generatedKey = submissionKey();
  $('s-key').value = generatedKey;
  $('submit-form').addEventListener('input', (e) => {
    // Identical retries retain their identity; a new draft gets a fresh one.
    // An explicitly entered identity remains under the operator's control.
    if (['s-goal', 's-target', 's-command', 's-args'].includes(e.target.id) && $('s-key').value === generatedKey) {
      generatedKey = submissionKey();
      $('s-key').value = generatedKey;
    }
  });
  $('submit-form').addEventListener('invalid', (e) => {
    const disclosure = e.target.closest('details');
    if (disclosure) disclosure.open = true;
  }, true);
  $('submit-form').addEventListener('submit', (e) => { e.preventDefault(); postSubmit('/api/v2/tasks/preflight'); });
  $('s-record').addEventListener('click', () => postSubmit('/api/v2/tasks/record'));
  $('msg-send').addEventListener('click', () => runWrite('排队消息', async () => {
    const message = $('msg-text').value.trim();
    if (!message) throw new Error('消息为空');
    const model = await postWrite(`/api/v2/tasks/${encodeURIComponent(state.selected)}/messages`, { message });
    $('msg-text').value = '';
    await selectTask(state.selected);
    return model;
  }));
  $('s-create').addEventListener('click', () => {
    if (!$('submit-form').reportValidity()) return;
    return runWrite('创建任务', async () => {
      const model = await postWrite('/api/v2/tasks/create', { spec: submitPayload() });
      $('submit-result').textContent = `${JSON.stringify(model, null, 2)}\n\n启动：点左侧该任务，再按「启动（V2）」`;
      await refreshList();
      return model;
    });
  });
  $('a-start').addEventListener('click', () => runWrite('启动任务', async () => {
    const model = await postWrite(`/api/v2/tasks/${encodeURIComponent(state.selected)}/start`, {});
    await refreshList();
    return model;
  }));
  $('a-cancel').addEventListener('click', () => runWrite('取消任务', async () => {
    const model = await postWrite(`/api/v2/tasks/${encodeURIComponent(state.selected)}/cancel`, { reason: 'operator cancelled from the workbench' });
    await refreshList();
    return model;
  }));
  $('token-form').addEventListener('submit', async event => {
    event.preventDefault();
    if(state.pending||access.state.pending)return;
    try {
      if(await access.connectLegacy($('token-input').value)) {
        $('token-input').value='';$('access-advanced').open=false;
        showAccessResult('操作权限已连接，可继续当前草稿。');
      }
    } catch(error) {showAccessResult(error.message,true);}
  });
  const changeAccess = async () => {
    if(state.pending||access.state.pending)return;
    try {
      if(!access.state.known){await access.refresh();return;}
      if(!access.state.authorized&&!access.state.available){$('access-details').open=true;$('access-advanced').open=true;return;}
      const revoking=access.state.authorized;
      if(await (revoking?access.revoke():access.authorize()))showAccessResult(revoking?'已取消授权。当前草稿已保留。':'授权成功，可继续当前草稿。');
    } catch(error) {showAccessResult(error.message,true);}
  };
  $('authorize-access').addEventListener('click',changeAccess);
  $('access-panel-action').addEventListener('click',changeAccess);
  access.subscribe(refreshWriteControls);
  refreshWriteControls();

  try {
    const payload = await getJson('/api/v2/capabilities');
    state.capabilities = payload.model ?? payload;
    $('capabilities').textContent = `写操作：${Object.entries(state.capabilities.write).filter(([, v]) => v).map(([k]) => k).join(', ') || '无'}`;
    refreshWriteControls();
  } catch { /* the banner stays empty; the footer already says this page is read-only */ }
  await access.refresh();
  await refreshList();
  const bookmarkedTask = taskFromHash();
  if (bookmarkedTask && !state.selected) await selectTask(bookmarkedTask);
  await refreshSide();
  setInterval(refreshList, 5000);
  setInterval(refreshSide, 30000);
  setInterval(() => {if(!document.hidden)void access.refresh();},1500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void access.refresh();});
  setInterval(() => { if (state.selected) selectTask(state.selected); }, 3000);
}

function showAccessResult(message, failed=false) {
  $('access-feedback').textContent=message;$('access-feedback').hidden=false;
  if(failed) {
    $('access-details').open=true;
    const out=$('submit-result');out.hidden=false;out.className='evidence bad';out.textContent=message;
  }
}

boot();
