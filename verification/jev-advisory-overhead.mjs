// jev-advisory-overhead.mjs - SYNTHETIC end-to-end comparison: Jev OFF vs ON.
//
// No real executor, no real Jev call: this drives the same decision path the pipeline uses
// (deterministic classifyExecutionError -> optional advisory overlay) over a batch of failure
// events, once with the model off and once with a MODELLED Jev (fixed latency per call), and
// reports (a) whether the deterministic result is unchanged and (b) the wall-clock difference.
//
// It is deliberately labelled synthetic: it proves the integration does not change outcomes and
// quantifies the added latency, NOT that a real-executor run succeeds (that is U5/U6 live).
//
// Usage: node verification/jev-advisory-overhead.mjs [--events 20] [--latency-ms 250]

import { classifyExecutionError } from '../lib/executor-error-classifier.mjs';
import { withErrorAdvisory } from '../lib/error-advisory.mjs';

const argValue = (flag, dflt) => { const i = process.argv.indexOf(flag); return i !== -1 ? Number(process.argv[i + 1]) : dflt; };
const EVENTS = argValue('--events', 20);
const LATENCY = argValue('--latency-ms', 250);

const SAMPLES = [
  { expected: 'RATE_LIMIT', stderr: 'Error: 429 Too Many Requests: rate limit reached' },
  { expected: 'AUTH_FAILURE', stderr: 'Error: 401 Unauthorized: token expired' },
  { expected: 'ACCOUNT_POLICY', stderr: 'account disabled for Terms of Service violation (403)' },
  { expected: 'ENVIRONMENT_FAULT', stderr: 'exec: "codex": executable file not found in $PATH' },
  { expected: 'TRANSIENT_FAULT', stderr: 'connection reset by peer while streaming' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A modelled Jev: echoes a deterministic answer for the sample, after LATENCY.
const modelledFetch = (sample) => async () => {
  await sleep(LATENCY);
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'jev-1.13.0',
      answers: {
        suggested_category: { type: 'choice', choice: sample.expected, confidence: 0.9 },
        retryable_hint: { type: 'noul', noul: sample.expected === 'RATE_LIMIT' || sample.expected === 'TRANSIENT_FAULT' ? 0.9 : 0.1 },
        suspected_account_ban: { type: 'noul', noul: sample.expected === 'ACCOUNT_POLICY' ? 0.95 : 0.02 },
        severity: { type: 'score', score: sample.expected === 'ACCOUNT_POLICY' ? 3 : 1 },
      },
    }),
  };
};

const events = Array.from({ length: EVENTS }, (_, i) => SAMPLES[i % SAMPLES.length]);

async function runFlow(jevOn) {
  const started = Date.now();
  const results = [];
  for (const sample of events) {
    let classification = classifyExecutionError('codex', { exit_code: 1, stderr: sample.stderr });
    if (jevOn) {
      classification = await withErrorAdvisory({
        executorType: 'codex',
        classification,
        evidence: { stderr: sample.stderr, exit_code: 1 },
        deps: { fetchImpl: modelledFetch(sample), sleep: () => Promise.resolve() },
        env: { AF_DECISION_MODEL: 'jev', AF_TYPESAFE_API_KEY: 'sk-modelled' },
      });
    }
    results.push({ category: classification.category, retryable: classification.retryable, safety_action: classification.safety_action, advisory: classification.advisory ?? null });
  }
  return { wallMs: Date.now() - started, results };
}

console.log(`synthetic advisory comparison: events=${EVENTS} modelled-latency=${LATENCY}ms/event (no real executor, no real Jev call)\n`);

const off = await runFlow(false);
const on = await runFlow(true);

let identical = 0;
for (let i = 0; i < events.length; i += 1) {
  const a = off.results[i];
  const b = on.results[i];
  if (a.category === b.category && a.retryable === b.retryable && a.safety_action === b.safety_action) identical += 1;
  else console.log(`DIFF at event ${i}: off=${JSON.stringify(a)} on=${JSON.stringify(b)}`);
}

const advisories = on.results.filter((r) => r.advisory).length;
const expectedAdvisories = events.length;

console.log(`deterministic verdicts identical: ${identical}/${events.length}`);
console.log(`advisories attached with Jev ON: ${advisories}/${expectedAdvisories} (0 with OFF: ${off.results.filter((r) => r.advisory).length})`);
console.log(`wall time  OFF: ${off.wallMs}ms   ON: ${on.wallMs}ms   delta: ${on.wallMs - off.wallMs}ms (~${((on.wallMs - off.wallMs) / events.length).toFixed(1)}ms/event)`);
console.log(`sample advisory (ON): ${JSON.stringify(on.results[0].advisory)}`);

const ok = identical === events.length && advisories === expectedAdvisories && off.results.every((r) => r.advisory === null);
console.log(`\n${ok ? 'PASS' : 'FAIL'}: integration changes no deterministic verdict; advisory is additive and off adds nothing`);
process.exit(ok ? 0 : 1);
