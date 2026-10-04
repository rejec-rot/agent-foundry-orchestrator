# Agent Foundry Orchestrator - Release Manifest


## V2 Unified Workspace and Project Picker — 2026-10-04

| Field | Verified value |
|---|---|
| Code commit | [`16fcfd70df91f3635059917f97f601ff5b7d2d4f`](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/16fcfd70df91f3635059917f97f601ff5b7d2d4f) — one Planner creation surface, visible Worker task changes and authenticated host directories |
| Full regression | 901 tests: 896 passed, 0 failed, 5 existing environment-gated skips |
| Regression completed at | 2026-10-04T01:35:20Z |
| Architecture invariants | 6/6 passed at 2026-10-04T01:34:28Z |
| Browser verification | Planner 57/57; first-chat 46/46; Agent discovery 35/35; project picker 19/19; actual local visual/access checks 25/25 |
| Browser verified at | Planner 2026-10-04T01:36:27Z; first-chat 2026-10-04T01:36:55Z; discovery 2026-10-04T01:39:18Z; picker 2026-10-04T01:34:32Z; local preview 2026-10-04T01:33:27Z |
| Independent review | Non-author PASS; independently passed directory API 5/5, architecture 6/6, first-chat 46 checks and Planner 56 checks. The final discovery report separately covers the sidebar new-goal entry. |

New goals enter the full-row Planner workspace. The duplicate modal and its free
path, acceptance command, JSON arguments and submission-key fields are removed.
Empty task, delivery, member and history surfaces stay hidden until relevant;
actual work graphs and approval remain available. Worker cards locate their tasks,
and task cards expose the existing pause → Planner revision → redispatch flow.
Direct Planner conversation messages are not repeated in member history.

Authenticated directory browsing stays inside explicit `AF_PROJECT_BROWSE_ROOT`.
New directories use a selected trusted profile from the existing canonical project
registry. Registration checks required files and exact acceptance assets, inherits
configured policy/tier, and never executes acceptance or Agents. Canonical registry
realpath, shared exclusive locks and atomic replacement preserve symlink aliases.
Stale-response retries return existing registrations only when project, template,
profile and policy are equivalent; stale or conflicting updates cannot overwrite.
Only registry-identity team creation admits registered projects in the browse root.

Browser fixtures exercise real HTTP, filesystem/registry writes and the durable
team controller with controlled model outputs. The actual host preview uses the
private playground registry and token file; it validates directory selection,
accurate model grades and cache-only page openings, without team creation or model
prompts. The five gated deployment/live-model tests are unchanged.


## V2 Direct Planner Conversation — 2026-10-04

| Attribute | Verification |
| :--- | :--- |
| Code commit | [`27d687e7c8d8df5f88de9553d3c4af5f822ea481`](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/27d687e7c8d8df5f88de9553d3c4af5f822ea481) — full-row Planner and direct conversation |
| Full regression verified at | 2026-10-03T15:28:29Z, Node v24.21.0 |
| Full regression | 896 tests: 891 passed, 0 failed, 5 skipped by existing environment/opt-in gates |
| Architecture invariants | 6 passed, 0 failed, 0 skipped; rechecked 2026-10-04 |
| Browser verification | 51 Planner workflow checks, 46 first-chat/recovery checks, 32 discovery checks, 23 real local visual/access checks; all passed |
| Browser verified at | 2026-10-04T00:53:53Z for Planner; first-chat 2026-10-04T00:51:43Z; local preview 2026-10-04T00:53:38Z |
| Independent review | Non-author reviewer rechecked the final diff and independently passed all 51 Planner and 46 first-chat checks; no blocking findings |

Planner occupies one full row, with larger text, conversation space and send
controls; the plan follows below. An empty workspace can select a registered
project and acceptance profile, then send its first message directly. Existing
teams apply a changed Planner profile and wait for its confirmed receipt before
sending the message. The separate save action is optional. Direct first chat
uses human-controlled dispatch, so Workers wait for plan approval.

