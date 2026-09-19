# Trusted Import V2 delivery baseline

## Source of truth

The implementation lives in `lib/trusted-import/` and is entered from
`orchestrator.mjs` only when `trusted_import.enabled === true`. The candidate
workspace, CAS, task journal, and canonical Git ref are separate state
domains. The repository commit containing this record is the traceable
baseline for the V2 work.

## Recovery guarantees covered by the entry path

- A task keeps its persisted `baseline_oid`; recovery compares it with the
  current canonical OID and runs the stale delta through `rebaseCandidateDelta`.
  Same-path concurrent changes fail with `REBASE_CONFLICT`. A clean rebase is
  materialized back into the candidate so another recovery cannot turn the
  concurrent files into deletions.
- Executor adapters publish process-group termination evidence. V2 requires
  that evidence and verifies that no active task run remains before capture.
- V2 admits only the single workspace flow, requires an explicit reviewer
  executor independent from the author, reviews the sealed candidate snapshot,
  and requires `PASS` before authorization and Hard G.
- Hard G journals the exact commit/tree/parent transaction before
  `update-ref`. A new process can verify and finalize a promotion committed
  before the previous process died.

## Verification

The focused V2 and Trusted Import suite passes with **51/51** tests, including
same-path conflict, clean rebase, mode admission, and a real child-process
restart after canonical promotion.

The repository-wide run reached 354 tests with 352 passes. Two existing
long-running test files (`runtime-guard-policy.test.mjs` and
`sandbox-executor.test.mjs`) remain blocked by pending event-loop work on this
host; they were not used as V2 acceptance evidence.
