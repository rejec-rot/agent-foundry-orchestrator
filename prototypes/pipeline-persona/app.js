/* ============================================================
   V2 流程管线原型 B —— 纯前端模拟，不依赖后端
   所有数据为模拟值；真实系统中一切状态投影自任务文件等权威记录。
   ============================================================ */
'use strict';

/* ---------- 阶段定义（对应真实 V2 交付链） ---------- */
const STAGES = [
  { id: 'submit',  name: '提交',   sub: 'SUBMIT' },
  { id: 'author',  name: '编写',   sub: 'AUTHOR' },
  { id: 'review',  name: '评审',   sub: 'REVIEW' },
  { id: 'gate',    name: '四带门', sub: 'FOUR-BAND GATE' },
  { id: 'accept',  name: '验收',   sub: 'ACCEPTANCE' },
  { id: 'promote', name: '提升',   sub: 'PROMOTION' },
];

const STATE_WORD = {
  pending: '未到达', active: '进行中', passed: '已通过',
  failed: '失败', waiting: '等待人工', unknown: '不可核验',
};
const STATE_CLASS = {
  pending: 'st-pending', active: 'st-active', passed: 'st-passed',
  failed: 'st-failed', waiting: 'st-waiting', unknown: 'st-unknown',
};

/* ---------- 模拟任务数据（结构对照真实任务记录字段） ---------- */
function freshTasks() {
  return [
    {
      id: 'AF-2026-0930-014',
      goal: '为 V2 控制台增加只读审计导出',
      project: 'agent-foundry-next',
      state: 'WAITING_HUMAN', state_version: 41,
      author: 'codex-author-01', reviewer: 'cline-reviewer-02',
      created: '2026-09-30 13:02:11',
      idemKey: 'idem-9c31-44af',
      stages: { submit: 'passed', author: 'passed', review: 'passed', gate: 'waiting', accept: 'pending', promote: 'pending' },
      workers: [
        { id: 'w1', role: '接口契约整理', agoMin: 12, active: false,
          injects: [{ text: '把导出范围收窄到 recovery-* 记录', step: 2 }] },
        { id: 'w2', role: '导出渲染器', agoMin: 3, active: true,
          injects: [{ text: 'render --out 禁止覆盖既有文件', step: 1 }] },
        { id: 'w3', role: '脱敏策略核对', agoMin: 26, active: false, injects: [] },
      ],
      manifest: { add: 6, modify: 3, del: 0, mode: 1 },
      review: { verdict: 'PASS', digest: '9f2ca4…e1b7', bound: 'sealed snapshot #3', by: 'cline-reviewer-02（独立于作者 ✓）' },
      gate: { band: 'D', verdict: 'WAITING_HUMAN', pending: ['SECURITY.md'], note: '候选改动触及受保护路径，需签名人工批准' },
      unverifiable: [],
      lastActivityMin: 3,
    },
    {
      id: 'AF-2026-0929-007',
      goal: '修复恢复入口重入一致性',
      project: 'agent-foundry-next',
      state: 'ACCEPTANCE_RUNNING', state_version: 58,
      author: 'cline-author-04', reviewer: 'codex-reviewer-01',
      created: '2026-09-29 21:44:03',
      idemKey: 'idem-77be-01c2',
      stages: { submit: 'passed', author: 'passed', review: 'passed', gate: 'passed', accept: 'active', promote: 'pending' },
      workers: [
        { id: 'w1', role: '重放路径比对', agoMin: 47, active: false, injects: [] },
        { id: 'w2', role: '回归用例补齐', agoMin: 9, active: true,
          injects: [{ text: '优先覆盖并发重基场景', step: 2 }] },
      ],
      manifest: { add: 1, modify: 5, del: 0, mode: 0 },
      review: { verdict: 'PASS', digest: '41dd90…a2c3', bound: 'sealed snapshot #2', by: 'codex-reviewer-01（独立于作者 ✓）' },
      gate: { band: 'B(i)', verdict: 'ALLOW', pending: [], note: '闭包满足，四带门放行' },
      unverifiable: ['runtime/executor-runtime-events.jsonl（存在坏行 2 行，保留有效前缀）'],
      lastActivityMin: 1,
    },
  ];
}

