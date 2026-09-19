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
- Executor adapters publish process-group termination evidence together with a
  verified writer scope. A process group alone is diagnostic only because a
  double-forked `setsid` descendant can escape it. V2 runs real executors only
  inside a delegated cgroup v2 scope or a Docker PID namespace, kills that
  scope, and verifies it is empty before capture. If neither boundary is
  available, the V2 executor launch fails closed. The durable run handle keeps
  the cgroup identity so the orphan reaper can clean it after a hard process
  kill.
- V2 admits only the single workspace flow, requires an explicit reviewer
  executor independent from the author, reviews the sealed candidate snapshot,
  and requires `PASS` before authorization and Hard G.
- Hard G journals the exact commit/tree/parent transaction before
  `update-ref`. A new process can verify and finalize a promotion committed
  before the previous process died. If canonical advanced afterward, recovery
  accepts the transaction only when its promoted commit is an ancestor of the
  current canonical ref and materializes that current ref.

## Verification

The focused V2 and Trusted Import suite passes with **53/53** tests, including
same-path conflict, clean rebase, mode admission, a real child-process restart
after canonical promotion, committed-ancestor recovery, and an escaped
`setsid` writer probe.

On this host `/sys/fs/cgroup` is mounted but has no delegated writable subtree.
The strong-scope implementation therefore reports that capability as
unavailable; a real V2 executor must be deployed with `AF_CGROUP_BASE` pointing
to a delegated cgroup subtree or with `AF_SANDBOX_EXECUTORS=on` and a configured
executor image.

The repository-wide run reached 358 tests with 355 passes. The additional
durable-scope orphan regression was run separately and passed 12/12. Three existing
long-running suites (`runtime-guard-policy.test.mjs`,
`sandbox-executor.test.mjs`, and `sandbox.test.mjs`) remained pending on this
host and were stopped by the bounded run; they were not used as V2 acceptance
evidence.