The project read API returns canonical IDs only. Registry-scoped creation binds
the trusted path and acceptance profile on the server through existing intake,
authorization and allowed-root checks. Optional goal/configuration versions on
Planner messages reject stale choices, and queued Planner messages prevent
configuration changes before consumption.

Uncertain creation, configuration or message responses keep their original
payload and submission ID. Explicit retries preserve that identity; no POST is
silently retried. Input and shortcut suggestions stay locked until the result
is confirmed, while rejected configuration retains the draft for a deliberate
retry. Browser fixtures cover response loss, real failed detail reads, receipt
GET 403 after an accepted POST, authentication failure during an uncertain
configuration retry and concurrent version changes.

Browser workflow tests use controlled model adapters; first-chat intake
responses are controlled, with trusted creation independently covered by API
tests. The live preview uses an independently registered local playground and
authenticated writes scoped to that project. Visual verification sent zero
model prompts. Private tokens, the local project registry and runtime state
are outside the repository. Cached page opening and the explicit rescan button
remain unchanged; exact verified model reasoning grades still gate selection.
The five existing regression skips retain their original gates.

## V2 Agent Card Motion — 2026-10-03

| Attribute | Verification |
| :--- | :--- |
| Code commit | [`c1da8707238069e150afffee2ebb9e19e37e6530`](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/c1da8707238069e150afffee2ebb9e19e37e6530) — Persona inspired Agent inventory cards |
| Verified at | 2026-10-03T11:43:30Z, Node v24.21.0 |
| Full regression | 891 tests: 886 passed, 0 failed, 5 skipped by existing environment/opt-in gates |
| Architecture invariants | 6 passed, 0 failed, 0 skipped |
| Browser verification | 32 discovery checks, 40 Planner workflow checks, 15 real local visual/accessibility checks; all passed |
| Independent review | Non-author reviewer checked the final card renderer, motion, shared frames and CSS specificity, and independently passed 32 discovery checks |

All inventory cards use cut outlines, red offset shadows, dark name strips,
halftone surfaces, serial number artwork and decorative stars. Opening the
inventory starts one staggered entrance; pointer hover and keyboard focus
produce a short lift, tilt and diagonal swipe. Motion is bounded and uses CSS
transform/opacity with inline SVG decoration. Reduced motion disables movement;
forced colors restores visible borders and hides decorative artwork. The real
preview was checked at 320, 390, 768, 1440 and 1920px, including touch layout and
actual keyboard Tab navigation.

Agent status, model metadata, reasoning grades and admission remain unchanged.
Visual interactions caused zero native scans. The existing five regression
skips retain their documented environment/opt-in gates; no gate was weakened.

## V2 Catalog Loading Update — 2026-10-03

| Attribute | Verification |
| :--- | :--- |
| Code commit | [`2bb4379abde46b6e72303689f1b30ade8bcf8a49`](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/2bb4379abde46b6e72303689f1b30ade8bcf8a49) — cached directory reads and explicit manual rescanning |
| Verified at | 2026-10-03T11:09:45Z, Node v24.21.0 |
| Full regression | 891 tests: 886 passed, 0 failed, 5 skipped by existing environment/opt-in gates |
| Architecture invariants | 6 passed, 0 failed, 0 skipped |
| Browser verification | 32 discovery checks, 40 Planner workflow checks, 10 real local cache checks; all passed |
| Independent review | Non-author reviewer rechecked the diff and independently passed all 32 discovery browser checks after the refresh queue fix |

Opening, reloading or returning to the collaboration page reads the existing
catalog without launching native model discovery. The “重新扫描” button remains
available and explicitly requests fresh Agent/model/reasoning metadata. Cache
reads keep the original discovery time and exact verified model grades. A busy
team poll queues explicit catalog requests; a queued scan takes priority over a
queued cached read. The 13-second scan fixture still verifies one completed
request without a silent retry.

The real local preview was checked without any native scan or model prompt;
Cline, Command Code and Qoder kept their verified per-model reasoning choices.
The cache remains an in-process projection, so service restart can require a
manual scan to refill native metadata. Backend save, proposal and dispatch
validation remains unchanged. The five existing skipped cases are documented
in the preceding reasoning-discovery update below; no test gate was weakened.

