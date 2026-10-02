// store.mjs - atomic task store (Control Plane truth)
// Any reader sees either the previous complete JSON or the new complete JSON.
// Same-filesystem rename; no database introduced (Phase 1.1 boundary).

import {
  renameSync, unlinkSync, linkSync, readFileSync, existsSync,
  openSync, writeSync, closeSync, fsyncSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindNewParkVersion } from './trusted-import/human-gate-park.mjs';

// A rename is only durable once the DIRECTORY entry is on stable storage; the
// file's own bytes need an fsync before the rename replaces the target.
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch { /* directory fsync is not supported everywhere (e.g. some FUSE) */ }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } }
}

export function readTaskFile(taskFile) {
  return JSON.parse(readFileSync(taskFile, 'utf8'));
}

export function taskFileExists(taskFile) {
  return existsSync(taskFile);
}

// Atomic JSON write for any runtime state file: tmp file in the SAME directory,
// then rename over the target, so a crash can never leave a half-written JSON
// behind that a reader would then have to interpret.
//
// The bytes are fsync'd before the rename and the directory after it, matching
// saveTaskAtomic. Without it, a power cut could lose the file that records open
// circuit breakers - i.e. the safety state would be LESS durable than task
// state, and a lost state file is a fail-open path.
export function writeJsonAtomic(file, obj, { fail = null, mode = 0o600, noOverwrite = false } = {}) {
  const dir = dirname(file);
  const tmp = join(dir, `.${file.split('/').pop()}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
  let fd = null;
  try {
    if (fail === 'write') throw new Error('injected write failure');
    fd = openSync(tmp, 'wx', mode);
    writeSync(fd, JSON.stringify(obj, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (fail === 'rename') throw new Error('injected rename failure');
    if (noOverwrite) {
      try { linkSync(tmp, file); }
      catch (err) { if (err?.code !== 'EEXIST') throw err; return false; }
      finally { unlinkSync(tmp); }
    } else {
      renameSync(tmp, file);
    }
    fsyncDir(dir);
    return true;
  } catch (err) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

// The SINGLE writer for task lifecycle state. Every lifecycle write must go
// through here (or orchestrator's saveTask, which delegates): the monotonic
// state_version is what the stale-recovery-plan guard compares against, so a
// state change written without advancing the version would silently defeat it.
// Only the first persist of a brand-new task uses saveTaskAtomic directly.
export function saveTaskWithVersion(tasksDir, task) {
  task.__assertOwnership?.();
  task.state_version = (task.state_version ?? 0) + 1;
  bindNewParkVersion(task,task.state_version);
  task.updated_at = new Date().toISOString();
  saveTaskAtomic(join(tasksDir, `${task.task_id}.json`), task);
  return task;
}

// Atomic write: tmp file in the SAME directory, then rename over the target.
// The file is fsync'd before the rename and the directory after it, so the
// documented "durable across a power cut" promise actually holds.
// failMode is a test hook (Phase 1.1 TEST D); production callers omit it.
export function saveTaskAtomic(taskFile, task, { fail = null } = {}) {
  return writeJsonAtomic(taskFile, task, { fail });
}
