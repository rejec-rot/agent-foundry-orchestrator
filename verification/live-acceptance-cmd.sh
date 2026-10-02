#!/usr/bin/env bash
# live-acceptance-cmd.sh - ONE real, end-to-end V2 task with REAL model executors.
#
# Reproduces the run that produced docs/design/SYSTEM-STATUS.md §2 "live acceptance":
#   author   = command-code (`cmd`)   reviewer = cline (independent, as V2 requires)
#   target   = a throw-away git repo under /tmp; the promotion lands in ITS refs/afr/canonical
#   result   = COMPLETED / PROMOTED in ~75s with a PASSING acceptance (node --test)
#
# Requirements on the host:
#   * `cmd` and `cline` installed and authenticated;
#   * a WRITABLE cgroup v2 subtree for AF_CGROUP_BASE (the user's own systemd delegation works,
#     no root needed) - trusted-import runs refuse without a verifiable writer scope;
#   * AF_COMMAND_CODE_YOLO=1: this CLI cannot write files in print mode without --yolo. The adapter
#     refuses the run without either that opt-in or verified external isolation (see lib/adapters.mjs).
#
# It spends real model calls. Run it deliberately.
#
#
# Author: command-code (`cmd`) - operator instruction. Reviewer: cline (must differ).
# Target: a throw-away git repository under /tmp, so the promotion lands in THAT repo's
# refs/afr/canonical and nothing in the working tree is at risk.
#
# Nothing here is a simulation: the author edits files, the reviewer reviews them, the
# acceptance command runs, and the promotion updates a real ref.

set -uo pipefail
REPO=/home/reject/DSHWorkSpace/agent-foundry-next
LIVE=/tmp/af-live-$(date +%Y%m%d-%H%M%S)
mkdir -p "$LIVE"/{target,tasks,subs,ws,events,runtime}

cd "$REPO" || exit 1

# ---------------------------------------------------------------- target repository
cd "$LIVE/target" || exit 1
git init -q -b main .
git config user.email "live@agent-foundry.local"
git config user.name "agent-foundry live"
mkdir -p src tests
cat > README.md <<'EOF'
# live acceptance target

A throw-away repository used to prove the V2 pipeline end to end with a real model.
EOF
node --version > .node-version
git add -A
git commit -qm "baseline: empty project with a README"
echo "baseline commit: $(git rev-parse HEAD)"

# ---------------------------------------------------------------- control-plane registry
cat > "$LIVE/projects.json" <<EOF
{
  "schema_version": "af-project-registry-v1",
  "projects": [
    {
      "project_id": "live-acceptance",
      "root": "$LIVE/target",
      "workspace_root": "$LIVE/ws",
      "policy": {
        "allowed_root": ["src/**", "tests/**"],
        "forbidden": [],
        "protected_paths": [],
        "projection": { "exclude": [] },
        "import": { "deny": [] }
      },
      "acceptance_profiles": [
        {
          "profile_id": "live-tests",
          "acceptance": { "command": "node", "args": ["--test", "tests/live.test.mjs"] },
          "assets": []
        }
      ]
    }
  ]
}
EOF

# ---------------------------------------------------------------- submission spec
cat > "$LIVE/spec.json" <<EOF
{
  "goal": "Create src/slugify.mjs exporting a function slugify(text) that lowercases the text, replaces every run of characters that are not a-z or 0-9 with a single hyphen, and trims leading and trailing hyphens. Also create tests/live.test.mjs using node:test and node:assert/strict with exactly three tests that import slugify from ../src/slugify.mjs and check: 'Hello World' becomes 'hello-world'; '  Mixed_CASE --x  ' becomes 'mixed-case-x'; and an empty string stays ''. Both files must be created exactly at those paths.",
  "target_path": "$LIVE/target",
  "acceptance": { "command": "node", "args": ["--test", "tests/live.test.mjs"] },
  "proposed_required": ["src/**", "tests/**"],
  "idempotency_key": "live-acceptance-4"
}
EOF

