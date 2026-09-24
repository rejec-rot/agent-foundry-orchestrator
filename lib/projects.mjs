// projects.mjs - the project registry and trusted acceptance-profile identity (§6 G6).
//
// The registry is CONTROL-PLANE data: it is read from a configured file, never from the submitter,
// and it is the only place a project's root, acceptance profile or workspace assignment comes from.
// Every failure mode is a refusal, matching the discipline already used for the acceptance
// allowlist: a missing file is "not configured", a damaged file is "refuse", never "allow anything"
// and never "allow nothing".
//
// Provenance matters here: the resolved identity records WHICH registry file and digest produced it,
// so a digest copied out of a test fixture is visibly not a production profile.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { stableStringify } from './submission.mjs';

export const PROJECT_REGISTRY_SCHEMA = 'af-project-registry-v1';
export const ACCEPTANCE_PROFILE_SCHEMA = 'af-acceptance-profile-v1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function projectRegistryFile(env = process.env, cwd = process.cwd()) {
  return env.AF_PROJECTS_FILE || join(cwd, 'config', 'projects.json');
}

function isContained(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Strict read of the registry.
 * @returns {{ ok: boolean, configured: boolean, registry: object|null, file: string, digest: string|null, reason: string|null }}
 */
export function loadProjectRegistry({ file = projectRegistryFile() } = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, configured: false, registry: null, file, digest: null, reason: `no project registry at ${file}` };
    return { ok: false, configured: true, registry: null, file, digest: null, reason: `the project registry is unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, configured: true, registry: null, file, digest: null, reason: `the project registry is not valid JSON: ${err.message}` };
  }
  const problems = validateRegistry(parsed);
  if (problems.length > 0) return { ok: false, configured: true, registry: null, file, digest: null, reason: `the project registry is invalid: ${problems.join('; ')}` };
  return { ok: true, configured: true, registry: parsed, file, digest: sha256(stableStringify({ projects: parsed.projects })), reason: null };
}

/** Validate every field the rest of the system will trust. Returns a list of problems. */
export function validateRegistry(parsed) {
  const problems = [];
  if (!parsed || typeof parsed !== 'object') return ['the registry is not an object'];
  if (parsed.schema_version && parsed.schema_version !== PROJECT_REGISTRY_SCHEMA) problems.push(`unexpected schema_version ${parsed.schema_version}`);
  if (!Array.isArray(parsed.projects) || parsed.projects.length === 0) problems.push('"projects" must be a non-empty array');
  const seen = new Set();
  for (const [i, project] of (Array.isArray(parsed.projects) ? parsed.projects : []).entries()) {
    const where = `projects[${i}]`;
    if (!project || typeof project !== 'object') { problems.push(`${where} is not an object`); continue; }
    if (typeof project.project_id !== 'string' || project.project_id.trim() === '') problems.push(`${where}.project_id must be a non-empty string`);
    else if (seen.has(project.project_id)) problems.push(`${where}.project_id is a duplicate: ${project.project_id}`);
    else seen.add(project.project_id);
    if (typeof project.root !== 'string' || !isAbsolute(project.root)) problems.push(`${where}.root must be an absolute path`);
    for (const [j, profile] of (Array.isArray(project.acceptance_profiles) ? project.acceptance_profiles : []).entries()) {
      const at = `${where}.acceptance_profiles[${j}]`;
      if (typeof profile?.profile_id !== 'string' || profile.profile_id.trim() === '') problems.push(`${at}.profile_id must be a non-empty string`);
      if (typeof profile?.acceptance?.command !== 'string' || profile.acceptance.command.trim() === '') problems.push(`${at}.acceptance.command must be a non-empty string`);
      if (profile?.acceptance?.args !== undefined && !Array.isArray(profile.acceptance.args)) problems.push(`${at}.acceptance.args must be an array of strings when present`);
      for (const [k, asset] of (Array.isArray(profile?.assets) ? profile.assets : []).entries()) {
        const atAsset = `${at}.assets[${k}]`;
        if (typeof asset?.asset_id !== 'string' || asset.asset_id.trim() === '') problems.push(`${atAsset}.asset_id must be a non-empty string`);
        if (typeof asset?.digest !== 'string' || !/^[0-9a-f]{64}$/.test(asset.digest)) problems.push(`${atAsset}.digest must be a sha256 hex digest`);
      }
    }
  }
  return problems;
}

/** Find a project by id, or by target root (realpath, so symlinks cannot smuggle a different tree). */
export function resolveProject({ registry, projectId = null, targetRoot = null } = {}) {
  if (!registry?.projects) return { ok: false, reason: 'no registry is loaded' };
  if (projectId) {
    const found = registry.projects.find((p) => p.project_id === projectId) ?? null;
    return found ? { ok: true, project: found } : { ok: false, reason: `no such project: ${projectId}` };
  }
  if (!targetRoot) return { ok: false, reason: 'a project id or a target root is required' };
  let real;
  try { real = realpathSync(targetRoot); } catch (err) { return { ok: false, reason: `the target root cannot be resolved: ${err.message}` }; }
  const matches = registry.projects.filter((p) => {
    let rootReal;
    try { rootReal = realpathSync(p.root); } catch { return false; }
    return rootReal === real;
  });
  if (matches.length === 0) return { ok: false, reason: `no project is registered for ${real}` };
  if (matches.length > 1) return { ok: false, reason: `${matches.length} projects claim ${real}; refusing to guess` };
  return { ok: true, project: matches[0] };
}

/**
 * Resolve a trusted acceptance profile for a project.
 *
 * The command is re-checked against the existing acceptance allowlist, and the returned identity
 * carries the profile digest, the allowlist digest, the registry digest and the registry FILE - so
 * the provenance of "this is the real production profile" is inspectable rather than assumed.
 */
export function resolveAcceptanceProfile({ registry, registryFile = null, registryDigest = null, projectId, profileId, allowlist, acceptanceCommandAllowed }) {
  const project = resolveProject({ registry, projectId });
  if (!project.ok) return { ok: false, reason: project.reason };
  const profiles = Array.isArray(project.project.acceptance_profiles) ? project.project.acceptance_profiles : [];
  if (profiles.length === 0) return { ok: false, reason: `project ${projectId} has no acceptance profiles` };
  const profile = profileId ? profiles.find((p) => p.profile_id === profileId) : (profiles.length === 1 ? profiles[0] : null);
  if (!profile) return { ok: false, reason: profileId ? `no such acceptance profile: ${profileId}` : `project ${projectId} has ${profiles.length} profiles; an explicit profile is required` };

  if (typeof acceptanceCommandAllowed === 'function') {
    const allowed = acceptanceCommandAllowed({ command: profile.acceptance.command, args: profile.acceptance.args ?? [] }, allowlist);
    if (!allowed.ok) return { ok: false, reason: `profile ${profile.profile_id}: ${allowed.reason}` };
  }

  const identity = {
    schema_version: ACCEPTANCE_PROFILE_SCHEMA,
    project_id: project.project.project_id,
    profile_id: profile.profile_id,
    root: project.project.root,
    acceptance: { command: profile.acceptance.command, args: profile.acceptance.args ?? [] },
    assets: (profile.assets ?? []).map((a) => ({ asset_id: a.asset_id, digest: a.digest })),
  };
  return {
    ok: true,
    identity,
    profile_digest: sha256(stableStringify(identity)),
    assets_digest: sha256(stableStringify(identity.assets)),
    provenance: {
      registry_file: registryFile,
      registry_digest: registryDigest,
      allowlist_digest: allowlist?.ok === true ? sha256(stableStringify(allowlist.allowed)) : null,
      allowlist_file: allowlist?.file ?? null,
      resolved_at: new Date().toISOString(),
    },
  };
}

/** Per-task workspace assignment inside a project, kept out of the project's own tree. */
export function assignProjectDirs({ project, taskId, workspaceRoot = null }) {
  if (!project?.root) return { ok: false, reason: 'a resolved project is required' };
  if (typeof taskId !== 'string' || taskId.trim() === '') return { ok: false, reason: 'taskId is required' };
  const base = workspaceRoot ?? project.workspace_root;
  if (typeof base !== 'string' || !isAbsolute(base)) return { ok: false, reason: 'the project has no workspace_root and none was supplied' };
  const candidateDir = join(base, taskId, 'candidate');
  const casDir = join(base, taskId, 'cas');
  if (isContained(project.root, candidateDir) || isContained(candidateDir, project.root)) return { ok: false, reason: 'the assigned candidate directory overlaps the project root' };
  if (isContained(project.root, casDir) || isContained(casDir, project.root)) return { ok: false, reason: 'the assigned CAS directory overlaps the project root' };
  return { ok: true, candidate_dir: candidateDir, cas_dir: casDir };
}

/** Diagnostics for the operator: what the registry resolves to right now. */
export function describeRegistry({ registry, file, digest }) {
  if (!registry) return { ok: false, file, reason: 'no registry is loaded' };
  return {
    ok: true,
    file,
    digest,
    registered: existsSync(file),
    projects: registry.projects.map((p) => ({
      project_id: p.project_id,
      root: p.root,
      profiles: (p.acceptance_profiles ?? []).map((profile) => profile.profile_id),
    })),
  };
}
