// rollback.mjs - restore a task workspace to a state that is known good
//
// `docs/ROADMAP.md` P7, referencing `shepherd-agents/shepherd` (MIT): execution
// should be a reversible trace, not a one-way ratchet. The gap this closes is
// real and measured: recovery.mjs can CONTINUE from a breakpoint but nothing can
// go BACK. A revision that passes review and then fails acceptance, or a later
// revision that makes the workspace worse, had no way back to the last state that
// actually passed.
//
// Design, chosen to be non-destructive to a workspace the orchestrator does not own:
//
//   - A "restore point" is a DANGLING COMMIT created with plumbing
//     (`add -A` -> `write-tree` -> `commit-tree`) plus a ref under
//     `refs/af-restore/<task>/<revision>`. HEAD and the current branch are never
//     moved, so capturing cannot disturb ongoing work.
//   - Restoring uses `git restore --source=<ref> --worktree --staged -- .`, which
//     overwrites files with the captured content WITHOUT rewriting history
//     (no `reset --hard`, no branch move).
//   - A restore first captures a SAFETY restore point of the current state, so a
//     rollback is itself reversible. That is the whole point of a reversible
//     trace: an operator must never have to choose between "keep the bad state"
//     and "lose the work".
//   - Files ADDED after the capture are reported, and only removed when `prune`
//     is asked for explicitly: deleting untracked files by default would destroy
//     legitimate new work.
//
// Capability is explicit, never silent (ROADMAP principle 5): a workspace that is
// not a git repository is refused with `NOT_A_GIT_REPO`, and `rollbackCapability`
// reports the same so a caller can say so in its evidence.
//
// @module rollback

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isGitRepo, runGit } from './worktree.mjs';

/** Ref namespace for restore points. */
export const RESTORE_REF_PREFIX = 'refs/af-restore';

/**
 * Whether this workspace can hold restore points.
 * @param {string} dir - workspace directory.
 * @returns {{available: boolean, reason: string|null}} capability.
 */
export function rollbackCapability(dir) {
  if (!dir) return { available: false, reason: 'no workspace directory' };
  try {
    return isGitRepo(dir)
      ? { available: true, reason: null }
      : { available: false, reason: `NOT_A_GIT_REPO: ${dir} is not a git repository, so no restore point can be captured` };
  } catch (err) {
    return { available: false, reason: `cannot inspect ${dir}: ${String(err?.message ?? err)}` };
  }
}

/** The ref name for one task revision. */
function refFor(taskId, revision) {
  return `${RESTORE_REF_PREFIX}/${taskId}/${revision}`;
}

/**
 * Files present in the working tree that the captured tree does not contain.
 *
 * Compared against the captured TREE rather than by reading `git status`: the
 * safety snapshot stages everything (`add -A`), so a new file stops being
 * "untracked" after the first restore and a status-based check would silently
 * stop seeing it.
 *
 * @param {string} dir - repository directory.
 * @param {string} ref - restore ref.
 * @returns {string[]} relative paths added since the capture.
 */
function additionsSince(dir, ref) {
  try {
    const captured = new Set(
      runGit(['ls-tree', '-r', '--name-only', ref], dir).split('\n').filter(Boolean),
    );
    const present = runGit(['ls-files', '--cached', '--others', '--exclude-standard'], dir)
      .split('\n')
      .filter(Boolean);
    return present.filter((path) => !captured.has(path)).sort();
  } catch {
    return [];
  }
}

/**
 * Snapshot the current working tree into a dangling commit and point a ref at it.
 *
 * The commit is created with plumbing, so HEAD, the branch and the reflog are all
 * left alone. The index IS brought in line with the working tree (`add -A`), which
 * is the one visible side effect; it is what makes the snapshot include files the
 * task created but never staged.
 *
 * @param {object} options - options.
 * @param {string} options.dir - workspace directory.
 * @param {string} options.taskId - task id (used in the ref).
 * @param {string|number} options.revision - revision label.
 * @param {string} [options.label] - human label for the evidence.
 * @param {string} [options.refSuffix] - appended to the revision in the ref name.
 * @returns {{ok: boolean, reason?: string, sha?: string, ref?: string, head?: string, label?: string, captured_at?: string, dir?: string}}
 */