let tasks = freshTasks();
let currentTaskId = tasks[0].id;
let writeMode = false;
let selection = null; // { kind:'stage'|'worker', stageId, workerId? }
let booted = false;

const $ = (sel) => document.querySelector(sel);
const cur = () => tasks.find((t) => t.id === currentTaskId);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 管线渲染 ---------- */
function renderPipeline() {
  const t = cur();
  const row = $('#pipelineRow');
  row.classList.toggle('settled', booted);
  row.innerHTML = '';

  STAGES.forEach((stage, i) => {
    if (i > 0) {
      const link = document.createElement('div');
      const prev = t.stages[STAGES[i - 1].id];
      link.className = 'link' +
        (prev === 'passed' && ['active', 'waiting'].includes(t.stages[stage.id]) ? ' flowing'
        : prev === 'passed' && t.stages[stage.id] !== 'pending' ? ' passed'
        : prev === 'passed' ? ' passed' : '');
      if (t.stages[stage.id] === 'waiting') link.classList.add('blocked');
      link.style.setProperty('--i', i);
      row.appendChild(link);
    }
    row.appendChild(buildNode(t, stage, i));
  });
}

function buildNode(t, stage, i) {
  const st = t.stages[stage.id];
  const node = document.createElement('div');
  node.className = `node ${STATE_CLASS[st]}`;
  node.style.setProperty('--i', i);
  node.tabIndex = 0;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${stage.name}：${STATE_WORD[st]}`);
  node.dataset.stageId = stage.id;

  let html = '';
  if (st === 'active') html += '<span class="ants" aria-hidden="true"></span>';
  if (st === 'failed') html += '<span class="fail-x" aria-hidden="true">✕</span>';
  if (st === 'waiting' && t.gate.pending.length) {
    html += `<span class="pending-badge">待决 ${t.gate.pending.length}</span>`;
  }
  html += `<div class="node-name">${esc(stage.name)}</div>`;
  html += `<div class="node-sub">${esc(stage.sub)}</div>`;
  html += `<div class="node-state-word">${esc(STATE_WORD[st])}</div>`;

  // 编写 / 评审 / 提交节点的内嵌信息
  if (stage.id === 'author' && t.workers.length) {
    html += `<div class="worker-lane"><div class="mono-label worker-lane-label" title="单作者多工作者">WORKERS ×${t.workers.length}</div>`;
    t.workers.forEach((w) => {
      const flags = w.injects.map((inj, j) =>
        `<span class="inject-flag ${inj.step >= 2 ? 'done' : ''}" title="注入指令：${esc(inj.text)}">令${j + 1}</span>`).join('');
      html += `<div class="worker ${w.active ? 'active-dot' : ''}" data-worker="${esc(w.id)}" tabindex="0"
        role="button" aria-label="worker ${esc(w.id)}：${esc(w.role)}">
        <span class="worker-id">${esc(w.id)}</span>
        <span class="worker-role">${esc(w.role)}</span>
        ${flags}
        <span class="worker-ago">${w.agoMin}m前</span>
      </div>`;
    });
    html += '</div>';
  }
  if (stage.id === 'review') {
    html += `<div class="worker-lane"><div class="mono-label worker-lane-label">REVIEWER</div>
      <div class="worker" data-worker="__reviewer" tabindex="0" role="button" aria-label="评审执行器 ${esc(t.reviewer)}">
        <span class="worker-id">${esc(t.reviewer)}</span>
        <span class="worker-role">${st === 'passed' ? 'PASS · ' + esc(t.review.digest) : '独立评审'}</span>
      </div></div>`;
  }
  if (stage.id === 'submit') {
    html += `<div class="worker-lane"><div class="mono-label worker-lane-label">IDEMPOTENT KEY</div>
      <div class="worker" style="cursor:default"><span class="worker-role">${esc(t.idemKey)}</span></div></div>`;
  }

  node.innerHTML = html;
  if (selection && selection.kind === 'stage' && selection.stageId === stage.id) node.classList.add('selected');
  node.addEventListener('click', () => selectStage(stage.id));
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectStage(stage.id); });

  node.querySelectorAll('.worker[data-worker]').forEach((el) => {
    el.addEventListener('click', (e) => { e.stopPropagation(); selectWorker(stage.id, el.dataset.worker); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.stopPropagation(); selectWorker(stage.id, el.dataset.worker); } });
  });
  return node;
}

/* ---------- 右侧抽屉 ---------- */
function kv(k, v) { return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`; }

