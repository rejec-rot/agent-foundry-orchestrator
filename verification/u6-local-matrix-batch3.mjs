// u6-local-matrix-batch3.mjs - U6 acceptance, LOCAL ONLY, batch 3: A1a live state write/restart loop.
//
// Scope: A1 (no model calls), B1 (no outbound), C1 (local, concurrency 1, rollback 88a76c6). This
// closes the gap batch 2/H4 left open: H4 only proved the READ side of state.json. Here the sweep
// really WRITES attempts / next_attempt_at / EXHAUSTED (via the deps.recover injection seam, so no
// permission is ever touched), each attempt runs in a FRESH process, and the accumulated state is
// re-read by another fresh process (`af-admin a1a status`), including backoff growth and the
// exhaustion event that must reference the original alert.
//
// Usage: node verification/u6-local-matrix-batch3.mjs [--keep]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { a1aConfig, backoffMsFor, readA1aEvents } from '../lib/a1a.mjs';
import { recordBoundaryAlert } from '../lib/boundary-alerts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AF_ROOT = join(HERE, '..');
const keep = process.argv.includes('--keep');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = mkdtempSync(join(tmpdir(), 'af-u6b3-'));
const canonicalDir = join(root, 'canonical');
const casDir = join(root, 'cas');
const tasksDir = join(root, 'tasks');
const auditDir = join(root, 'audit');
const alertsFile = join(root, 'boundary-alerts.jsonl');
const allowlistFile = join(root, 'allowlist.json');
const queueFile = join(auditDir, 'a1a', 'state.json');
try {
for (const d of [canonicalDir, casDir, tasksDir, auditDir]) mkdirSync(d, { recursive: true });
const taskId = 'T-U6-B3';

const env = {
  ...process.env,
  AF_A1A_MODE: 'live',
  AF_A1A_ALLOWLIST_FILE: allowlistFile,
  AF_A1A_QUEUE_FILE: queueFile,
  AF_A1A_RETRY_BASE_MS: '60000',
  AF_A1A_RETRY_MAX_MS: '1800000',
  AF_A1A_MAX_ATTEMPTS: '3',
  AF_TASKS_DIR: tasksDir,
  AF_BOUNDARY_AUDIT_DIR: auditDir,
  AF_BOUNDARY_ALERTS_FILE: alertsFile,
};
Object.assign(process.env, env); // loadA1aAllowlist / recordBoundaryAlert read env too

const cfg = a1aConfig();

writeFileSync(join(tasksDir, `${taskId}.json`), JSON.stringify({ task_id: taskId }, null, 2));
writeFileSync(allowlistFile, JSON.stringify({ schema: 'af-a1a-allowlist-v1', assets: [{ canonical_dir: canonicalDir, cas_dir: casDir, task_id: taskId, max_attempts: 3 }] }));

// A retained alert for this asset: the exhaustion event must reference THIS alert id.
const alert = recordBoundaryAlert({ canonicalDir, casDir, taskId, reason: 'scope-anomaly' });

const runSweep = (nowIso, outcome) => {
  const proc = spawnSync(process.execPath, [join(HERE, 'u6-a1a-sweep-once.mjs')], {
    env: { ...env, AF_U6_NOW: nowIso, AF_U6_OUTCOME: outcome },
    encoding: 'utf8',
  });
  if (proc.status !== 0) throw new Error(`sweep helper failed: ${proc.stderr}`);
  return JSON.parse(proc.stdout.trim().split('\n').pop());
};

const stateOnDisk = () => JSON.parse(readFileSync(queueFile, 'utf8'));
const assetRecord = () => stateOnDisk().assets[`${canonicalDir}|${casDir}`];

console.log('U6 local matrix batch 3 (live state write/restart loop; no permission touched)\n');

  const nows = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', '2026-01-01T00:10:00.000Z'];

  for (let i = 1; i <= 3; i += 1) {
    const nowMs = Date.parse(nows[i - 1]);
    const res = runSweep(nows[i - 1], 'PROTECTION_RETAINED');
    const record = assetRecord();
    const expectedPhase = i < 3 ? 'DEFERRED' : 'EXHAUSTED';
    // The expected backoff is recomputed INDEPENDENTLY from the frozen formula
    // `min(base * 2^(n-1), max)` instead of calling backoffMsFor() - otherwise a wrong formula
    // inside the library would make this assertion pass by construction.
    const expectedBackoff = Math.min(cfg.retry_base_ms * (2 ** (i - 1)), cfg.retry_max_ms);
    check(`B3 attempt ${i}: backoff matches the frozen formula independently`, backoffMsFor(i, cfg) === expectedBackoff,
      `lib=${backoffMsFor(i, cfg)} expected=${expectedBackoff}`);
    if (i > 1) {
      check(`B3 backoff(${i}) grows over backoff(${i - 1})`, backoffMsFor(i, cfg) > backoffMsFor(i - 1, cfg));
    }
    const expectedNext = new Date(nowMs + expectedBackoff).toISOString();
    check(`B3 attempt ${i}: attempts recorded on disk`, record?.attempts === i, `attempts=${record?.attempts}`);
    check(`B3 attempt ${i}: phase=${expectedPhase}`, record?.phase === expectedPhase, `phase=${record?.phase}`);
    if (i < 3) {
      check(`B3 attempt ${i}: next_attempt_at = now + backoff(${i})`, record?.next_attempt_at === expectedNext, `next=${record?.next_attempt_at} expected=${expectedNext}`);
    }
    console.log(`  raw attempt ${i}: ${JSON.stringify({ decision: res.results?.[0]?.decision, attempts: record?.attempts, phase: record?.phase, next: record?.next_attempt_at })}`);
  }

  // A FRESH process re-reads the accumulated state through the operator surface.
  // The cap must clamp, not just be documented: with retry_max_ms below the raw growth, every
  // attempt schedules exactly now + cap.
  {
    const cappedCfg = { ...a1aConfig(), retry_base_ms: 60000, retry_max_ms: 90000, max_attempts: 3 };
    // `min(base * 2^(n-1), cap)`: attempt 1 is under the cap, everything from attempt 2 on clamps.
    for (const [attempts, expected] of [[1, 60000], [2, 90000], [3, 90000], [5, 90000]]) {
      check(`B3 backoff(${attempts}) = min(base*2^(n-1), cap) = ${expected}`,
        backoffMsFor(attempts, cappedCfg) === expected,
        `backoff=${backoffMsFor(attempts, cappedCfg)}`);
    }
  }

  const statusProc = spawnSync(process.execPath, [join(AF_ROOT, 'af-admin.mjs'), 'a1a', 'status', '--json'], { env: { ...env }, encoding: 'utf8' });
  const status = JSON.parse(statusProc.stdout);
  const asset = status.assets[0];
  check('B3 fresh process reads attempts=3 across a restart', asset?.attempts === 3, `attempts=${asset?.attempts}`);
  check('B3 fresh process reads phase=EXHAUSTED / exhausted=true', asset?.phase === 'EXHAUSTED' && asset?.exhausted === true, `phase=${asset?.phase} exhausted=${asset?.exhausted}`);
  check('B3 a1a status exits 1 when an asset is exhausted', statusProc.status === 1, `exit=${statusProc.status}`);

  // The exhaustion event must reference the ORIGINAL alert and never fake a count.
  const events = readA1aEvents(cfg);
  const exhaustedEvents = events.events.filter((e) => e.event === 'a1a_recovery_exhausted');
  check('B3 exactly one exhaustion event', exhaustedEvents.length === 1, `count=${exhaustedEvents.length}`);
  check('B3 exhaustion event links the original alert id', exhaustedEvents[0]?.alert_id === alert.alert_id, `alert_id=${exhaustedEvents[0]?.alert_id}`);
  check('B3 exhaustion event states resolution, never a fake count', exhaustedEvents[0]?.alert_resolution === 'linked' && exhaustedEvents[0]?.occurrences === undefined, `resolution=${exhaustedEvents[0]?.alert_resolution}`);

  // A further sweep is refused by the budget gate (same epoch), not retried.
  const fourth = runSweep('2026-01-01T00:15:00.000Z', 'PROTECTION_RETAINED');
  check('B3 4th attempt refused by the same-epoch budget gate', fourth.results?.[0]?.decision === 'REFUSED_INELIGIBLE' && /3\.9-budget/.test(fourth.results?.[0]?.reason_code ?? ''), `decision=${fourth.results?.[0]?.decision} reason=${fourth.results?.[0]?.reason_code}`);
  check('B3 4th attempt did not change attempts', assetRecord()?.attempts === 3, `attempts=${assetRecord()?.attempts}`);
} catch (err) {
  check('B3 no unhandled error', false, err.message);
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}

check('no residue: repo runtime/asset-locks absent', !existsSync(join(AF_ROOT, 'runtime', 'asset-locks')));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
process.exit(failed.length === 0 ? 0 : 1);
