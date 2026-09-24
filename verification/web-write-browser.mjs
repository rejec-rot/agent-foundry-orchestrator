// web-write-browser.mjs - a REAL browser check of the authenticated write path (§7.3).
//
// The point is the difference between "the button is disabled" and "the server refuses": this
// drives the page, saves the operator token through the UI, creates and cancels a task, and proves
// that the SAME request without the token is rejected by the server, not merely greyed out.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../tests/helpers/executors-fixture.mjs';
import { startReadApi } from '../server/read-api.mjs';

const keep = process.argv.includes('--keep');
const BREAKPOINTS = [1440, 390];
const TOKEN = 'browser-operator-token';
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-web-write-'));
  const tasks = join(root, 'tasks');
  const target = join(root, 'target');
  const locks = join(root, 'locks');
  const runtime = join(root, 'runtime');
  const submissions = join(root, 'submissions');
  for (const d of [tasks, target, locks, runtime, submissions]) mkdirSync(d, { recursive: true });
  const tokenFile = join(root, 'web-token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  return {
    root, tasks, target, locks, tokenFile,
    roots: { tasks, locks, runtime, alerts: join(root, 'alerts.jsonl') },
  };
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cdp connect failed')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      return;
    }
    events.push(msg);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { send, events, close: () => ws.close() };
}

const fx = fixture();
const spawned = [];
const api = await startReadApi({
  roots: fx.roots,
  allowedRoots: [fx.target],
  allowRecord: true,
  token: { configured: true, token: TOKEN, source: fx.tokenFile },
  locksDir: fx.locks,
  spawnWorker: (taskId) => { spawned.push(taskId); return { pid: 4242 }; },
});

