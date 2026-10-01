const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={CREATED:'待启动',PLANNING:'主作者规划中',WORKING:'成员协作中',INTEGRATING:'整合中',READY_FOR_REVIEW:'候选待交付',DELIVERING:'交付中',WAITING_HUMAN:'等待人工审批',COMPLETED:'已完成',BLOCKED:'等待处理',RECOVERY_REQUIRED:'需要恢复检查',PAUSED:'已暂停',CANCELLED:'已取消',READY:'等待派发或依赖',RUNNING:'执行中',DONE:'产物已接受',FAILED:'执行失败',DISCARDED:'旧结果已拒绝',INTERRUPTED:'执行中断',IDLE:'空闲',queued:'已排队',received:'已收到',applied:'已落实',rejected:'已拒绝',superseded:'方向已更新'};
const label=value=>labels[value]??value;
let token='';try{token=sessionStorage.getItem('af-write-token')??'';}catch{}
let selected=null,workId=null,team=null,capabilities=null,refreshing=false;
async function request(path,body=null) {
  const res=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-af-csrf':'1'},body:JSON.stringify(body)}:{cache:'no-store'});
  const envelope=await res.json();const model=envelope.model??envelope;
  if(!res.ok)throw new Error(model.reason??model.error??`HTTP ${res.status}`);
  return model;
}
function notice(message){$('notice').textContent=message;}
function writes(){
  const enabled=Boolean(token&&capabilities?.write?.team_command),terminal=['COMPLETED','CANCELLED','RECOVERY_REQUIRED'].includes(team?.state);
  document.querySelectorAll('[data-write]').forEach(button=>{button.disabled=!enabled||(button.id!=='create'&&!team)||(terminal&&!['create','adjust','replan'].includes(button.id));});
  $('adjust').disabled=!enabled||!workId||['CANCELLED','RECOVERY_REQUIRED'].includes(team?.state);
  $('retry').disabled=!enabled||!workId||terminal;
}
function render() {
  if(!team)return;
  $('team-goal').textContent=team.goal;$('team-state').textContent=label(team.state);
  $('team-meta').textContent=`${team.team_id} · 目标版本 ${team.goal_revision} · ${team.failure_reason??'点击成员和工作项查看分工、交流并调整方向。'}`;
  $('members').innerHTML=team.members.map(m=>{const active=team.runs.findLast(r=>r.agent_id===m.agent_id&&r.status==='RUNNING');const status=active?.process_state==='QUEUED'?'等待执行额度':active?.process_state==='RUNNING'?'进程运行中':label(m.status);return `<button class="member-card" data-member="${esc(m.agent_id)}"><strong>${m.role==='lead'?'主作者':esc(m.agent_id)}</strong><small>${esc(m.executor_type)} · ${esc(status)}</small></button>`;}).join('');
  const chosen=$('member-target').value;
  $('member-target').innerHTML=team.members.map(m=>`<option value="${esc(m.agent_id)}">${m.role==='lead'?'主作者':esc(m.agent_id)} · ${esc(m.executor_type)}</option>`).join('');
  if(team.members.some(m=>m.agent_id===chosen))$('member-target').value=chosen;
  const chosenWorker=$('worker-target').value;
  $('worker-target').innerHTML=team.members.filter(m=>m.role==='worker').map(m=>`<option value="${esc(m.agent_id)}">${esc(m.agent_id)} · ${esc(m.executor_type)}</option>`).join('');
  if(team.members.some(m=>m.role==='worker'&&m.agent_id===chosenWorker))$('worker-target').value=chosenWorker;
  $('work-items').innerHTML=team.work_items.length?team.work_items.map(item=>`<button class="work-card ${item.work_item_id===workId?'selected':''}" data-work="${esc(item.work_item_id)}"><strong>${esc(item.work_item_id)} · ${esc(label(item.status))}</strong><p>${esc(item.goal)}</p><small>${esc(item.agent_id)} · 版本 ${item.revision} · ${item.depends_on.length?`依赖 ${esc(item.depends_on.join(' → '))}`:'可独立执行'}</small>${item.blocked_reason?`<p>${esc(item.blocked_reason)}</p>`:''}</button>`).join(''):'<p class="hint">主作者规划后会显示真实分工。</p>';
  const current=team.work_items.find(i=>i.work_item_id===workId);
  if(!current)workId=null;
  $('selected-work').textContent=current?`${current.work_item_id} · ${current.agent_id} · 当前版本 ${current.revision}`:'点击工作项后，可以修改该项的方向。';
  $('delivery').innerHTML=team.delivery?`${esc(label(team.delivery.status))} · ${esc(team.delivery.phase??'')} · <a href="/#${encodeURIComponent(team.delivery.task_id)}">查看交付证据</a>`:team.integration?'候选已整合，等待交付服务。':'尚未整合候选。';
  $('messages').innerHTML=team.messages.slice(-30).map(m=>`<article class="history-card"><strong>${esc(m.from_agent_id)} → ${esc(m.to_agent_id)}</strong> · ${esc(label(m.status))}<p>${esc(m.message)}</p>${m.reply_to?`<small>回复 ${esc(m.reply_to)}</small>`:''}</article>`).join('')||'<p class="hint">还没有成员消息。</p>';
  $('receipts').innerHTML=team.commands.slice(-20).reverse().map(c=>`<article class="history-card"><strong>${esc(c.type)} · ${esc(label(c.status))}</strong><p>${esc(c.message??c.reason??c.command_id)}</p>${c.evidence?`<small>${esc(JSON.stringify(c.evidence))}</small>`:''}</article>`).join('')||'<p class="hint">操作提交后在这里显示回执。</p>';
  $('runs').innerHTML=team.runs.slice(-30).map(r=>`<article class="history-card">${esc(r.agent_id)} · ${esc(r.work_item_id)} · ${esc(label(r.status))}<p>${esc(r.run_id)} · ${esc(r.executor_type)}</p></article>`).join('');
  $('artifacts').innerHTML=team.artifacts.slice(-12).map(a=>`<article class="history-card">${esc(a.work_item_id)} · 版本 ${a.revision}<p>${esc(a.summary)}</p><small>${esc(a.artifact_id)} · ${a.manifest.summary.totalChanges} 项文件变化</small></article>`).join('');
  writes();
}
async function refresh() {
  if(refreshing)return;refreshing=true;
  try {
    const listing=await request('/api/teams');
    $('teams').innerHTML=listing.teams.map(t=>`<button data-team="${esc(t.team_id)}" aria-current="${t.team_id===selected}"><strong>${esc(t.goal)}</strong><p>${esc(label(t.state))} · ${t.members.length} 位成员</p></button>`).join('')||'<p class="disclosure-body hint">创建一个协作目标开始。</p>';
    if(!selected&&listing.teams.length)selected=listing.teams[0].team_id;
    const id=selected;if(id){const model=await request(`/api/teams/${encodeURIComponent(id)}`);if(selected===id){team=model;render();}}
    $('connection').textContent='已连接 · 状态自动更新';
  }catch(err){$('connection').textContent='连接失败';notice(err.message);}
  finally{refreshing=false;}
}
async function command(payload){if(!team)return;const result=await request(`/api/teams/${encodeURIComponent(team.team_id)}/commands`,{command:payload,command_id:`CMD-${crypto.randomUUID()}`});notice(`操作已排队：${result.command_id}。领取与落实情况会显示在回执中。`);await refresh();}
const handle=fn=>async event=>{event?.preventDefault();try{await fn(event);}catch(err){notice(err.message);}};
$('refresh').onclick=refresh;
$('teams').onclick=handle(async event=>{const id=event.target.closest('[data-team]')?.dataset.team;if(id){selected=id;workId=null;team=null;await refresh();}});
$('members').onclick=event=>{const id=event.target.closest('[data-member]')?.dataset.member;if(id)$('member-target').value=id;};
$('work-items').onclick=event=>{const id=event.target.closest('[data-work]')?.dataset.work;if(!id)return;workId=id;const item=team.work_items.find(i=>i.work_item_id===id);$('member-target').value=item.agent_id;$('worker-target').value=item.agent_id;$('direction').value=item.goal;render();};
$('save-token').onclick=()=>{token=$('token').value.trim();try{sessionStorage.setItem('af-write-token',token);}catch{}writes();notice(token?'令牌已保存到本次会话。':'令牌已清除。');};
for(const id of ['start','pause','cancel','deliver'])$(id).onclick=handle(()=>command({type:id}));
$('send-message').onclick=handle(()=>command({type:'message',agent_id:$('member-target').value,message:$('message').value}));
$('adjust').onclick=handle(()=>{const item=team.work_items.find(i=>i.work_item_id===workId);return command({type:'adjust',work_item_id:workId,expected_revision:item.revision,agent_id:$('worker-target').value,message:$('direction').value});});
$('retry').onclick=handle(()=>{const item=team.work_items.find(i=>i.work_item_id===workId);return command({type:'retry',work_item_id:workId,expected_revision:item.revision});});
$('replan').onclick=handle(()=>command({type:'replan',goal:$('new-goal').value,expected_goal_revision:team.goal_revision}));
$('create-form').onsubmit=handle(async()=>{const args=JSON.parse($('args').value);if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw new Error('验收参数需要字符串数组。');
  const result=await request('/api/teams',{spec:{goal:$('goal').value,target_path:$('target').value,acceptance:{command:$('command').value,args},idempotency_key:$('key').value},worker_count:Number($('workers').value)});
  selected=result.team_id;workId=null;notice('团队已创建，可以启动协作。');await refresh();});
try{capabilities=await request('/api/v2/capabilities');writes();}catch(err){notice(err.message);}
await refresh();setInterval(refresh,1500);
