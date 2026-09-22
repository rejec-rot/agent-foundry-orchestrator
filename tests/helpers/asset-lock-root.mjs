// asset-lock-root.mjs - keep the suite's asset locks out of the repository runtime.
//
// The asset lock protocol creates its lock directory on first acquisition (mkdirSync inside
// withAssetLockSet). A test that engages, disengages or recovers a boundary therefore used to
// create `runtime/asset-locks/` in the checkout. Import this FIRST (before any module that takes a
// lock) so the suite locks into a private temp directory instead: same rule as 34d359b for the
// alert log and the hermetic root for the scheduler state.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ASSET_LOCK_ROOT = mkdtempSync(join(tmpdir(), 'af-test-asset-locks-'));
process.env.AF_ASSET_LOCK_DIR = ASSET_LOCK_ROOT;

process.on('exit', () => {
  try { rmSync(ASSET_LOCK_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});