## V2 Development Update — 2026-10-03

The V2 development line remains `2.0.0-dev`. The v1.2 freeze record below is
historical; this update records the current collaboration-platform change.

| Attribute | Verification |
| :--- | :--- |
| Code commit | [`a9dbd9d473562ad9603c1b062557abf21888bd4d`](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/a9dbd9d473562ad9603c1b062557abf21888bd4d) — unified per-model reasoning discovery |
| Verified at | 2026-10-03T10:42:41Z, Node v24.21.0 |
| Full regression | 891 tests: 886 passed, 0 failed, 5 skipped by existing environment/opt-in gates |
| Architecture invariants | 6 passed, 0 failed, 0 skipped |
| Browser verification | 22 discovery checks, 40 Planner workflow checks, 25 real local catalog checks; all passed |
| Independent review | Cline audit reviewed Command Code metadata/isolation; Command Code audit reviewed Cline, shared projection, API and UI; identified issues were fixed and rechecked |

Cline obtains exact provider/model controls from its installed SDK and
intersects grades with its CLI's accepted values. Command Code 1.73.0 reads
the installed picker registry and fallback arrays without evaluating the
bundle. Its listing processes use a disposable home, credential-free BYOK
metadata and `CI=1`, so startup migration and IDE installation cannot modify
the operator's configuration. Unknown model or scan states cannot enable
grades. Planner and Worker use the same contract, and a 13-second scan fixture
verifies that the page waits for its first response rather than retrying.

Local metadata verification found 18 Cline models (9 graded, 8 toggle-only,
1 unconfirmed), 86 Command Code models (57 graded, 29 without grades), and
2 graded Qoder models. An additional isolated BYOK fixture preserved its exact
model ID and `low / max` grades; original configuration files were unchanged.
These counts describe the tested local installation, not a universal catalog.
No model prompt was sent by the native metadata verification.

The five skipped tests are two Docker deployment acceptance cases, one real
executor integration case disabled by default, and two missing-registry cases
inapplicable with the configured fixture registry. No test gate was weakened.

## Release Overview