function injectRecordHtml(inj) {
  const steps = ['排队', '已接收', '已落实'];
  return `<div class="inject-record"><div class="text">「${esc(inj.text)}」</div>
    <div class="inject-steps">${steps.map((s, i) =>
      `<span class="inject-step ${i < inj.step ? 'hit' : i === inj.step ? 'now' : ''}">${s}${i <= inj.step ? ' ✓' : ''}</span>`).join('')}
    </div></div>`;
}

function stageTag(st) {
  const cls = st === 'passed' ? 'pass' : st === 'waiting' ? 'amber' : st === 'failed' ? 'fail' : '';
  return `<span class="tag ${cls}">${STATE_WORD[st]}</span>`;
}

function drawerHtmlForStage(t, stageId) {
  const st = t.stages[stageId];
  const common = `<h3>状态来源</h3>${kv('阶段状态', stageTag(st))}
    ${kv('投影自', 'tasks/' + t.id + '.json')}
    ${kv('state_version', t.state_version)}
    <p class="note">本面板为只读投影；派生值均标注来源，读不到即显示「不可核验」，不推断。</p>`;

  if (stageId === 'submit') return `
    <h3>任务定义</h3>
    ${kv('目标', esc(t.goal))}${kv('项目', esc(t.project))}${kv('创建时间', t.created)}
    ${kv('幂等键', esc(t.idemKey))}${kv('作者', esc(t.author))}${kv('评审', esc(t.reviewer) + '（独立 ✓）')}
    <h3>密封候选差异（manifest 摘要）</h3>
    <span class="tag pass">ADD ${t.manifest.add}</span><span class="tag">MODIFY ${t.manifest.modify}</span>
    <span class="tag">DELETE ${t.manifest.del}</span><span class="tag amber">MODE ${t.manifest.mode}</span>
    <p class="note">差异绑定密封快照；大文件/二进制/越界路径各有明确展示策略。</p>` + common;

  if (stageId === 'author') return `
    <h3>作者与工作者（单作者多工作者）</h3>
    ${kv('主作者执行器', esc(t.author))}
    ${t.workers.map((w) => `<div class="state-line"><span class="state-dot" style="background:${w.active ? 'var(--accent)' : 'var(--ink-faint)'}"></span>
      <b>${esc(w.id)}</b>&nbsp;${esc(w.role)}<span class="note">· ${w.agoMin} 分钟前活动</span></div>`).join('')}
    <h3>注入指令记录</h3>
    ${t.workers.flatMap((w) => w.injects).map(injectRecordHtml).join('') || '<p class="note">暂无注入记录</p>'}
    <p class="note">指令经 operator-control 注入，不打断运行中进程；落实前不改变任何节点状态。</p>` + common;

  if (stageId === 'review') return `
    <h3>评审结果</h3>
    ${kv('结论', `<span class="tag ${t.review.verdict === 'PASS' ? 'pass' : 'fail'}">${t.review.verdict}</span>`)}
    ${kv('评审执行器', esc(t.review.by))}${kv('快照摘要', esc(t.review.digest))}${kv('绑定', esc(t.review.bound))}
    <p class="note">评审针对密封候选快照；拒绝时此处显示结构化理由，且不提供「强制通过」。</p>` + common;

  if (stageId === 'gate') return `
    <h3>四带门判定</h3>
    ${kv('带位', 'Band ' + esc(t.gate.band))}
    ${kv('判定', `<span class="tag ${t.gate.verdict === 'ALLOW' ? 'pass' : 'amber'}">${esc(t.gate.verdict)}</span>`)}
    ${st === 'waiting' ? `
      <h3>待决路径（${t.gate.pending.length}）</h3>
      ${t.gate.pending.map((p) => `<span class="tag amber">${esc(p)}</span>`).join('')}
      <p class="note">${esc(t.gate.note)}</p>
      <h3>如何批准（仅 CLI，浏览器不持有密钥）</h3>
      <div class="cli-hint">af-admin v2 gate-resume --task ${esc(t.id)}<br>--reason "已人工核对改动" --confirm<br><br>需要 AF_OPERATOR_KEY 签名；未配置即拒绝（exit 3）。批准后锁内复验 state_version=${t.state_version}，过期重算。</div>
      <p class="note">本页面<b>没有也不会提供</b>「批准」按钮。</p>` : `<p class="note">${esc(t.gate.note)}</p>`}` + common;

  if (stageId === 'accept') return `
    <h3>隔离验收</h3>
    ${st === 'pending' ? '<p class="note">尚未到达。验收在隔离环境执行，证据（命令、退出码、输出摘要）绑定密封快照后才会在此展示；日志摘要不等于完整日志。</p>'
    : kv('验收证据', 'acceptance_evidence_id → acc-8f31') + kv('命令', 'node --test（profile: ci-basic）') + kv('退出码', st === 'passed' ? '0' : '运行中')}
    ${t.unverifiable.length ? `<h3>不可核验来源（${t.unverifiable.length}）</h3>${t.unverifiable.map((u) => `<p class="note">⚠ ${esc(u)}</p>`).join('')}` : ''}` + common;

  if (stageId === 'promote') return `
    <h3>正式提升</h3>
    ${st === 'passed'
      ? kv('baseline_oid', '07c3a4c…') + kv('new_commit_oid', 'e58b21d…') + kv('refs/afr/canonical', '<span class="tag pass">已前进</span>')
      : '<p class="note">尚未提升。canonical 的唯一提升路径是 Hard G 原子事务；本页面不改变该路径，提升前后崩溃均可从事务记录恢复。</p>'}` + common;

  return common;
}

