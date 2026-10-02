// Physical projections and immutable artifacts; no executor-facing git worktrees.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrustedCAS } from '../trusted-import/cas.mjs';
import { sealSnapshot } from '../trusted-import/snapshot.mjs';
import { computeManifest } from '../trusted-import/manifest.mjs';
import { projectCandidate, matchPathPattern } from '../trusted-import/projection.mjs';
import { captureCandidateFS } from '../trusted-import/capture.mjs';
import { verifyQuiesced } from '../trusted-import/quiesce.mjs';
import { materializeSnapshotForAcceptance, terminationEvidenceConfirmed } from '../trusted-import/orchestrator-adapter.mjs';
import { adoptRepository, getCanonicalOid } from '../trusted-import/adopt.mjs';
import { teamDir } from './store.mjs';
import { teamError } from './model.mjs';

export const casFor = (runtimeDir, teamId) => new TrustedCAS({ casDir: join(teamDir(runtimeDir,teamId), 'artifacts') });
export function initializeBaseline(runtimeDir, team, task) {
  const canonicalOid = getCanonicalOid(task.fixture_dir) ?? adoptRepository({ repoDir: task.fixture_dir }).canonical_oid;
  const dir = join(teamDir(runtimeDir,team.team_id), 'baseline');
  return { oid: canonicalOid, snapshot: projectCandidate({ repoDir: task.fixture_dir, canonicalOid, targetDir: dir,
    policy: task.trusted_import.policy?.projection ?? {}, cas: casFor(runtimeDir,team.team_id) }).projectedBaselineSnapshot };
}
export function mergeArtifacts(team, artifacts, { strict = false } = {}) {
  const entries = new Map(team.baseline.snapshot.entries.map(e => [e.path, {...e}]));
  const conflicts = [];
  for (const artifact of artifacts) for (const change of artifact.manifest.changes) {
    const current = entries.get(change.path);
    const oldMatches = (current?.blob_digest ?? null) === (change.old_digest ?? null) && (!change.old_mode || current?.mode === change.old_mode);
    const nextDigest = change.new_digest ?? change.digest ?? null;
    const alreadyApplied = (current?.blob_digest ?? null) === nextDigest && (!change.new_mode || current?.mode === change.new_mode);
    if (!oldMatches && !alreadyApplied) { conflicts.push({ path: change.path, artifact_id: artifact.artifact_id, current_digest: current?.blob_digest ?? null, change }); continue; }
    if (change.action === 'DELETE') entries.delete(change.path);
    else entries.set(change.path, { path: change.path, type: 'blob', mode: change.new_mode ?? current?.mode ?? '0644', blob_digest: nextDigest, size: change.size });
  }
  if (strict && conflicts.length) throw teamError(`input artifacts conflict: ${conflicts.map(c=>c.path).join(', ')}`, 'TEAM_INPUT_CONFLICT');
  return { snapshot: sealSnapshot({ entries: [...entries.values()], metadata: { team_id: team.team_id, goal_revision: team.goal_revision } }), conflicts };
}
export function inputArtifacts(team, item) {
  const needed = new Set();
  const visit = id => { if (needed.has(id)) return; const dep = team.work_items.find(i=>i.work_item_id===id); if (!dep || dep.status !== 'DONE') throw teamError('dependency not complete'); for (const d of dep.depends_on) visit(d); needed.add(id); };
  for (const id of item.depends_on) visit(id);
  return [...needed].map(id => team.artifacts.find(a=>a.artifact_id===team.work_items.find(i=>i.work_item_id===id).artifact_id));
}
export function prepareWorkspace(runtimeDir, team, runId, input, conflicts = []) {
  const cwd = join(teamDir(runtimeDir,team.team_id), 'workspaces', runId);
  mkdirSync(cwd, { recursive: true });
  const cas = casFor(runtimeDir,team.team_id);
  materializeSnapshotForAcceptance({ stagingDir: cwd, snapshot: input, cas });
  mkdirSync(join(cwd, '.af-scratch'), { recursive: true });
  for (let i=0;i<conflicts.length;i++) {
    const change = conflicts[i].change;
    const digest = change.new_digest ?? change.digest;
    if (digest) writeFileSync(join(cwd,'.af-scratch',`conflict-${i}`),cas.get(digest));
  }
  return cwd;
}
export async function captureArtifact(runtimeDir, team, run, result, item) {
  if (!terminationEvidenceConfirmed(result.writer_termination)) throw teamError('writer scope termination unconfirmed', 'TEAM_WRITER_UNCONFIRMED');
  const cas = casFor(runtimeDir,team.team_id);
  const evidence = await verifyQuiesced({ terminationVerifier: async () => terminationEvidenceConfirmed(result.writer_termination) });
  const capture = captureCandidateFS({ candidateDir: run.workspace_dir, scratchDir: join(run.workspace_dir,'.af-scratch'), cas, quiesceEvidence: evidence });
  const snapshot = sealSnapshot({ entries: capture.entries, metadata: { run_id: run.run_id, team_id: team.team_id } });
  const manifest = computeManifest({ projectedBaselineSnapshot: run.input_snapshot, candidateSnapshot: snapshot });
  if (item && manifest.changes.some(c => !item.allowed_paths.some(p => p === '.' || matchPathPattern(p,c.path)))) throw teamError('worker modified paths outside its work item scope', 'TEAM_PATH_SCOPE');
  return { artifact_id: `ART-${run.run_id}`, run_id: run.run_id, work_item_id: run.work_item_id,
    revision: run.work_item_revision, goal_revision: run.goal_revision, snapshot, manifest,
    writer_termination: result.writer_termination, summary: String(result.summary ?? '').slice(0,4000) };
}
