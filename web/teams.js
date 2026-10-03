const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, extra = '') => '<svg class="icon ' + extra + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const labels = {
  CREATED: '待启动', DISCUSSING: '与 Planner 商讨', PLAN_READY: '等待确认计划', DRAFT: '待确认派工', HELD: '暂停 · Planner 改向', PLANNING: 'Planner 规划中', WORKING: '成员协作中', INTEGRATING: '整合中',
  READY_FOR_REVIEW: '候选待交付', DELIVERING: '交付中', WAITING_HUMAN: '等待人工审批',
  COMPLETED: '已完成', BLOCKED: '等待处理', RECOVERY_REQUIRED: '需要恢复检查',
  PAUSED: '已暂停', CANCELLED: '已取消', READY: '等待依赖', RUNNING: '执行中',
  DONE: '产物已接受', FAILED: '执行失败', DISCARDED: '旧结果已拒绝', INTERRUPTED: '执行中断',
  IDLE: '准备就绪', PAUSING: '正在停止', queued: '已排队', received: '已收到', applied: '已落实',
  rejected: '已拒绝', superseded: '方向已更新', delivered: '已回复',
};
const commandLabels = { start: '启动团队', pause: '暂停协作', cancel: '结束协作', deliver: '继续交付',
  message: '发送消息', adjust: '调整工作项', retry: '重试工作项', replan: '重新规划', propose_plan: '请求行动计划', approve_plan: '确认编组并派工', configure_agents:'更新 Agent 配置' };