function drawerHtmlForWorker(t, stageId, workerId) {
  if (workerId === '__reviewer') {
    return `<h3>评审执行器</h3>
      ${kv('身份', esc(t.reviewer))}${kv('与作者独立', '是 ✓（服务端复核）')}
      ${kv('登记状态', '可用（缓存值，as_of 见页顶）')}
      <p class="note">登记状态与本次真实验证分开显示；历史状态不冒充实时探活。</p>`;
  }
  const w = t.workers.find((x) => x.id === workerId);
  if (!w) return '<p class="note">worker 不存在</p>';
  return `<h3>Worker ${esc(w.id)}</h3>
    ${kv('分工', esc(w.role))}${kv('隶属', esc(t.author) + ' / 编写阶段')}
    ${kv('最近活动', w.agoMin + ' 分钟前')}${kv('状态', w.active ? '执行中' : '待命')}
    <h3>注入指令记录</h3>
    ${w.injects.map(injectRecordHtml).join('') || '<p class="note">暂无注入记录</p>'}
    <p class="note">${writeMode ? '底部指令条已锁定该 worker，可直接调整其细分工作内容与方向。' : '当前为只读模式：调整分工需切换到写模式（真实系统由服务端令牌控制）。'}</p>`;
}

function openDrawer(title, kicker, bodyHtml) {
  $('#drawerTitle').textContent = title;
  $('#drawerKicker').textContent = kicker;
  $('#drawerBody').innerHTML = bodyHtml;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
}

