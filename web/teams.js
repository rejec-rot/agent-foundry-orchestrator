const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, extra = '') => '<svg class="icon ' + extra + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const labels = {
  CREATED: '待启动', PLANNING: '主作者规划中', WORKING: '成员协作中', INTEGRATING: '整合中',
  READY_FOR_REVIEW: '候选待交付', DELIVERING: '交付中', WAITING_HUMAN: '等待人工审批',
  COMPLETED: '已完成', BLOCKED: '等待处理', RECOVERY_REQUIRED: '需要恢复检查',
  PAUSED: '已暂停', CANCELLED: '已取消', READY: '等待依赖', RUNNING: '执行中',
  DONE: '产物已接受', FAILED: '执行失败', DISCARDED: '旧结果已拒绝', INTERRUPTED: '执行中断',
  IDLE: '准备就绪', PAUSING: '正在停止', queued: '已排队', received: '已收到', applied: '已落实',
  rejected: '已拒绝', superseded: '方向已更新',
};
const commandLabels = { start: '启动团队', pause: '暂停协作', cancel: '结束协作', deliver: '继续交付',
  message: '发送消息', adjust: '调整工作项', retry: '重试工作项', replan: '重新规划' };
const label = value => labels[value] ?? value;
const htmlCache = new Map();
const emptyMembers = $('members').innerHTML;
const emptyBoard = $('work-items').innerHTML;
const emptyActivity = $('messages').innerHTML;
let token = '';
try { token = sessionStorage.getItem('af-write-token') ?? ''; } catch {}
let selected = null, workId = null, team = null, capabilities = null, refreshing = false;
let pending = 0, editBase = null, goalBase = null, noticeTimer = null, lastConnectionError = null;