const profileDir = mkdtempSync(join(tmpdir(), 'af-chrome-write-'));
const artifacts = join(process.cwd(), 'verification', 'artifacts', 'web-write');
mkdirSync(artifacts, { recursive: true });

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${profileDir}`, '--remote-debugging-port=9334', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d.toString(); });

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* not up yet */ }
  }
  check('chrome devtools endpoint reachable', Boolean(target), target ? target.url : chromeLog.slice(-200));
  if (!target) throw new Error('no chrome page target');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 980, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: api.url });
  await sleep(2500);

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) console.log('      [page exception]', res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result?.value;
  };

  check('the workbench loaded', /V2/.test(String(await evaluate('document.title'))));

  // 1. Server capabilities say writes are possible; the PAGE still has no token, so its buttons
  //    must stay disabled. Capability and page state are different things on purpose.
  const disabled = await evaluate("({ create: document.getElementById('s-create').disabled, start: document.getElementById('a-start').disabled, mode: document.getElementById('mode-line').textContent })");
  check('the create button is disabled until a token is saved', disabled?.create === true, JSON.stringify(disabled));
  check('the page states that writes are enabled by the server', /写操作已启用/.test(String(disabled?.mode)), String(disabled?.mode));

  // 2. The real refusal - not the greyed-out button. A write without a token must be rejected by
  //    the SERVER, in the page's own context.
  const unauthed = await evaluate(`(async () => {
    const res = await fetch('/api/v2/tasks/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-af-csrf': '1' }, body: JSON.stringify({ spec: { goal: 'x', target_path: ${JSON.stringify(fx.target)}, acceptance: { command: 'node', args: ['--test'] }, idempotency_key: 'browser-unauthed' } }) });
    const body = await res.json();
    return { status: res.status, reason: body?.model?.reason ?? body?.reason ?? null };
  })()`);
  check('an unauthenticated write is refused by the server (401)', unauthed?.status === 401, JSON.stringify(unauthed));
  check('no task was created by the refused write', readdirSync(fx.tasks).filter((n) => n.endsWith('.json')).length === 0);

  // 3. Save the token through the UI, then create a task with the form.
  await evaluate("document.getElementById('token-input').value = 'browser-operator-token'");
  await evaluate("document.getElementById('token-save').click()");
  await sleep(300);
  const afterToken = await evaluate("({ create: document.getElementById('s-create').disabled, input: document.getElementById('token-input').value, stored: sessionStorage.getItem('af-write-token') })");
  check('saving the token enables the create button', afterToken?.create === false, JSON.stringify(afterToken));
  check('the token input is cleared and never left in the DOM', afterToken?.input === '', `value=${JSON.stringify(afterToken?.input)}`);

  await evaluate("document.getElementById('s-goal').value = 'browser created task'");
  await evaluate(`document.getElementById('s-target').value = ${JSON.stringify(fx.target)}`);
  await evaluate("document.getElementById('s-key').value = 'browser-create-1'");
  await evaluate("document.getElementById('s-create').click()");
  await sleep(1500);
  const created = await evaluate("document.getElementById('submit-result').textContent");
  check('the page reports the created task', /TASK-V2-/.test(String(created)), String(created).slice(0, 160));
  const taskFiles = readdirSync(fx.tasks).filter((n) => n.endsWith('.json'));
  check('the task exists on disk after the browser created it', taskFiles.length === 1, taskFiles.join(','));
  const taskId = taskFiles[0]?.replace(/\.json$/, '');

  // 4. Start it: the request must be accepted and the worker (here a stub) dispatched.
  await evaluate(`state.selected = ${JSON.stringify(taskId)}; refreshWriteControls();`);
  const startDisabled = await evaluate("document.getElementById('a-start').disabled");
  check('the start button enables for a selected task', startDisabled === false, `disabled=${startDisabled}`);
  await evaluate("document.getElementById('a-start').click()");
  await sleep(1200);
  const startResult = await evaluate("document.getElementById('submit-result').textContent");
  check('start is accepted (202) and dispatched to the worker', /accepted|started/.test(String(startResult)) && spawned.length === 1, `spawned=${JSON.stringify(spawned)}`);

  // 5. Cancel writes a durable request.
  await evaluate("document.getElementById('a-cancel').click()");
  await sleep(1200);
  const cancelResult = await evaluate("document.getElementById('submit-result').textContent");
  check('cancel records a durable request', /trusted boundary|requested/.test(String(cancelResult)), String(cancelResult).slice(0, 160));
  check('the cancel request file exists', existsSync(join(fx.tasks, `${taskId}.cancel.json`)));

  // 5b. Collaboration: a message can be queued from the page, and the page must NOT claim it was
  //     carried out - only that it is queued.
  await evaluate("document.getElementById('msg-text').value = 'please re-run the review with the stricter gate'");
  const sendDisabled = await evaluate("document.getElementById('msg-send').disabled");
  check('the queue-message button enables with a token and a selection', sendDisabled === false, `disabled=${sendDisabled}`);
  await evaluate("document.getElementById('msg-send').click()");
  await sleep(1500);
  const collab = await evaluate("document.getElementById('collab').textContent");
  check('the queued message is visible with its honest status', /已排队/.test(String(collab)), String(collab).slice(0, 200));
  check('the page never claims the message was carried out', !/已落实/.test(String(collab)) || /没有/.test(String(collab)), String(collab).slice(0, 200));

  // 6. The token never leaks into the URL or the visible DOM text.
  const leak = await evaluate("({ url: location.href, html: document.documentElement.outerHTML.includes('browser-operator-token') })");
  check('the token is not in the URL', !String(leak?.url).includes(TOKEN), String(leak?.url));
  check('the token is not in the rendered DOM', leak?.html === false);

  for (const width of BREAKPOINTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 980, deviceScaleFactor: 1, mobile: width <= 480 });
    await sleep(400);
    const overflow = await evaluate('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
    check(`no horizontal overflow at ${width}px`, overflow.sw <= overflow.cw + 1, `scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, `write-${width}.png`), Buffer.from(shot.data, 'base64'));
  }

  const errors = cdp.events
    .filter((e) => (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
      || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    .map((e) => e.params?.entry?.text ?? e.params?.args?.map((a) => a.value).join(' '));
  // The deliberate unauthenticated POST above makes the browser log its 401 resource failure, so
  // the check is stated precisely: apart from that probe, nothing may log an error.
  const deliberate = /Failed to load resource.*\b(401|403)\b/;
  const unexpected = errors.filter((e) => !deliberate.test(String(e)));
  check('no console errors beyond the deliberate auth-refusal probe', unexpected.length === 0, unexpected.join(' | ').slice(0, 300));

  cdp.close();
} catch (err) {
  check('browser run completed without throwing', false, err.message);
} finally {
  chrome.kill('SIGKILL');
  await api.close();
  if (!keep) rmSync(profileDir, { recursive: true, force: true });
  if (keep) console.log(`      kept: fixture=${fx.root} profile=${profileDir}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