/* ---------- 列表视图（与管线信息逐项等价） ---------- */
function renderList() {
  const tb = $('#taskTable tbody');
  tb.innerHTML = tasks.map((t) => {
    const idx = STAGES.findIndex((s) => ['active', 'waiting', 'failed'].includes(t.stages[s.id]));
    const stageName = idx >= 0 ? STAGES[idx].name : '—';
    const needHuman = t.stages.gate === 'waiting' ? `<span class="tag amber">待决 ${t.gate.pending.length}</span>` : '—';
    return `<tr>
      <td class="mono">${esc(t.id)}</td>
      <td class="mono">${esc(t.state)}</td>
      <td class="mono">${t.state_version}</td>
      <td class="mono">${esc(t.author)}<br>${esc(t.reviewer)}</td>
      <td>${esc(stageName)}</td>
      <td class="mono">无开放告警</td>
      <td>${needHuman}</td>
      <td class="mono">${t.lastActivityMin} 分钟前</td>
    </tr>`;
  }).join('');
}

/* ---------- 选择与指令条 ---------- */
function updateInjectBar() {
  const bar = $('#injectBar');
  const t = cur();
  const targetable = writeMode && selection &&
    (selection.stageId === 'author' || (selection.kind === 'worker' && selection.stageId === 'author'));
  if (!targetable) { bar.classList.remove('open'); bar.setAttribute('aria-hidden', 'true'); return; }
  const label = selection.kind === 'worker'
    ? `${t.author} / ${selection.workerId}`
    : `${t.author}（主作者）`;
  $('#injectTarget').textContent = label;
  bar.classList.add('open');
  bar.setAttribute('aria-hidden', 'false');
}

function selectStage(stageId) {
  selection = { kind: 'stage', stageId };
  const t = cur();
  const stage = STAGES.find((s) => s.id === stageId);
  openDrawer(stage.name, 'NODE · ' + stage.sub, drawerHtmlForStage(t, stageId));
  renderPipeline();
  updateInjectBar();
}

function selectWorker(stageId, workerId) {
  selection = { kind: 'worker', stageId, workerId };
  const t = cur();
  openDrawer(workerId === '__reviewer' ? t.reviewer : workerId,
    'WORKER · ' + (stageId === 'review' ? 'REVIEW' : 'AUTHOR'),
    drawerHtmlForWorker(t, stageId, workerId));
  renderPipeline();
  document.querySelectorAll(`.worker[data-worker="${workerId}"]`).forEach((el) => el.classList.add('selected'));
  updateInjectBar();
}

/* ---------- 注入指令（模拟三档状态推进） ---------- */
function sendInject() {
  const input = $('#injectInput');
  const text = input.value.trim();
  if (!text || !selection) return;
  const t = cur();
  const w = selection.kind === 'worker'
    ? t.workers.find((x) => x.id === selection.workerId)
    : t.workers[0]; // 主作者指令落在 w1（模拟）
  if (!w) return;
  const inj = { text, step: 0 };
  w.injects.push(inj);
  input.value = '';
  rerenderKeepDrawer();
  setTimeout(() => { inj.step = 1; rerenderKeepDrawer(); }, 2000); // 模拟：已接收
  setTimeout(() => { inj.step = 2; rerenderKeepDrawer(); }, 5000); // 模拟：已落实
}

function rerenderKeepDrawer() {
  renderPipeline();
  renderList();
  if (selection) {
    const t = cur();
    $('#drawerBody').innerHTML = selection.kind === 'worker'
      ? drawerHtmlForWorker(t, selection.stageId, selection.workerId)
      : drawerHtmlForStage(t, selection.stageId);
  }
  updateUvBadge();
}

/* ---------- 顶栏：不可核验徽标 / 时钟 / 模式 ---------- */
function updateUvBadge() {
  const n = cur().unverifiable.length;
  $('#uvCount').textContent = n;
  $('#unverifiableBadge').classList.toggle('hidden', n === 0);
}

function tickClock() {
  const d = new Date();
  $('#asOf').textContent = d.toTimeString().slice(0, 8);
}

function setMode(write) {
  writeMode = write;
  const badge = $('#modeBadge');
  badge.textContent = write ? '写模式' : '只读';
  badge.className = 'badge ' + (write ? 'badge-write' : 'badge-readonly');
  $('#modeToggle').textContent = write ? '切到只读' : '切到写模式';
  updateInjectBar();
  if (selection) rerenderKeepDrawer();
}

