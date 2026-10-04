// Interactive replay of the real controller with virtual, account-free Agents.
// node qa/simulated-workflow.mjs --serve --port 8788 --output-dir /tmp/af-demo
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkbenchBookmarks } from './workbench-bookmarks.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[index + 1];
};
const outputDir = resolve(option('--output-dir', null) ?? mkdtempSync(join(tmpdir(), 'af-simulation-')));
if (existsSync(join(outputDir, 'report.json'))) throw new Error('Choose a fresh output directory; existing reports are preserved.');
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
const port = Number(option('--port', '8788'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');

// Set every test-specific path BEFORE importing config/adapters. Host files are untouched.
const configDir = join(outputDir, 'fixture-config');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'operator.json'), JSON.stringify({ disabled: [], reason: 'virtual demonstration only' }));
Object.assign(process.env, {
  AF_EXECUTORS_DIR: join(repoRoot, 'fixtures/agent-foundry-global/executors'),
  AF_OPERATOR_EXECUTORS_FILE: join(configDir, 'operator.json'),
  AF_SAFETY_STATE_FILE: join(configDir, 'safety.json'),
  AF_RUNTIME_EVENTS_LOG: join(configDir, 'events.jsonl'),
});
const [{ plannerFixture }, { output, plan, drive, delay, END }, { readTeam, commitTeam },
  { TeamController }, { createReadApi }, { spawnManaged, signalTree }, { DevTools }] = await Promise.all([
  import('../tests/helpers/planner-team-fixture.mjs'), import('../tests/helpers/team-fixture.mjs'),
  import('../lib/team/store.mjs'), import('../lib/team/controller.mjs'), import('../server/read-api.mjs'),
  import('../lib/child-process.mjs'), import('./browser-client.mjs'),
]);

let held = false, releaseRevision, releaseCoordination, releaseReview;
let reviews = 0, aggregateRuns = 0;
const fx = plannerFixture({
  effort: 'high',
  proposal: () => output({
    summary: '建议三位 Worker：A 提供输入与校验，B 提供独立输入，C 等待 A/B 后整合加法模块。你确认模型、思考强度和分工后再开工。',
    workers: [
      { executor_type: 'writer', model: 'worker-fast', effort: 'low' },
      { executor_type: 'virtual-worker', model: 'worker-deep', effort: 'high' },
      { executor_type: 'writer', model: 'worker-model', effort: 'medium' },
    ],
    work_items: plan().map((item, i) => ({ ...item,
      goal: ['A：导出数值 1，并提供输入校验。', 'B：独立导出数值 2。', 'C：整合 A/B，交付数值之和及验收结果。'][i],
    })),
  }),
  run: async ({ capsule, kind }, pending) => {
    if (kind === 'a' && !held) {
      held = true;
      return new Promise(done => pending.set(capsule.runId, done));
    }
    let code;
    if (kind === 'a') code = 'export const value = 1;\nexport function assertFinite(input) {\n  if (!Number.isFinite(input)) throw new TypeError("Expected a finite number");\n  return input;\n}\n';
    if (kind === 'b') code = 'export const value = 2;\n';
    if (kind === 'c') code = aggregateRuns++ === 0 ? 'export const value = 3;\n'
      : 'import { value as a, assertFinite } from "./a.mjs";\nimport { value as b } from "./b.mjs";\nexport const value = assertFinite(a) + assertFinite(b);\n';
    if (!code) throw new Error(`Unexpected virtual Worker task: ${kind}`);
    writeFileSync(join(capsule.cwd, 'src', `${kind}.mjs`), code);
    return output({ summary: `${kind.toUpperCase()} 的虚拟 Worker 已提交文件。` });
  },
  revise: () => new Promise(done => {
    releaseRevision = () => done(output({
      summary: '已暂停 A 与依赖它的 C。A 新方向：拒绝 Infinity/NaN，返回合法数值。B 的成果保留，A 完成后再派 C。',
      work_items: readTeam(fx.options.runtimeDir, fx.team.team_id).work_items.map(item => ({ ...item,
        goal: item.work_item_id === 'a' ? 'A：导出数值 1；assertFinite 拒绝 Infinity/NaN，返回合法数值。' : item.goal,
      })),
    }));
  }),
});

