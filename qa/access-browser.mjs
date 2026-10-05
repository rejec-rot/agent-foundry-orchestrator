// Real Chromium regression for local authorization; all services and credentials are fixtures.
// Run: node qa/access-browser.mjs [--output-dir /tmp/af-access-browser]
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevTools } from './browser-client.mjs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-dir');
if (args.length !== 0 && (args.length !== 2 || outputIndex !== 0 || !args[1] || args[1].startsWith('--'))) {
  throw new Error('Usage: node qa/access-browser.mjs [--output-dir PATH]');
}
const outputDir = outputIndex < 0 ? mkdtempSync(join(tmpdir(), 'af-access-browser-artifacts-')) : resolve(args[outputIndex + 1]);
mkdirSync(outputDir, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'af-access-browser-fixture-'));
const profile = join(root, 'chrome-profile');
const configDir = join(root, 'executor-config');
const roots = { tasks: join(root, 'tasks'), locks: join(root, 'locks'), runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') };
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const path of [profile, configDir, roots.tasks, roots.locks, roots.runtime, join(root, 'project'), join(root, 'workspaces')]) mkdirSync(path, { recursive: true });

// Set isolated paths before importing configuration consumers. Never load host accounts or keys.
const isolatedEnv = {
  AF_EXECUTORS_DIR: join(repository, 'fixtures', 'agent-foundry-global', 'executors'),
  AF_OPERATOR_EXECUTORS_FILE: join(root, 'operator-executors.json'),
  AF_SAFETY_STATE_FILE: join(root, 'executor-safety.json'),
  AF_RUNTIME_EVENTS_LOG: join(root, 'executor-events.jsonl'),
  CODEX_CONFIG_PATH: join(configDir, 'config.toml'),
  CLAUDE_SETTINGS_PATH: join(configDir, 'claude.json'),
  CLINE_SETTINGS_PATH: join(configDir, 'cline.json'),
  COMMAND_CODE_CONFIG_PATH: join(configDir, 'command-code.json'),
};
const originalEnv = new Map(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, isolatedEnv);
writeFileSync(isolatedEnv.AF_OPERATOR_EXECUTORS_FILE, JSON.stringify({ disabled: [] }));
writeFileSync(isolatedEnv.CODEX_CONFIG_PATH, 'model = "fixture-default-model"\nmodel_reasoning_effort = "high"\n');
for (const key of ['CLAUDE_SETTINGS_PATH', 'CLINE_SETTINGS_PATH', 'COMMAND_CODE_CONFIG_PATH']) writeFileSync(isolatedEnv[key], '{}');

const checks = [], services = [], pages = [];
const counters = { scans: 0, adapterRuns: 0, adapterResumes: 0, workerSpawns: 0, controllerStarts: 0 };
const timings = {};
const requestLog = [];
const delay = ms => new Promise(done => setTimeout(done, ms));
const check = (name, value) => {
  checks.push({ name, ok: value === true });
  assert.equal(value, true, name);
};
const pollBudgetMs = 3500;
let chrome, chromeControl, failure;

function fingerprint(path) {
  const hash = createHash('sha256');
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name), absolute = join(directory, entry.name);
      hash.update(relative);
      if (entry.isDirectory()) walk(absolute, relative);
      else hash.update(readFileSync(absolute));
    }
  };
  walk(path);
  return hash.digest('hex');
}

// The instrumentation records booleans and route names; no credential values enter the report.
const instrumentation = `(() => {
  window.accessQa = { requests: [], visibilityChanges: [] };
  document.addEventListener('visibilitychange', () => window.accessQa.visibilityChanges.push(document.hidden));
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const headers = new Headers(options.headers ?? (input instanceof Request ? input.headers : undefined));
    const record = { path: url.pathname, search: url.search, method: options.method ?? input.method ?? 'GET', bearer: headers.has('authorization') };
    window.accessQa.requests.push(record);
    const response = await nativeFetch(input, options);
    if (/^\\/api\\/v2\\/access\\/(authorize|revoke)$/.test(url.pathname)) {
      const body = await response.clone().json();
      const model = body.model ?? body;
      record.responseFields = Object.keys(model).sort();
    }
    return response;
  };
})();`;

async function ready(page, type, authorized = false, readOnly = false) {
  const label = authorized ? '取消授权' : readOnly ? '只读模式' : '一键授权';
  await page.waitFor(`document.getElementById('access-label')?.textContent === ${JSON.stringify(label)}`);
  await page.waitFor(type === 'teams'
    ? "document.getElementById('team-state')?.textContent === '与 Planner 商讨' && document.getElementById('connection')?.dataset.status === 'connected' && !document.getElementById('refresh').hasAttribute('aria-busy')"
    : "Boolean(document.querySelector('#detail .work-head')) && document.getElementById('conn')?.textContent.includes('已连接')");
}

