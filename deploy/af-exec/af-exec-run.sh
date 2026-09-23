#!/bin/sh
# af-exec-run - privileged launcher template for option A (installed by provision.sh, root:0755).
#
# The control plane stays root-owned; this helper is the ONLY thing that drops to the executor
# identity. It refuses to run unless it is executed as root, and it refuses uid 0 as the target -
# a request to "run as root" is a misconfiguration, not a downgrade path.
#
# Installed at /usr/local/sbin/af-exec-run by deploy/af-exec/provision.sh --apply.
# Usage (from the control plane):  af-exec-run --uid <uid> --gid <gid> -- <command> [args...]
set -eu

UID_TARGET=""
GID_TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --uid) UID_TARGET="${2:-}"; shift 2 ;;
    --gid) GID_TARGET="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "af-exec-run: must be executed by root (the privileged launcher is the only identity drop)" >&2
  exit 3
fi
if [ -z "$UID_TARGET" ] || [ "$UID_TARGET" -eq 0 ] 2>/dev/null; then
  echo "af-exec-run: refusing to run with uid '${UID_TARGET:-<unset>}'; the executor identity must not be root" >&2
  exit 4
fi
if [ -z "$GID_TARGET" ]; then
  echo "af-exec-run: --gid is required" >&2
  exit 2
fi
if [ $# -eq 0 ]; then
  echo "af-exec-run: no command given" >&2
  exit 2
fi

exec setpriv --reuid="$UID_TARGET" --regid="$GID_TARGET" --clear-groups -- "$@"
