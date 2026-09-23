// af-exec-isolation.mjs - capability probe for privilege-domain separation, option A.
//
// Decision source: docs/PRIVILEGE-SEPARATION.md §5/§8 (option A = dedicated host UID `af-exec`
// with a root-owned control plane). The decision was taken in the DSH session; what is
// implementable WITHOUT root is the capability probe, the fail-closed refusal, and the
// root-only provisioning template that an administrator executes later.
//
// This module never escalates privileges and never changes ownership. It only ANSWERS whether the
// host is currently able to run executors as `af-exec`, and it fails closed: an unverifiable
// answer is `capable: false`, so callers must refuse rather than silently downgrade to running
// executors with the control-plane identity.
//
// All probes are injectable (`deps`) so tests never depend on the host.

import { existsSync, readFileSync, statSync } from 'node:fs';

export const AF_EXEC_USER = 'af-exec';
/** Directories whose ownership matters for option A (root-owned control plane). */
export const ROOT_OWNED_SURFACES = Object.freeze(['lib', 'af-admin.mjs']);

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

/** Does a local user account with this name exist? (passwd only - no NSS/network lookups.) */
function userExists(name, passwdPath = '/etc/passwd') {
  try {
    return readFileSync(passwdPath, 'utf8').split('\n').some((line) => line.split(':')[0] === name);
  } catch {
    return null; // unreadable => unverifiable, never "no"
  }
}

function runQuiet(fn) {
  try {
    return fn();
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

/**
 * Probe the host for option-A capability. Pure with respect to the host: it stats files and runs
 * only injected/passive checks; it never writes, never escalates.
 *
 * @returns {{ capable: boolean, checks: object[], reason: string|null, af_exec_user: string }}
 */
export function probeAfExecIsolation({ deps = {}, env = process.env } = {}) {
  const getUid = deps.uid ?? uid;
  const exists = deps.userExists ?? userExists;
  const stat = deps.stat ?? statSync;
  const canDispatch = deps.canDispatch ?? (() => null); // setuid/su capability: unknown by default

  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true ? true : (ok === 'unknown' ? 'unknown' : false), detail });

  const currentUid = runQuiet(() => getUid());
  const isRoot = currentUid === 0;
  add('A1-running-as-root', isRoot ? true : 'unknown', isRoot
    ? 'running as root: control-plane ownership can be asserted'
    : `uid=${currentUid === 0 ? 0 : (typeof currentUid === 'number' ? currentUid : String(currentUid))} - ownership changes cannot be made or verified here`);

  const hasUser = runQuiet(() => exists(AF_EXEC_USER));
  add('A2-af-exec-user-exists', hasUser === true ? true : (hasUser === null ? 'unknown' : false), hasUser === true
    ? `user "${AF_EXEC_USER}" exists`
    : (hasUser === null ? 'user database unreadable: cannot confirm the account exists' : `user "${AF_EXEC_USER}" does not exist (provisioning with root is required)`));

  const ownership = ROOT_OWNED_SURFACES.map((rel) => {
    const res = runQuiet(() => {
      const st = stat(rel);
      return { rel, uid: st.uid, mode: st.mode & 0o7777 };
    });
    return res;
  });
  const ownedByRoot = ownership.every((o) => !o.error && o.uid === 0);
  add('A3-control-plane-root-owned', ownership.some((o) => o.error) ? 'unknown' : ownedByRoot,
    ownership.some((o) => o.error)
      ? `could not inspect: ${ownership.filter((o) => o.error).map((o) => o.rel).join(', ')}`
      : ownership.map((o) => `${o.rel} uid=${o.uid} mode=${o.mode.toString(8)}`).join('; '));

  const dispatch = runQuiet(() => canDispatch());
  add('A4-dispatch-as-af-exec', dispatch === true ? true : (dispatch === null ? 'unknown' : false), dispatch === true
    ? 'the platform can dispatch a child as another uid'
    : (dispatch === null ? 'dispatch capability was not probed (unverifiable here)' : 'cannot dispatch as another uid'));

  const capable = checks.every((c) => c.ok === true);
  const firstUnknown = checks.find((c) => c.ok === 'unknown');
  const firstNo = checks.find((c) => c.ok === false);
  return {
    capable,
    checks,
    af_exec_user: AF_EXEC_USER,
    reason: capable
      ? null
      : `option-A isolation is not verifiable here (${(firstNo ?? firstUnknown).id}: ${(firstNo ?? firstUnknown).detail})`,
  };
}

/**
 * Fail-closed gate: refuse to run executors when option-A isolation cannot be confirmed.
 * Never returns a "downgrade" answer - callers get a refusal with reasons.
 *
 * @returns {{ ok: boolean, reason: string|null, checks: object[] }}
 */
export function assertAfExecIsolation({ deps = {}, env = process.env } = {}) {
  const probe = probeAfExecIsolation({ deps, env });
  if (probe.capable) return { ok: true, reason: null, checks: probe.checks };
  return {
    ok: false,
    reason: `${probe.reason}; refusing to run executors under the control-plane identity - this is a refusal, not a downgrade`,
    checks: probe.checks,
  };
}

/** True when the root-only provisioning template is present (shipped, never auto-run). */
export function provisioningTemplatePresent(path = 'deploy/af-exec/provision.sh') {
  return existsSync(path);
}
