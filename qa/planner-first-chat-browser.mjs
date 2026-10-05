// Real Chromium check for starting a Planner conversation from an empty workspace.
// API reads and team commands use the real HTTP handler and durable controller; model calls
// are controlled by plannerFixture. Only team creation is intercepted so the fixture is reused.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnManaged, signalTree } from '../lib/child-process.mjs';
import { plannerFixture } from '../tests/helpers/planner-team-fixture.mjs';
import { readTeam, commitTeam } from '../lib/team/store.mjs';
import { TeamController } from '../lib/team/controller.mjs';
import { PROJECT_REGISTRY_SCHEMA } from '../lib/projects.mjs';
import { authorizeWrite, resolveWriteToken, createLocalWriteSessionAuth } from '../server/web-auth.mjs';
import { createReadApi } from '../server/read-api.mjs';
import { DevTools } from './browser-client.mjs';

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const checks = [];
function check(name, condition) {
  assert.ok(condition, name);
  checks.push(name);
}
function equal(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
}
function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise(resolveClose => server.close(resolveClose));
}

const tempRoot = mkdtempSync(join(tmpdir(), 'af-planner-first-chat-'));
const projectRoot = join(tempRoot, 'project');
const workspaceRoot = join(tempRoot, 'workspace');
mkdirSync(projectRoot, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
const registryFile = join(tempRoot, 'projects.json');
const missingRegistryFile = join(tempRoot, 'missing-projects.json');
writeFileSync(registryFile, JSON.stringify({
  schema_version: PROJECT_REGISTRY_SCHEMA,
  projects: [{
    project_id: 'browser-project',
    root: projectRoot,
    workspace_root: workspaceRoot,
    acceptance_profiles: [
      { profile_id: 'acceptance-one', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] } },
      { profile_id: 'acceptance-two', acceptance: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] } },
    ],
  }],
}, null, 2));

const fx = plannerFixture({ effort: 'high' });
const initial = readTeam(fx.options.runtimeDir, fx.team.team_id);
const writer = initial.planning.eligible_executors.find(entry => entry.executor_type === 'writer');
assert.ok(writer, 'planner fixture exposes the writer model catalog');
writer.reasoning_efforts = ['high'];
writer.models = writer.models.map(model => model.id === 'planning-model'
  ? { ...model, reasoning_efforts: ['high'], reasoning_status: 'verified', reasoning_control: 'effort', reasoning_source: 'controlled browser fixture' }
  : model);
writer.models.push({ id: 'unknown-model', label: 'Unknown model', reasoning_efforts: [], reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: 'controlled browser fixture' });
commitTeam(fx.options.runtimeDir, initial, 'first-chat-model-fixture', null, () => {});

const controller = new TeamController({ ...fx.options, ...fx.io, select: id => fx.io.adapters[id], autoDeliver: false });
const roots = {
  tasks: fx.options.tasksDir,
  locks: fx.options.locksDir,
  runtime: fx.options.runtimeDir,
  alerts: join(fx.root, 'alerts.jsonl'),
};
const testToken = 'planner-first-chat-browser-token';
const mainEnv = { ...process.env, AF_WEB_TOKEN: testToken, AF_WEB_TOKEN_FILE: '', AF_PROJECTS_FILE: registryFile };
const readOnlyEnv = { ...process.env, AF_WEB_TOKEN: '', AF_WEB_TOKEN_FILE: '', AF_PROJECTS_FILE: registryFile };
const mainToken = resolveWriteToken(mainEnv);
const readOnlyToken = { configured: false, token: null, source: null, reason: 'fixture server has no write token' };
const executorFixture = {
  schema: 'af-v2-executors-v1',
  executors: [{
    id: 'writer', installed: true, adapter_status: 'matched', protocol: 'fixture',
    availability: 'AVAILABLE', capability: 'AVAILABLE', supports_model: true,
    requires_model: false, supports_planner: true, discovery_status: 'ready',
    reasoning_efforts: ['high'], reasoning_status: 'verified',
    models: [
      { id: 'planning-model', label: 'Planning model', reasoning_efforts: ['high'], reasoning_status: 'verified', reasoning_control: 'effort', reasoning_source: 'controlled browser fixture' },
      { id: 'unknown-model', label: 'Unknown model', reasoning_efforts: [], reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: 'controlled browser fixture' },
    ],
  }],
  scan: null,
};
const scanRequests = { readOnly: 0, main: 0 };
const createAttempts = [];
const commandPosts = [];
const runtimeErrors = [];
const tickErrors = [];
let exposeFixtureTeam = false;
const readOnlyApi = createReadApi({
  roots, allowedRoots: [fx.repo], allowRecord: false, env: readOnlyEnv,
  token: readOnlyToken, ensureController: null,
  catalogScanner: async () => { throw new Error('catalog scan must not run in this QA'); },
  agentDiscoverer: () => [],
});
const localSessionAuth=createLocalWriteSessionAuth();
const mainApi = createReadApi({
  roots, allowedRoots: [fx.repo], allowRecord: true, env: mainEnv,
  token: mainToken, ensureController: null, localSessionAuth,
  catalogScanner: async () => { throw new Error('catalog scan must not run in this QA'); },
  agentDiscoverer: () => [],
});

