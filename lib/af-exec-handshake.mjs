// af-exec-handshake.mjs - option-A capability handshake and the parent-owned artifact boundary.
//
// Option A (docs/design/ADR-AF-EXEC-ISOLATION.md) separates identities: the control plane stays
// root-owned and the executor runs as `af-exec`. Two things have to be provable at runtime, and
// both are fail-closed here:
//
//   1. HANDSHAKE - a root-owned claim records the expected identity of the executor and the
//      protection of the control plane; before dispatching anything the control plane re-verifies
//      that claim against the live filesystem. A missing/unreadable/mismatched claim is a REFUSAL,
//      never a fallback to running under the control-plane identity.
//
//   2. PARENT-OWNED ARTIFACTS - the executor may only produce artifacts INSIDE its own workspace.
//      Anything the executor returns is a *candidate*; the parent validates containment (and
//      refuses control-plane paths) and performs every state write itself.
//
// Nothing here escalates privileges, creates users or changes ownership. All filesystem access is
// injected so tests never depend on the host.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathWithinRoot } from './submission.mjs';

export const ISOLATION_CLAIM_SCHEMA = 'af-exec-isolation-claim-v1';

/** Group/other write bits - a claim or control-plane surface carrying them is not protected. */
const WRITABLE_BY_OTHERS = 0o022;

/** Strict read: missing is `missing`, anything else is `unverifiable` (never "absent = fine"). */
export function readIsolationClaim({ file, deps = {} } = {}) {
  const read = deps.readFile ?? ((p) => readFileSync(p, 'utf8'));
  try {
    const claim = JSON.parse(read(file));
    return { ok: true, missing: false, claim, reason: null };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { ok: false, missing: true, claim: null, reason: `no isolation claim at ${file} - option-A isolation was never provisioned here` };
    }
    return { ok: false, missing: false, claim: null, reason: `isolation claim unreadable: ${err?.message ?? err}` };
  }
}

/**
 * Re-verify the claim against the live filesystem.
 * @returns {{ ok: boolean, checks: object[], reason: string|null }}
 */
export function verifyIsolationClaim({ claim, claimFile = null, deps = {} } = {}) {
  const stat = deps.stat ?? statSync;
  const resolveUser = deps.resolveUser ?? (() => null);
  const controlUid = deps.controlUid ?? 0;
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true ? true : (ok === 'unknown' ? 'unknown' : false), detail });
  const statOk = (path) => {
    try {
      const st = stat(path);
      return { ok: true, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
    } catch {
      return { ok: false };
    }
  };

  add('H1-schema', claim?.schema === ISOLATION_CLAIM_SCHEMA, claim?.schema === ISOLATION_CLAIM_SCHEMA ? 'claim schema matches' : `unexpected claim schema: ${claim?.schema ?? 'missing'}`);

  const exec = claim?.af_exec ?? null;
  const separated = Boolean(exec) && Number.isInteger(exec.uid) && exec.uid !== controlUid;
  add('H2-separated-identity', separated, separated
    ? `executor uid=${exec.uid} differs from the control plane uid=${controlUid}`
    : `executor identity is absent or equal to the control-plane uid (${controlUid}): no separation`);

  const resolved = exec?.user ? resolveUser(exec.user) : null;
  const userMatches = Boolean(resolved) && resolved.uid === exec.uid && (resolved.gid === exec.gid || exec.gid === undefined);
  add('H3-user-matches-claim', resolved ? userMatches : 'unknown', resolved
    ? (userMatches ? `user ${exec.user} resolves to uid=${resolved.uid}` : `user ${exec.user} resolves to uid=${resolved.uid}, claim says ${exec.uid}`)
    : `could not resolve user ${exec?.user ?? '(none)'}`);

  if (claimFile) {
    const st = statOk(claimFile);
    const protectedClaim = st.ok && st.uid === controlUid && (st.mode & WRITABLE_BY_OTHERS) === 0;
    add('H4-claim-file-protected', st.ok ? protectedClaim : 'unknown', st.ok
      ? `claim uid=${st.uid} mode=${st.mode.toString(8)}`
      : `could not inspect the claim file ${claimFile}`);
  } else {
    add('H4-claim-file-protected', 'unknown', 'no claim file path was supplied');
  }

  const workspace = claim?.workspace ?? null;
  const ws = workspace ? statOk(workspace) : { ok: false };
  const wsOwned = ws.ok && exec && ws.uid === exec.uid;
  add('H5-workspace-owned-by-executor', workspace ? (ws.ok ? wsOwned : 'unknown') : false, workspace
    ? (ws.ok ? `workspace uid=${ws.uid} (expected ${exec?.uid})` : `could not inspect workspace ${workspace}`)
    : 'the claim names no workspace');

  const surfaces = Array.isArray(claim?.control_plane_surfaces) ? claim.control_plane_surfaces : [];
  const unsafe = [];
  const uninspectable = [];
  for (const rel of surfaces) {
    const st = statOk(rel);
    if (!st.ok) { uninspectable.push(rel); continue; }
    if (st.uid !== controlUid || (st.mode & WRITABLE_BY_OTHERS) !== 0) unsafe.push(`${rel}(uid=${st.uid},mode=${st.mode.toString(8)})`);
  }
  add('H6-control-plane-protected',
    uninspectable.length > 0 ? 'unknown' : unsafe.length === 0,
    uninspectable.length > 0 ? `could not inspect: ${uninspectable.join(', ')}` : (unsafe.length === 0 ? `${surfaces.length} surface(s) root-owned and not writable by group/other` : `not protected: ${unsafe.join(', ')}`));

  const launcher = claim?.launcher ?? null;
  if (launcher) {
    const st = statOk(launcher);
    const okLauncher = isAbsolute(launcher) && st.ok && st.uid === controlUid && (st.mode & 0o7777) === 0o755;
    add('H7-launcher-root-owned', st.ok ? okLauncher : 'unknown', st.ok
      ? `launcher ${launcher} uid=${st.uid} mode=${st.mode.toString(8)} (expected root:0755)`
      : `could not inspect launcher ${launcher}`);
  } else {
    add('H7-launcher-root-owned', 'unknown', 'the claim names no privileged launcher');
  }

  const failed = checks.filter((c) => c.ok !== true);
  return {
    ok: failed.length === 0,
    checks,
    reason: failed.length === 0 ? null : `isolation handshake failed at ${failed[0].id}: ${failed[0].detail}`,
  };
}