export function captureRestorePoint({ dir, taskId, revision, label = '', refSuffix = '' }) {
  const capability = rollbackCapability(dir);
  if (!capability.available) return { ok: false, reason: capability.reason };

  try {
    const head = runGit(['rev-parse', 'HEAD'], dir);
    runGit(['add', '-A'], dir);
    const tree = runGit(['write-tree'], dir);
    const sha = runGit(['commit-tree', tree, '-p', head, '-m', `chore(af): restore point ${taskId} rev ${revision}${label ? ` - ${label}` : ''}`], dir);
    const ref = refFor(taskId, `${revision}${refSuffix}`);
    runGit(['update-ref', ref, sha], dir);
    return {
      ok: true,
      sha,
      ref,
      head,
      taskId,
      revision,
      label,
      captured_at: new Date().toISOString(),
      dir,
    };
  } catch (err) {
    return { ok: false, reason: `CAPTURE_FAILED: ${String(err?.message ?? err)}` };
  }
}

/**
 * List the restore points recorded for a task.
 * @param {object} options - options.
 * @param {string} options.dir - workspace directory.
 * @param {string} options.taskId - task id.
 * @returns {{ok: boolean, reason?: string, points: object[]}} restore points, newest first.
 */
export function listRestorePoints({ dir, taskId }) {
  const capability = rollbackCapability(dir);
  if (!capability.available) return { ok: false, reason: capability.reason, points: [] };
  try {
    const out = runGit(['for-each-ref', '--format=%(refname)|%(objectname)|%(creatordate:iso-strict)', `${RESTORE_REF_PREFIX}/${taskId}/`], dir);
    const points = out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, sha, created] = line.split('|');
        return { ref, sha, created_at: created, revision: ref.split('/').pop() };
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { ok: true, points };
  } catch (err) {
    return { ok: false, reason: `LIST_FAILED: ${String(err?.message ?? err)}`, points: [] };
  }
}

/**
 * Restore the workspace to a captured state.
 *
 * @param {object} options - options.
 * @param {string} options.dir - workspace directory.
 * @param {string} options.taskId - task id.
 * @param {string|number} options.revision - restore point to return to.
 * @param {boolean} [options.apply] - false reports without touching the workspace.
 * @param {boolean} [options.prune] - also delete files added since the capture.
 * @returns {object} evidence of what happened (or would happen).
 */