| Attribute | Specification |
| :--- | :--- |
| **Release Name** | Agent Foundry Orchestrator Production Release v1.2 (Full Capabilities) |
| **Frozen At** | 2026-09-15T22:30:00+08:00 |
| **Architecture Reference** | [`FINAL_ARCHITECTURE.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/FINAL_ARCHITECTURE.md) |
| **Safety Model Reference** | [`EXECUTOR_SAFETY_MODEL.md`](file:///mnt/c/Users/relaret/agent-foundry-orchestrator/EXECUTOR_SAFETY_MODEL.md) |
| **Regression Test Status** | **182 / 182 PASS (100%)** — verified on a CLEAN CLONE (`git clone . /tmp/verify && node --test`), not only on the author's checkout |
| **Last Hardened At** | 2026-09-16 (see Post-freeze Hardening below) |
| **Execution Engine** | Multi-step DAG state machine (`orchestrator.mjs` + `lib/scheduler.mjs` + `lib/worktree.mjs`) |
| **Storage Architecture** | Filesystem atomic rename (`saveTaskAtomic`), zero SQLite/Postgres/Redis dependencies |

---

## Post-freeze Hardening (B0 / B1)

The v1.2 baseline was green only on the author's machine. A clean clone registered
133 of 146 tests and failed 15 of them, so the recorded "146 / 146" could not be
reproduced. Batches B0 (make the baseline trustworthy) and B1 (five critical
safety defects) were applied on top of it.

**B0 — trustworthy baseline**

| Commit | Change |
| :--- | :--- |
| `c55daf0` | Restore executable bits on the 9 shebang-carrying launchers/scripts — a clean clone had none, so every direct `spawn(argv[0])` failed with EACCES. |
| `0b94436` | Stop tracking `runtime/scheduler.json` (per-instance state; every test run left the worktree dirty). |
| `ded6285` | Make asset classification cwd-independent: resolve relative targets against an explicit base root and decide TEMP_CACHE from the target's own path, not from an ancestor directory. |
| `9ecb08c` | Add `fixtures/gateway/` — the conversation-gateway tests hard-imported the sibling gateway repo and died at load time without it (15 cases never registered). |
| `a51745d` | Add `fixtures/agent-foundry-global/executors/` and drive the adapter-contract tests through stub launchers, so the capability and 6A/CLINE cases no longer need the registry or the signed-in provider CLIs. |

**B1 — critical safety defects**

| Commit | Change |
| :--- | :--- |
| `c9a43c3` | A 403/ToS refusal reported on stdout is `ACCOUNT_POLICY` again (codex reports on stdout with an empty stderr), instead of a retryable transient fault that never opened the breaker. |
| `f9b8fb7` | Unify cancellation: codex/antigravity/claude cancelled through `terminateRun`, so a cancelled run was classified retryable and the task could be re-run or FAILED-overwritten. A cancellation is now sticky. |
| `6892f12` | A publish counts only when the vault says `published === true` / `published_path`; `policy_decision: auto_publish` is a strategy class, not an outcome, and no longer completes a task. |
| `2a9b7d4` | Enforce a real acceptance allowlist (`config/acceptance-allowlist.json`), bind the acceptance anchor so an edited task file fails closed as `TASK_FILE_TAMPERED`, scrub the acceptance child's environment, and refuse a workspace inside the orchestrator root. |
| `dfcccc3` | Circuit state is written atomically and an unreadable state file now fails CLOSED (every breaker opens, evidence quarantined, `STATE_CORRUPTION` audited) instead of silently reopening them. |

**Verified after B1** (clean clone, Node v24):

```text
ℹ tests 171
ℹ pass 171
ℹ fail 0
ℹ skipped 0
```

`git status --porcelain` is empty after a full run, and the plan's acceptance
probes now read:

```text
corrupt state file        -> OPEN_MANUAL_RESET / canExecute=false   (was CLOSED / true)
403 on stdout             -> ACCOUNT_POLICY / retryable=false       (was TRANSIENT_FAULT)
auto_publish+published:false -> unknown                             (was published)
```

**B2 — source-of-truth consistency and recovery correctness**

| Commit | Change |
| :--- | :--- |
| `6dd4e88` | Per-executor policy is deep merged (antigravity kept losing its 1h cooldown), cooldown_until is epoch ms everywhere and compared in ms, a guard refusal is `ENVIRONMENT_FAULT` rather than a fabricated `ACCOUNT_POLICY`, codex forwards its purpose so a recovery probe can acquire a slot, the cline fallback no longer auto-resets the breaker, and log rotation no longer drops events appended while it read the file. |
| `3c4a755` | The CLI `run`/`resume` take the task lock; the staged author content is bound to its revision (a crashed fix no longer resumes on the previous revision's content) with a dedicated `FIX_RUNNING` state; acceptance reuse is content-addressed; lock renewal is atomic with an ownership re-check; every lifecycle write goes through one version-incrementing writer (`saveTaskWithVersion`), which required validating the stale-recovery plan BEFORE recovery writes its own bookkeeping; a failed parallel batch cancels sibling runs before tearing down worktrees; `tasksDir` is forwarded to the continuation. |
| `d33d09e` | All author-machine hardcoded paths removed from `lib/config.mjs` and `bin/cline-af` (env -> sibling -> `$HOME`; an unreadable canonical fails closed), and a missing capability registry now fails CLOSED: the router returns `primary: null` / `EXECUTOR_REGISTRY_MISSING` and the scheduler's preflight refuses the task, instead of silently routing as if every executor's state were known. |

**Verified after B2** (clean clone, Node v24):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

The plan's §5 checklist now passes end to end, including the two items that had
never passed: `grep -rn '/mnt/c/Users/relaret\|/home/relaret' lib/ bin/ config/`
returns 0, and `AF_EXECUTORS_DIR=/nonexistent` yields an explicit
`EXECUTOR_REGISTRY_MISSING` refusal instead of a silently green suite.

**B3 — minors and engineering hygiene**

| Commit | Change |
| :--- | :--- |
| `74ef9c9` | N1–N13 and E1–E5. Correctness: the cancel CLI path referenced an undeclared `now`; `settleIfPublished` cleared a published flag on ANY error (including a misconfigured bridge) instead of only on a vault rejection; `execAsync` wrapped an async executor in `new Promise`, so a throw after the first await left the promise forever pending; 'error'+'close' double-recorded breaker evidence; codex/cline `health()` could never report `ok: false`; the codex planner could die on an unhandled EPIPE; `ensureGitRepo` silently `git init`-ed any directory and rewrote its commit identity; the shipped task template could not run at all and the acceptance command was only validated after the expensive stages; a failed lease renewal was swallowed, leaving a run executing without its lock. Hardening: the credential scan is recursive with a broader pattern and the audit sanitizer now strips nested credential keys; PROD-2 exercises the real classifier instead of asserting its own baked-in literal; `saveTaskAtomic` fsyncs the file and the directory. Hygiene: `.gitattributes`, `package.json` (`npm test`), a CI regression gate, the duplicate safety-policy file removed (single source) with an explicit cline policy, and `contracts/action-types.json` is now genuinely the runtime source the validator reads. |

**Verified after B3** (clean clone, Node v24, via `npm test`):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

The plan's §5 checklist passes end to end on the clean clone, including the two
items that had never passed: `grep -rn '/mnt/c/Users/relaret\|/home/relaret' lib/
bin/ config/` returns 0, and `AF_EXECUTORS_DIR=/nonexistent` yields an explicit
`EXECUTOR_REGISTRY_MISSING` refusal instead of a silently green suite.

Not verified locally: the CI workflow itself (`.github/workflows/regression.yml`)
has no runner here. Its steps are the same commands that were run by hand above;
it is the one artefact in this batch that has not been executed end to end.

**Follow-up on the observations logged during B2/B3**

| Commit | Change |
| :--- | :--- |
| `4f800a7` | Cancellation race: a cancel landing between "run id announced" and "process registered" found no handle and terminated nothing, so the process ran to completion behind a task already marked CANCELLED; the recorded request is now honoured the moment the child exists. Blocked fallback: a cline fallback refused by the breaker reported the circuit refusal as the outcome, hiding the quota refusal that actually failed - the root cause is returned with a `fallback_blocked` record. |
| `4bb5448` | Isolating the repository's `tasks/` directory for tests: `approval/intent-gate.mjs` now honours `AF_TASKS_DIR`, nine test files import the isolation fixture, and governance TEST F-gov forges its task where the module under test actually reads. The 136 historical leftovers were archived to `~/DSHWorkSpace/afr-tasks-leftovers-<ts>.tar.gz` and removed. |

**Follow-up verification** (fresh clone, `npm test`):

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

`tasks/` holds `task-template.json` before and after the run, and
`git status --porcelain` is empty.

---


| Phase | Milestone Name | Key Architectural Deliverable |
| :--- | :--- | :--- |
| **PHASE 1** | Control Plane Core | Task file truth (`tasks/<id>.json`), POSIX atomic writes, author -> review -> acceptance state loop. |
| **PHASE 2** | Governance Bridge | Formal governance integration with `vault-mcp`, L2 `auto_publish` vs L3 `human_required`, fail-closed. |
| **PHASE 3** | Task QA Independence | Independent reviewer verification (`author_id != reviewer_id`), acceptance command whitelist enforcement. |
| **PHASE 4** | Task Recovery & Lock Management | `O_CREAT \| O_EXCL` file locks, dead PID reclamation, idempotent multi-stage crash recovery. |
| **PHASE 5-A/B/C** | Runtime Safety Guard | Circuit breaker (`CLOSED`, `OPEN_COOLDOWN`, `OPEN_MANUAL_RESET`), slot limits, burst launch protection. |
| **PHASE 6-A** | Enterprise Executor Adapter | Vertex Gemini enterprise adapter (`lib/adapters.mjs`), standardized run/resume/cancel/health lifecycle. |
| **PHASE 6-B** | Gated Executor Recovery | Manual-only circuit recovery: isolated sandbox probe -> evidence generation -> operator admit gate. |
| **PHASE 6-C** | Multi-Executor Routing | Deterministic pure-function funnel (`lib/executor-router.mjs`), capability/availability filters, transient fallback. |
| **PHASE 7-A** | Graceful Shutdown | Process termination handler for `SIGTERM`/`SIGINT`, active child process tree cleanup, orphan elimination. |
| **PHASE 7-B** | Operator Maintenance Layer | Operator CLI tool (`af-admin.mjs`), executor status inspect, terminal task prune, audit log rotation. |
| **PHASE 8-A** | Production Readiness Audit | Persistence check, security scan, executor status matrix, 5 failure injection tests, operator runbook. |
| **PHASE 8-B** | Production Freeze Documentation | Release manifest, change control protocol, disaster recovery runbook, architecture invariant tests. |
| **PHASE 9** | Multi-Executor Extension (Cline) | Native Cline CLI adapter (`bin/cline-af`), DeepSeek-V4-Flash fallback support, health/resume/run integration. |
| **PHASE 10** | Human Intent Gate & Action Contract | `intent/` + `approval/` + `contracts/`: Action Validator, Asset Classifier, Intent Policy, sensitive operation blocking. |
| **PHASE 11** | Autonomous Planning Layer | `planner/` + `lib/codex-planner.mjs`: Task decomposition, DAG batching, `task-plan.schema.json`, planner boundary invariants. |
| **PHASE 12** | Worktree & Workbench Sandbox | `lib/worktree.mjs` + `lib/workbench.mjs`: Multi-step DAG execution in parallel Git worktrees, conflict fail-closed detection. |
| **PHASE 13** | Host Decoupling & Clean Release | `lib/config.mjs`: Elimination of 94 hardcoded host paths, dynamic environment resolution, clean factory state reset. |

---

## Core Runtime Guarantees

1. **ROLE != PLATFORM**:
   - Platforms (`codex`, `claude`, `antigravity`, `vertex-gemini`, `cline`) are strictly execution adapters.
   - Roles (`author`, `reviewer`, `verifier`, `worker`, `planner`) are dynamic attributes assigned per Task Capsule.
   - No executor is hardcoded to any task role.
2. **Governance Single Source of Truth**:
   - All formal knowledge governance decisions derive solely from `agent-foundry-vault` via `vault-mcp`.
   - The Orchestrator never computes, fakes, or relaxes governance policy locally.
3. **Human Intent Gate Protection**:
   - Sensitive modifications (schema changes, system config, destructive deletes, plan direction shifts) require explicit human approval via `approval/intent-gate.mjs`.
4. **Capability / Availability / Runtime Safety Separation**:
   - **Capability**: Statically defined in `agent-foundry-global/executors/*.json` (e.g. MCP support, terminal support).
   - **Availability**: Dynamically tracked based on provider account standing (e.g. `ACCOUNT_DISABLED`, `UNAVAILABLE`).
   - **Runtime Safety**: Managed in-memory and persisted by `ExecutorRuntimeGuard` (concurrency slot, circuit breaker).
5. **Fail-Closed Principle**:
   - Any fatal policy violation (`ACCOUNT_POLICY`, 403 Forbidden, TOS violation) immediately trips the circuit to `OPEN_MANUAL_RESET`.
   - Under fatal errors, automatic retries are strictly 0, router fallback is strictly forbidden, and the task halts fail-closed.
6. **Parallel Worktree Isolation**:
   - Multi-step DAG tasks execute concurrent branches in isolated Git worktrees (`lib/worktree.mjs`), with automatic conflict detection failing closed safely.
7. **Cross-Platform Portability**:
   - Zero hardcoded author host paths. All paths are resolved via `lib/config.mjs` using environment variables (`AF_GLOBAL_DIR`, `AF_VAULT_MCP_SERVER`), relative discovery, and dynamic `HOME` inference.
8. **Zero Credential Persistence**:
   - The Orchestrator never writes API keys, tokens, auth headers, passwords, or raw prompts/responses to disk.

---

## File Manifest & Component Baseline

```
agent-foundry-orchestrator/
├── orchestrator.mjs                   # Main Orchestrator CLI, DAG Multi-step & Lifecycle Entry
├── af-admin.mjs                       # Operator Administration CLI
├── bin/                               # CLI Wrappers
│   ├── af-admin                       # Global CLI wrapper
│   ├── cline-af                       # Portable Cline launcher with canonical AGENTS.md injection
│   └── vertex-gemini-af               # Enterprise Vertex Gemini launcher
├── approval/                          # Human Intent Gate
│   ├── approval-schema.json           # Gate approval data schema
│   ├── intent-gate.mjs                # Intent gate evaluation engine
│   └── intent-policy.mjs              # Risk policy rules
├── intent/                            # Intent & Asset Classification
│   ├── action-validator.mjs           # Action payload validator
│   └── asset-classifier.mjs           # Sensitive asset classifier (gov, config, schema, code)
├── contracts/                         # Action Contracts
│   ├── action-contract.schema.json    # JSON Schema for agent actions
│   └── action-types.json              # Whitelist of permissible action types
├── planner/                           # Autonomous Task Planning
│   ├── planner.mjs                    # Goal decomposition & DAG batch scheduler
│   └── schema/task-plan.schema.json   # Plan schema specification
├── config/                            # Runtime Policy & Restrictions
│   ├── executor-safety-profiles.json  # Safety profiles per executor
│   └── operator-executors.json        # Operator executor dynamic override (factory clean: empty)
├── lib/                               # Core Architectural Modules
│   ├── acceptance.mjs                 # Acceptance command whitelist & sandbox execution
│   ├── adapters.mjs                   # Unified Executor Adapters (Claude, Vertex, Codex, Cline, Antigravity)
│   ├── codex-planner.mjs              # Codex-driven planner interface
│   ├── config.mjs                     # Cross-platform environment & path discovery
│   ├── executor-error-classifier.mjs  # Error taxonomy (TRANSIENT, RATE_LIMIT, ACCOUNT_POLICY)
│   ├── executor-ops.mjs               # Operator maintenance & gated recovery functions
│   ├── executor-router.mjs            # Deterministic multi-executor routing pure function
│   ├── executor-runtime-guard.mjs     # Circuit breaker state machine & slot concurrency guard
│   ├── executor-status.mjs            # Executor capability & availability status loader
│   ├── governance.mjs                 # Governance bridge & publish verdict classifier
│   ├── operator-control.mjs           # Dynamic executor restrictions & user message injection
│   ├── recovery.mjs                   # Idempotent crash recovery classifier & executor
│   ├── reviews.mjs                    # Independent code review parser & binder
│   ├── scheduler.mjs                  # Core task state machine
│   ├── store.mjs                      # POSIX atomic filesystem store
│   ├── tasklock.mjs                   # Exclusive task file lock manager
│   ├── vault-client.mjs               # MCP Vault Client wrapper
│   ├── workbench.mjs                  # Developer workbench prompt & experience control
│   └── worktree.mjs                   # Git worktree parallel execution & DAG batch merging
├── tasks/                             # Task JSON directory (factory clean: task-template.json + .gitkeep)
├── runtime/                           # Runtime state & policies (factory clean: zero logs)
├── locks/                             # Exclusive execution locks (.gitkeep)
├── tests/                             # Automated test suite (182 tests, 100% passing on a clean clone)
├── FINAL_ARCHITECTURE.md              # Authoritative architectural blueprint
├── EXECUTOR_SAFETY_MODEL.md           # Authoritative executor safety and failure model
├── AGY_INCIDENT_POSTMORTEM.md         # Postmortem and design rationale for runtime guard
├── PERSISTENCE_CHECK.md               # Persistence audit report
├── SECURITY_AUDIT.md                  # Security & credential audit report
├── EXECUTOR_STATUS_MATRIX.md          # Multi-executor capability & status matrix
├── OPERATOR_RUNBOOK.md                # Standard operating procedure manual
├── CHANGE_CONTROL.md                  # Baseline change control protocol
├── DISASTER_RECOVERY.md               # Disaster recovery runbook
└── RELEASE_MANIFEST.md                # This release manifest
```
