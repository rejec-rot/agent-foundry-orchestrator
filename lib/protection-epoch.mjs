// protection-epoch.mjs - persisted protection epoch and expected protection metadata.
//
// Why this exists (A1a design §2/§3.7, frozen constraints H1-H3): the pre-protection snapshot
// records what the tree looked like BEFORE protection, so it cannot answer "is the protection
// currently the protection we intended?". Automatic recovery needs that answer, and it needs a
// record that survives a restart and names the batch it belongs to. This module writes and reads
// that epoch record and verifies the EXPECTED protection metadata (root-owned, directories 0555,
// files 0444) rather than comparing against the pre-protection snapshot.
//
// Fail-closed rules: an epoch that cannot be read is `unverifiable`; an entry that cannot be
// inspected makes the whole verification `unverifiable`; a mismatch is a mismatch, never a pass.

import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeJsonAtomic } from './store.mjs';
import { boundaryRecoveryAuditDir } from './host-boundary.mjs';

export const PROTECTION_EPOCH_SCHEMA = 'af-protection-epoch-v1';

/** The protection this system applies: root-owned, directories 0555, files 0444. */
export function expectedProtectionMetadata() {
  return { uid: 0, gid: 0, dir_mode: 0o555, file_mode: 0o444 };
}

/** Epoch records live beside the recovery audit trail, in their own subdirectory. */
export function protectionEpochDir(env = process.env) {
  return env.AF_PROTECTION_EPOCH_DIR || join(env.AF_BOUNDARY_AUDIT_DIR || boundaryRecoveryAuditDir(), 'epochs');
}

/**
 * Persist one protection epoch. The record is the ONLY durable statement of "what protection was
 * applied to which paths in this batch", so it carries the snapshot files it was derived from.
 *
 * @returns {{ epoch_id: string, file: string, epoch: object }}
 */