function operationId(prefix) {
  const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  return prefix + id;
}
function setHTML(id, html) {
  if (htmlCache.get(id) !== html) {
    $(id).innerHTML = html;
    htmlCache.set(id, html);
  }
}
async function request(path, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const options = body === null ? { cache: 'no-store' } : {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-af-csrf': '1' },
      body: JSON.stringify(body),
    };
    const res = await fetch(path, { ...options, signal: controller.signal });
    const envelope = await res.json(), model = envelope.model ?? envelope;
    if (!res.ok) throw new Error(model.reason ?? model.error ?? ('HTTP ' + res.status));
    return model;
  } finally { clearTimeout(timer); }
}
function notice(message, kind = 'info') {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').dataset.kind = kind;
  $('notice').hidden = false;
  const dialog = document.querySelector('dialog[open]');
  if (kind === 'error' && dialog) {
    let feedback = dialog.querySelector('.dialog-feedback');
    if (!feedback) {
      feedback = document.createElement('p');
      feedback.className = 'dialog-feedback';
      feedback.setAttribute('role', 'alert');
      const actions = dialog.querySelector('.dialog-actions');
      actions?.before(feedback);
    }
    feedback.textContent = message;
    feedback.hidden = false;
  }
  if (kind !== 'error') noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 7000);
}
function navigation(open) {
  $('sidebar').dataset.open = String(open);
  $('nav-backdrop').hidden = !open;
  $('menu-toggle').setAttribute('aria-expanded', String(open));
  const mobile = matchMedia('(max-width:720px)').matches;
  $('sidebar').inert = mobile && !open;
  $('workspace').inert = mobile && open;
  if (mobile && open) $('sidebar').querySelector('.nav-item').focus();
}
function openDialog(id) {
  if (!['create-dialog', 'token-dialog'].includes(id) && !team) {
    notice('先选择或创建一个团队。');
    return;
  }
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  const dialog = $(id);
  const feedback = dialog.querySelector('.dialog-feedback');
  if (feedback) feedback.hidden = true;
  if (id === 'create-dialog' && !$('key').value) $('key').value = operationId('goal-');
  if (id === 'token-dialog') $('token').value = token;
  if (id === 'replan-dialog') {
    $('new-goal').value = team.goal;
    goalBase = { teamId: team.team_id, revision: team.goal_revision };
  }
  navigation(false);
  dialog.showModal();
  const input = { 'create-dialog': 'goal', 'token-dialog': 'token', 'message-dialog': 'message',
    'work-dialog': 'direction', 'replan-dialog': 'new-goal' }[id];
  if (input) $(input).focus();
}
function writes() {
  const enabled = Boolean(token && capabilities?.write?.team_command) && pending === 0;
  const terminal = ['COMPLETED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(team?.state);
  for (const button of document.querySelectorAll('[data-write]')) {
    button.disabled = !enabled || (button.id !== 'create' && !team) ||
      (terminal && !['create', 'adjust', 'replan'].includes(button.id));
  }
  $('adjust').disabled = !enabled || !workId || editBase?.teamId !== team?.team_id ||
    ['CANCELLED', 'RECOVERY_REQUIRED'].includes(team?.state);
  $('retry').disabled = !enabled || !workId || editBase?.teamId !== team?.team_id || terminal;
  $('pause').disabled ||= ['CREATED', 'PAUSED'].includes(team?.state);
  $('deliver').disabled ||= !team?.integration || ['CREATED', 'PLANNING', 'WORKING', 'INTEGRATING', 'PAUSED'].includes(team?.state);
  $('start').disabled ||= ['PLANNING', 'WORKING', 'INTEGRATING', 'DELIVERING', 'PAUSING'].includes(team?.state);
  const handoff = ['READY_FOR_REVIEW', 'WAITING_HUMAN'].includes(team?.state) && team?.integration;
  $('start').querySelector('span').textContent = handoff ? '继续交付' :
    ['PAUSED', 'BLOCKED'].includes(team?.state) ? '恢复团队' :
    ['PLANNING', 'WORKING', 'INTEGRATING'].includes(team?.state) ? '团队协作中' :
    team?.state === 'DELIVERING' ? '正在交付' : team?.state === 'PAUSING' ? '正在停止' : '启动团队';
  $('start').querySelector('use').setAttribute('href', handoff ? '#i-arrow' : '#i-play');
  $('access-label').textContent = token ? '令牌已设置' : '连接令牌';
  const writable = token && capabilities?.write?.team_command;
  $('access-hint').textContent = writable ? '你的团队状态会自动更新，操作结果可在回执中查看。' :
    capabilities && !capabilities.write?.team_command ? '当前空间为只读模式，可查看团队状态与交付记录。' :
    '连接操作令牌后，即可启动和调整团队。';
  $('create-auth-hint').textContent = writable ? '目标创建后，由你决定何时启动协作。' : $('access-hint').textContent;
}
function memberName(id) {
  const member = team?.members.find(m => m.agent_id === id);
  if (member?.role === 'lead' || id === 'lead') return '主作者';
  if (['user', 'human', 'operator'].includes(id)) return '你';
  const number = /^worker-(\d+)$/.exec(id ?? '')?.[1];
  return number ? 'Worker ' + number.padStart(2, '0') : String(id ?? '团队');
}
function render() {
  if (!team) {
    $('team-goal').textContent = '你的下一次协作，从这里开始。';
    $('team-meta').textContent = '新建一个目标，或从左侧选择你的团队。';
    $('team-state').hidden = true;
    $('team-version').textContent = '';
    setHTML('members', emptyMembers); setHTML('work-items', emptyBoard);
    setHTML('messages', emptyActivity); setHTML('receipts', emptyActivity);
    setHTML('runs', '<p class="hint">团队启动后，会在这里记录每次执行。</p>');
    setHTML('artifacts', '<p class="hint">成员提交的成果会保留在这里。</p>');
    $('message-count').textContent = '0'; $('receipt-count').textContent = '0';
    setHTML('delivery', '整合成果后，继续独立评审与验收。');
    $('progress-label').textContent = '等待规划';
    $('progress-fill').style.width = '0%';
    document.querySelector('.progress-track').setAttribute('aria-valuenow', '0');
    writes();
    return;
  }
  $('team-goal').textContent = team.goal;
  $('team-state').textContent = label(team.state); $('team-state').hidden = false;
  $('team-state').dataset.state = team.state;
  $('team-version').textContent = 'GOAL / ' + String(team.goal_revision).padStart(2, '0');
  $('team-meta').textContent = team.failure_reason ?? (team.members.length + ' 位成员 · 主作者组织分工与整合，你来掌握方向。');
  $('team-meta').title = team.team_id;
  setHTML('members', team.members.map((member, index) => {
    const active = team.runs.findLast(run => run.agent_id === member.agent_id && run.status === 'RUNNING');
    const status = active?.process_state === 'QUEUED' ? '等待执行额度' :
      active?.process_state === 'RUNNING' ? '进程运行中' : label(member.status);
    return '<button type="button" class="member-card ' + (member.role === 'lead' ? 'lead' : '') +
      '" data-member="' + esc(member.agent_id) + '" data-running="' + Boolean(active) +
      '" aria-label="与' + esc(memberName(member.agent_id)) + '对话"><span class="member-avatar" aria-hidden="true">' +
      (member.role === 'lead' ? 'L' : String(index).padStart(2, '0')) + '</span><span class="member-detail"><strong>' +
      esc(memberName(member.agent_id)) + '</strong><small>' + esc(member.executor_type) +
      '</small><span class="member-status">' + esc(status) + '</span></span>' + icon('arrow', 'member-cta') + '</button>';
  }).join(''));
  const chosen = $('member-target').value, chosenWorker = $('worker-target').value;
  setHTML('member-target', team.members.map(m => '<option value="' + esc(m.agent_id) + '">' +
    esc(memberName(m.agent_id)) + ' · ' + esc(m.executor_type) + '</option>').join(''));
  if (team.members.some(m => m.agent_id === chosen)) $('member-target').value = chosen;
  setHTML('worker-target', team.members.filter(m => m.role === 'worker').map(m => '<option value="' +
    esc(m.agent_id) + '">' + esc(memberName(m.agent_id)) + ' · ' + esc(m.executor_type) + '</option>').join(''));
  if (team.members.some(m => m.role === 'worker' && m.agent_id === chosenWorker)) $('worker-target').value = chosenWorker;
  setHTML('work-items', team.work_items.length ? team.work_items.map((item, index) => {
    return '<button type="button" class="work-card ' + (item.work_item_id === workId ? 'selected' : '') +
      '" data-work="' + esc(item.work_item_id) + '" data-state="' + esc(item.status) +
      '" aria-label="查看并调整工作项：' + esc(item.goal) +
      '"><span class="work-card-top"><span class="work-number" aria-hidden="true">' + String(index + 1).padStart(2, '0') +
      '</span><span class="work-status">' + esc(label(item.status)) + '</span></span><strong>' +
      esc(item.work_item_id) + '</strong><span class="work-goal">' + esc(item.goal) +
      '</span><span class="work-dependency">' + (item.depends_on.length ?
        '依赖 ' + esc(item.depends_on.join(' + ')) : '↗ 可独立执行') +
      '</span><span class="work-assignment"><span>' + esc(memberName(item.agent_id)) +
      ' · v' + esc(item.revision) + '</span>' + icon('arrow') + '</span>' +
      (item.blocked_reason ? '<span class="work-error">' + esc(item.blocked_reason) + '</span>' : '') + '</button>';
  }).join('') : '<div class="empty-board"><span aria-hidden="true">↗</span><h4>' +
    (team.state === 'CREATED' ? '团队已集结，随时可以行动。' : '主作者正在组织行动计划。') +
    '</h4><p>主作者会规划分工、依赖与交付要求。<br>每个工作项都可以单独沟通和调整。</p></div>');
  const current = team.work_items.find(item => item.work_item_id === workId);
  if (!current) {
    workId = null; editBase = null;
    if ($('work-dialog').open) $('work-dialog').close();
  }
  $('selected-work').textContent = current ? current.work_item_id + ' · ' + memberName(current.agent_id) +
    ' · 编辑版本 ' + (editBase?.revision ?? current.revision) +
    (editBase && current.revision !== editBase.revision ? '（方向已更新，请重新打开工作项）' : '') : '先选择一个工作项。';
  const done = team.work_items.filter(item => item.status === 'DONE').length, total = team.work_items.length;
  const progress = total ? Math.round(done / total * 100) : 0;
  $('progress-label').textContent = total ? done + ' / ' + total + ' 已完成' : '等待规划';
  $('progress-fill').style.width = progress + '%';
  document.querySelector('.progress-track').setAttribute('aria-valuenow', String(progress));
  setHTML('delivery', team.delivery ? esc(label(team.delivery.status)) + ' · ' +
    esc(team.delivery.phase ?? '') + ' · <a href="/workbench.html#' + encodeURIComponent(team.delivery.task_id) +
    '">查看交付证据 ↗</a>' : team.integration ? '候选已整合，可继续独立评审与验收。' : '整合成果后，继续独立评审与验收。');
  $('message-count').textContent = String(team.messages.length);
  $('receipt-count').textContent = String(team.commands.length);
  setHTML('messages', team.messages.slice(-30).reverse().map(message => '<article class="history-card"><strong>' +
    esc(memberName(message.from_agent_id)) + ' → ' + esc(memberName(message.to_agent_id)) +
    '</strong><span class="history-state">' + esc(label(message.status)) + '</span><p>' +
    esc(message.message) + '</p>' + (message.reply_to ? '<small>回复 ' + esc(message.reply_to) + '</small>' : '') +
    '</article>').join('') || emptyActivity);
  setHTML('receipts', team.commands.slice(-20).reverse().map(command => '<article class="history-card"><strong>' +
    esc(commandLabels[command.type] ?? command.type) + ' · ' + esc(label(command.status)) +
    '</strong><p>' + esc(command.message ?? command.reason ?? '操作已登记') + '</p>' +
    (command.evidence ? '<small>已记录落实证据</small>' : '') + '</article>').join('') ||
    '<div class="empty-activity">' + icon('check') + '<p>每次行动，都会有回应。</p><span>操作提交后，在这里查看落实情况。</span></div>');
  setHTML('runs', team.runs.slice(-30).reverse().map(run => '<article class="history-card"><strong>' +
    esc(memberName(run.agent_id)) + ' · ' + esc(run.work_item_id) + '</strong><span class="history-state">' +
    esc(label(run.status)) + ' · ' + esc(run.executor_type) + '</span><p>' + esc(run.run_id) + '</p></article>').join('') ||
    '<p class="hint">团队启动后，会在这里记录每次执行。</p>');
  setHTML('artifacts', team.artifacts.slice(-12).reverse().map(artifact => '<article class="history-card"><strong>' +
    esc(artifact.work_item_id) + ' · 版本 ' + esc(artifact.revision) + '</strong><p>' + esc(artifact.summary) +
    '</p><small>' + esc(artifact.artifact_id) + ' · ' + esc(artifact.manifest?.summary?.totalChanges ?? 0) +
    ' 项文件变化</small></article>').join('') || '<p class="hint">成员提交的成果会保留在这里。</p>');
  writes();
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('refresh').setAttribute('aria-busy', 'true');
  try {
    if (!capabilities) capabilities = await request('/api/v2/capabilities');
    const listing = await request('/api/teams');
    if (selected && !listing.teams.some(item => item.team_id === selected)) { selected = null; team = null; workId = null; }
    if (!selected && listing.teams.length) selected = listing.teams[0].team_id;
    $('team-count').textContent = String(listing.teams.length).padStart(2, '0');
    setHTML('teams', listing.teams.map(item => '<button type="button" data-team="' + esc(item.team_id) +
      '" aria-current="' + (item.team_id === selected) + '"><strong>' + esc(item.goal) +
      '</strong><small>' + esc(label(item.state)) + ' · ' + item.members.length +
      ' 位成员</small></button>').join('') || '<p class="sidebar-empty">你的团队会在这里集合。<br>新建一个目标，开始第一次协作。</p>');
    const id = selected;
    if (id) {
      const model = await request('/api/teams/' + encodeURIComponent(id));
      if (selected === id) { team = model; render(); }
    } else render();
    $('connection').dataset.status = 'connected';
    $('connection').querySelector('span').textContent = '实时连接';
    lastConnectionError = null;
  } catch (error) {
    $('connection').dataset.status = 'error';
    $('connection').querySelector('span').textContent = '连接中断';
    if (lastConnectionError !== error.message) notice(error.name === 'AbortError' ? '连接超时，正在等待服务恢复。' : error.message, 'error');
    lastConnectionError = error.message;
  } finally {
    refreshing = false;
    $('refresh').removeAttribute('aria-busy');
  }
}
async function command(payload, baseTeam = team?.team_id) {
  if (!baseTeam) throw new Error('先选择一个团队。');
  const result = await request('/api/teams/' + encodeURIComponent(baseTeam) + '/commands',
    { command: payload, command_id: operationId('CMD-') });
  notice('操作已排队。成员领取与落实情况会显示在操作回执中。');
  await refresh();
  return result;
}
const handle = (fn, write = true) => async event => {
  event?.preventDefault();
  if (write && pending) return;
  const button = event?.submitter ?? (event?.currentTarget?.tagName === 'BUTTON' ? event.currentTarget : null);
  if (write) { pending++; button?.setAttribute('aria-busy', 'true'); writes(); }
  const feedback = event?.currentTarget?.closest('dialog')?.querySelector('.dialog-feedback');
  if (feedback) feedback.hidden = true;
  try { await fn(event); } catch (error) { notice(error.name === 'AbortError' ? '操作请求超时，请查看回执后再重试。' : error.message, 'error'); }
  finally { if (write) { pending--; button?.removeAttribute('aria-busy'); writes(); } }
};
document.addEventListener('click', event => {
  const opener = event.target.closest('[data-open]');
  if (opener) openDialog(opener.dataset.open);
  const closer = event.target.closest('[data-close]');
  if (closer) closer.closest('dialog').close();
});
$('menu-toggle').onclick = () => navigation($('sidebar').dataset.open !== 'true');
$('nav-backdrop').onclick = () => { navigation(false); $('menu-toggle').focus(); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('sidebar').dataset.open === 'true') { navigation(false); $('menu-toggle').focus(); }
});
const mobile = matchMedia('(max-width:720px)');
const syncNavigation = () => { navigation(false); $('sidebar').inert = mobile.matches; };
mobile.addEventListener('change', syncNavigation);
syncNavigation();
$('refresh').onclick = refresh;
$('teams').onclick = handle(async event => {
  const id = event.target.closest('[data-team]')?.dataset.team;
  if (!id || id === selected) return;
  selected = id; workId = null; editBase = null; team = null;
  navigation(false); render();
  await refresh();
}, false);
$('members').onclick = event => {
  const id = event.target.closest('[data-member]')?.dataset.member;
  if (id) { $('member-target').value = id; openDialog('message-dialog'); }
};
$('work-items').onclick = event => {
  const id = event.target.closest('[data-work]')?.dataset.work;
  if (!id) return;
  const item = team.work_items.find(work => work.work_item_id === id);
  workId = id; editBase = { teamId: team.team_id, revision: item.revision };
  $('member-target').value = item.agent_id; $('worker-target').value = item.agent_id;
  $('direction').value = item.goal;
  render();
  $('work-items').querySelector('[data-work="' + CSS.escape(id) + '"]').focus();
  openDialog('work-dialog');
};
$('token-form').onsubmit = event => {
  event.preventDefault();
  token = $('token').value.trim();
  try { if (token) sessionStorage.setItem('af-write-token', token); else sessionStorage.removeItem('af-write-token'); } catch {}
  writes(); $('token-dialog').close();
  notice(token ? '操作令牌已保存到本次会话。' : '操作令牌已清除。');
};
for (const id of ['start', 'pause', 'cancel', 'deliver']) $(id).onclick = handle(() =>
  command({ type: id === 'start' && ['READY_FOR_REVIEW', 'WAITING_HUMAN'].includes(team?.state) && team?.integration ? 'deliver' : id }));
