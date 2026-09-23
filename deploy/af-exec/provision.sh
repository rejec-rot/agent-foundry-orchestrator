#!/bin/sh
# provision.sh - root-only provisioning for privilege-domain separation, option A (af-exec UID).
#
# Decision source: docs/PRIVILEGE-SEPARATION.md (§5 option A, §8) and
# docs/design/ADR-AF-EXEC-ISOLATION.md. This script is a TEMPLATE for an administrator: it is NOT
# executed by the agent, never escalates privileges itself, and changes nothing unless the operator
# explicitly passes --apply.
#
# Guarantees:
#   * refuses to run unless uid 0 (exit 3) - a non-root invocation is a safe no-op;
#   * DRY-RUN BY DEFAULT: without --apply it only prints the exact actions it would take;
#   * idempotent: every action is guarded by a check, re-running is safe;
#   * prints a rollback block, and never touches credentials or existing users' homes.
#
# Usage:
#   sudo sh deploy/af-exec/provision.sh                 # dry-run (prints the plan)
#   sudo sh deploy/af-exec/provision.sh --apply         # perform it
#   sudo sh deploy/af-exec/provision.sh --apply --workspace /srv/af-workspace
set -eu

AF_EXEC_USER="${AF_EXEC_USER:-af-exec}"
WORKSPACE="${AF_WORKSPACE:-/srv/af-workspace}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --workspace) shift; WORKSPACE="${1:-$WORKSPACE}" ;;
    --workspace=*) WORKSPACE="${arg#--workspace=}" ;;
    *) ;;
  esac
done

say() { printf '%s\n' "$*"; }
plan() { printf '  [%s] %s\n' "$([ "$APPLY" -eq 1 ] && echo apply || echo dry-run)" "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  say "refusing: option-A provisioning requires root (uid 0). Current uid=$(id -u)." >&2
  say "Nothing was changed. Ask an administrator to run this with sudo." >&2
  exit 3
fi

say "af-exec provisioning plan (apply=$APPLY)"
say "  user      : $AF_EXEC_USER"
say "  workspace : $WORKSPACE"
say "  repo root : $REPO_ROOT"

# 1. dedicated executor account (no login shell, no home of its own beyond the workspace)
if id "$AF_EXEC_USER" >/dev/null 2>&1; then
  plan "user $AF_EXEC_USER already exists - skip useradd"
else
  plan "useradd --system --create-home --home-dir $WORKSPACE --shell /usr/sbin/nologin $AF_EXEC_USER"
  [ "$APPLY" -eq 1 ] && useradd --system --create-home --home-dir "$WORKSPACE" --shell /usr/sbin/nologin "$AF_EXEC_USER"
fi

# 2. control plane stays root-owned and unwritable by the executor identity
for surface in lib af-admin.mjs orchestrator.mjs; do
  [ -e "$REPO_ROOT/$surface" ] || continue
  plan "chown -R root:root $REPO_ROOT/$surface"
  plan "chmod -R go-w $REPO_ROOT/$surface"
  if [ "$APPLY" -eq 1 ]; then chown -R root:root "$REPO_ROOT/$surface"; chmod -R go-w "$REPO_ROOT/$surface"; fi
done

# 3. workspace owned by the executor identity
plan "install -d -o $AF_EXEC_USER -g $AF_EXEC_USER -m 0750 $WORKSPACE"
[ "$APPLY" -eq 1 ] && install -d -o "$AF_EXEC_USER" -g "$AF_EXEC_USER" -m 0750 "$WORKSPACE"

# 4. privileged launcher: the ONLY identity drop, root-owned and not writable by group/other
LAUNCHER=/usr/local/sbin/af-exec-run
plan "install -o root -g root -m 0755 $REPO_ROOT/deploy/af-exec/af-exec-run.sh $LAUNCHER"
[ "$APPLY" -eq 1 ] && install -o root -g root -m 0755 "$REPO_ROOT/deploy/af-exec/af-exec-run.sh" "$LAUNCHER"

# 5. root-owned isolation claim: the runtime handshake re-verifies it against the live filesystem
CLAIM_DIR=/etc/af-exec
CLAIM_FILE="$CLAIM_DIR/claim.json"
EXEC_UID="$(id -u "$AF_EXEC_USER" 2>/dev/null || echo 0)"
EXEC_GID="$(id -g "$AF_EXEC_USER" 2>/dev/null || echo 0)"
plan "install -d -o root -g root -m 0755 $CLAIM_DIR"
plan "write $CLAIM_FILE (root:0600) recording af-exec uid=$EXEC_UID gid=$EXEC_GID, workspace=$WORKSPACE, launcher=$LAUNCHER"
if [ "$APPLY" -eq 1 ]; then
  install -d -o root -g root -m 0755 "$CLAIM_DIR"
  umask 077
  cat > "$CLAIM_FILE" <<CLAIM
{
  "schema": "af-exec-isolation-claim-v1",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "af_exec": { "user": "$AF_EXEC_USER", "uid": $EXEC_UID, "gid": $EXEC_GID },
  "workspace": "$WORKSPACE",
  "launcher": "$LAUNCHER",
  "control_plane_surfaces": ["$REPO_ROOT/lib", "$REPO_ROOT/af-admin.mjs", "$REPO_ROOT/orchestrator.mjs"]
}
CLAIM
  chown root:root "$CLAIM_FILE"
  chmod 0600 "$CLAIM_FILE"
fi

say ""
say "rollback (run as root):"
say "  rm -f /etc/af-exec/claim.json /usr/local/sbin/af-exec-run   # remove the handshake + launcher"
say "  userdel -r $AF_EXEC_USER          # only if the account is no longer wanted"
say "  chown -R <previous owner> $REPO_ROOT/lib $REPO_ROOT/af-admin.mjs   # restore ownership"
say "  rm -rf $WORKSPACE                 # only if it holds no evidence"
say ""
if [ "$APPLY" -eq 1 ]; then
  say "applied. Next: re-run the capability probe and record the result before enabling executors."
else
  say "dry-run only: nothing was changed. Re-run with --apply to perform it."
fi
