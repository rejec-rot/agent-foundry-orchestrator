// u6-a1a-sweep-once.mjs - run ONE A1a live sweep with an injected recovery outcome (U6 batch 3).
//
// The point is to exercise the LIVE state-writing path (attempts / next_attempt_at / EXHAUSTED /
// the exhaustion event) WITHOUT touching any permission: `deps.recover` replaces the recovery
// transaction with a stub, exactly the injection seam the module already uses for decideScopes,
// findTask, etc. Eligibility guards are stubbed permissive so the sweep reaches the live branch.
//
// Env:
//   AF_U6_OUTCOME   outcome the stub recovery returns (e.g. PROTECTION_RETAINED)
//   AF_U6_NOW       ISO timestamp used as `now` (deterministic backoff)
//   plus the usual AF_A1A_* / AF_TASKS_DIR / AF_BOUNDARY_ALERTS_FILE / AF_BOUNDARY_AUDIT_DIR
//
// Prints one JSON line: the sweep result.

import { a1aConfig, runA1aSweep, loadA1aAllowlist } from '../lib/a1a.mjs';

const cfg = a1aConfig();
const allowlist = loadA1aAllowlist(cfg);
const entry = allowlist.assets[0];

const task = {
  task_id: entry?.task_id ?? 'T-U6-B3',
  state: 'COMPLETED',
  fixture_dir: entry?.canonical_dir,
  trusted_import: {
    cas_dir: entry?.cas_dir,
    boundary_state: 'PROTECTION_RETAINED_PENDING_RECOVERY',
    author_completed: true,
    author_termination_evidence: { termination_confirmed: true, process_group_alive: false, scope_verified: true },
  },
};

const deps = {
  allowlist,
  findTask: () => ({ ok: true, missing: false, task }),
  decideScopes: () => ({ decision: 'UNLOCK', status: 'empty', anomalies: [] }),
  loadSnapshot: () => ({ entries: [] }),
  verifyProtection: () => ({ ok: true, checked: 1, expected: { uid: 0, gid: 0, dir_mode: 0o555, file_mode: 0o444 }, epoch: { epoch_id: 'epoch-u6' } }),
  checkAuditWritable: () => ({ ok: true }),
  classifyRecovery: () => ({ state: 'clean', reason: null }),
  lockStatus: () => [],
  // The injection seam: never performs a real recovery, so no permission is touched.
  recover: () => ({ outcome: process.env.AF_U6_OUTCOME || 'PROTECTION_RETAINED', delivered: false, alert_closed: false }),
};

const res = runA1aSweep({ cfg, now: Date.parse(process.env.AF_U6_NOW || new Date().toISOString()), deps });
console.log(JSON.stringify(res));
