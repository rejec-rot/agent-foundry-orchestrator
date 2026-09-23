// app.js - V2 workbench (read-only). Zero dependencies, offline-capable.
//
// Every value comes from the read-only API; this file never sends a mutating request (there is no
// such route). A block that could not be read is rendered as UNVERIFIABLE/MISSING and never as
// "no data" - the UI must not claim emptiness it cannot prove.

const STAGES = [
  ['投影', 'PROJECTION'], ['编写', 'AUTHOR'], ['写者停止', 'QUIESCE'], ['捕获', 'CAPTURE'],
  ['评审', 'REVIEW'], ['授权', 'AUTHORIZATION'], ['验收', 'ACCEPTANCE'], ['提升', 'PROMOTION'],
];

const state = { tasks: [], selected: null, filter: '', capabilities: null };

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.reason ?? `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function setConn(live, detail) {
  const el = $('conn');
  el.className = `conn ${live ? 'live' : 'dead'}`;
  el.textContent = live ? '已连接' : `连接中断：${detail ?? '未知原因'}`;
}

function tag(text, cls = '') { return `<span class="tag ${cls}">${esc(text)}</span>`; }

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
      <div class="tags">
        ${tag(t.state ?? 'unknown', `state-${esc(t.state ?? '')}`)}
        ${t.boundary_state ? tag(`边界 ${t.boundary_state}`) : ''}
        ${t.needs_human ? tag('需人工', 'state-WAITING_HUMAN') : ''}
        ${t.lock_stale ? tag('锁疑似陈旧') : ''}
        ${t.read_status && t.read_status !== 'ok' ? tag(`读取 ${t.read_status}`, 'unverifiable') : ''}
      </div>
    </button>`).join('');

  for (const el of $('tasks').querySelectorAll('.row')) {
    el.addEventListener('click', () => selectTask(el.dataset.id));
  }
}

function stageStrip(currentPhase) {
  const idx = STAGES.findIndex(([, key]) => key === currentPhase);
  return `<div class="stages">${STAGES.map(([label, key], i) => {
    const cls = idx === -1 ? '' : (i < idx ? 'done' : (i === idx ? 'current' : ''));
    return `<span class="stage ${cls}">${esc(label)}</span>`;
  }).join('')}</div>`;
}

function blockValue(block, fallback = '—') {
  if (!block) return `<span class="unverifiable">不可核验（无该数据块）</span>`;
  if (block.read_status === 'unverifiable') return `<span class="unverifiable">不可核验：${esc(block.reason ?? '原因未记录')}</span>`;
  if (block.read_status === 'missing') return `<span class="missing">不存在</span>`;
  return esc(fallback);
}

async function selectTask(taskId) {
  state.selected = taskId;
  renderTasks();
  const el = $('detail');
  el.innerHTML = `<p class="hint">正在读取 ${esc(taskId)} …</p>`;
  try {
    const [taskPayload, evidencePayload] = await Promise.all([
      getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}`),
      getJson(`/api/v2/tasks/${encodeURIComponent(taskId)}/evidence`).catch((err) => ({ error: err.message })),
    ]);
    renderDetail(taskPayload.model ?? taskPayload, evidencePayload.error ? evidencePayload : (evidencePayload.model ?? evidencePayload));
  } catch (err) {
    el.innerHTML = `<p class="missing">读取失败：${esc(err.message)}</p>`;
  }
}

function renderDetail(model, evidence) {
  const task = model.blocks?.task ?? {};
  const value = task.value ?? {};
  const phase = value.phase ?? null;
  const boundary = value.boundary_state ?? (value.trusted_import?.boundary_state ?? null);
  const boundaryAlert = value.boundary_alert ?? null;

  $('detail').innerHTML = `
    <div class="detail">
      <h3>${esc(value.goal ?? taskIdSafe(model))}</h3>
      <div class="tags">
        ${tag(value.state ?? 'unknown', `state-${esc(value.state ?? '')}`)}
        ${phase ? tag(`阶段 ${phase}`) : ''}
        ${boundary ? tag(`边界 ${boundary}`) : ''}
      </div>
      ${stageStrip(phase)}
      <dl class="kv">
        <dt>任务 ID</dt><dd>${esc(value.task_id ?? taskIdSafe(model))}</dd>
        <dt>状态版本</dt><dd>${esc(value.state_version ?? '—')}</dd>
        <dt>更新时间</dt><dd>${esc(value.updated_at ?? '—')}</dd>
        <dt>作者 / 评审</dt><dd>${esc(value.author_executor ?? '—')} / ${esc(value.reviewer_executor ?? '—')}</dd>
        <dt>修复循环</dt><dd>${esc(value.trusted_import?.fix_loop ? `${value.trusted_import.fix_loop.attempts}/${value.trusted_import.fix_loop.max_attempts}` : '—')}</dd>
        <dt>待人工</dt><dd>${esc((value.trusted_import?.pending_human_decisions ?? []).map((d) => d.path).join(', ') || '—')}</dd>
        <dt>边界告警</dt><dd>${boundaryAlert ? esc(`${boundaryAlert.severity ?? 'warning'} · occurrences=${boundaryAlert.occurrences ?? 0}`) : '—'}</dd>
        <dt>任务块</dt><dd>${blockValue(task)}</dd>
        <dt>数据时间</dt><dd>${esc(model.generated_at ?? '—')}</dd>
      </dl>
      <h2>证据</h2>
      ${evidence?.error ? `<p class="unverifiable">证据读取失败：${esc(evidence.error)}</p>` : `<pre class="evidence">${esc(JSON.stringify(evidence, null, 2))}</pre>`}
    </div>`;
}

const taskIdSafe = (model) => model.blocks?.task?.value?.task_id ?? model.task_id ?? '任务';

async function refreshList() {
  try {
    const payload = await getJson('/api/v2/tasks');
    const model = payload.model ?? payload;
    state.tasks = (model.tasks ?? []).map((t) => ({ ...t, read_status: t.read_status ?? model.blocks?.tasks?.read_status ?? 'ok' }));
    $('asof').textContent = `数据更新于 ${model.generated_at ?? ''}`;
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
    $('executors').innerHTML = (exec.executors ?? []).map((e) => `
      <dt>${esc(e.id)}</dt><dd>${esc(e.availability)}${e.reason ? ` · ${esc(e.reason)}` : ''}</dd>`).join('') || '<dt>—</dt><dd>无可读执行器</dd>';
  } catch (err) {
    $('environment').innerHTML = `<dt>环境</dt><dd class="unverifiable">读取失败：${esc(err.message)}</dd>`;
  }
}

async function boot() {
  try {
    const payload = await getJson('/api/v2/capabilities');
    state.capabilities = payload.model ?? payload;
    $('capabilities').textContent = `写操作：${Object.entries(state.capabilities.write).filter(([, v]) => v).map(([k]) => k).join(', ') || '无'}`;
  } catch { /* the banner stays empty; the footer already says this page is read-only */ }
  await refreshList();
  await refreshSide();
  $('filter').addEventListener('input', (e) => { state.filter = e.target.value; renderTasks(); });
  setInterval(refreshList, 5000);
  setInterval(refreshSide, 30000);
  setInterval(() => { if (state.selected) selectTask(state.selected); }, 3000);
}

boot();
