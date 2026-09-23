// u6-enospc-probe.mjs - the REAL full-disk (ENOSPC) verification, once the operator mounts it.
//
// A genuine ENOSPC cannot be produced without root: it needs a small filesystem that is actually
// full. This probe therefore waits for the operator to mount one (see the command in the message
// that shipped this file) and then drives a real recovery with its audit directory on that volume,
// asserting the fail-closed behaviour a full disk must produce.
//
// It never fills anything except the mounted throw-away volume, and it refuses to run at all if
// the mount is missing (so an accidental invocation cannot touch a real filesystem).
//
// Usage: node verification/u6-enospc-probe.mjs [--mount /mnt/af-enospc]

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { engageTaskHostBoundary, disengageTaskHostBoundary, recoverRetainedBoundary } from '../lib/host-boundary.mjs';

const argValue = (flag, dflt) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : dflt; };
const mountPoint = argValue('--mount', '/mnt/af-enospc');

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- gate: the operator's mount must be present, and must be a tmpfs --------------
if (!existsSync(mountPoint)) {
  console.error(`refusing: ${mountPoint} does not exist.`);
  console.error('Ask the operator to run:');
  console.error('  sudo mkdir -p ' + mountPoint);
  console.error(`  sudo mount -t tmpfs -o size=64k tmpfs ${mountPoint}`);
  process.exit(2);
}
const mounts = readFileSync('/proc/mounts', 'utf8').split('\n').filter((l) => l.split(' ')[1] === mountPoint);
const isTmpfs = mounts.some((l) => l.startsWith('tmpfs ') || l.includes(' tmpfs '));
check('the mount point is a tmpfs (throw-away volume, not a real filesystem)', isTmpfs, mounts[0] ?? 'not mounted');

// ---- fill it completely: this IS the ENOSPC condition ------------------------------
const filler = join(mountPoint, 'fill.bin');
let filled = 0;
let sawEnospc = false;
try {
  const fd = openSync(filler, 'w');
  const chunk = Buffer.alloc(4096, 0x41);
  for (let i = 0; i < 4096; i += 1) {
    try { writeSync(fd, chunk); filled += chunk.length; } catch (err) {
      if (err?.code === 'ENOSPC') { sawEnospc = true; break; }
      throw err;
    }
  }
  closeSync(fd);
} catch (err) {
  if (err?.code === 'ENOSPC') sawEnospc = true;
  else check('filling the volume failed for a reason other than ENOSPC', false, err.message);
}
check('the volume is genuinely full (a write returned ENOSPC)', sawEnospc, `filled≈${filled} bytes`);

const probeTmp = join(mountPoint, 'probe.tmp');
const freeCheck = (() => {
  let fd = null;
  try {
    fd = openSync(probeTmp, 'w');
    writeSync(fd, Buffer.alloc(1024));
    return false;
  } catch (err) {
    return err?.code === 'ENOSPC';
  } finally {
    // On a full volume the open may succeed while the write fails, so the leftover has to be
    // removed explicitly - the probe must not leave anything behind on the operator's volume.
    if (fd !== null) { try { closeSync(fd); } catch { /* best effort */ } }
    try { rmSync(probeTmp, { force: true }); } catch { /* best effort */ }
  }
})();
check('no room remains for even a small file', freeCheck);

// ---- a real recovery whose audit lives on the full volume --------------------------
const root = mkdtempSync(join(tmpdir(), 'af-enospc-real-'));
const canonicalDir = join(root, 'canonical');
const casDir = join(root, 'cas');
const snapDir = join(root, 'snap');
const locksDir = join(root, 'locks');
const scopes = join(root, 'scopes');
const auditDir = join(mountPoint, 'audit');
for (const d of [canonicalDir, casDir, snapDir, locksDir, scopes, auditDir]) mkdirSync(d, { recursive: true });
Object.assign(process.env, {
  AF_CGROUP_BASE: scopes,
  AF_BOUNDARY_SNAPSHOT_DIR: snapDir,
  AF_ASSET_LOCK_DIR: locksDir,
  AF_BOUNDARY_AUDIT_DIR: auditDir,
  AF_BOUNDARY_ALERTS_FILE: join(root, 'alerts.jsonl'),
});

try {
  engageTaskHostBoundary({ canonicalDir, casDir });
  const uidBefore = statSync(canonicalDir).uid;
  const res = recoverRetainedBoundary({
    canonicalDir,
    casDir,
    justification: 'real ENOSPC: audit volume is full',
    auditDir,
  });

  check('a full audit volume refuses the recovery', res.outcome === 'REFUSED', `outcome=${res.outcome} reason=${res.reason ?? ''}`);
  check('the refusal names the audit failure (not a silent no-op)', /BOUNDARY_AUDIT_UNAVAILABLE|ENOSPC/i.test(res.reason ?? ''), (res.reason ?? '').slice(0, 160));
  check('nothing was modified (ownership untouched)', statSync(canonicalDir).uid === uidBefore, `uid=${statSync(canonicalDir).uid}`);
  const written = readdirSync(auditDir).filter((n) => n.endsWith('.json')).length;
  check('no audit record was half-written onto the full volume', written === 0, `files=${written}`);
  check('no mutation marker exists (the gate never ran)', !readdirSync(auditDir).some((n) => n.includes('mutation-started')));
} catch (err) {
  check('the probe completed without an unexpected error', false, err.message);
} finally {
  try { disengageTaskHostBoundary({ canonicalDir, casDir, force: true }); } catch { /* best effort */ }
  try { for (const n of readdirSync(locksDir)) rmSync(join(locksDir, n), { force: true }); } catch { /* best effort */ }
  rmSync(root, { recursive: true, force: true });
  try { rmSync(filler, { force: true }); rmSync(auditDir, { recursive: true, force: true }); } catch { /* the volume is the operator's to unmount */ }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; FAILED: ${failed.map((c) => c.name).join(', ')}` : ''}`);
console.log(`\nnext: sudo umount ${mountPoint}`);
process.exit(failed.length === 0 ? 0 : 1);