// Two real unit tests run inside the temporary delivery repository.
writeFileSync(join(fx.repo, 'tests/gate.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { value } from '../src/c.mjs';
import { assertFinite } from '../src/a.mjs';
test('the delivered total equals 3', () => assert.equal(value, 3));
test('finite input contract', () => {
  assert.equal(assertFinite(7), 7);
  assert.throws(() => assertFinite(Infinity), TypeError);
  assert.throws(() => assertFinite(NaN), TypeError);
});
`);
fx.git(['add', 'tests/gate.test.mjs']);
fx.git(['commit', '-m', 'simulation acceptance contract']);
fx.git(['update-ref', 'refs/afr/canonical', fx.git(['rev-parse', 'HEAD'])]);
const initial = readTeam(fx.options.runtimeDir, fx.team.team_id);
initial.goal = '【模拟演示】交付可验证的加法模块：A=1、B=2、C 整合两者，并支持中途细化任务。';
initial.planning.eligible_executors.push({
  executor_type: 'virtual-worker', supports_model: true, supports_effort: true,
  supports_planner: false, default_model: 'worker-deep',
  models: [{ id: 'worker-deep', label: '虚拟深度模型', reasoning_status: 'verified', reasoning_efforts: ['high'] }],
});
commitTeam(fx.options.runtimeDir, initial, 'simulation-fixture', null, () => {});
fx.task.goal = initial.goal;
writeFileSync(join(fx.options.tasksDir, `${fx.task.task_id}.json`), JSON.stringify(fx.task));
const originalRun = fx.io.adapters.writer.run;
fx.io.adapters.writer.run = async capsule => {
  if (capsule.work_item_id === 'coordinate') {
    fx.calls.push(capsule);
    const result = await new Promise(done => { releaseCoordination = () => done(output({
      summary: 'Reviewer 发现 C 写死了结果。只返工 C：真正导入 A/B 计算，不重跑已接受的 A/B。',
      retry_work_item_ids: ['c'],
    })); });
    return { status: 'completed', session_ref: `session-${capsule.runId}`, structured_result: { parsed: result }, writer_termination: END, exit_code: 0 };
  }
  return originalRun(capsule);
};
fx.io.adapters['virtual-worker'] = { ...fx.io.adapters.writer, type: 'virtual-worker' };
fx.io.adapters.reviewer.run = async capsule => {
  reviews++;
  const round = reviews;
  await new Promise(done => { releaseReview = done; });
  return { status: 'completed', session_ref: `virtual-review-${capsule.runId}`, writer_termination: END, exit_code: 0,
    structured_result: { result: JSON.stringify({
      task_id: capsule.task_id, revision: Number(/REVISION UNDER REVIEW: (\d+)/.exec(capsule.prompt)[1]),
      decision: round === 1 ? 'NEEDS_FIX' : 'PASS',
      summary: round === 1 ? '模拟复检：C 写死了 3，需真正使用 A/B 的结果。' : '模拟复检：C 已使用 A/B 计算，输入校验契约满足要求。',
      issues: [], required_changes: round === 1 ? ['仅修改 src/c.mjs：导入 A/B 计算实际数值之和。'] : [],
      evidence: ['src/c.mjs:1', 'src/a.mjs:2'],
    }) },
  };
};
const controller = new TeamController({ ...fx.options, ...fx.io,
  select: id => fx.io.adapters[id], autoDeliver: false,
  discoverCatalog: async () => { throw new Error('Native model discovery is forbidden in this demonstration'); },
});
const catalog = initial.planning.eligible_executors.map(entry => ({ ...entry, id: entry.executor_type,
  installed: true, adapter_status: 'matched', availability: 'AVAILABLE', capability: 'AVAILABLE',
  supports_planner: entry.supports_planner !== false, protocol: 'SIMULATED',
  discovery_status: 'ready', discovery_source: 'virtual fixture; no native scan',
}));
const projectsFile = join(configDir, 'projects.json');
writeFileSync(projectsFile, JSON.stringify({ schema_version: 'af-project-registry-v1', projects: [{
  project_id: 'simulation-project', root: fx.repo, workspace_root: join(fx.root, 'workspaces'),
  policy: fx.task.trusted_import.policy,
  acceptance_profiles: [{ profile_id: 'simulation-tests', acceptance: fx.task.acceptance_cmd, assets: [] }],
}] }));
const realApi = createReadApi({
  roots: { tasks: fx.options.tasksDir, locks: fx.options.locksDir, runtime: fx.options.runtimeDir, alerts: join(fx.root, 'alerts.jsonl') },
  allowRecord: false, ensureController: null, agentDiscoverer: () => [],
  catalogScanner: async () => { throw new Error('Native scan forbidden'); },
  env: { ...process.env, AF_WEB_TOKEN: '', AF_WEB_TOKEN_FILE: '', AF_PROJECTS_FILE: projectsFile,
    AF_SUBMISSION_DIR: join(fx.root, 'submissions') },
});
const checks = [], steps = [];
let report = { ok: false, simulated: true, running: true, steps, checks,
  scope: { agents: 'virtual', termination: 'synthetic', controller: 'real', acceptance: 'real', git: 'temporary repository only' },
};
const persistReport = () => writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
const send = (res, type, body, status = 200) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const badge = '<div style="position:fixed;right:12px;bottom:12px;z-index:10000;background:#141414;color:#f7f4ec;border:2px solid #e81932;padding:9px 14px;font:600 12px sans-serif">模拟数据 · 虚拟 Agents · <a href="/" style="color:#fff">查看流程回放 ↗</a></div>';
const server = createServer((req, res) => {
  let path;
  try { path = new URL(req.url, 'http://localhost').pathname; } catch { return send(res, 'text/plain', 'Bad request', 400); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 'application/json', JSON.stringify({ error: 'read_only_simulation' }), 405);
  if (path === '/' || path === '/demo.html') return send(res, 'text/html; charset=utf-8', readFileSync(join(repoRoot, 'qa/simulation-viewer.html')));
  if (path === '/report.json') return send(res, 'application/json', JSON.stringify(report));
  if (/^\/screenshots\/[a-z0-9-]+\.png$/.test(path)) {
    const file = join(outputDir, path.slice(1));
    return existsSync(file) ? send(res, 'image/png', readFileSync(file)) : send(res, 'text/plain', 'No such screenshot', 404);
  }
  if (path === '/teams.html' || path === '/workbench.html') return send(res, 'text/html; charset=utf-8',
    readFileSync(join(repoRoot, 'web', path.slice(1)), 'utf8').replace('</body>', badge + '</body>'));
  if (path === '/api/v2/executors') return send(res, 'application/json', JSON.stringify({ model: {
    schema: 'af-v2-executors-v1', executors: catalog, source: 'SIMULATED CATALOG — no installed-client claims', scan: null,
  } }));
  void Promise.resolve(realApi(req, res)).catch(error => {
    if (!res.headersSent) send(res, 'application/json', JSON.stringify({ error: error.message }), 500);
    else res.destroy();
  });
});
let browser, chrome, profile, shutdownPromise, completed = false;
async function closeChrome() {
  browser?.close(); browser = null;
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) await new Promise(done => {
    const timer = setTimeout(() => signalTree(chrome, 'SIGKILL'), 5000);
    chrome.once('close', () => { clearTimeout(timer); done(); }); signalTree(chrome, 'SIGTERM');
  });
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function shutdown() {
  shutdownPromise ??= (async () => {
    releaseRevision?.(); releaseCoordination?.(); releaseReview?.();
    await closeChrome(); await controller.close();
    if (server.listening) await new Promise(done => server.close(done));
  })();
  return shutdownPromise;
}
const stop = signal => {
  if (!completed) { report = { ...report, ok: false, running: false, interrupted: true, error: `演示已停止（${signal}）` }; persistReport(); }
  void shutdown().then(() => process.exit(0));
};
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

try {
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  profile = mkdtempSync(join(tmpdir(), 'af-simulation-chrome-'));
  chrome = spawnManaged(process.env.AF_BROWSER_BIN ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = ''; chrome.on('error', e => { chromeError = e.message; });
  chrome.stderr.on('data', chunk => { chromeError += chunk.toString(); });
  const readyFile = join(profile, 'DevToolsActivePort');
  for (let end = Date.now() + 15000; !existsSync(readyFile) && Date.now() < end && chrome.exitCode === null;) await delay(50);
  if (!existsSync(readyFile)) throw new Error(`Chrome did not start: ${chromeError.slice(-500)}`);
  const chromePort = readFileSync(readyFile, 'utf8').split('\n')[0];
  const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
  browser = await DevTools.connect(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await browser.send('Runtime.enable'); await browser.send('Page.enable');
  await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const check = (label, condition) => { assert.ok(condition, label); checks.push({ label, passed: true }); persistReport(); };
  const current = () => controller.read(fx.team.team_id);
  const advance = predicate => drive(controller, predicate, { timeout: 20000 });
  const labels = { DISCUSSING: '与 Planner 商讨', PLAN_READY: '等待确认计划', WORKING: '成员协作中',
    READY_FOR_REVIEW: '候选待交付', DELIVERING: '交付中', COMPLETED: '已完成' };
  const capture = async (id, title, description, facts, delivery = false) => {
    const team = current(), screenshot = `${id}.png`;
    await browser.send('Page.navigate', { url: baseUrl + (delivery ? `/workbench.html?simulation-stage=${id}#${team.delivery_task_id}` : `/teams.html?simulation-stage=${id}`) });
    await browser.waitFor(`location.search===${JSON.stringify('?simulation-stage=' + id)}`);
    await browser.waitFor(delivery ? `Boolean(document.querySelector('#detail .work-head'))&&[...document.querySelectorAll('#detail .kv dd')].some(dd=>dd.textContent===${JSON.stringify(team.delivery_task_id)})`
      : `document.getElementById('team-state')?.textContent===${JSON.stringify(labels[team.state])}`);
    await browser.evaluate('document.fonts.ready');
    if (delivery) {
      const phase = controller.task(team).trusted_import.phase;
      check(`${title}的阶段条对应真实 ${phase}`, await browser.evaluate(phase === 'PROMOTED'
        ? "document.querySelectorAll('#detail .stage.done').length===8&&document.getElementById('detail-phase').textContent.includes('PROMOTED')"
        : "document.querySelector('#detail .stage.current')?.title.startsWith('REVIEW')"));
    }
    if (!delivery) await browser.evaluate("document.getElementById('planner-conversation').scrollTop=0;document.getElementById('receipts-tab').click()");
    await browser.screenshot(join(outputDir, 'screenshots', screenshot));
    const step = { id, title, description, state: team.state, screenshot, facts };
    steps.push(step); persistReport(); writeFileSync(join(outputDir, `${id}.team.json`), JSON.stringify(team, null, 2));
    console.log(JSON.stringify({ step: title, state: team.state }));
  };

  fx.send({ type: 'message', agent_id: 'lead', message: '我们交付一个加法模块。请先商讨输入、边界与验收，我确认计划后再开工。' }, 'CMD-demo-chat');
  await advance(() => current().commands['CMD-demo-chat']?.status === 'applied');
  check('Planner 商讨后没有擅自启动 Worker', !fx.calls.some(c => ['a', 'b', 'c'].includes(c.work_item_id)));
  await capture('01-discussion', '先和 Planner 商讨', '先确认目标、约束和验收方式。Planner 使用虚拟 planning-model / high。', ['消息已回复', 'Worker 尚未开工']);

  fx.send({ type: 'propose_plan' }, 'CMD-demo-plan');
  await advance(() => current().state === 'PLAN_READY');
  check('行动提案等待人类确认，三个任务尚未派发', current().work_items.length === 3 && !fx.calls.some(c => ['a', 'b', 'c'].includes(c.work_item_id)));
  await capture('02-plan', 'Planner 提案，等待你确认', 'A 与 B 并行，C 等待两者；推荐三位 Worker，并给出模型与思考强度。', ['A/B 独立', 'C 依赖 A/B', '确认前不派工']);

  const planned = current();
  fx.send({ type: 'approve_plan', expected_plan_revision: planned.plan_revision, expected_goal_revision: planned.goal_revision,
    workers: planned.members.filter(member => member.role === 'worker').map(({ executor_type, model, effort }) => ({ executor_type, model, effort })),
    assignments: { a: 'worker-1', b: 'worker-2', c: 'worker-3' } }, 'CMD-demo-approve');
  await advance(() => held && current().work_items.find(i => i.work_item_id === 'b')?.status === 'DONE');
  const peer = current().work_items.find(i => i.work_item_id === 'b').artifact_id;
  check('独立 Worker 实际并行；C 在依赖完成前保持等待', fx.io.max() >= 2 && current().work_items.find(i => i.work_item_id === 'c').status === 'READY');
  check('Worker 使用不同执行器、模型和准确的虚拟等级', fx.calls.some(c => c.work_item_id === 'a' && c.model === 'worker-fast' && c.effort === 'low')
    && fx.calls.some(c => c.work_item_id === 'b' && c.model === 'worker-deep' && c.effort === 'high'));
  await capture('03-workers', '确认编组，Worker 开工', 'A 正在执行，B 已提交成果，C 等待依赖；演示包含两个虚拟执行器和三种模型配置。', ['A：worker-fast / low', 'B：worker-deep / high', 'C：worker-model / medium']);

  fx.send({ type: 'adjust', work_item_id: 'a', expected_revision: 1, message: '请细化 A：拒绝 Infinity 和 NaN，合法数值原样返回；保留 B 的成果。' }, 'CMD-demo-refine');
  await advance(() => Boolean(releaseRevision));
  check('修改先停止旧 A，并挂起 A/C 等待 Planner', ['a', 'c'].every(id => current().work_items.find(i => i.work_item_id === id).status === 'HELD')
    && current().runs.some(r => r.work_item_id === 'a' && r.status === 'DISCARDED'));
  await capture('04-paused', '暂停受影响任务，交给 Planner', '操作员提交新要求。旧 A 结果已废弃，A 与 C 挂起，等待 Planner 给出可执行的新方向。', ['A/C：HELD', 'B 的已接受成果保留', '改向回执尚未完成']);

  releaseRevision(); releaseRevision = null;
  await advance(() => current().state === 'READY_FOR_REVIEW');
  check('Planner 改向回执含真实 Planner 运行记录', Boolean(current().commands['CMD-demo-refine'].evidence.planner_run_id));
  check('重新派工只影响 A/C，B 的成果 ID 保持原值', current().work_items.find(i => i.work_item_id === 'b').artifact_id === peer
    && current().work_items.find(i => i.work_item_id === 'a').revision === 2);
  check('整合候选实际生成 CAS 快照', Boolean(current().integration?.artifact_id));
  await capture('05-reassigned', 'Planner 重写方向，重新派工与整合', 'A 完成输入校验；C 首轮提交了写死的常量 3，等待复检发现问题。控制器接受新版本并整合候选，无关的 B 无需重跑。', ['A 版本：2', 'B 版本：1', '已生成整合候选']);

  controller.autoDeliver = true;
  fx.send({ type: 'deliver' }, 'CMD-demo-deliver');
  await advance(() => reviews === 1 && Boolean(releaseReview));
  await capture('06-review', '同配置 Reviewer，独立会话复检', 'Reviewer 沿用 Planner 的模型与 high 强度，用全新会话审查密封候选。此轮将发现 C 写死结果。', ['Reviewer：planning-model / high', '独立新会话', '候选已密封'], true);
  releaseReview(); releaseReview = null;
  await advance(() => Boolean(releaseCoordination));
  check('Reviewer 的 NEEDS_FIX 真实返回 Planner', current().review_feedback?.decision === 'NEEDS_FIX');
  await capture('07-rework', 'Reviewer 退回，Planner 选择局部返工', '首轮复检提出：C 应真正使用 A/B 计算。Planner 将只返工 C，保留已经接受的 A/B。', ['首轮：NEEDS_FIX', '复检意见已到达 Planner', 'A/B 成果保留']);
  const acceptedA = current().work_items.find(i => i.work_item_id === 'a').artifact_id;
  releaseCoordination(); releaseCoordination = null;
  await advance(() => reviews === 2 && Boolean(releaseReview));
  check('复检返工只重跑 C，A/B 的成果保持不变', current().work_items.find(i => i.work_item_id === 'a').artifact_id === acceptedA
    && current().work_items.find(i => i.work_item_id === 'b').artifact_id === peer
    && current().runs.filter(r => r.kind === 'worker' && r.work_item_id === 'c').length === 2);
  await capture('08-second-review', 'C 修复完成，再次独立复检', 'C 已改成导入 A/B 计算；候选重新整合和密封。第二个 Reviewer 会话仍使用 Planner 配置。', ['只重跑 C', 'A/B 未重跑', '第二轮独立复检'], true);
  releaseReview(); releaseReview = null;
  await advance(() => current().state === 'COMPLETED' && controller.deliveries.size === 0);
  const team = current(), task = controller.task(team);
  const reviewerCalls = fx.calls.filter(c => c.assigned_role === 'reviewer');
  check('两轮 Reviewer 均沿用 Planner 模型和思考强度', reviewerCalls.length === 2 && reviewerCalls.every(c => c.model === 'planning-model' && c.effort === 'high'));
  const reviewSessions = task.runs.filter(r => r.assigned_role === 'reviewer').map(r => r.session_ref);
  check('Reviewer 两个会话互不复用，也不复用任何写入会话', reviewSessions.length === 2 && new Set(reviewSessions).size === 2
    && reviewSessions.every(session => session && !team.runs.some(r => r.session_ref === session)));
  check('受信交付真实完成验收并达到 PROMOTED', task.state === 'COMPLETED' && team.delivery.phase === 'PROMOTED'
    && task.trusted_import.acceptance_evidence?.status === 'PASS');
  const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].map(path => ({ path, content: fx.git(['show', `refs/afr/canonical:${path}`]) }));
  check('演示 Git 正式引用实际更新，C 使用 A/B 计算', fx.git(['rev-parse', 'refs/afr/canonical']) !== team.baseline.oid
    && files.find(file => file.path === 'src/c.mjs').content.includes('assertFinite(a) + assertFinite(b)'));
  await capture('09-delivered', '验收通过，演示项目完成交付', '真实运行两项 Node 验收测试，通过后将候选晋升到演示仓库的正式引用，并保留完整证据。', ['第二轮：PASS', '验收：PASS', '交付：PROMOTED', '仅更新临时演示仓库'], true);
  const bookmarkTaskId = 'task-template-demo', bookmarkTaskFile = join(fx.options.tasksDir, bookmarkTaskId + '.json');
  writeFileSync(bookmarkTaskFile, JSON.stringify({ ...task, task_id: bookmarkTaskId, goal: '【模拟】历史书签验证任务' }));
  try { await verifyWorkbenchBookmarks({ browser, baseUrl, taskId: team.delivery_task_id, otherTaskId: bookmarkTaskId, check }); }
  finally { rmSync(bookmarkTaskFile, { force: true }); }
  check('真实页面的浏览器脚本没有异常', browser.errors.length === 0);
  check('演示服务拒绝所有网页写入', (await fetch(baseUrl + '/api/teams', { method: 'POST', body: '{}' })).status === 405);
  report = { ok: false, simulated: true, running: true,
    scope: report.scope,
    verified_at: new Date().toISOString(), steps, checks,
    final: { team_id: team.team_id, task_id: team.delivery_task_id, phase: team.delivery.phase, review_rounds: reviews,
      planner: team.planning.planner, workers: team.members.filter(m => m.role === 'worker').map(({ agent_id, executor_type, model, effort }) => ({ agent_id, executor_type, model, effort })),
      files, team_url: '/teams.html', delivery_url: `/workbench.html#${team.delivery_task_id}` },
  };
  persistReport();
  await browser.send('Page.navigate', { url: baseUrl + '/?replay-check=1' });
  await browser.waitFor(`document.querySelectorAll('#step-tabs button').length===${steps.length}&&document.getElementById('stage-screenshot').naturalWidth>0`);
  check('回放页面标明虚拟 Agent、合成退出与真实验收', await browser.evaluate("document.getElementById('scope-strip').textContent.includes('合成')&&document.getElementById('scope-strip').textContent.includes('真实')"));
  await browser.click('#next-stage');
  await browser.waitFor("document.getElementById('stage-title').textContent==='Planner 提案，等待你确认'&&document.getElementById('stage-screenshot').src.includes('02-plan.png')");
  check('回放下一阶段按钮同步文字和真实截图', true);
  await browser.click('#step-tab-3');
  check('可直接查看暂停与 Planner 改向阶段', await browser.evaluate("document.getElementById('stage-title').textContent.includes('暂停')&&document.getElementById('facts-list').textContent.includes('HELD')"));
  await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End' });
  check('键盘可到达最终交付阶段，下一阶段正确禁用', await browser.evaluate("document.getElementById('next-stage').disabled&&document.getElementById('step-tab-8').getAttribute('aria-selected')==='true'"));
  await browser.click('#check-list .check-button');
  check('回放可展开检查结果并查看实际交付代码', await browser.evaluate("document.querySelector('#check-list .check-button').getAttribute('aria-expanded')==='true'&&document.getElementById('final-content').textContent.includes('assertFinite(a) + assertFinite(b)')"));
  for (const width of [360, 390, 768, 1440]) {
    await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 720 });
    check(`${width}px 回放布局没有横向溢出`, await browser.evaluate('document.documentElement.scrollWidth<=innerWidth+2'));
  }
  check('回放页面无浏览器脚本异常', browser.errors.length === 0);
  report.ok = true; report.running = false;
  report.verified_at = new Date().toISOString(); persistReport();
  await browser.send('Page.reload');
  await browser.waitFor(`document.querySelectorAll('#check-list .check-button').length===${checks.length}&&document.getElementById('stage-screenshot').naturalWidth>0`);
  await browser.evaluate('document.fonts.ready');
  await browser.screenshot(join(outputDir, 'screenshots', 'replay-desktop.png'));
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await browser.screenshot(join(outputDir, 'screenshots', 'replay-mobile.png'));
  writeFileSync(join(outputDir, 'final-task.json'), JSON.stringify(task, null, 2));
  writeFileSync(join(outputDir, 'instance.json'), JSON.stringify({ pid: process.pid, url: baseUrl, fixture_root: fx.root, output_dir: outputDir }, null, 2));
  completed = true;
  console.log(JSON.stringify({ ok: true, url: baseUrl, checks: checks.length, phases: steps.length, report: join(outputDir, 'report.json') }));
  await closeChrome(); await controller.close();
  if (!args.includes('--serve')) await shutdown();
} catch (error) {
  report = { ...report, ok: false, running: false, error: error.message };
  report.checks.push({ label: error.message, passed: false });
  persistReport();
  await shutdown(); throw error;
}
