// u6-recover-once.mjs - run ONE controlled recovery in a fresh process (U6 restart-consistency helper).
//
// This exists so the restart cases are real process boundaries, not in-process simulations: the
// parent starts this script, it may die mid-transaction, and a SECOND fresh process then has to
// interpret the durable evidence the first one left behind.
//
// Reads its inputs from the environment (never argv secrets):
//   AF_U6_CANONICAL   canonical dir (required)
//   AF_U6_CAS         cas dir (required)
//   AF_U6_AUDIT       audit dir for this recovery (required)
//   AF_U6_JUSTIFICATION  operator justification (optional)
//   AF_U6_FAULT       '', 'result', or 'alert-close' - inject that failure and exit
//   AF_CGROUP_BASE    passed through for scope inspection
//
// Always prints one JSON line and exits 0, so the parent can read the outcome either way.

import { recoverRetainedBoundary } from '../lib/host-boundary.mjs';

const canonicalDir = process.env.AF_U6_CANONICAL;
const casDir = process.env.AF_U6_CAS;
const auditDir = process.env.AF_U6_AUDIT;
const fault = process.env.AF_U6_FAULT || '';

const hooks = {};
if (fault === 'result') {
  hooks.onPhase = (phase) => { if (phase === 'result') throw new Error('injected: process dies before RESULT is durable'); };
}
const options = {
  canonicalDir,
  casDir,
  justification: process.env.AF_U6_JUSTIFICATION || 'U6 restart-consistency probe',
  auditDir,
};
if (Object.keys(hooks).length > 0) options.hooks = hooks;
if (fault === 'alert-close') options.closeAlert = () => { throw new Error('injected: alert store unreachable'); };

let result;
try {
  result = recoverRetainedBoundary(options);
} catch (err) {
  result = { outcome: 'THREW', reason: err.message };
}

console.log(JSON.stringify({
  outcome: result.outcome,
  recovered: result.recovered === true,
  delivered: result.delivered === true,
  alert_closed: result.alert_closed ?? null,
  reason: result.reason ?? null,
}));