export function writeProtectionEpoch({
  canonicalDir = null,
  casDir = null,
  paths = [],
  snapshots = [],
  expected = expectedProtectionMetadata(),
  dir = null,
  at = new Date().toISOString(),
  hostUid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const epochId = `${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const epoch = {
    schema_version: PROTECTION_EPOCH_SCHEMA,
    epoch_id: epochId,
    at,
    host_uid: hostUid,
    pid: process.pid,
    canonical_dir: canonicalDir,
    cas_dir: casDir,
    paths: [...new Set(paths.filter(Boolean))],
    expected,
    snapshots: snapshots.map((snapshot) => ({ path: snapshot.path ?? null, file: snapshot.file ?? null, entries: snapshot.entries ?? null, captured: snapshot.captured ?? null })),
  };
  const target = join(dir || protectionEpochDir(), `epoch-${epochId}.json`);
  mkdirSync(dirname(target), { recursive: true });
  writeJsonAtomic(target, epoch);
  return { epoch_id: epochId, file: target, epoch };
}

/** Strict read: a definite absence is `missing`, anything else is `unverifiable`. */
export function readProtectionEpoch({ file } = {}) {
  try {
    const raw = readFileSync(file, 'utf8');
    const epoch = JSON.parse(raw);
    if (!epoch || typeof epoch !== 'object' || epoch.schema_version !== PROTECTION_EPOCH_SCHEMA) {
      return { ok: false, missing: false, epoch: null, reason: 'epoch record has an unknown schema', file };
    }
    return { ok: true, missing: false, epoch, reason: null, file };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, epoch: null, reason: 'not present', file };
    return { ok: false, missing: false, epoch: null, reason: `epoch record unreadable: ${err.message}`, file };
  }
}

/** Newest epoch that covers the given asset (read-only scan; unreadable records are reported). */
export function latestProtectionEpochFor({ canonicalDir, dir = null } = {}) {
  const root = dir || protectionEpochDir();
  let names;
  try {
    names = readdirSync(root).filter((name) => /^epoch-.*\.json$/.test(name));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, missing: true, epoch: null, file: root, reason: 'no epoch directory' };
    return { ok: false, missing: false, epoch: null, file: root, reason: `epoch directory unreadable: ${err.message}` };
  }
  // Fail closed: an unreadable record means the newest epoch cannot be established at all.
  // Returning an older record (or "missing") here would hand automatic recovery an untrustworthy
  // baseline.
  const unreadable = [];
  const readable = [];
  for (const name of names.sort().reverse()) {
    const result = readProtectionEpoch({ file: join(root, name) });
    if (!result.ok) { unreadable.push({ file: join(root, name), reason: result.reason }); continue; }
    readable.push(result);
  }
  if (unreadable.length > 0) {
    return {
      ok: false,
      missing: false,
      epoch: null,
      file: root,
      unreadable,
      reason: `${unreadable.length} epoch record(s) could not be read (${unreadable.map((entry) => entry.file.split('/').pop()).join(', ')}), so the newest epoch for this asset cannot be established`,
    };
  }
  const best = readable.find((result) => result.epoch?.paths?.includes(canonicalDir)) ?? null;
  if (best) return best;
  return { ok: true, missing: true, epoch: null, file: root, reason: 'no epoch covers this asset' };
}

/**
 * Verify the EXPECTED protection metadata for every entry of every protected path.
 *
 * @returns {{
 *   ok: boolean, checked: number, mismatches: object[], unverifiable: number,
 *   reason: string|null, expected: object
 * }}
 */
export function verifyProtectionExpectation({ epoch } = {}) {
  const expected = epoch?.expected ?? expectedProtectionMetadata();
  const paths = Array.isArray(epoch?.paths) ? epoch.paths : [];
  if (paths.length === 0) {
    return { ok: false, checked: 0, mismatches: [], unverifiable: 0, reason: 'the epoch records no protected paths', expected };
  }
  let checked = 0;
  let unverifiable = 0;
  const mismatches = [];
  const inspect = (target) => {
    let stat;
    try {
      stat = lstatSync(target);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        mismatches.push({ path: target, problem: 'missing' });
        return null;
      }
      unverifiable += 1;
      return null;
    }
    return stat;
  };
  const compare = (target, stat) => {
    const isDir = stat.isDirectory();
    const mode = stat.mode & 0o7777;
    const expectedMode = isDir ? expected.dir_mode : expected.file_mode;
    if (stat.uid !== expected.uid || stat.gid !== expected.gid || mode !== expectedMode) {
      mismatches.push({ path: target, problem: 'metadata', uid: stat.uid, gid: stat.gid, mode: mode.toString(8), expected_uid: expected.uid, expected_gid: expected.gid, expected_mode: expectedMode.toString(8) });
      return;
    }
    checked += 1;
  };
  for (const root of paths) {
    const rootStat = inspect(root);
    if (!rootStat) continue;
    compare(root, rootStat);
    if (!rootStat.isDirectory()) continue;
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        unverifiable += 1;
        return;
      }
      for (const name of entries) {
        const child = join(dir, name);
        const stat = inspect(child);
        if (!stat) continue;
        compare(child, stat);
        if (stat.isDirectory()) walk(child);
      }
    };
    walk(root);
  }
  const ok = unverifiable === 0 && mismatches.length === 0;
  return {
    ok,
    checked,
    mismatches,
    unverifiable,
    reason: ok ? null : (unverifiable > 0
      ? `${unverifiable} entr(ies) could not be inspected, so the protection cannot be confirmed`
      : `${mismatches.length} entr(ies) deviate from the expected protection metadata`),
    expected,
  };
}

/** Convenience: verify the newest epoch recorded for an asset. */
export function verifyProtectionFor({ canonicalDir, dir = null } = {}) {
  const epochResult = latestProtectionEpochFor({ canonicalDir, dir });
  if (!epochResult.ok) return { ok: false, checked: 0, mismatches: [], unverifiable: 0, reason: epochResult.reason, expected: expectedProtectionMetadata(), epoch: null };
  if (epochResult.missing) return { ok: false, checked: 0, mismatches: [], unverifiable: 0, reason: 'no protection epoch is recorded for this asset', expected: expectedProtectionMetadata(), epoch: null };
  return { ...verifyProtectionExpectation({ epoch: epochResult.epoch }), epoch: epochResult.epoch };
}

/** A directory exists (or definitely does not) - used by callers before writing an epoch. */
export function epochDirExists(dir = protectionEpochDir()) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