/* ---------- 原型演示控制（模拟实时事件流，非设计一部分） ---------- */
function demo(action) {
  const t = tasks[0]; // 演示事件作用于一号任务
  if (action === 'approve' && t.stages.gate === 'waiting') {
    t.stages.gate = 'passed'; t.stages.accept = 'active';
    t.gate = { band: 'D', verdict: 'ALLOW', pending: [], note: '签名批准已复验（state_version 41），闭包满足' };
    t.state = 'ACCEPTANCE_RUNNING'; t.state_version += 1; t.lastActivityMin = 0;
  }
  if (action === 'accept' && t.stages.accept === 'active') {
    t.stages.accept = 'passed'; t.stages.promote = 'active';
    t.state = 'PUBLISHING'; t.state_version += 1; t.lastActivityMin = 0;
  }
  if (action === 'promote' && t.stages.promote === 'active') {
    t.stages.promote = 'passed';
    t.state = 'COMPLETED'; t.state_version += 1; t.lastActivityMin = 0;
  }
  if (action === 'fail') {
    t.stages.review = 'failed'; t.stages.gate = 'pending'; t.stages.accept = 'pending'; t.stages.promote = 'pending';
    t.review = { verdict: 'FAIL', digest: '9f2ca4…e1b7', bound: 'sealed snapshot #3', by: t.reviewer + '（独立于作者 ✓）' };
    t.state = 'REVIEW_FAILED'; t.state_version += 1; t.lastActivityMin = 0;
  }
  if (action === 'reset') {
    tasks = freshTasks(); currentTaskId = tasks[0].id; selection = null; closeDrawer();
    $('#taskSelect').value = currentTaskId;
  }
  rerenderKeepDrawer();
}

/* ---------- 初始化 ---------- */
function switchView(v) {
  const isPipeline = v === 'pipeline';
  $('#pipelineView').classList.toggle('hidden', !isPipeline);
  $('#listView').classList.toggle('hidden', isPipeline);
  $('#viewPipeline').classList.toggle('active', isPipeline);
  $('#viewList').classList.toggle('active', !isPipeline);
  $('#viewPipeline').setAttribute('aria-selected', String(isPipeline));
  $('#viewList').setAttribute('aria-selected', String(!isPipeline));
}

function init() {
  const sel = $('#taskSelect');
  sel.innerHTML = tasks.map((t) => `<option value="${esc(t.id)}">${esc(t.id)} · ${esc(t.goal)}</option>`).join('');
  sel.addEventListener('change', () => {
    currentTaskId = sel.value; selection = null; closeDrawer(); rerenderKeepDrawer();
  });

  $('#drawerClose').addEventListener('click', () => { selection = null; closeDrawer(); renderPipeline(); updateInjectBar(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { selection = null; closeDrawer(); renderPipeline(); updateInjectBar(); }
  });

  $('#viewPipeline').addEventListener('click', () => switchView('pipeline'));
  $('#viewList').addEventListener('click', () => switchView('list'));
  $('#modeToggle').addEventListener('click', () => setMode(!writeMode));
  $('#injectSend').addEventListener('click', sendInject);
  $('#injectInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendInject(); });
  document.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => demo(b.dataset.demo)));

  // URL 参数（供截图/直达）：?task=2&view=list&mode=write&node=gate&demo=approve,accept
  const q = new URLSearchParams(location.search);
  if (q.get('task') === '2') { currentTaskId = tasks[1].id; sel.value = currentTaskId; }
  (q.get('demo') || '').split(',').filter(Boolean).forEach(demo);
  if (q.get('mode') === 'write') setMode(true);
  if (q.get('view') === 'list') switchView('list');

  renderPipeline();
  renderList();
  updateUvBadge();
  tickClock();
  setInterval(tickClock, 1000);
  setTimeout(() => { booted = true; $('#pipelineRow').classList.add('settled'); }, 2400);

  const node = q.get('node');
  if (node) setTimeout(() => selectStage(node), 100);
}

document.addEventListener('DOMContentLoaded', init);