function buildServer({ api, mode }) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/v2/executors') {
      if (url.searchParams.get('scan') === '1') scanRequests[mode]++;
      sendJson(res, 200, { model: executorFixture, paths_redacted: false, path_mode: 'fixture', truncations: [] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/teams' && (mode === 'readOnly' || !exposeFixtureTeam)) {
      // The empty-workspace view hides the already-persisted fixture until controlled intake.
      sendJson(res, 200, { model: { teams: [] }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
      return;
    }
    if (mode === 'main' && req.method === 'POST' && url.pathname === '/api/teams') {
      void (async () => {
        const auth = authorizeWrite({ req, token: mainToken, expectedHosts: [req.headers.host ?? ''],localSessionAuth });
        if (!auth.ok) {
          sendJson(res, auth.status, { model: { ok: false, reason: auth.reason }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
          return;
        }
        const payload = await readBody(req);
        createAttempts.push(payload);
        if (createAttempts.length === 1) {
          sendJson(res, 422, { model: { ok: false, reason: 'controlled first-create failure' }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
          return;
        }
        if (createAttempts.length === 3 && payload.spec?.idempotency_key===createAttempts[1].spec?.idempotency_key) {
          sendJson(res, 200, {model:{ok:true,created:false,team_id:fx.team.team_id,task_id:fx.task.task_id}});
          return;
        }
        if (createAttempts.length !== 2) {
          sendJson(res, 409, { model: { ok: false, reason: 'unexpected duplicate create in browser test' }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
          return;
        }
        const requestedPlanner = payload?.planning?.planner;
        const team = readTeam(fx.options.runtimeDir, fx.team.team_id);
        team.planning.dispatch_mode = payload?.planning?.dispatch_mode;
        team.planning.planner = { ...requestedPlanner };
        team.members[0].executor_type = requestedPlanner?.executor_type;
        team.members[0].model = requestedPlanner?.model ?? null;
        if (requestedPlanner?.effort) team.members[0].effort = requestedPlanner.effort;
        else delete team.members[0].effort;
        commitTeam(fx.options.runtimeDir, team, 'controlled-first-chat-create', null, () => {});
        exposeFixtureTeam = true;
        sendJson(res, 201, { model: {
          ok: true, created: true, team_id: fx.team.team_id, task_id: fx.task.task_id,
        }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
      })().catch(() => {
        if (!res.headersSent) sendJson(res, 500, { model: { ok: false, reason: 'controlled create fixture failed' }, paths_redacted: false, path_mode: 'fixture', truncations: [] });
      });
      return;
    }
    if (req.method === 'POST' && /^\/api\/teams\/[^/]+\/commands$/.test(url.pathname)) commandPosts.push(url.pathname);
    void api(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'fixture_http_failure' });
    });
  });
}

const readOnlyServer = buildServer({ api: readOnlyApi, mode: 'readOnly' });
const mainServer = buildServer({ api: mainApi, mode: 'main' });
const readOnlyUrl = await listen(readOnlyServer);
const mainUrl = await listen(mainServer);
const timer = setInterval(() => controller.tick().catch(error => tickErrors.push(String(error?.message ?? error))), 25);
const profile = mkdtempSync(join(tmpdir(), 'af-planner-first-chat-chrome-'));
const chrome = spawnManaged(process.env.AF_BROWSER_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let browser;
let report;
try {
  const portFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  while (!existsSync(portFile) && Date.now() < deadline && chrome.exitCode == null) await delay(100);
  if (!existsSync(portFile)) throw new Error('Chromium did not expose its DevTools port');
  const chromePort = readFileSync(portFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  browser = await DevTools.connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  browser.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') runtimeErrors.push('console error');
  });
  await browser.send('Runtime.enable');
  await browser.send('Page.enable');
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.firstChatQa={saveClicks:0};document.addEventListener('click',event=>{if(event.target.closest?.('#save-console-planner'))window.firstChatQa.saveClicks++;},true);` });
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  await browser.send('Page.navigate', { url: `${readOnlyUrl}/teams.html` });
  await browser.waitFor("document.getElementById('connection')?.dataset.status==='connected' && document.getElementById('planner-chat-hint')?.textContent.includes('只读模式')").catch(async error => {
    console.error(JSON.stringify(await browser.evaluate("({state:document.getElementById('team-state')?.textContent,hint:document.getElementById('planner-chat-hint')?.textContent,connection:document.getElementById('connection')?.textContent,notice:document.getElementById('notice')?.textContent,scriptErrors:window.firstChatQa})")));
    throw error;
  });
  check('workspace starts with no selected or listed team', await browser.evaluate("document.getElementById('team-state').hidden&&document.querySelectorAll('#teams [data-team]').length===0"));
  check('read-only workspace explains why direct chat is unavailable', await browser.evaluate("document.getElementById('planner-chat-hint').textContent.includes('只读模式')&&document.getElementById('planner-send').disabled"));
  check('read-only workspace does not offer a permission connection button', await browser.evaluate("document.getElementById('planner-connect-access').hidden"));

  await browser.send('Page.navigate', { url: `${mainUrl}/teams.html` });
  await browser.waitFor("document.getElementById('connection')?.dataset.status==='connected' && !document.getElementById('planner-connect-access').hidden");
  check('missing authorization is explained beside chat', await browser.evaluate("document.getElementById('planner-chat-hint').textContent.includes('授权')"));
  check('missing authorization exposes the one-click button', await browser.evaluate("!document.getElementById('planner-connect-access').hidden"));
  check('new-team state hides save-console-planner', await browser.evaluate("document.getElementById('save-console-planner').hidden"));

  await browser.click('#planner-connect-access');
  await browser.waitFor("document.getElementById('access-label').textContent==='取消授权'");
  await browser.waitFor("document.getElementById('planner-chat-hint')?.textContent.includes('尚未接入工作项目')===false && document.getElementById('console-project')?.options.length>1");
  check('the sole registered project auto-selects after permission is connected', await browser.evaluate("document.getElementById('console-project').value==='browser-project'"));
  check('multiple acceptance profiles remain unselected until an explicit choice', await browser.evaluate("document.getElementById('console-acceptance').value===''&&document.getElementById('console-acceptance').options.length===3"));

  mainEnv.AF_PROJECTS_FILE = missingRegistryFile;
  await browser.click('#refresh');
  await browser.waitFor("document.getElementById('planner-chat-hint')?.textContent.includes('尚未接入工作项目')");
  check('unregistered-project state explains why chat cannot start', await browser.evaluate("document.getElementById('planner-chat-hint').textContent==='尚未接入工作项目，注册项目后即可开始商讨。'&&document.getElementById('planner-send').disabled"));
  mainEnv.AF_PROJECTS_FILE = registryFile;
  await browser.click('#refresh');
  await browser.waitFor("document.getElementById('console-project')?.value==='browser-project'&&document.getElementById('console-acceptance')?.options.length===3");
  check('restoring the registry keeps the one project selected and acceptance explicit', await browser.evaluate("document.getElementById('console-project').value==='browser-project'&&document.getElementById('console-acceptance').value===''"));

  await browser.evaluate("document.getElementById('console-acceptance').value='acceptance-one';document.getElementById('console-acceptance').dispatchEvent(new Event('change',{bubbles:true}))");
  await browser.evaluate("document.getElementById('console-planner-model-select').value='unknown-model';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}))");
  check('unverified model has no guessed effort options', await browser.evaluate("document.getElementById('console-planner-effort').disabled&&[...document.getElementById('console-planner-effort').options].map(option=>option.value).every(value=>value==='')"));
  await browser.evaluate("document.getElementById('console-planner-model-select').value='planning-model';document.getElementById('console-planner-model-select').dispatchEvent(new Event('change',{bubbles:true}))");
  equal('verified model exposes only its exact high effort grade', await browser.evaluate("[...document.getElementById('console-planner-effort').options].map(option=>option.value)"), ['', 'high']);
  await browser.evaluate("document.getElementById('console-planner-effort').value='high';document.getElementById('console-planner-effort').dispatchEvent(new Event('change',{bubbles:true}))");
  check('selected profile can be sent directly without saving Planner settings', await browser.evaluate("!document.getElementById('planner-send').disabled&&document.getElementById('save-console-planner').hidden&&window.firstChatQa.saveClicks===0"));

  const firstMessage = '直接商讨目标边界和验收；先不要派发 Worker。';
  await browser.evaluate(`document.getElementById('planner-input').value=${JSON.stringify(firstMessage)};document.getElementById('planner-input').dispatchEvent(new Event('input',{bubbles:true}))`);
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('notice')?.textContent.includes('controlled first-create failure')");
  check('failed first-create keeps the original message available for retry', await browser.evaluate(`document.getElementById('planner-input').value===${JSON.stringify(firstMessage)}`));
  check('failed first-create displays the controlled error to the user', await browser.evaluate("document.getElementById('notice').textContent.includes('controlled first-create failure')"));
  equal('failed creation sends only registry identity, goal/idempotency, and planning', Object.keys(createAttempts[0]).sort(), ['planning', 'profile_id', 'project_id', 'spec']);
  equal('first-chat spec contains no caller-controlled path, acceptance, or nested registry IDs', Object.keys(createAttempts[0].spec).sort(), ['goal', 'idempotency_key']);
  equal('first-create uses the explicitly selected project and profile', [createAttempts[0].project_id, createAttempts[0].profile_id], ['browser-project', 'acceptance-one']);
  equal('first-create selects human-controlled dispatch', createAttempts[0].planning.dispatch_mode, 'human');
  equal('first-create carries the exact selected Planner and effort', createAttempts[0].planning.planner, { executor_type: 'writer', model: 'planning-model', effort: 'high' });

  await browser.evaluate(`(()=>{
    const nativeFetch=window.fetch;window.loseCreateResponse=true;window.messageRequests=[];window.blockTeamReads=false;window.blockedTeamReads=0;window.receipt403=0;window.forceReceipt403=false;
    window.fetch=async(url,...options)=>{
      const body=options[0]?.body?JSON.parse(options[0].body):null;
      if(body?.command?.type==='message') {
        window.messageRequests.push(body);
        if(window.messageRequests.length===2||window.messageRequests.length===4){window.blockTeamReads=false;window.forceReceipt403=false;}
        const response=await nativeFetch(url,...options);
        if(window.messageRequests.length===1){window.blockTeamReads=true;throw new TypeError('controlled message response loss');}
        if(window.messageRequests.length===3)window.forceReceipt403=true;
        return response;
      }
      if(window.forceReceipt403&&String(url).startsWith('/api/teams/')){window.receipt403++;return new Response(JSON.stringify({model:{reason:'controlled receipt read forbidden'}}),{status:403,headers:{'content-type':'application/json'}});}
      if(window.blockTeamReads&&String(url).startsWith('/api/teams/')){window.blockedTeamReads++;throw new TypeError('controlled receipt read failure');}
      const response=await nativeFetch(url,...options);
      if(window.loseCreateResponse&&String(url)==='/api/teams'&&options[0]?.method==='POST'&&response.ok){window.loseCreateResponse=false;throw new TypeError('controlled create response loss');}
      return response;
    };
  })()`);
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('planner-chat-hint').textContent.includes('目标创建回执未确认')&&!document.getElementById('planner-send').disabled");
  check('uncertain creation freezes the original goal and project/model/Worker settings',await browser.evaluate("document.getElementById('planner-input').readOnly&&document.getElementById('console-project').disabled&&document.getElementById('console-planner-executor').disabled&&document.getElementById('configure-workers').disabled"));
  check('uncertain creation retains the exact first message',await browser.evaluate(`document.getElementById('planner-input').value===${JSON.stringify(firstMessage)}`));
  equal('uncertain creation has not launched any model',fx.calls.length,0);
  check('an exposed listing cannot auto-select a team while intake is uncertain',await browser.evaluate("document.getElementById('team-state').hidden"));
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('planner-chat-hint').textContent.includes('消息回执未确认')&&document.getElementById('planner-input').readOnly&&!document.getElementById('planner-send').disabled");
  check('lost message response freezes text, suggestions and profile until its receipt is confirmed',await browser.evaluate(`document.getElementById('planner-input').value===${JSON.stringify(firstMessage)}&&document.getElementById('console-planner-executor').disabled&&[...document.querySelectorAll('[data-prompt]')].every(button=>button.disabled)`));
  await browser.click('#refresh');await browser.waitFor('window.blockedTeamReads>0');
  check('an actual detail read fails while the message response is uncertain',await browser.evaluate('window.blockedTeamReads>0'));
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('planner-conversation')?.textContent.includes('建议先明确目标与验收') && !document.getElementById('planner-input').value && !document.getElementById('planner-input').readOnly");
  const messageRequests=await browser.evaluate('window.messageRequests');
  equal('message response-loss retry uses the identical command ID and payload',messageRequests[1],messageRequests[0]);
  equal('message response loss and retry launch only one Planner discussion',fx.calls.length,1);
  check('confirmed message receipt unlocks the input',await browser.evaluate("!document.getElementById('planner-input').readOnly"));
  const nextMessage='回执读取失败后，继续使用同一条消息。';
  await browser.evaluate(`document.getElementById('planner-input').value=${JSON.stringify(nextMessage)}`);
  await browser.click('#planner-send');
  await browser.waitFor("document.getElementById('planner-input').readOnly&&!document.getElementById('planner-send').disabled&&window.receipt403>0");
  check('a receipt GET 403 after accepted POST keeps the original text frozen',await browser.evaluate(`document.getElementById('planner-input').value===${JSON.stringify(nextMessage)}`));
  await browser.click('#planner-send');
  await browser.waitFor("!document.getElementById('planner-input').value&&!document.getElementById('planner-input').readOnly");
  const after403=await browser.evaluate('window.messageRequests');
  equal('receipt GET 403 retry keeps the accepted command ID and payload',after403[3],after403[2]);
  equal('receipt GET 403 cannot create a second durable message',controller.read(fx.team.team_id).messages.filter(m=>m.from_agent_id==='operator'&&m.message===nextMessage).length,1);
  equal('create retry reuses the same idempotency key', createAttempts.map(attempt => attempt.spec.idempotency_key).length, 3);
  check('create retry key is identical after the controlled failure', createAttempts[0].spec.idempotency_key === createAttempts[1].spec.idempotency_key);
  equal('response-loss retry preserves the complete original create payload',createAttempts[2],createAttempts[1]);
  check('successful creation exposes the fixture team through the real team listing', await browser.evaluate("document.getElementById('team-state')?.textContent==='与 Planner 商讨'&&document.getElementById('planner-model')?.textContent.includes('planning-model')"));
  check('chat command used the real HTTP team-command route', commandPosts.some(path => path === `/api/teams/${encodeURIComponent(fx.team.team_id)}/commands`));
  check('actual lead received the first user message in the durable team log', controller.read(fx.team.team_id).messages.some(message => message.from_agent_id === 'operator' && message.to_agent_id === 'lead' && message.message === firstMessage));
  check('fixture Planner reply is visible in the browser conversation', await browser.evaluate("document.getElementById('planner-conversation').textContent.includes('建议先明确目标与验收，再确定分工。')"));
  check('selected model and exact effort reach the fixture model call', fx.calls.some(call => call.work_item_id === 'discuss' && call.model === 'planning-model' && call.effort === 'high'));
  check('direct first chat starts no Worker work', fx.calls.filter(call => ['a', 'b', 'c'].includes(call.work_item_id)).length === 0 && controller.read(fx.team.team_id).members.filter(member => member.role === 'worker').every(member => member.status === 'IDLE'));

  clearInterval(timer);
  const failureMessageId='CMD-ui-failure', failureRunId='RUN-ui-failure';
  const failureState=readTeam(fx.options.runtimeDir,fx.team.team_id);
  failureState.messages.push({message_id:failureMessageId,from_agent_id:'operator',to_agent_id:'lead',goal_revision:failureState.goal_revision,
    status:'queued',received_by:failureRunId,message:'受控失败状态检查',created_at:new Date().toISOString()});
  failureState.commands[failureMessageId]={status:'received'};
  failureState.runs.push({run_id:failureRunId,agent_id:'lead',work_item_id:'discuss',kind:'discuss',goal_revision:failureState.goal_revision,
    message_ids:[failureMessageId],status:'FAILED',process_state:'EXITED',writer_termination:{process_started:false,termination_confirmed:true,
      process_group_alive:false,scope_verified:true,scope_empty:true,scope_kind:'none'},error:'TRUSTED_IMPORT_WRITER_SCOPE_UNAVAILABLE: cgroup EACCES /var/run/private Bearer abcdefghijk'});
  failureState.state='BLOCKED';failureState.failure_reason='TRUSTED_IMPORT_WRITER_SCOPE_UNAVAILABLE: cgroup EACCES /var/run/private';
  commitTeam(fx.options.runtimeDir,failureState,'controlled-planner-ui-failure',null,()=>{});
  await browser.click('#refresh');
  await browser.waitFor("[...document.querySelectorAll('.chat-bubble.from-operator')].some(b=>b.textContent.includes('受控失败状态检查')&&b.textContent.includes('Planner 执行失败')&&b.textContent.includes('Planner 进程未启动'))");
  check('failed queued chat shows that Planner execution failed before process start',await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控失败状态检查'));return b?.querySelector('strong small')?.textContent==='已排队'&&b.textContent.includes('Planner 执行失败')&&b.textContent.includes('Planner 进程未启动')&&!b.textContent.includes('已落实')&&!b.textContent.includes('已收到')})()`));
  check('failure detail is server-redacted and does not expose the path or bearer token',await browser.evaluate("(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控失败状态检查'));return !b.textContent.includes('/var/run/private')&&!b.textContent.includes('abcdefghijk')&&b.textContent.includes('sha256:')})()"));
  check('a previously applied Planner message is not relabeled by a later failure',await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes(${JSON.stringify(firstMessage)}));return b?.querySelector('strong small')?.textContent==='已落实'&&!b.querySelector('.chat-run-outcome')})()`));

  const retryRunId='RUN-ui-failure-retry';
  const retryState=readTeam(fx.options.runtimeDir,fx.team.team_id), retryMessage=retryState.messages.find(m=>m.message_id===failureMessageId);
  retryState.runs.push({run_id:retryRunId,agent_id:'lead',work_item_id:'discuss',kind:'discuss',goal_revision:retryState.goal_revision,
    message_ids:[failureMessageId],status:'RUNNING',process_state:'RUNNING',writer_termination:null,error:null});
  retryMessage.received_by=retryRunId;retryMessage.status='queued';retryState.state='DISCUSSING';retryState.failure_reason=null;
  retryState.members.find(m=>m.agent_id==='lead').status='RUNNING';
  commitTeam(fx.options.runtimeDir,retryState,'controlled-planner-ui-retry-running',null,()=>{});
  await browser.click('#refresh');
  await browser.waitFor("[...document.querySelectorAll('.chat-bubble.from-operator')].some(b=>b.textContent.includes('受控失败状态检查')&&b.textContent.includes('Planner 正在处理此消息'))");
  check('a new RUNNING retry takes precedence over the preserved FAILED run and restores the thinking hint',await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控失败状态检查'));return b?.querySelector('strong small')?.textContent==='已排队'&&b.textContent.includes('Planner 正在处理此消息')&&!b.textContent.includes('Planner 执行失败')&&!b.textContent.includes('EACCES')&&document.querySelector('.planner-thinking')?.textContent.includes('Planner 正在思考')})()`));
  equal('retry history keeps the failed attempt and adds a distinct running attempt',controller.read(fx.team.team_id).runs.filter(r=>[failureRunId,retryRunId].includes(r.run_id)).map(r=>[r.run_id,r.status]),[[failureRunId,'FAILED'],[retryRunId,'RUNNING']]);

  const recoveredState=readTeam(fx.options.runtimeDir,fx.team.team_id), retryRun=recoveredState.runs.find(r=>r.run_id===retryRunId), recoveredMessage=recoveredState.messages.find(m=>m.message_id===failureMessageId);
  recoveredState.state='DISCUSSING';retryRun.status='COMPLETED';retryRun.process_state='EXITED';retryRun.writer_termination={process_started:true,termination_confirmed:true,
    process_group_alive:false,scope_verified:true,scope_empty:true,scope_kind:'cgroup'};retryRun.error=null;recoveredState.members.find(m=>m.agent_id==='lead').status='IDLE';
  recoveredMessage.status='applied';recoveredMessage.applied_by=retryRunId;
  commitTeam(fx.options.runtimeDir,recoveredState,'controlled-planner-ui-retry-completed',null,()=>{});
  await browser.click('#refresh');
  await browser.waitFor("[...document.querySelectorAll('.chat-bubble.from-operator')].some(b=>b.textContent.includes('受控失败状态检查')&&b.querySelector('strong small')?.textContent==='已落实')");
  check('a successful retry clears the failure banner and shows the applied message status',await browser.evaluate("(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控失败状态检查'));return b?.querySelector('strong small')?.textContent==='已落实'&&!b.querySelector('.chat-run-outcome')})()"));
  equal('a successful retry leaves the prior FAILED run in history',controller.read(fx.team.team_id).runs.filter(r=>[failureRunId,retryRunId].includes(r.run_id)).map(r=>[r.run_id,r.status]),[[failureRunId,'FAILED'],[retryRunId,'COMPLETED']]);

  const startedFailureMessageId='CMD-ui-started-failure', startedFailureRunId='RUN-ui-started-failure';
  const startedFailureState=readTeam(fx.options.runtimeDir,fx.team.team_id);
  startedFailureState.messages.push({message_id:startedFailureMessageId,from_agent_id:'operator',to_agent_id:'lead',goal_revision:startedFailureState.goal_revision,
    status:'queued',received_by:startedFailureRunId,message:'受控已启动失败状态检查',created_at:new Date().toISOString()});
  startedFailureState.runs.push({run_id:startedFailureRunId,agent_id:'lead',work_item_id:'discuss',kind:'discuss',goal_revision:startedFailureState.goal_revision,
    message_ids:[startedFailureMessageId],status:'FAILED',process_state:'EXITED',writer_termination:{process_started:true,termination_confirmed:true,
      process_group_alive:false,scope_verified:true,scope_empty:true,scope_kind:'cgroup'},error:'controlled Planner error after process start'});
  startedFailureState.state='BLOCKED';
  commitTeam(fx.options.runtimeDir,startedFailureState,'controlled-planner-ui-started-failure',null,()=>{});
  await browser.click('#refresh');
  await browser.waitFor("[...document.querySelectorAll('.chat-bubble.from-operator')].some(b=>b.textContent.includes('受控已启动失败状态检查')&&b.textContent.includes('Planner 执行失败'))");
  check('a FAILED run is shown even when its process did start',await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控已启动失败状态检查'));return b?.querySelector('strong small')?.textContent==='已排队'&&b.textContent.includes('controlled Planner error after process start')&&!b.textContent.includes('Planner 进程未启动')})()`));

  const unconfirmedMessageId='CMD-ui-unconfirmed', unconfirmedRunId='RUN-ui-unconfirmed';
  const unconfirmedState=readTeam(fx.options.runtimeDir,fx.team.team_id);
  unconfirmedState.messages.push({message_id:unconfirmedMessageId,from_agent_id:'operator',to_agent_id:'lead',goal_revision:unconfirmedState.goal_revision,
    status:'queued',received_by:unconfirmedRunId,message:'受控未确认状态检查',created_at:new Date().toISOString()});
  unconfirmedState.runs.push({run_id:unconfirmedRunId,agent_id:'lead',work_item_id:'discuss',kind:'discuss',goal_revision:unconfirmedState.goal_revision,
    message_ids:[unconfirmedMessageId],status:'UNCONFIRMED',process_state:'EXITED',writer_termination:{process_started:true,termination_confirmed:false,
      process_group_alive:true,scope_verified:false,scope_empty:false,scope_kind:'cgroup'},error:'controlled Planner termination evidence is unavailable'});
  unconfirmedState.state='RECOVERY_REQUIRED';
  commitTeam(fx.options.runtimeDir,unconfirmedState,'controlled-planner-ui-unconfirmed',null,()=>{});
  await browser.click('#refresh');
  await browser.waitFor("[...document.querySelectorAll('.chat-bubble.from-operator')].some(b=>b.textContent.includes('受控未确认状态检查')&&b.textContent.includes('Planner 执行状态未确认'))");
  check('UNCONFIRMED runs show the execution uncertainty and preserve the queued receipt',await browser.evaluate(`(()=>{const b=[...document.querySelectorAll('.chat-bubble.from-operator')].find(x=>x.textContent.includes('受控未确认状态检查'));return b?.querySelector('strong small')?.textContent==='已排队'&&b.textContent.includes('Planner 执行状态未确认')&&b.textContent.includes('终止状态尚未确认')&&!b.textContent.includes('已落实')})()`));

  check('new-team save-console-planner was never clicked', await browser.evaluate('window.firstChatQa.saveClicks===0'));
  equal('no native catalog scan ran during the browser flow', [scanRequests.readOnly, scanRequests.main], [0, 0]);
  equal('browser runtime exceptions are absent', browser.errors, []);
  equal('frontend JavaScript console errors are absent', runtimeErrors, []);
  equal('fixture controller has no rejected tick errors', tickErrors, []);

  report = {
    ok: true,
    browser: 'Chromium',
    model_adapters: 'controlled plannerFixture only',
    team_http: 'real createReadApi GET and durable command/controller flow; controlled POST /api/teams responses',
    checks,
    check_count: checks.length,
    create_attempt_count: createAttempts.length,
    worker_run_count: fx.calls.filter(call => ['a', 'b', 'c'].includes(call.work_item_id)).length,
    verified_at: new Date().toISOString(),
  };
} finally {
  clearInterval(timer);
  browser?.close();
  if (chrome.exitCode == null && chrome.signalCode == null) {
    await new Promise(resolveStop => {
      const timeout = setTimeout(() => signalTree(chrome, 'SIGKILL'), 5000);
      chrome.once('close', () => { clearTimeout(timeout); resolveStop(); });
      signalTree(chrome, 'SIGTERM');
    });
  }
  await controller.close();
  await closeServer(readOnlyServer);
  await closeServer(mainServer);
  fx.cleanup();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(JSON.stringify(report, null, 2));