export function restoreToPoint({ dir, taskId, revision, apply = true, prune = false }) {
  const capability = rollbackCapability(dir);
  if (!capability.available) return { ok: false, reason: capability.reason };

  const ref = refFor(taskId, revision);
  let target;
  try {
    target = runGit(['rev-parse', '--verify', `${ref}^{commit}`], dir);
  } catch {
    return { ok: false, reason: `NO_SUCH_RESTORE_POINT: ${ref} does not exist` };
  }

  const currentHead = runGit(['rev-parse', 'HEAD'], dir);
  const additions = additionsSince(dir, ref);
  const dirty = runGit(['status', '--porcelain'], dir).split('\n').filter(Boolean);

  if (!apply) {
    return {
      ok: true,
      applied: false,
      dir,
      taskId,
      revision,
      ref,
      target,
      current_head: currentHead,
      files_changed: dirty.length,
      files_added_since_capture: additions,
      would_prune: prune ? additions : [],
    };
  }

  // A restore must itself be reversible, so the state being replaced is captured
  // first. Without this an operator would have to choose between keeping a bad
  // state and losing the work that produced it.
  const safety = captureRestorePoint({
    dir,
    taskId,
    revision: `pre-restore-${Date.now()}`,
    label: `safety point before restoring ${taskId} to ${revision}`,
  });

  try {
    // Restore ONLY the paths the capture contains, instead of the whole pathspec.
    //
    // `git restore --source=<ref> -- .` also DELETES files that exist now but not
    // in the capture, and the safety snapshot below stages everything (`add -A`),
    // which promotes new files into "tracked" and makes them deletable. Restoring
    // an explicit path list keeps everything the capture never knew about, which
    // is what the documented contract promises: additions are reported, and only
    // removed when `prune` is asked for.
    const capturedPaths = runGit(['ls-tree', '-r', '--name-only', ref], dir)
      .split('\n')
      .filter(Boolean);
    if (capturedPaths.length > 0) {
      runGit(['restore', '--source', ref, '--worktree', '--staged', '--', ...capturedPaths], dir);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `RESTORE_FAILED: ${String(err?.message ?? err)}`,
      safety_ref: safety?.ref ?? null,
    };
  }

  const pruned = [];
  if (prune) {
    for (const path of additions) {
      try {
        // A restore stages everything (`add -A` in the safety snapshot), so a file
        // added after the capture may already be index-tracked by the time prune
        // runs; `git clean` only removes UNtracked files. Try `git rm` first, then
        // fall back to `clean` for a genuinely untracked path.
        try {
          runGit(['rm', '-f', '--quiet', '--', path], dir);
        } catch {
          runGit(['clean', '-f', '--', path], dir);
        }
        // Only claim a deletion that actually happened.
        if (!existsSync(join(dir, path))) pruned.push(path);
      } catch { /* never claim a deletion that failed */ }
    }
  }

  return {
    ok: true,
    applied: true,
    dir,
    taskId,
    revision,
    ref,
    target,
    previous_head: currentHead,
    head_unchanged: runGit(['rev-parse', 'HEAD'], dir) === currentHead,
    safety_ref: safety?.ok ? safety.ref : null,
    safety_sha: safety?.ok ? safety.sha : null,
    files_changed: dirty.length,
    files_added_since_capture: additions,
    pruned,
    restored_at: new Date().toISOString(),
  };
}

/**
 * Render restore-point evidence for the operator CLI.
 * @param {object} result - capture/list/restore result.
 * @param {string} action - which operation produced it.
 * @returns {string} human-readable report.
 */
export function formatRollbackResult(result, action) {
  if (!result?.ok) return `${action}: refused - ${result?.reason ?? 'unknown reason'}`;
  if (action === 'list') {
    if (!result.points.length) return 'restore points: none recorded for this task';
    return ['restore points:', ...result.points.map((p) => `  ${p.revision}  ${String(p.sha).slice(0, 12)}  ${p.created_at}`)].join('\n');
  }
  if (action === 'capture') {
    return `restore point captured: ${result.revision} -> ${String(result.sha).slice(0, 12)} (${result.ref})\n  HEAD and the branch were left unchanged`;
  }
  if (!result.applied) {
    return `restore (DRY-RUN): would restore ${result.revision} (${String(result.target).slice(0, 12)})\n  files changed now: ${result.files_changed}\n  files added since capture: ${result.files_added_since_capture.length ? result.files_added_since_capture.join(', ') : 'none'}\n  add --confirm to execute`;
  }
  const lines = [
    `restore APPLIED: ${result.revision} (${String(result.target).slice(0, 12)})`,
    `  HEAD unchanged: ${result.head_unchanged}`,
    `  files changed: ${result.files_changed}`,
    `  safety point kept: ${result.safety_ref ?? 'none'} (the replaced state is recoverable)`,
  ];
  if (result.files_added_since_capture.length) {
    lines.push(
      result.pruned.length
        ? `  pruned ${result.pruned.length} file(s) added since the capture`
        : `  kept ${result.files_added_since_capture.length} file(s) added since the capture (pass --prune to delete)`
    );
  }
  return lines.join('\n');
}