/**
 * Build the dispatch descriptor for one executor run. A failed handshake is a REFUSAL - this
 * function never returns a descriptor that would run the executor as the control plane.
 *
 * @returns {{ ok: boolean, uid?: number, gid?: number, launcher?: string, argv?: object, reason?: string, checks?: object[] }}
 */
export function buildExecutorDispatch({ claim, claimFile = null, command, args = [], deps = {} } = {}) {
  const verify = verifyIsolationClaim({ claim, claimFile, deps });
  if (!verify.ok) {
    return { ok: false, reason: `${verify.reason}; refusing to dispatch the executor under the control-plane identity (no downgrade)`, checks: verify.checks };
  }
  if (typeof command !== 'string' || !command) {
    return { ok: false, reason: 'command is required', checks: verify.checks };
  }
  return {
    ok: true,
    uid: claim.af_exec.uid,
    gid: claim.af_exec.gid,
    launcher: claim.launcher ?? null,
    argv: { uid: claim.af_exec.uid, gid: claim.af_exec.gid, command, args: [...args] },
    checks: verify.checks,
  };
}

/**
 * The parent-owned artifact boundary: an executor-produced artifact must live inside its own
 * workspace and must never be a control-plane path. Callers write state themselves afterwards.
 *
 * @returns {{ ok: boolean, path?: string, reason?: string }}
 */
export function assertParentOwnedArtifact({ workspace, artifactPath, controlPlaneSurfaces = [] } = {}) {
  const within = pathWithinRoot(artifactPath, workspace);
  if (!within.ok) {
    return { ok: false, reason: `artifact refused: ${within.reason} (an executor may only produce artifacts inside its own workspace)` };
  }
  for (const surface of controlPlaneSurfaces) {
    const rel = pathWithinRoot(within.path, surface);
    if (rel.ok) return { ok: false, reason: `artifact refused: ${within.path} lies inside the control-plane surface ${surface}` };
  }
  return { ok: true, path: within.path };
}

/** Isolation mode. Default `off` (no behaviour change); anything unrecognised is also `off`. */
export function executorIsolationMode(env = process.env) {
  return env.AF_EXEC_ISOLATION === 'require' ? 'require' : 'off';
}

/**
 * Plan the argv for one executor run under option A.
 *
 * `off` (default) returns the argv untouched. `require` performs the handshake first and either
 * rewrites the argv to go through the privileged launcher, or REFUSES - it never returns the
 * original argv, because that would run the executor under the control-plane identity.
 *
 * @returns {{ ok: boolean, mode: 'off'|'require', argv: string[]|null, reason: string|null }}
 */
export function planRunIsolation({ argv, env = process.env, claimFile = null, deps = {} } = {}) {
  const mode = executorIsolationMode(env);
  if (mode === 'off') return { ok: true, mode, argv, reason: null };
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, mode, argv: null, reason: 'AF_EXEC_ISOLATION=require but no executor argv was supplied' };

  const file = claimFile ?? env.AF_EXEC_CLAIM_FILE ?? '/etc/af-exec/claim.json';
  const read = readIsolationClaim({ file, deps });
  if (!read.ok) return { ok: false, mode, argv: null, reason: `AF_EXEC_ISOLATION=require but ${read.reason}` };

  const dispatch = buildExecutorDispatch({ claim: read.claim, claimFile: file, command: argv[0], args: argv.slice(1), deps });
  if (!dispatch.ok) return { ok: false, mode, argv: null, reason: dispatch.reason };
  if (!dispatch.launcher) {
    return { ok: false, mode, argv: null, reason: 'AF_EXEC_ISOLATION=require but the claim names no privileged launcher; refusing to run the executor under the control-plane identity' };
  }
  return {
    ok: true,
    mode,
    argv: [dispatch.launcher, '--uid', String(dispatch.uid), '--gid', String(dispatch.gid), '--', ...argv],
    reason: null,
  };
}