const label = value => labels[value] ?? value;
const effortLabels = { none:'关闭', off:'关闭', minimal:'极低', low:'轻量', medium:'标准', high:'深入', xhigh:'高强度', max:'最高', ultra:'Ultra' };
const effortLabel = value => effortLabels[value] ?? value;
const htmlCache = new Map();
const emptyMembers = $('members').innerHTML;
const emptyBoard = $('work-items').innerHTML;
const emptyActivity = $('messages').innerHTML;
let token = '';
try { token = sessionStorage.getItem('af-write-token') ?? ''; } catch {}
let selected = null, workId = null, team = null, capabilities = null, refreshing = false;
let pending = 0, editBase = null, goalBase = null, noticeTimer = null, lastConnectionError = null;
let executorCatalog = null, dispatchBase = null, profileDraft = [], agentScan = null;
let createWorkersDraft = null, consoleProfileBase = null, consoleProfileDirty = false, consoleProfileKey = '', consoleProfileEditable = null, configCommand = null;
const emptyConversation = $('planner-conversation').innerHTML;

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
async function request(path, body = null, { timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
function openDialog(id, configureWorkers=false) {
  if (!['create-dialog', 'token-dialog', 'dispatch-dialog'].includes(id) && !team) {
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
  if (id === 'dispatch-dialog') {
    if(!executorCatalog){notice('正在读取 Agent 配置，请稍后打开。');return;}
    if(team && !team.planning){notice('此团队使用原有启动流程；新建 Planner 目标后可配置 Agents。');return;}
    const mode=!team?'local':!configureWorkers&&team.state==='PLAN_READY'?'approve':'configure';
    dispatchBase = {mode,teamId:team?.team_id??null, revision:team?.plan_revision??0, goalRevision:team?.goal_revision??0,
      configRevision:team?.planning?.agent_config_revision??0,items:team?.work_items.map(i=>({...i}))??[]};
    profileDraft = team?team.members.filter(m=>m.role==='worker').map(({executor_type,model,effort})=>({executor_type,model,effort})):structuredClone(createWorkersDraft??Array.from({length:3},()=>consoleProfile()));
    $('dispatch-workers').value=String(profileDraft.length);
    $('dispatch-workers').disabled=Boolean(team?.planning?.approved_plan_revision!==null&&team?.planning?.approved_plan_revision!==undefined);
    $('dispatch-heading').textContent=mode==='approve'?'这一次，让谁行动？':'选择你的 Worker Agents。';
    $('dispatch-plan-version').textContent=mode==='approve'?'计划 v'+dispatchBase.revision+' · '+dispatchBase.items.length+' 个工作项 · 确认模型、强度与分工。':mode==='local'?'预设编组会随新目标一起保存；也可让 Planner 推荐。':'每位 Worker 可用相同或不同的 Agent、模型与思考强度。';
    $('worker-profile-hint').textContent=mode==='approve'?'确认后才开始执行。Planner / Reviewer 的配置保持一致。':team&& !canConfigureAgents()?'执行中先暂停团队，待全部尝试停止后再保存配置。':'保存配置不会开工。生成计划时，Planner 会遵循你预设的 Worker 编组。';
    $('assignment-heading').hidden=mode!=='approve';$('work-assignments').hidden=mode!=='approve';
    $('approve-plan').innerHTML=(mode==='approve'?'确认并开工':mode==='local'?'使用这套编组':'保存 Worker 配置')+' '+icon('arrow');
    renderDispatch();
  }
  navigation(false);
  dialog.showModal();
  const input = { 'create-dialog': 'goal', 'token-dialog': 'token', 'message-dialog': 'message',
    'work-dialog': 'direction', 'replan-dialog': 'new-goal', 'dispatch-dialog':'dispatch-workers' }[id];
  if (input) $(input).focus();
}
function writes() {
  const enabled = Boolean(token && capabilities?.write?.team_command) && pending === 0;
  const terminal = ['COMPLETED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(team?.state);
  for (const button of document.querySelectorAll('[data-write]')) {
    button.disabled = !enabled || (button.id !== 'create' && !team) ||
      (terminal && !['create', 'adjust', 'replan'].includes(button.id));
  }
  const plannerEntry=executorCatalog?.find(e=>e.id===$('planner-executor').value);
  $('create').disabled ||= !plannerEntry || plannerEntry.availability!=='AVAILABLE' || !plannerEntry.supports_planner || !profileModelReady(plannerEntry,$('planner-model-input').value.trim());
  $('adjust').disabled = !enabled || !workId || editBase?.teamId !== team?.team_id ||
    ['CANCELLED', 'RECOVERY_REQUIRED'].includes(team?.state);
  $('retry').disabled = !enabled || !workId || editBase?.teamId !== team?.team_id || terminal;
  if(team?.planning && ['DRAFT','HELD'].includes(team.work_items.find(i=>i.work_item_id===workId)?.status)){ $('adjust').disabled=true; $('retry').disabled=true; }
  $('planner-send').disabled = !enabled || consoleProfileDirty || Boolean(configCommand) || !team?.planning || !['DISCUSSING','PLAN_READY','WORKING','BLOCKED'].includes(team.state);
  $('propose-plan').disabled = !enabled || consoleProfileDirty || Boolean(configCommand) || !team?.planning || !['DISCUSSING','PLAN_READY'].includes(team.state) || team.members.find(m=>m.role==='lead')?.status==='RUNNING';
  $('configure-dispatch').disabled = !enabled || team?.state!=='PLAN_READY' || team.members.find(m=>m.role==='lead')?.status==='RUNNING' || team.messages.some(m=>m.to_agent_id==='lead'&&['queued','received'].includes(m.status));
  $('approve-plan').disabled = pending>0 || Boolean(configCommand) || (dispatchBase?.mode==='local'?false:
    !enabled || dispatchBase?.teamId!==team?.team_id || dispatchBase?.revision!==team?.plan_revision || dispatchBase?.configRevision!==(team?.planning?.agent_config_revision??0) ||
    (dispatchBase?.mode==='approve'?$('configure-dispatch').disabled:!canConfigureAgents()));
  const workerProfilesReady=selectedWorkersDispatchable();
  if([...document.querySelectorAll('.worker-profile')].some(row=>!profileModelReady(entryFor(row.querySelector('[data-profile-executor]').value,Boolean(team?.planning)),row.querySelector('[data-profile-model]').value.trim())))$('approve-plan').disabled=true;
  if(dispatchBase?.mode==='approve'&&!workerProfilesReady){
    $('approve-plan').disabled=true;
    $('worker-profile-hint').textContent='待注册、停用或待适配的 Agent 可以查看配置，但当前不能派工。请为每位 Worker 选择可派工的适配器。';
  }else if(dispatchBase?.mode==='approve')$('worker-profile-hint').textContent='确认后开始执行。Planner / Reviewer 的配置保持一致。';
  $('save-console-planner').disabled=pending>0 || Boolean(configCommand) || (team ? !enabled || !canConfigureAgents() || !consoleProfileDirty : !$('console-planner-executor').value);
  $('save-console-planner').disabled ||= !profileModelReady(entryFor($('console-planner-executor').value,Boolean(team?.planning)),$('console-planner-model-input').value.trim());
  $('pause').disabled ||= ['CREATED', 'PAUSED'].includes(team?.state);
  $('deliver').disabled ||= !team?.integration || ['CREATED', 'PLANNING', 'WORKING', 'INTEGRATING', 'PAUSED'].includes(team?.state);
  $('start').disabled ||= ['PLANNING', 'WORKING', 'INTEGRATING', 'DELIVERING', 'PAUSING'].includes(team?.state);
  const handoff = ['READY_FOR_REVIEW', 'WAITING_HUMAN'].includes(team?.state) && team?.integration;
  $('start').querySelector('span').textContent = handoff ? '继续交付' :
    ['PAUSED', 'BLOCKED'].includes(team?.state) ? '恢复团队' :
    ['PLANNING', 'WORKING', 'INTEGRATING'].includes(team?.state) ? '团队协作中' :
    team?.state === 'DELIVERING' ? '正在交付' : team?.state === 'PAUSING' ? '正在停止' : '启动团队';
  $('start').querySelector('use').setAttribute('href', handoff ? '#i-arrow' : '#i-play');
  if(team?.planning && ['DISCUSSING','PLAN_READY'].includes(team.state)) $('start').querySelector('span').textContent=team.state==='PLAN_READY'?'确认计划与编组':'与 Planner 商讨';
  $('access-label').textContent = token ? '令牌已设置' : '连接令牌';
  const writable = token && capabilities?.write?.team_command;
  $('access-hint').textContent = writable ? '你的团队状态会自动更新，操作结果可在回执中查看。' :
    capabilities && !capabilities.write?.team_command ? '当前空间为只读模式，可查看团队状态与交付记录。' :
    '连接操作令牌后，即可启动和调整团队。';
  $('create-auth-hint').textContent = writable ? '创建后先进入 Planner 商讨；开工方式以你的选择为准。' : $('access-hint').textContent;
  $('create-auth-hint').hidden=Boolean(writable);
}
function memberName(id) {
  const member = team?.members.find(m => m.agent_id === id);
  if (member?.role === 'lead' || id === 'lead') return 'Planner';
  if (['user', 'human', 'operator'].includes(id)) return '你';
  const number = /^worker-(\d+)$/.exec(id ?? '')?.[1];
  return number ? 'Worker ' + number.padStart(2, '0') : String(id ?? '团队');
}
function renderPlanner() {
  document.body.dataset.hasTeam=String(Boolean(team));
  const legacy=Boolean(team&&!team.planning);
  $('console-planner-form').hidden=legacy;
  $('configure-workers').hidden=legacy;$('worker-config-summary').hidden=legacy;
  renderConsoleProfile();
  if(configCommand && configCommand.teamId!==team?.team_id)configCommand=null;
  if(configCommand) {
    const receipt=team?.team_id===configCommand.teamId?team.commands.find(c=>c.command_id===configCommand.commandId):null;
    if(receipt && ['applied','rejected'].includes(receipt.status)) {
      if(receipt.status==='applied') {if(configCommand.role==='planner')consoleProfileDirty=false;consoleProfileKey='';notice('Agent 配置已保存，下一次执行使用新配置。');}
      else notice(receipt.reason??'配置未保存，请刷新后重新确认。','error');
      configCommand=null;renderConsoleProfile();
    }
  }
  const workerCount=team?.members.filter(m=>m.role==='worker').length??createWorkersDraft?.length;
  $('worker-config-summary').textContent=workerCount?workerCount+' 位 Worker · 点击「选择 Worker Agents」逐个设置模型与思考强度。':'可预设每位 Worker 的 Agent、模型与思考强度，也可让 Planner 推荐。';
  $('planner-chat-form').hidden=legacy;
  document.querySelector('.chat-suggestions').hidden=legacy;
  const planner=team?.planning?.planner??team?.members.find(m=>m.role==='lead');
  $('planner-model').textContent=planner?planner.executor_type+' / '+(planner.model??'默认模型')+' · '+(planner.effort?effortLabel(planner.effort)+'思考':'默认强度'):'选择模型与思考强度，建立你的行动小队。';
  $('dispatch-mode-label').textContent=legacy?'此团队保留原有启动流程。':team?.planning?.dispatch_mode==='planner'?'Planner 推荐编组后自动开工。':'由你确认，团队才开工。';
  $('propose-plan').innerHTML=(team?.state==='PLAN_READY'?'重新生成计划':team?.planning?.dispatch_mode==='planner'?'生成计划并开工':'生成行动计划')+' '+icon('arrow');
  $('adjust').innerHTML=(legacy?'更新方向':'暂停并交给 Planner')+' '+icon('arrow');
  $('work-change-hint').textContent=legacy?'停止旧尝试并更新受影响的依赖，保留其他成员已接受的成果。':'先停止当前项及依赖它的旧尝试 → 通知 Planner → Planner 改写任务 → 重新派工。其他成员的已接受成果继续保留。';
  $('plan-approval').hidden=team?.state!=='PLAN_READY';
  const phase=!team||['CREATED','DISCUSSING'].includes(team.state)?'discuss':['PLANNING','PLAN_READY'].includes(team.state)?'plan':
    ['WORKING','INTEGRATING','PAUSED','PAUSING','BLOCKED'].includes(team.state)?'work':'review';
  for(const item of document.querySelectorAll('[data-phase]'))item.dataset.current=String(item.dataset.phase===phase);
  const conversation=team?.messages.filter(m=>m.goal_revision===team.goal_revision && ((m.from_agent_id==='operator'&&m.to_agent_id==='lead') || (m.from_agent_id==='lead'&&m.to_agent_id==='operator')))??[];
  const log=$('planner-conversation'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<48;
  const html=legacy?'<div class="chat-empty"><span class="calling-card" aria-hidden="true">YOUR NEXT<br><b>MOVE AWAITS.</b><i>✦</i></span><h4>开启新的 Planner 协作。</h4><p>当前团队使用原有启动流程。<br>新建目标，即可先聊天、确认编组后开工。</p><button class="text-button" type="button" data-open="create-dialog">新建 Planner 目标 '+icon('arrow')+'</button></div>':conversation.slice(-60).map(m=>'<article class="chat-bubble '+(m.from_agent_id==='operator'?'from-operator':'from-planner')+'"><strong>'+esc(memberName(m.from_agent_id))+'<small>'+esc(label(m.status))+'</small></strong><p>'+esc(m.message)+'</p></article>').join('') || emptyConversation;
  const active=team?.runs.findLast(r=>r.agent_id==='lead'&&r.status==='RUNNING');
  const next=html+(active?'<p class="planner-thinking" role="status">✦ '+(active.kind==='revise'?'Planner 正在改写任务方向…':active.kind==='plan'?'Planner 正在拟定行动计划…':'Planner 正在思考…')+'</p>':'');
  const changed=htmlCache.get('planner-conversation')!==next;setHTML('planner-conversation',next);
  if(changed&&atBottom)log.scrollTop=log.scrollHeight;
  const requests=team?.rework_requests?.filter(q=>q.status==='queued')??[];
  $('rework-status').hidden=!requests.length;
  setHTML('rework-status',requests.map(q=>'<strong>↯ '+esc(q.work_item_id)+' · 暂停 → Planner 改向 → 重新派工</strong><p>'+esc(q.feedback)+'</p>').join(''));
}
function unsupportedAdapter(entry) {
  return entry?.adapter_status==='unsupported'||entry?.availability==='UNSUPPORTED';
}
function executorOptionStatus(entry,role) {
  if(unsupportedAdapter(entry))return '待适配';
  if(role==='planner'&&entry.supports_planner===false)return '仅 Worker';
  if(entry.availability==='DISABLED_BY_OPERATOR')return '已停用';
  if(entry.availability==='UNREGISTERED')return '待平台注册';
  if(entry.availability==='UNAVAILABLE')return '当前不可派工';
  if(entry.availability==='AVAILABLE')return '可派工';
  if(entry.installed===false)return '未检测到安装';
  return '';
}
function executorOptions(selectedId,role='planner',useEligible=false) {
  let entries=useEligible&&team?.planning
    ?team.planning.eligible_executors.map(e=>{const live=executorCatalog?.find(item=>item.id===e.executor_type);return {...e,...(live??{}),id:e.executor_type};})
    :(executorCatalog??[]);
  // Existing teams keep their saved eligible_executors pool. A new team's Worker pool
  // uses every matched adapter, including adapters that cannot serve as Planner.
  if(role==='worker'&&!useEligible)entries=entries.filter(e=>!unsupportedAdapter(e));
  return entries.map(e=>{
    const disabled=unsupportedAdapter(e)||(role==='planner'&&e.supports_planner===false);
    const status=executorOptionStatus(e,role);
    return '<option value="'+esc(e.id)+'"'+(e.id===selectedId?' selected':'')+(disabled?' disabled':'')+'>'+esc(e.id==='command-code'?'cmd':e.id)+(status?' · '+esc(status):'')+'</option>';
  }).join('')||'<option value="">没有可用适配器</option>';
}
function protocolLabel(protocol) {
  return ({acp:'ACP',rpc:'RPC','native-cli':'Native CLI'})[protocol]??(protocol||'未提供');
}
function availabilityLabel(entry) {
  if(unsupportedAdapter(entry))return '待适配';
  if(entry.availability==='AVAILABLE')return '当前可派工';
  if(entry.availability==='UNREGISTERED')return '适配器已匹配，待平台注册';
  if(entry.availability==='DISABLED_BY_OPERATOR')return '已由操作方停用';
  if(entry.availability==='UNAVAILABLE')return '适配器已匹配，当前不可派工';
  return entry.availability??'状态未知';
}
function renderAgentInventory() {
  if(!executorCatalog)return;
  $('agent-inventory-count').textContent=executorCatalog.length+' 个 Agent';
  setHTML('agent-inventory',executorCatalog.map(entry=>{
    const installed=entry.installed===true;
    const matched=entry.adapter_status==='matched';
    const dispatchable=matched&&entry.availability==='AVAILABLE';
    const adapterLabel=entry.adapter_status==='matched'?'已匹配':entry.adapter_status==='unsupported'?'待适配':'状态未知';
    const discovery=entry.discovery_source||'未提供发现来源说明';
    const models=(entry.models??[]).filter(model=>!model.configured_only).length;
    const adjustable=(entry.models??[]).filter(m=>m.reasoning_status==='verified'&&m.reasoning_efforts?.length).length;
    const unknown=(entry.models??[]).filter(m=>!m.configured_only&&m.reasoning_status!=='verified').length;
    return '<article class="agent-inventory-card" data-adapter="'+esc(entry.adapter_status??'unknown')+'" data-dispatchable="'+dispatchable+'">'+
      '<div class="agent-inventory-heading"><strong>'+esc(entry.id==='command-code'?'cmd':entry.id)+'</strong><span>'+esc(protocolLabel(entry.protocol))+'</span></div>'+
      '<div class="agent-inventory-states"><span data-state="'+(installed?'ready':'muted')+'">'+(installed?'已安装':'未检测到安装')+'</span><span data-state="'+(matched?'ready':'pending')+'">'+esc(adapterLabel)+'</span><span data-state="'+(dispatchable?'ready':'pending')+'">'+esc(availabilityLabel(entry))+'</span></div>'+
      '<p>'+esc(unsupportedAdapter(entry)?'角色能力待验证':entry.supports_planner===true?'Planner 与 Worker':entry.supports_planner===false?'Worker 专用':'角色能力未提供')+' · '+(entry.supports_model?'支持模型配置':'仅使用默认模型')+' · '+models+' 个目录模型</p>'+
      (models?'<p class="hint">'+adjustable+' 个模型可调思考档位'+(unknown?' · '+unknown+' 个待确认':' · 已完成逐模型确认')+'</p>':'')+
      (entry.id==='pi'&&entry.discovery_status==='ready'&&models===0?'<p class="hint">Pi 尚未配置可用模型；在 Pi 配置模型提供方后重新扫描。</p>':'')+
      '<small>发现来源：'+esc(discovery)+'</small></article>';
  }).join('')||'<p class="agent-inventory-empty">未发现可显示的 Agent。</p>');
}
function renderExecutorSelect() {
  const chosen=$('planner-executor').value;
  setHTML('planner-executor',executorOptions(chosen,'planner'));
  if(chosen && [...$('planner-executor').options].some(o=>o.value===chosen))$('planner-executor').value=chosen;
  else {const entries=executorCatalog?.filter(e=>e.supports_planner!==false&&!unsupportedAdapter(e))??[];const option=entries.find(e=>e.availability==='AVAILABLE')??entries.find(e=>e.availability==='UNREGISTERED'&&e.models?.length)??entries.find(e=>e.availability==='UNREGISTERED')??entries[0];$('planner-executor').value=option?.id??'';}
  updatePlannerControls();
}
function entryFor(id,forTeam=false) {
  const live=executorCatalog?.find(e=>e.id===id);
  if(!forTeam)return live;
  const saved=team?.planning?.eligible_executors.find(e=>e.executor_type===id);
  return saved ? {...saved,...(live??{})} : null;
}
function profileModelReady(entry,model) {return !entry?.requires_model||Boolean(model||entry.default_model);}
function modelChoices(entry) {
  const required=entry?.requires_model&&!entry.default_model;
  return '<option value=""'+(required?' disabled':'')+'>'+esc(required?'请选择模型':entry?.default_model?'默认 · '+entry.default_model:'默认模型')+'</option>'+(entry?.models??[]).map(m=>'<option value="'+esc(m.id)+'">'+esc(m.label??m.id)+'</option>').join('')+(entry?.supports_model?'<option value="__custom">自定义模型…</option>':'');
}
function selectedWorkersDispatchable() {
  const rows=[...document.querySelectorAll('.worker-profile')];
  return rows.length>0&&rows.every(row=>{
    const id=row.querySelector('[data-profile-executor]')?.value;
    const entry=entryFor(id,Boolean(team?.planning));
    return Boolean(entry&&!unsupportedAdapter(entry)&&(!entry.availability||entry.availability==='AVAILABLE')&&profileModelReady(entry,row.querySelector('[data-profile-model]').value.trim()));
  });
}
function updateEffort(select,entry,model) {
  const chosen=select.value,selected=entry?.models?.find(m=>m.id===(model||entry.default_model));
  const verified=selected?.reasoning_status==='verified';
  const levels=verified?selected.reasoning_efforts??[]:[];
  const control=verified?selected.reasoning_control:'unknown';
  const reason=!entry?.supports_model?'此接入使用 Agent 的默认配置。':!selected&&!model&&!entry?.default_model?'先选择模型，再确认其思考档位。':!verified?'未读取到此模型的准确档位，使用 Agent 默认。':control==='toggle'?'此模型提供思考开关，没有分级强度。':control==='budget'?'此模型提供思考预算，没有分级强度。':!levels.length?(control==='effort'?'当前 CLI 没有可用的思考档位。':'此模型不提供可选思考档位。'):null;
  const nativeDefault=levels.includes(selected?.default_effort)?selected.default_effort:null;
  const defaultLabel=!selected&&!model&&!entry?.default_model&&entry?.supports_model?'请先选择模型':control==='toggle'?'仅思考开关 · 沿用默认':control==='budget'?'仅思考预算 · 沿用默认':nativeDefault?'模型默认 · '+effortLabel(nativeDefault)+' ('+nativeDefault+')':verified||!entry?.supports_model?'沿用 Agent 默认':'档位未确认 · 沿用默认';
  select.innerHTML='<option value="">'+esc(defaultLabel)+'</option>'+levels.map(level=>'<option value="'+esc(level)+'">'+esc(effortLabel(level))+' · '+esc(level)+'</option>').join('');
  select.disabled=!levels.length;
  select.value=levels.includes(chosen)?chosen:'';
  select.title=reason??'此模型支持：'+levels.join(' / ');
  const hint=select.closest('.field')?.querySelector('[data-effort-hint]');
  if(hint)hint.textContent=reason??'支持 '+levels.join(' / ')+(entry?.default_effort_status==='unverified'&&(!model||model===entry.default_model)?' · Agent 默认强度未确认，建议明确选择。':'');
}
function updatePlannerControls(reset=false) {
  const entry=entryFor($('planner-executor').value),input=$('planner-model-input'),select=$('planner-model-select');
  if(reset){input.value='';$('planner-effort').value='';}
  const chosen=input.value.trim();
  select.innerHTML=modelChoices(entry);
  select.value=chosen?entry?.models?.some(m=>m.id===chosen)?chosen:'__custom':'';
  select.disabled=!entry?.supports_model;
  input.hidden=select.value!=='__custom';input.disabled=!entry?.supports_model||input.hidden;
  updateEffort($('planner-effort'),entry,chosen);
  $('model-selection-hint').textContent=!entry?'没有可用的 Agent。':unsupportedAdapter(entry)?'此 Agent 尚无适配器，暂不能选择。':entry.availability==='UNREGISTERED'?'适配器已匹配但尚未注册；可配置模型，注册后才能派工。':entry.availability==='DISABLED_BY_OPERATOR'?'此 Agent 已停用，切换已接入的 Agent 后开始。':entry.availability==='UNAVAILABLE'?'此 Agent 当前不可派工，请选择其他 Agent。':!entry.supports_model?'此 Agent 仅使用默认模型，不提供模型覆盖。':entry.models?.length?'从扫描目录选择模型；思考等级与所选模型联动。':'输入自定义模型 ID，或沿用 Agent 默认模型。';
  $('model-selection-hint').dataset.ready=String(entry?.availability==='AVAILABLE');
  if(!team){consoleProfileKey='';renderConsoleProfile();}
  writes();
}
function canConfigureAgents() {
  return Boolean(team?.planning && (['DISCUSSING','PLAN_READY'].includes(team.state) ||
    (team.state==='PAUSED' && ['DISCUSSING','PLAN_READY','PLANNING','WORKING','BLOCKED'].includes(team.paused_from_state))) &&
    ![...team.runs,...team.delivery_runs].some(r=>['RUNNING','UNCONFIRMED'].includes(r.status)));
}
function consoleProfile() {
  return {executor_type:$('console-planner-executor').value,model:$('console-planner-model-input').value.trim()||null,effort:$('console-planner-effort').value||null};
}
function updateConsoleControls(reset=false) {
  const entry=entryFor($('console-planner-executor').value,Boolean(team?.planning)),input=$('console-planner-model-input'),select=$('console-planner-model-select');
  const custom=select.value==='__custom'&&!reset;
  if(reset){input.value='';$('console-planner-effort').value='';}
  const chosen=input.value.trim();
  select.innerHTML=modelChoices(entry);
  select.value=chosen?(entry?.models?.some(m=>m.id===chosen)?chosen:'__custom'):custom&&entry?.supports_model?'__custom':'';
  select.disabled=!entry?.supports_model;input.hidden=select.value!=='__custom';input.disabled=!entry?.supports_model||input.hidden;
  updateEffort($('console-planner-effort'),entry,chosen);
  if(team && !canConfigureAgents())for(const control of $('console-planner-form').querySelectorAll('select,input'))control.disabled=true;
}
function renderConsoleProfile() {
  if(!executorCatalog)return;
  const key=(team?.team_id??'new')+':'+(team?.planning?.agent_config_revision??0);
  if(consoleProfileBase?.teamId!==(team?.team_id??null)){consoleProfileDirty=false;consoleProfileKey='';}
  if(!consoleProfileDirty && (key!==consoleProfileKey || !consoleProfileBase)) {
    const p=team?.planning?.planner??{executor_type:$('planner-executor').value,model:$('planner-model-input').value||null,effort:$('planner-effort').value||null};
    $('console-planner-executor').innerHTML=executorOptions(p.executor_type,'planner',Boolean(team?.planning));
    $('console-planner-executor').value=p.executor_type;
    $('console-planner-model-select').value='';
    $('console-planner-model-input').value=p.model??'';$('console-planner-effort').innerHTML='<option value="'+esc(p.effort??'')+'">'+esc(p.effort??'默认')+'</option>';
    updateConsoleControls();consoleProfileKey=key;
    if(team && p.effort && $('console-planner-effort').value!==p.effort)consoleProfileDirty=true;
    consoleProfileBase={teamId:team?.team_id??null,revision:team?.plan_revision??0,goalRevision:team?.goal_revision??0,configRevision:team?.planning?.agent_config_revision??0};
  }
  // Status updates may unlock the editor without changing its saved profile.
  const editable=!team||canConfigureAgents();
  $('console-planner-executor').disabled=!editable;
  if(editable!==consoleProfileEditable){if(editable)updateConsoleControls();else for(const control of $('console-planner-form').querySelectorAll('select,input'))control.disabled=true;consoleProfileEditable=editable;}
  if(!consoleProfileDirty)consoleProfileBase={teamId:team?.team_id??null,revision:team?.plan_revision??0,goalRevision:team?.goal_revision??0,configRevision:team?.planning?.agent_config_revision??0};
  const entry=entryFor($('console-planner-executor').value,Boolean(team?.planning));
  $('console-profile-hint').textContent=configCommand?'配置正在保存，请等待回执。':!team?(entry?.availability==='AVAILABLE'?'选择后，新目标会使用这套 Planner 配置。':entry?.availability==='DISABLED_BY_OPERATOR'?'此 Agent 已停用；当前选择可保存为配置草稿。':entry?.availability==='UNAVAILABLE'?'此 Agent 当前不可用；请选择其他 Agent 开始。':'此 Agent 待接入；可先选择模型与思考强度。'):!editable?'正在执行或交付；先暂停团队，再修改配置。':consoleProfileDirty?'有未保存的配置，保存后再继续商讨。':'配置已生效；修改后点击保存。';
  $('save-console-planner').innerHTML=(team?'保存配置':'使用此 Planner')+' '+icon('arrow');
}
function syncConsoleToCreate() {
  const p=consoleProfile();$('planner-executor').value=p.executor_type;
  $('planner-model-input').value=p.model??'';
  $('planner-effort').innerHTML='<option value="'+esc(p.effort??'')+'">'+esc(p.effort??'默认')+'</option>';
  updatePlannerControls();
}
function updateWorkerControls(row,reset=false) {
  const executor=row.querySelector('[data-profile-executor]'),input=row.querySelector('[data-profile-model]'),effort=row.querySelector('[data-profile-effort]'),select=row.querySelector('[data-profile-model-select]');
  const entry=entryFor(executor.value,Boolean(team?.planning));
  if(reset){input.value='';effort.value='';}
  input.disabled=!entry?.supports_model;input.placeholder=entry?.default_model?'默认 · '+entry.default_model:'默认模型或输入模型 ID';
  if(input.disabled)input.value='';
  row.querySelector('datalist').innerHTML=(entry?.models??[]).map(m=>'<option value="'+esc(m.id)+'">'+esc(m.label??m.id)+'</option>').join('');
  select.innerHTML=modelChoices(entry);
  const chosen=input.value.trim();select.value=chosen?(entry?.models?.some(m=>m.id===chosen)?chosen:'__custom'):'';
  select.disabled=!entry?.supports_model;input.hidden=select.value!=='__custom';input.disabled=!entry?.supports_model||input.hidden;
  updateEffort(effort,entry,input.value.trim());
}
function readDispatchDraft() {
  profileDraft=[...document.querySelectorAll('.worker-profile')].map(row=>({executor_type:row.querySelector('[data-profile-executor]').value,model:row.querySelector('[data-profile-model]').value.trim()||null,effort:row.querySelector('[data-profile-effort]').value||null}));
}
function renderDispatch() {
  const count=Number($('dispatch-workers').value),lead=team?.planning?.planner??consoleProfile();
  while(profileDraft.length<count)profileDraft.push({...lead});profileDraft=profileDraft.slice(0,count);
  $('dispatch-workers-output').value=String(count);
  $('worker-profiles').innerHTML=profileDraft.map((p,i)=>'<div class="worker-profile"><strong aria-label="Worker '+(i+1)+'">'+String(i+1).padStart(2,'0')+'</strong><label class="field"><span>Agent</span><select data-profile-executor="'+i+'" aria-label="Worker '+(i+1)+' 执行器">'+executorOptions(p.executor_type,'worker',Boolean(team?.planning))+'</select></label><label class="field"><span>模型</span><select data-profile-model-select="'+i+'" aria-label="Worker '+(i+1)+' 模型选择"></select><input data-profile-model="'+i+'" list="worker-models-'+i+'" maxlength="160" value="'+esc(p.model??'')+'" aria-label="Worker '+(i+1)+' 自定义模型 ID"><datalist id="worker-models-'+i+'"></datalist></label><label class="field worker-effort"><span>思考强度</span><select data-profile-effort="'+i+'" aria-label="Worker '+(i+1)+' 思考强度"><option value="'+esc(p.effort??'')+'" selected>'+esc(effortLabel(p.effort??'默认'))+'</option></select><small data-effort-hint></small></label></div>').join('');
  for(const row of document.querySelectorAll('.worker-profile'))updateWorkerControls(row);
  const previous=Object.fromEntries([...document.querySelectorAll('[data-assignment]')].map(s=>[s.dataset.assignment,s.value]));
  $('work-assignments').innerHTML=dispatchBase.items.map(item=>{
    const wanted=previous[item.work_item_id]??item.agent_id;
    return '<label class="assignment-row"><span>'+esc(item.work_item_id)+'<small>'+esc(item.goal)+'</small></span><select data-assignment="'+esc(item.work_item_id)+'" aria-label="'+esc(item.work_item_id)+' 分配给">'+profileDraft.map((_,i)=>'<option value="worker-'+(i+1)+'"'+(wanted==='worker-'+(i+1)?' selected':'')+'>Worker '+String(i+1).padStart(2,'0')+'</option>').join('')+'</select></label>';
  }).join('');
  writes();
}
function render() {
  renderPlanner();
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
  $('team-meta').textContent = team.failure_reason ?? (team.planning ? 'Planner 商讨与规划 · '+team.members.filter(m=>m.role==='worker').length+' 位 Worker · 同模型 Reviewer 独立复检。' : team.members.length + ' 位成员 · Planner 组织分工与整合，你来掌握方向。');
  $('team-meta').title = team.team_id;
  setHTML('members', team.members.map((member, index) => {
    const active = team.runs.findLast(run => run.agent_id === member.agent_id && run.status === 'RUNNING');
    const status = active?.process_state === 'QUEUED' ? '等待执行额度' :
      active?.process_state === 'RUNNING' ? '进程运行中' : label(member.status);
    return '<button type="button" class="member-card ' + (member.role === 'lead' ? 'lead' : '') +
      '" data-member="' + esc(member.agent_id) + '" data-running="' + Boolean(active) +
      '" aria-label="与' + esc(memberName(member.agent_id)) + '对话"><span class="member-avatar" aria-hidden="true">' +
      (member.role === 'lead' ? 'P' : String(index).padStart(2, '0')) + '</span><span class="member-detail"><strong>' +
      esc(memberName(member.agent_id)) + '</strong><small>' + esc(member.executor_type) + (member.model?' / '+esc(member.model):' / 默认模型') +
      (member.effort?' · '+esc(effortLabel(member.effort)):'')+'</small><span class="member-status">' + esc(status) + '</span></span>' + icon('arrow', 'member-cta') + '</button>';
  }).join('') + (team.planning ? '<div class="member-card reviewer"><span class="member-avatar" aria-hidden="true">R</span><span class="member-detail"><strong>Reviewer</strong><small>'+esc(team.planning.planner.executor_type)+' / '+esc(team.planning.planner.model??'默认模型')+'</small><span class="member-status">'+(['DELIVERING','WAITING_HUMAN','COMPLETED'].includes(team.state)?'独立复检 · '+esc(label(team.delivery?.status??team.state)):'与 Planner 同模型 · 独立会话')+'</span></span></div>' : ''));
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
    (['CREATED','DISCUSSING'].includes(team.state) ? '先聊想法，再决定行动。' : 'Planner 正在组织行动计划。') +
    '</h4><p>商讨目标、约束与验收要求。<br>生成计划后，确认 Worker 的数量与模型。</p></div>');
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
    esc(label(run.status)) + ' · ' + esc(run.executor_type) + '</span><p>'+esc(run.model??'默认模型')+' · '+esc(run.effort?effortLabel(run.effort)+'思考':'默认强度')+'</p><small>' + esc(run.run_id) + '</small></article>').join('') ||
    '<p class="hint">团队启动后，会在这里记录每次执行。</p>');
  setHTML('artifacts', team.artifacts.slice(-12).reverse().map(artifact => '<article class="history-card"><strong>' +
    esc(artifact.work_item_id) + ' · 版本 ' + esc(artifact.revision) + '</strong><p>' + esc(artifact.summary) +
    '</p><small>' + esc(artifact.artifact_id) + ' · ' + esc(artifact.manifest?.summary?.totalChanges ?? 0) +
    ' 项文件变化</small></article>').join('') || '<p class="hint">成员提交的成果会保留在这里。</p>');
  writes();
}
async function refresh(reloadCatalog=false) {
  if (refreshing) return;
  refreshing = true;
  $('refresh').setAttribute('aria-busy', 'true');
  try {
    if (!capabilities) capabilities = await request('/api/v2/capabilities');
    if (!executorCatalog || reloadCatalog===true) {
      $('agent-scan-status').textContent='正在扫描 Agents 与模型…';$('scan-agents').disabled=true;
      // Each native client can use 12 seconds plus startup and cleanup time.
      const inventory=await request('/api/v2/executors?scan=1',null,{timeoutMs:30000});executorCatalog=inventory.executors;agentScan=inventory.scan;
      renderExecutorSelect();consoleProfileKey='';
      renderAgentInventory();
      if(consoleProfileDirty)updateConsoleControls();
      if($('dispatch-dialog').open)for(const row of document.querySelectorAll('.worker-profile'))updateWorkerControls(row);
      const count=(key,fallback)=>Number.isFinite(agentScan?.[key])?agentScan[key]:fallback();
      const installed=count('installed_agents',()=>executorCatalog.filter(e=>e.installed).length);
      const matched=count('matched_agents',()=>executorCatalog.filter(e=>e.installed&&e.adapter_status==='matched').length);
      const unmatched=count('unmatched_agents',()=>executorCatalog.filter(e=>e.installed&&e.adapter_status==='unsupported').length);
      const dispatchable=executorCatalog.filter(e=>e.adapter_status==='matched'&&e.availability==='AVAILABLE').length;
      $('agent-scan-status').textContent='扫描'+(agentScan?.status==='partial'?'部分完成':'完成')+' · '+installed+' 个已安装客户端 / '+matched+' 个已匹配适配器 / '+dispatchable+' 个当前可派工';
      const modelCount=executorCatalog.reduce((n,e)=>n+(e.models?.filter(m=>!m.configured_only).length??0),0);
      const adjustable=executorCatalog.reduce((n,e)=>n+e.models.filter(m=>!m.configured_only&&m.reasoning_status==='verified'&&m.reasoning_efforts?.length).length,0);
      const unknown=executorCatalog.reduce((n,e)=>n+e.models.filter(m=>!m.configured_only&&m.reasoning_status!=='verified').length,0);
      $('agent-scan-details').textContent=unmatched+' 个已安装客户端待适配 · '+modelCount+' 个目录模型 · '+adjustable+' 个模型可调思考档位 / '+unknown+' 个模型的思考能力待确认 · '+new Date(agentScan?.completed_at??inventory.generated_at).toLocaleTimeString();
    }
    const listing = await request('/api/teams');
    if (selected && !listing.teams.some(item => item.team_id === selected)) { selected = null; team = null; workId = null; }
    if (!selected && listing.teams.length) selected = listing.teams[0].team_id;
    $('team-count').textContent = String(listing.teams.length).padStart(2, '0');
    const id = selected;
    if (id) {
      const model = await request('/api/teams/' + encodeURIComponent(id));
      if (selected === id) { team = model; render(); }
    } else render();
    listing.teams=listing.teams.map(item=>item.team_id===team?.team_id?team:item);
    setHTML('teams', listing.teams.map(item => '<button type="button" data-team="' + esc(item.team_id) +
      '" aria-current="' + (item.team_id === selected) + '"><strong>' + esc(item.goal) +
      '</strong><small>' + esc(label(item.state)) + ' · ' + (item.planning?item.members.filter(m=>m.role==='worker').length+' 位 Worker':item.members.length+' 位成员') +
      '</small></button>').join('') || '<p class="sidebar-empty">你的团队会在这里集合。<br>新建一个目标，开始第一次协作。</p>');
    $('connection').dataset.status = 'connected';
    $('connection').querySelector('span').textContent = '实时连接';
    lastConnectionError = null;
  } catch (error) {
    if($('agent-scan-status').textContent.includes('正在扫描')) {
      $('agent-scan-status').textContent='扫描失败 · 可重新扫描';
      $('agent-scan-details').textContent='未获取到最新目录，请重新扫描确认模型与等级。';
    }
    $('connection').dataset.status = 'error';
    $('connection').querySelector('span').textContent = '连接中断';
    if (lastConnectionError !== error.message) notice(error.name === 'AbortError' ? '连接超时，正在等待服务恢复。' : error.message, 'error');
    lastConnectionError = error.message;
    if(!executorCatalog || reloadCatalog===true){$('agent-scan-status').textContent='扫描未完成';$('agent-scan-details').textContent='目录读取失败，请重新扫描；不推断思考强度。';}
  } finally {
    refreshing = false;
    $('refresh').removeAttribute('aria-busy');
    $('scan-agents').disabled=false;
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
  if (write && event?.submitter?.disabled) return;
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
$('refresh').onclick = ()=>refresh(true);
$('scan-agents').onclick=()=>refresh(true);
$('teams').onclick = handle(async event => {
  const id = event.target.closest('[data-team]')?.dataset.team;
  if (!id || id === selected) return;
  selected = id; workId = null; editBase = null; team = null; dispatchBase=null; $('planner-input').value='';
  navigation(false); render();
  await refresh();
}, false);
$('members').onclick = event => {
  const id = event.target.closest('[data-member]')?.dataset.member;
  if(id==='lead'&&team?.planning){$('planner-input').scrollIntoView({block:'center'});$('planner-input').focus();return;}
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
for (const id of ['start', 'pause', 'cancel', 'deliver']) $(id).onclick = handle(() => {
  if(id==='start' && team?.planning && team.state==='DISCUSSING'){ $('planner-input').scrollIntoView({block:'center'}); $('planner-input').focus(); return; }
  if(id==='start' && team?.planning && team.state==='PLAN_READY'){openDialog('dispatch-dialog');return;}
  return command({ type: id === 'start' && ['READY_FOR_REVIEW', 'WAITING_HUMAN'].includes(team?.state) && team?.integration ? 'deliver' : id });
});
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
$('planner-executor').onchange=()=>{if(!team)consoleProfileDirty=false;updatePlannerControls(true);};
$('planner-model-select').onchange=()=>{
  const select=$('planner-model-select'),input=$('planner-model-input');
  input.value=select.value==='__custom'?'':select.value;
  input.hidden=select.value!=='__custom';input.disabled=input.hidden;
  updateEffort($('planner-effort'),entryFor($('planner-executor').value),input.value);
  syncCreationProfile();
  if(!input.hidden)input.focus();
};
$('planner-model-input').oninput=()=>{updateEffort($('planner-effort'),entryFor($('planner-executor').value),$('planner-model-input').value.trim());syncCreationProfile();};
$('planner-effort').onchange=syncCreationProfile;
function syncCreationProfile(){if(!team){consoleProfileDirty=false;consoleProfileKey='';renderConsoleProfile();writes();}}
function consoleChanged(reset=false){consoleProfileDirty=true;updateConsoleControls(reset);if(!team)syncConsoleToCreate();renderConsoleProfile();writes();}
$('console-planner-executor').onchange=()=>consoleChanged(true);
$('console-planner-model-select').onchange=()=>{
  const input=$('console-planner-model-input');input.value=$('console-planner-model-select').value==='__custom'?'':$('console-planner-model-select').value;
  // Preserve custom mode while the operator starts typing a model ID.
  if($('console-planner-model-select').value==='__custom'){input.hidden=false;input.disabled=false;input.focus();consoleProfileDirty=true;updateEffort($('console-planner-effort'),entryFor($('console-planner-executor').value,Boolean(team)),null);writes();}
  else consoleChanged();
};
$('console-planner-model-input').oninput=()=>{consoleProfileDirty=true;updateEffort($('console-planner-effort'),entryFor($('console-planner-executor').value,Boolean(team)),$('console-planner-model-input').value.trim());if(!team)syncConsoleToCreate();writes();};
$('console-planner-effort').onchange=()=>consoleChanged();
$('console-planner-form').onsubmit=handle(async()=>{
  if($('console-planner-model-select').value==='__custom'&&!$('console-planner-model-input').value.trim())throw new Error('填写自定义模型 ID，或选择默认模型。');
  if(!team){syncConsoleToCreate();consoleProfileDirty=false;openDialog('create-dialog');return;}
  if(!consoleProfileBase || consoleProfileBase.teamId!==team.team_id)throw new Error('重新选择当前团队后再配置 Planner。');
  const result=await command({type:'configure_agents',expected_plan_revision:consoleProfileBase.revision,expected_goal_revision:consoleProfileBase.goalRevision,
    expected_agent_config_revision:consoleProfileBase.configRevision,planner:consoleProfile()},consoleProfileBase.teamId);
  configCommand={teamId:consoleProfileBase.teamId,commandId:result.command_id,role:'planner'};
  render();
});
$('configure-workers').onclick=()=>{if(team&&consoleProfileDirty){notice('先保存 Planner 配置，再设置 Worker Agents。');return;}openDialog('dispatch-dialog',true);};
$('dispatch-mode').onchange=()=>{$('create-mode-summary').textContent=$('dispatch-mode').value==='planner'?'Planner 编组并自动开工':'看过计划，再确认开工';};
$('planner-chat-form').onsubmit=handle(async()=>{
  if(consoleProfileDirty||configCommand)throw new Error('先保存 Planner 配置，再发送消息。');
  const message=$('planner-input').value.trim();if(!message)throw new Error('先写下你想和 Planner 商讨的内容。');
  await command({type:'message',agent_id:'lead',message});$('planner-input').value='';$('planner-input').focus();
});
for(const suggestion of document.querySelectorAll('[data-prompt]'))suggestion.onclick=()=>{$('planner-input').value=suggestion.dataset.prompt;$('planner-input').focus();};
$('propose-plan').onclick=handle(()=>{if(consoleProfileDirty||configCommand)throw new Error('先保存 Planner 配置，再生成行动计划。');return command({type:'propose_plan'});});
$('dispatch-workers').oninput=()=>{readDispatchDraft();renderDispatch();};
$('worker-profiles').onchange=event=>{
  const executor=event.target.closest('[data-profile-executor]');if(executor){updateWorkerControls(executor.closest('.worker-profile'),true);writes();return;}
  const select=event.target.closest('[data-profile-model-select]');if(select){const row=select.closest('.worker-profile'),input=row.querySelector('[data-profile-model]');input.value=select.value==='__custom'?'':select.value;
    if(select.value==='__custom'){input.hidden=false;input.disabled=false;input.focus();updateEffort(row.querySelector('[data-profile-effort]'),entryFor(row.querySelector('[data-profile-executor]').value,Boolean(team)),null);}
    else updateWorkerControls(row);}
};
$('worker-profiles').oninput=event=>{const input=event.target.closest('[data-profile-model]');if(input)updateWorkerControls(input.closest('.worker-profile'));};
$('dispatch-form').onsubmit=handle(async()=>{
  if(!dispatchBase)throw new Error('重新打开计划，确认最新编组。');readDispatchDraft();
  if(profileDraft.some(p=>!p.executor_type))throw new Error('为每位 Worker 选择一个 Agent。');
  for(const row of document.querySelectorAll('.worker-profile'))if(row.querySelector('[data-profile-model-select]').value==='__custom'&&!row.querySelector('[data-profile-model]').value.trim())throw new Error('填写 Worker 的自定义模型 ID，或选择默认模型。');
  if(dispatchBase.mode==='local'){createWorkersDraft=structuredClone(profileDraft);$('dispatch-dialog').close();render();notice('Worker 编组已预设，将随新目标一起保存。');return;}
  if(dispatchBase.mode==='configure'){
    const result=await command({type:'configure_agents',expected_plan_revision:dispatchBase.revision,expected_goal_revision:dispatchBase.goalRevision,expected_agent_config_revision:dispatchBase.configRevision,workers:profileDraft},dispatchBase.teamId);
    configCommand={teamId:dispatchBase.teamId,commandId:result.command_id,role:'workers'};$('dispatch-dialog').close();render();return;
  }
  const assignments=Object.fromEntries([...document.querySelectorAll('[data-assignment]')].map(s=>[s.dataset.assignment,s.value]));
  await command({type:'approve_plan',expected_plan_revision:dispatchBase.revision,expected_goal_revision:dispatchBase.goalRevision,expected_agent_config_revision:dispatchBase.configRevision,workers:profileDraft,assignments},dispatchBase.teamId);
  $('dispatch-dialog').close();
});
$('create-form').onsubmit = handle(async () => {
  let args;
  try { args = JSON.parse($('args').value); } catch { throw new Error('验收参数需要有效的 JSON 字符串数组。'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('验收参数需要字符串数组。');
  const result = await request('/api/teams', { spec: {
    goal: $('goal').value.trim(), target_path: $('target').value.trim(),
    acceptance: { command: $('command').value.trim(), args }, idempotency_key: $('key').value,
  }, planning:{dispatch_mode:$('dispatch-mode').value,
    planner:{executor_type:$('planner-executor').value,model:$('planner-model-input').value.trim()||null,effort:$('planner-effort').value||null},...(createWorkersDraft?{workers:createWorkersDraft}:{})} });
  selected = result.team_id; workId = null; editBase = null;
  createWorkersDraft=null;consoleProfileDirty=false;consoleProfileKey='';
  $('create-dialog').close(); $('create-form').reset(); $('key').value = operationId('goal-');
  $('create-mode-summary').textContent='看过计划，再确认开工';$('create-settings').open=false;
  renderExecutorSelect();notice('团队已创建。先与 Planner 商讨你的目标。');
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
