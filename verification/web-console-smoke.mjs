// web-console-smoke.mjs - REAL-BROWSER verification of the read-only V2 workbench.
//
// Follows the project's frontend convention: start the local server, drive headless Chrome over
// CDP with Node's native WebSocket (no dependencies), screenshot each breakpoint, and assert what
// only a browser can tell us - no horizontal overflow, no console errors, and the list actually
// rendered from the API.
//
// Usage: node verification/web-console-smoke.mjs [--keep]
// Exit: 0 all checks pass / 1 otherwise.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startReadApi } from '../server/read-api.mjs';

const keep = process.argv.includes('--keep');
const BREAKPOINTS = [1440, 768, 390, 320];
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small fixture so the list has something to render. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'af-web-smoke-'));
  const tasks = join(root, 'tasks');
  for (const d of [tasks, join(root, 'locks'), join(root, 'runtime')]) mkdirSync(d, { recursive: true });
  const mk = (id, state, phase, boundary) => writeFileSync(join(tasks, `${id}.json`), JSON.stringify({
    task_id: id, state, state_version: 2, goal: `fixture goal for ${id}`,
    author_executor: 'codex', reviewer_executor: 'claude',
    trusted_import: { enabled: true, phase, boundary_state: boundary },
  }, null, 2));
  mk('TASK-SMOKE-1', 'COMPLETED', 'PROMOTED', 'DISENGAGED');
  mk('TASK-SMOKE-2', 'WAITING_HUMAN', 'WAITING_HUMAN', 'PROTECTION_RETAINED_PENDING_RECOVERY');
  return {
    root,
    roots: { tasks, locks: join(root, 'locks'), runtime: join(root, 'runtime'), alerts: join(root, 'alerts.jsonl') },
  };
}

/** Minimal CDP client over the native WebSocket. */
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

const fixtureData = fixture();
const api = await startReadApi({ roots: fixtureData.roots });
const profileDir = mkdtempSync(join(tmpdir(), 'af-chrome-'));
const artifacts = join(process.cwd(), 'verification', 'artifacts', 'web-console');
mkdirSync(artifacts, { recursive: true });

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--user-data-dir=${profileDir}`, '--remote-debugging-port=9333', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d.toString(); });

try {
  // Wait for the DevTools endpoint, then attach to the page target.
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
      target = list.find((t) => t.type === 'page') ?? null;
    } catch { /* not up yet */ }
  }
  check('chrome devtools endpoint reachable', Boolean(target), target ? target.url : chromeLog.slice(-200));
  if (!target) throw new Error('no chrome page target');

  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: api.url });
  await sleep(2500); // load + first polls

  const evaluate = async (expression) => {
    const res = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return res.result?.value;
  };

  const title = await evaluate('document.title');
  check('page loaded the workbench', /V2/.test(String(title)), `title=${title}`);

  const rows = await evaluate("document.querySelectorAll('#tasks .row').length");
  check('the task list rendered from the API', Number(rows) === 2, `rows=${rows}`);

  const badge = await evaluate("document.querySelector('.badge.readonly')?.textContent ?? null");
  check('the read-only badge is visible', badge === '只读', `badge=${badge}`);

  const caps = await evaluate("document.getElementById('capabilities')?.textContent ?? ''");
  check('the footer states there are no write actions', /写操作：无/.test(caps), caps);

  // Selecting a task must render the stage strip and the evidence panel.
  await evaluate("document.querySelector('#tasks .row').click()");
  await sleep(1200);
  const detail = await evaluate("({ stages: document.querySelectorAll('#detail .stage').length, evidence: Boolean(document.querySelector('#detail pre.evidence')) })");
  check('task detail renders the stage strip and evidence', detail?.stages === 8 && detail?.evidence === true, JSON.stringify(detail));

  for (const width of BREAKPOINTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 480 });
    await sleep(400);
    const overflow = await evaluate('({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })');
    check(`no horizontal overflow at ${width}px`, overflow.sw <= overflow.cw + 1, `scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(artifacts, `workbench-${width}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`      screenshot: ${file}`);
  }

  const errors = cdp.events
    .filter((e) => (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
      || (e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error'))
    .map((e) => e.params?.entry?.text ?? e.params?.args?.map((a) => a.value ?? a.description).join(' '));
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // The API must refuse a write even when asked from the page.
  const writeStatus = await evaluate("fetch('/api/v2/tasks', { method: 'POST', body: '{}' }).then(r => r.status)");
  check('a write attempt from the page is refused with 405', Number(writeStatus) === 405, `status=${writeStatus}`);

  cdp.close();
} catch (err) {
  check('browser smoke completed without an unexpected error', false, err.message);
} finally {
  chrome.kill('SIGKILL');
  await api.close();
  if (!keep) { rmSync(profileDir, { recursive: true, force: true }); rmSync(fixtureData.root, { recursive: true, force: true }); }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
