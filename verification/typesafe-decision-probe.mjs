// typesafe-decision-probe.mjs - GATED live probe for the advisory decision model.
//
// This is the ONLY place in the repo that may call the hosted decision model, and it is a manual,
// explicitly-confirmed probe - never scheduled, never part of the pipeline. It sends only benign
// sample error strings (no repository content, no secrets) and prints the typed decisions plus how
// they compare to the deterministic classifier's label.
//
// Gating:
//   * must be run with --confirm, AND
//   * AF_DECISION_MODEL=jev, AND
//   * AF_TYPESAFE_API_KEY set (kept in a private env file; the key is NEVER printed).
//
// Usage:
//   set -a; . <config dir>/decision.env; set +a
//   node verification/typesafe-decision-probe.mjs --confirm
//
// Exit: 0 ok / 2 not configured (no call was made) .

import { decisionModelConfig, decide } from '../lib/decision-model.mjs';

const confirmed = process.argv.includes('--confirm');
const cfg = decisionModelConfig();

if (!confirmed) {
  console.log('gated probe: pass --confirm to actually call the hosted decision model.');
  console.log('(nothing was sent; this is the safe default)');
  process.exit(0);
}
if (cfg.mode !== 'jev') {
  console.error(`AF_DECISION_MODEL=${cfg.configured_mode} (expected jev); no call made.`);
  process.exit(2);
}
if (!cfg.api_key_configured) {
  console.error('AF_TYPESAFE_API_KEY is not set (put it in the private env file); no call made.');
  process.exit(2);
}

// Benign samples with the class the DETERMINISTIC classifier would assign, for comparison only.
const SAMPLES = [
  { expected: 'RATE_LIMIT', stderr: "Error: 429 Too Many Requests: rate limit reached, retry after 30s" },
  { expected: 'AUTH_FAILURE', stderr: 'Error: 401 Unauthorized: token expired, please re-authenticate' },
  { expected: 'ACCOUNT_POLICY', stderr: 'Your account has been disabled for a Terms of Service violation (403)' },
  { expected: 'ENVIRONMENT_FAULT', stderr: 'exec: "codex": executable file not found in $PATH' },
  { expected: 'TRANSIENT_FAULT', stderr: 'connection reset by peer while streaming the response' },
];

const criteria = Object.fromEntries(
  ['ACCOUNT_POLICY', 'RATE_LIMIT', 'AUTH_FAILURE', 'ENVIRONMENT_FAULT', 'TRANSIENT_FAULT'].map((c) => [c, c]),
);

console.log(`probe: model=${cfg.model} endpoint=${cfg.endpoint} (key not shown)\n`);
let agree = 0;
for (const sample of SAMPLES) {
  const res = await decide({
    state: `executor=codex exit_code=1\n${sample.stderr}`,
    questions: { category: { type: 'choice', instructions: 'Which class best describes this executor error?', criteria } },
  });
  if (!res.ok) {
    console.log(`FAIL  expected=${sample.expected} -> ${res.reason}`);
    continue;
  }
  const answer = res.answers.category;
  const ok = answer?.choice === sample.expected;
  if (ok) agree += 1;
  console.log(`${ok ? 'OK  ' : 'DIFF'}  expected=${sample.expected} got=${answer?.choice} conf=${answer?.confidence} (${res.model})`);
}
console.log(`\n${agree}/${SAMPLES.length} agreed with the deterministic expectation`);
process.exit(0);