cd "$REPO" || exit 1
export AF_ACCEPTANCE_ALLOWLIST="$REPO/config/acceptance-allowlist.json"
export AF_EXECUTORS_DIR="$REPO/fixtures/agent-foundry-global/executors"
export AF_PROJECTS_FILE="$LIVE/projects.json"
export AF_V2_WORKSPACE_ROOT="$LIVE/ws"
export AF_V2_EVENTS_DIR="$LIVE/events"
export AF_TASKS_DIR="$LIVE/tasks"
export AF_RUNTIME_DIR="$LIVE/runtime"
export AF_V2_AUTHOR_EXECUTOR=command-code
export AF_V2_REVIEWER_EXECUTOR=cline
# No root needed: the user's own systemd cgroup subtree is delegated, so the writer scope
# (required for trusted-import runs) can be created there. Verified before use.
export AF_CGROUP_BASE="${AF_CGROUP_BASE:-/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service}"
# OPERATOR AUTHORISATION, recorded here on purpose: this CLI cannot write files in print mode
# without --yolo, and no verified external isolation exists on this host. The instruction to use
# `cmd` as the executor is what authorises it; the adapter refuses without this switch.
export AF_COMMAND_CODE_YOLO=1

echo "================================================================"
echo "STEP 1/3  create the task through the system's own submission path"
echo "================================================================"
node af-admin.mjs v2 create --spec "$LIVE/spec.json" --root "$LIVE/target" --tasks-dir "$LIVE/tasks" --submissions-dir "$LIVE/subs" --json | tee "$LIVE/create.json"
TASK=$(node -e "const j=require('$LIVE/create.json'); console.log(j.task_id ?? '')")
echo "TASK_ID=$TASK"
echo "$TASK" > "$LIVE/task_id"
[ -n "$TASK" ] || { echo "FATAL: no task id"; exit 1; }

echo "================================================================"
echo "STEP 2/3  start it: real cmd author + real cline reviewer"
echo "================================================================"
echo "started_at=$(date -Is)"
node af-admin.mjs v2 start --task "$TASK" --tasks-dir "$LIVE/tasks" --locks-dir "$LIVE/runtime/locks" || echo "start returned non-zero"
echo "finished_at=$(date -Is)"

echo "================================================================"
echo "STEP 3/3  what the system recorded"
echo "================================================================"
node -e "
const fs=require('fs');
const t=JSON.parse(fs.readFileSync('$LIVE/tasks/$TASK.json','utf8'));
console.log(JSON.stringify({
  task_id:t.task_id, state:t.state, phase:t.trusted_import?.phase,
  author:t.author_executor, reviewer:t.reviewer_executor,
  revisions_used:t.trusted_import?.revisions_used ?? 0,
  author_completed:t.trusted_import?.author_completed ?? false,
  review_completed:t.trusted_import?.review_completed ?? false,
  promoted: Boolean(t.trusted_import?.promotion),
  failure_reason:t.failure_reason ?? null,
  last_error:t.trusted_import?.last_error ?? null,
  promotion:t.trusted_import?.promotion ?? null,
}, null, 2));
"
echo "--- canonical ref in the target repo ---"
cd "$LIVE/target" && git log --oneline -3 refs/afr/canonical 2>&1 && git diff --stat refs/afr/canonical 2>&1 | tail -3
echo "--- files the author produced (in the promoted tree) ---"
git ls-tree -r --name-only refs/afr/canonical 2>&1 | head -20
echo "--- the promoted src/slugify.mjs ---"
git show refs/afr/canonical:src/slugify.mjs 2>&1 | head -12
echo "--- the promoted tests/live.test.mjs (head) ---"
git show refs/afr/canonical:tests/live.test.mjs 2>&1 | head -8
echo "--- event timeline ---"
node -e "
const fs=require('fs');
const p='$LIVE/events/$TASK.jsonl';
try { for (const line of fs.readFileSync(p,'utf8').trim().split('\n')) { const e=JSON.parse(line); console.log(e.at, e.type, e.phase ?? ''); } } catch (e) { console.log('(no events:', e.message, ')'); }
"
echo "LIVE_DIR=$LIVE"