async function waitForPeer(page, authorized, name, started) {
  await page.waitFor(`document.getElementById('access-label')?.textContent === ${JSON.stringify(authorized ? '取消授权' : '一键授权')}`, pollBudgetMs);
  timings[name] = Date.now() - started;
  check(name + ' propagates through polling within 3.5 seconds', timings[name] <= pollBudgetMs);
}

async function setDrafts(teams, workbench, suffix) {
  const teamDraft = { 'planner-input': '先保留我的 Planner 草稿 ' + suffix, message: '尚未发送的成员消息 ' + suffix, 'new-goal': '尚未提交的整体目标 ' + suffix };
  const workDraft = { 's-goal': '交付草稿 ' + suffix, 's-target': join(root, 'project'), 's-command': 'node', 's-args': '--test draft.test.mjs', 's-key': 'draft-' + suffix, 'msg-text': '尚未排队的交付消息 ' + suffix };
  for (const [page, values] of [[teams, teamDraft], [workbench, workDraft]]) {
    await page.evaluate(`(() => { for (const [id, value] of Object.entries(${JSON.stringify(values)})) { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  }
  return async () => {
    const values = await Promise.all([[teams, teamDraft], [workbench, workDraft]].map(([page, draft]) => page.evaluate(`Object.entries(${JSON.stringify(draft)}).every(([id, value]) => document.getElementById(id).value === value)`)));
    return values.every(Boolean);
  };
}

async function noJsCredentials(page) {
  return page.evaluate("sessionStorage.getItem('af-write-token') === null && !document.cookie.includes('af_local_session') && [...document.querySelectorAll('input[type=password]')].every(input => !input.value) && window.accessQa.requests.every(request => !request.bearer)");
}

try {
  const [{ startReadApi }, { ADAPTERS }, { newTeam }, { createTeamRecord }, { spawnManaged }] = await Promise.all([
    import('../server/read-api.mjs'), import('../lib/adapters.mjs'), import('../lib/team/model.mjs'),
    import('../lib/team/store.mjs'), import('../lib/child-process.mjs'),
  ]);
  // Even a regression which accidentally submits work cannot reach a real adapter.
  for (const adapter of Object.values(ADAPTERS)) {
    if (typeof adapter.health === 'function') mock.method(adapter, 'health', () => ({ ok: true }));
    if (typeof adapter.run === 'function') mock.method(adapter, 'run', () => { counters.adapterRuns++; throw new Error('browser access QA refuses agent dispatch'); });
    if (typeof adapter.resume === 'function') mock.method(adapter, 'resume', () => { counters.adapterResumes++; throw new Error('browser access QA refuses agent resume'); });
  }
  const task = {
    task_id: 'TASK-ACCESS-QA', state: 'CREATED', state_version: 1, goal: '授权浏览器验收用团队',
    fixture_dir: join(root, 'project'), task_mode: 'workspace', author_executor: 'codex', reviewer_executor: 'codex',
    author_model: 'fixture-default-model', reviewer_model: 'fixture-default-model', runs: [],
    acceptance_cmd: { command: 'node', args: ['--test', 'tests/gate.test.mjs'] },
  };
  const team = newTeam(task);
  team.state = 'DISCUSSING'; team.rework_requests = [];
  team.members[0].model = 'fixture-default-model';
  team.planning = {
    workflow: 'planner', dispatch_mode: 'human', planner: { executor_type: 'codex', model: 'fixture-default-model', effort: 'high' }, approved_plan_revision: null,
    eligible_executors: [{ executor_type: 'codex', supports_model: true, supports_effort: true, reasoning_efforts: ['low', 'high'],
      models: [{ id: 'fixture-default-model', label: 'Fixture model', reasoning_efforts: ['low', 'high'], reasoning_status: 'verified' }] }],
  };
  task.team_binding = { team_id: team.team_id, goal_revision: 1 };
  writeFileSync(join(roots.tasks, task.task_id + '.json'), JSON.stringify(task));
  createTeamRecord(roots.runtime, team);
  const projectsFile = join(root, 'projects.json');
  writeFileSync(projectsFile, JSON.stringify({ schema_version: 'af-project-registry-v1', projects: [{
    project_id: 'access-qa', root: join(root, 'project'), workspace_root: join(root, 'workspaces'),
    policy: { allowed_root: ['**'], forbidden: [], protected_paths: [], projection: { exclude: [] }, import: { deny: [] } },
    acceptance_profiles: [{ profile_id: 'access-qa', acceptance: task.acceptance_cmd, assets: [] }],
  }] }));
  const baseline = { tasks: fingerprint(roots.tasks), runtime: fingerprint(roots.runtime) };
  const env = { ...isolatedEnv, AF_WEB_TOKEN: 'fixture-only-access-browser-token', AF_WEB_TOKEN_FILE: '', AF_PROJECTS_FILE: projectsFile };
  const serve = async (name, allowRecord) => {
    const handle = await startReadApi({ roots, allowedRoots: [join(root, 'project')], allowRecord, env,
      agentDiscoverer: () => [],
      catalogScanner: async () => { counters.scans++; throw new Error('browser access QA refuses native scans'); },
      ensureController: () => { counters.controllerStarts++; throw new Error('browser access QA refuses controller launch'); },
      spawnWorker: () => { counters.workerSpawns++; throw new Error('browser access QA refuses worker launch'); },
    });
    services.push(handle);
    handle.server.on('request', (req, res) => {
      const record = { service: name, method: req.method, path: new URL(req.url, handle.url).pathname,
        scan: new URL(req.url, handle.url).searchParams.get('scan') === '1', bearer: Boolean(req.headers.authorization),
        csrf: req.headers['x-af-csrf'] === '1', sameOrigin: req.headers.origin === handle.url,
        page: req.headers.referer ? new URL(req.headers.referer).pathname : null };
      requestLog.push(record);
      res.once('finish', () => {
        record.status = res.statusCode;
        const cookie = res.getHeader('set-cookie');
        if (cookie) record.cookieFlags = { httpOnly: /;\s*HttpOnly/i.test(String(cookie)), strict: /;\s*SameSite=Strict/i.test(String(cookie)), cleared: /;\s*Max-Age=0/i.test(String(cookie)) };
      });
    });
    return handle;
  };
  const writable = await serve('writable', true);
  const readOnly = await serve('read-only', false);
  check('both read APIs use isolated ephemeral ports', [writable.port, readOnly.port].every(port => port !== 8787 && port !== 8788) && writable.port !== readOnly.port);

  chrome = spawnManaged(process.env.AF_BROWSER_BIN ?? '/usr/bin/google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk.toString()).slice(-2000); });
  const portFile = join(profile, 'DevToolsActivePort'), deadline = Date.now() + 15000;
  while (!existsSync(portFile) && Date.now() < deadline && chrome.exitCode === null) await delay(100);
  if (!existsSync(portFile)) throw new Error('Chromium failed: ' + chromeLog);
  const [port, endpoint] = readFileSync(portFile, 'utf8').trim().split('\n');
  chromeControl = await DevTools.connect(`ws://127.0.0.1:${port}${endpoint}`);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const teams = await DevTools.connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  pages.push(teams);
  // A window per page keeps both documents visible, so the test exercises polling itself.
  const { targetId } = await chromeControl.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: false });
  const withWorkbench = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const workbench = await DevTools.connect(withWorkbench.find(target => target.id === targetId).webSocketDebuggerUrl);
  pages.push(workbench);
  for (const page of pages) {
    await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Network.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  }
  await teams.send('Page.navigate', { url: writable.url + '/teams.html' });
  await ready(teams, 'teams');
  await workbench.send('Page.navigate', { url: writable.url + '/workbench.html#' + task.task_id });
  await ready(workbench, 'workbench');
  check('same-origin windows are visible for real background-free polling', await teams.evaluate('!document.hidden') && await workbench.evaluate('!document.hidden'));
  await delay(1700);
  check('opening either workspace never authorizes automatically', !requestLog.some(request => request.method !== 'GET') &&
    await teams.evaluate("document.getElementById('authorize-access').dataset.authorized === 'false'") && await workbench.evaluate("document.getElementById('authorize-access').dataset.authorized === 'false'"));
  check('opening either workspace loads metadata without a native scan', counters.scans === 0 && !requestLog.some(request => request.scan));
  check('unauthorized team write actions stay disabled', await teams.evaluate("document.getElementById('planner-send').disabled && document.getElementById('propose-plan').disabled && document.getElementById('start').disabled"));
  check('unauthorized workbench write actions stay disabled', await workbench.evaluate("['s-create','s-record','a-start','a-cancel','msg-send'].every(id => document.getElementById(id).disabled)"));
  const draftsPreserved = await setDrafts(teams, workbench, 'initial');
  const peerVisibility = await workbench.evaluate('window.accessQa.visibilityChanges.length');
  const grantAt = Date.now();
  await teams.click('#authorize-access');
  await ready(teams, 'teams', true);
  await waitForPeer(workbench, true, 'teams grant to workbench', grantAt);
  check('teams one-click authorization requires no token dialog', await teams.evaluate("!document.querySelector('dialog[open]') && !document.getElementById('access-advanced').open"));
  check('shared authorization enables Planner and delivery write controls', await teams.evaluate("!document.getElementById('planner-send').disabled && !document.getElementById('propose-plan').disabled") &&
    await workbench.evaluate("['s-create','s-record','a-start','a-cancel','msg-send'].every(id => !document.getElementById(id).disabled)"));
  check('peer authorization arrives without navigation or a visibility refresh', await workbench.evaluate(`window.accessQa.visibilityChanges.length === ${peerVisibility}`) &&
    requestLog.some(request => request.page === '/workbench.html' && request.path === '/api/v2/access/status' && request.status === 200));
  check('authorization preserves all current drafts in both windows', await draftsPreserved());
  const grants = () => requestLog.filter(request => request.path === '/api/v2/access/authorize');
  check('one click produces exactly one same-origin CSRF-protected grant', grants().length === 1 && grants()[0].method === 'POST' && grants()[0].status === 200 && grants()[0].csrf && grants()[0].sameOrigin);
  const cookies = await teams.send('Network.getCookies', { urls: [writable.url] });
  const grantCookie = cookies.cookies.find(cookie => cookie.name === 'af_local_session');
  check('local grant is an HttpOnly SameSite=Strict cookie', Boolean(grantCookie?.httpOnly && grantCookie.sameSite === 'Strict' && grants()[0].cookieFlags?.httpOnly && grants()[0].cookieFlags?.strict));
  check('grant response carries authorization state and redaction metadata without credentials', await teams.evaluate("window.accessQa.requests.find(request => request.path === '/api/v2/access/authorize').responseFields.join(',') === 'authorized,schema,truncations'"));
  check('local authorization exposes no cookie or bearer token to page JavaScript', await noJsCredentials(teams) && await noJsCredentials(workbench));
  check('granting permission submits no team command or task write', requestLog.filter(request => request.method === 'POST').every(request => request.path === '/api/v2/access/authorize'));
  await teams.screenshot(join(outputDir, 'access-authorized-teams.png'), { fullPage: false });
  await workbench.screenshot(join(outputDir, 'access-authorized-workbench.png'), { fullPage: false });

  await teams.send('Page.reload'); await ready(teams, 'teams', true);
  await workbench.send('Page.reload'); await ready(workbench, 'workbench', true);
  check('both workspaces remain authorized after document reload', await teams.evaluate("!document.getElementById('planner-send').disabled") && await workbench.evaluate("!document.getElementById('s-create').disabled"));
  check('reload reuses the cookie without reauthorizing or storing a token', grants().length === 1 && await noJsCredentials(teams) && await noJsCredentials(workbench));
  const revokeDraftsPreserved = await setDrafts(teams, workbench, 'before-revoke');
  const teamVisibility = await teams.evaluate('window.accessQa.visibilityChanges.length');
  const revokeAt = Date.now();
  await workbench.click('#authorize-access'); await ready(workbench, 'workbench');
  await waitForPeer(teams, false, 'workbench revoke to teams', revokeAt);
  check('cross-window revocation disables all write controls', await teams.evaluate("document.getElementById('planner-send').disabled && document.getElementById('propose-plan').disabled && document.getElementById('start').disabled") &&
    await workbench.evaluate("['s-create','s-record','a-start','a-cancel','msg-send'].every(id => document.getElementById(id).disabled)"));
  check('peer revocation arrives without a visibility refresh', await teams.evaluate(`window.accessQa.visibilityChanges.length === ${teamVisibility}`));
  check('revocation preserves all current drafts in both windows', await revokeDraftsPreserved());
  const revocations = () => requestLog.filter(request => request.path === '/api/v2/access/revoke');
  check('revocation is one same-origin CSRF-protected request and expires the cookie', revocations().length === 1 && revocations()[0].status === 200 && revocations()[0].csrf && revocations()[0].sameOrigin && revocations()[0].cookieFlags?.cleared &&
    !(await teams.send('Network.getCookies', { urls: [writable.url] })).cookies.some(cookie => cookie.name === 'af_local_session'));
  check('revocation leaves no JavaScript credential behind', await noJsCredentials(teams) && await noJsCredentials(workbench));

  // Exercise the opposite buttons as well, using the same untouched drafts.
  const reverseGrantAt = Date.now();
  await workbench.click('#authorize-access'); await ready(workbench, 'workbench', true);
  await waitForPeer(teams, true, 'workbench grant to teams', reverseGrantAt);
  check('workbench one-click authorization keeps advanced token entry closed', await workbench.evaluate("!document.getElementById('access-advanced').open && !document.getElementById('token-input').value"));
  const reverseRevokeAt = Date.now();
  await teams.click('#authorize-access'); await ready(teams, 'teams');
  await waitForPeer(workbench, false, 'teams revoke to workbench', reverseRevokeAt);
  check('granting and revoking from the opposite pages preserve drafts', await revokeDraftsPreserved());
  await teams.send('Page.reload'); await ready(teams, 'teams');
  await workbench.send('Page.reload'); await ready(workbench, 'workbench');
  check('revoked authorization stays revoked after both pages reload', grants().length === 2 && revocations().length === 2 &&
    await teams.evaluate("document.getElementById('planner-send').disabled") && await workbench.evaluate("document.getElementById('s-create').disabled"));
  await teams.screenshot(join(outputDir, 'access-revoked-teams.png'), { fullPage: false });
  await workbench.screenshot(join(outputDir, 'access-revoked-workbench.png'), { fullPage: false });

  await teams.send('Page.navigate', { url: readOnly.url + '/teams.html' }); await ready(teams, 'teams', false, true);
  await workbench.send('Page.navigate', { url: readOnly.url + '/workbench.html#' + task.task_id }); await ready(workbench, 'workbench', false, true);
  for (const [page, name] of [[teams, 'teams'], [workbench, 'workbench']]) {
    check(name + ' disables unavailable local authorization with a read-only explanation', await page.evaluate("document.getElementById('authorize-access').disabled && document.getElementById('access-description').textContent.includes('当前服务仅允许查看') && document.getElementById('access-panel-action').hidden && document.getElementById('access-advanced').hidden"));
    await page.click('#authorize-access');
  }
  await delay(1700);
  check('disabled read-only authorization buttons cannot issue a grant', !requestLog.some(request => request.service === 'read-only' && request.method === 'POST') &&
    await teams.evaluate("document.getElementById('authorize-access').dataset.authorized === 'false'") && await workbench.evaluate("document.getElementById('authorize-access').dataset.authorized === 'false'"));
  await teams.screenshot(join(outputDir, 'access-read-only-teams.png'), { fullPage: false });
  await workbench.screenshot(join(outputDir, 'access-read-only-workbench.png'), { fullPage: false });
  check('no stage of local authorization starts an agent or controller', Object.values(counters).every(count => count === 0));
  check('grant and revoke never dispatch tasks, teams, or native scans', requestLog.filter(request => request.method === 'POST').every(request => ['/api/v2/access/authorize', '/api/v2/access/revoke'].includes(request.path)) && !requestLog.some(request => request.scan));
  check('authorization leaves task records and the team journal unchanged', baseline.tasks === fingerprint(roots.tasks) && baseline.runtime === fingerprint(roots.runtime));
  check('neither workspace sends a JavaScript bearer header', requestLog.every(request => !request.bearer));
  check('both browser windows complete without JavaScript exceptions', pages.every(page => page.errors.length === 0));
} catch (error) {
  failure = error;
} finally {
  for (const page of pages) page.close();
  chromeControl?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const { signalTree } = await import('../lib/child-process.mjs');
    await new Promise(done => {
      const timeout = setTimeout(() => signalTree(chrome, 'SIGKILL'), 5000);
      chrome.once('close', () => { clearTimeout(timeout); done(); });
      signalTree(chrome, 'SIGTERM');
    });
  }
  for (const service of services) { service.server.closeAllConnections(); await service.close(); }
  mock.restoreAll();
  for (const [key, value] of originalEnv) value === undefined ? delete process.env[key] : process.env[key] = value;
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const report = {
    ok: !failure, browser: 'Chromium', checks_passed: checks.filter(item => item.ok).length, check_count: checks.length, checks,
    polling_budget_ms: pollBudgetMs, polling_timings_ms: timings, dispatch_and_scan_counts: counters,
    authorization_requests: requestLog.filter(request => request.method === 'POST'),
    isolation: 'ephemeral loopback HTTP services, temporary browser profile, fixture-only credentials and configuration, blocked agent/model dispatch',
    verified_at: new Date().toISOString(), ...(failure ? { failure: failure.message } : {}),
  };
  writeFileSync(join(outputDir, 'access-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ok: report.ok, checks_passed: report.checks_passed, check_count: report.check_count, output_dir: outputDir, polling_timings_ms: timings, ...(failure ? { failure: failure.message } : {}) }, null, 2));
}
if (failure) throw failure;