$('message-form').onsubmit = handle(async () => {
  const message = $('message').value.trim();
  if (!message) throw new Error('写下一条消息，再发送给成员。');
  await command({ type: 'message', agent_id: $('member-target').value, message });
  $('message-dialog').close(); $('message').value = '';
});
$('work-form').onsubmit = handle(async () => {
  if (!editBase || !workId) throw new Error('重新选择需要调整的工作项。');
  const message = $('direction').value.trim();
  if (!message) throw new Error('请填写新的工作方向。');
  await command({ type: 'adjust', work_item_id: workId, expected_revision: editBase.revision,
    agent_id: $('worker-target').value, message }, editBase.teamId);
  $('work-dialog').close();
});
$('retry').onclick = handle(async () => {
  if (!editBase || !workId) throw new Error('重新选择需要重试的工作项。');
  await command({ type: 'retry', work_item_id: workId, expected_revision: editBase.revision }, editBase.teamId);
  $('work-dialog').close();
});
$('replan-form').onsubmit = handle(async () => {
  if (!goalBase) throw new Error('重新打开需要调整的目标。');
  const goal = $('new-goal').value.trim();
  if (!goal) throw new Error('请填写新的整体目标。');
  await command({ type: 'replan', goal, expected_goal_revision: goalBase.revision }, goalBase.teamId);
  $('replan-dialog').close();
});
$('workers').oninput = () => { $('workers-output').value = $('workers').value; };
$('create-form').onsubmit = handle(async () => {
  let args;
  try { args = JSON.parse($('args').value); } catch { throw new Error('验收参数需要有效的 JSON 字符串数组。'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('验收参数需要字符串数组。');
  const result = await request('/api/teams', { spec: {
    goal: $('goal').value.trim(), target_path: $('target').value.trim(),
    acceptance: { command: $('command').value.trim(), args }, idempotency_key: $('key').value,
  }, worker_count: Number($('workers').value) });
  selected = result.team_id; workId = null; editBase = null;
  $('create-dialog').close(); $('create-form').reset(); $('key').value = operationId('goal-');
  $('workers-output').value = $('workers').value;
  notice('团队已创建。准备好后，启动你的第一次协作。');
  await refresh();
});
function selectTab(id) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === id;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    $(button.dataset.tab).hidden = !active;
  }
}
for (const button of document.querySelectorAll('[data-tab]')) {
  button.onclick = () => selectTab(button.dataset.tab);
  button.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const id = event.key === 'Home' ? 'messages' : event.key === 'End' ? 'receipts' :
      button.dataset.tab === 'messages' ? 'receipts' : 'messages';
    selectTab(id); $(id + '-tab').focus();
  };
}
$('key').value = operationId('goal-');
writes();
await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
