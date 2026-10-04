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
import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { stableStringify } from './json-identity.mjs';
import { writeJsonAtomic } from './store.mjs';

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

/** Resolve the single operator-configured root that the browser may enumerate. */
export function resolveProjectBrowseRoot(env = process.env) {
  const configured = env.AF_PROJECT_BROWSE_ROOT;
  if (typeof configured !== 'string' || !configured.trim()) {
    return { ok: false, configured: false, reason: 'project directory browsing is disabled; configure AF_PROJECT_BROWSE_ROOT' };
  }
  if (!isAbsolute(configured) || configured.includes('\0')) {
    return { ok: false, configured: true, reason: 'AF_PROJECT_BROWSE_ROOT must be an absolute directory path' };
  }
  try {
    const root = realpathSync(configured);
    if (!statSync(root).isDirectory()) return { ok: false, configured: true, reason: 'AF_PROJECT_BROWSE_ROOT is not a directory' };
    return { ok: true, configured: true, root };
  } catch (err) {
    return { ok: false, configured: true, reason: `AF_PROJECT_BROWSE_ROOT cannot be resolved: ${err.message}` };
  }
}

/**
 * List immediate directories below one explicit browsing root. The returned paths are canonical
 * realpaths so a caller cannot use a symlink entry to leave the configured root.
 */
export function browseProjectDirectories({ browseRoot, path: requestedPath = null, maxEntries = 500, registry = null } = {}) {
  if (typeof browseRoot !== 'string' || !isAbsolute(browseRoot) || browseRoot.includes('\0')) {
    return { ok: false, status: 403, reason: 'a configured absolute project browse root is required' };
  }
  let root;
  try {
    root = realpathSync(browseRoot);
    if (!statSync(root).isDirectory()) return { ok: false, status: 403, reason: 'the configured project browse root is not a directory' };
  } catch (err) {
    return { ok: false, status: 403, reason: `the configured project browse root cannot be resolved: ${err.message}` };
  }

  let current = root;
  if (requestedPath !== null) {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath) || requestedPath.includes('\0')) {
      return { ok: false, status: 400, reason: 'path must be an absolute directory path' };
    }
    try { current = realpathSync(requestedPath); }
    catch (err) { return { ok: false, status: 404, reason: `the requested directory cannot be resolved: ${err.message}` }; }
    if (!isContained(root, current)) return { ok: false, status: 403, reason: 'the requested directory is outside AF_PROJECT_BROWSE_ROOT' };
  }

  let stat;
  try { stat = statSync(current); }
  catch (err) { return { ok: false, status: 404, reason: `the requested directory cannot be read: ${err.message}` }; }
  if (!stat.isDirectory()) return { ok: false, status: 422, reason: 'the requested path is not a directory' };

  let names;
  try { names = readdirSync(current, { withFileTypes: true }); }
  catch (err) { return { ok: false, status: 403, reason: `the requested directory cannot be listed: ${err.message}` }; }
  const entries = [];
  let truncated = false;
  for (const item of names) {
    const candidate = join(current, item.name);
    try {
      const real = realpathSync(candidate);
      if (!isContained(root, real) || !statSync(real).isDirectory()) continue;
      if (entries.length >= maxEntries) { truncated = true; break; }
      const claimedBy = registeredProjectIdsAt(real, registry);
      entries.push({ name: item.name, path: real, project_id: claimedBy.length === 1 ? claimedBy[0] : null,
        ...(claimedBy.length > 1 ? { registered_project_ids: claimedBy } : {}) });
    } catch { /* inaccessible and dangling entries are not browseable */ }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    schema: 'af-v2-project-directories-v1',
    browse_root: root,
    current_path: current,
    parent_path: current === root ? null : dirname(current),
    current_project_id: (() => {
      const claimedBy = registeredProjectIdsAt(current, registry);
      return claimedBy.length === 1 ? claimedBy[0] : null;
    })(),
    ...(registeredProjectIdsAt(current, registry).length > 1
      ? { current_registered_project_ids: registeredProjectIdsAt(current, registry) } : {}),
    entries,
    truncated,
  };
}

/**
 * Add a canonical project by explicitly choosing an existing trusted acceptance profile.
 * The lock serializes API writers, while the caller's registry digest prevents stale UI state from
 * overwriting edits made since the project list was loaded.
 */
export function registerProjectFromProfile({
  file,
  expectedRegistryDigest,
  browseRoot,
  root: requestedRoot,
  projectId,
  templateProjectId,
  templateProfileId,
  workspaceRoot,
  allowlist,
  acceptanceCommandAllowed,
} = {}) {
  if (typeof expectedRegistryDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRegistryDigest)) {
    return { ok: false, status: 422, reason: 'expected_registry_digest must be the current project registry digest' };
  }
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectId)) {
    return { ok: false, status: 422, reason: 'project_id must start with a letter or number and contain at most 64 letters, numbers, dots, underscores or hyphens' };
  }
  if (typeof templateProjectId !== 'string' || !templateProjectId.trim()
    || typeof templateProfileId !== 'string' || !templateProfileId.trim()) {
    return { ok: false, status: 422, reason: 'template_project_id and template_profile_id are required' };
  }
  if (typeof browseRoot !== 'string' || !isAbsolute(browseRoot) || browseRoot.includes('\0')) {
    return { ok: false, status: 403, reason: 'project registration requires AF_PROJECT_BROWSE_ROOT' };
  }
  if (typeof requestedRoot !== 'string' || !isAbsolute(requestedRoot) || requestedRoot.includes('\0')) {
    return { ok: false, status: 422, reason: 'root must be an absolute directory path selected from the project browser' };
  }
  if (typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) {
    return { ok: false, status: 422, reason: 'the server workspace root must be an absolute path' };
  }

  let canonicalRegistryFile;
  try {
    canonicalRegistryFile = realpathSync(file);
    if (!statSync(canonicalRegistryFile).isFile()) {
      return { ok: false, status: 503, reason: 'the project registry path does not resolve to a regular file' };
    }
  } catch (err) {
    return { ok: false, status: 503, reason: `the project registry file cannot be resolved: ${err.message}` };
  }

  let canonicalBrowseRoot;
  let canonicalRoot;
  try {
    canonicalBrowseRoot = realpathSync(browseRoot);
    if (!statSync(canonicalBrowseRoot).isDirectory()) return { ok: false, status: 403, reason: 'AF_PROJECT_BROWSE_ROOT is not a directory' };
    canonicalRoot = realpathSync(requestedRoot);
    if (!statSync(canonicalRoot).isDirectory()) return { ok: false, status: 422, reason: 'the selected project root is not a directory' };
  } catch (err) {
    return { ok: false, status: 422, reason: `the selected project root cannot be resolved: ${err.message}` };
  }
  if (!isContained(canonicalBrowseRoot, canonicalRoot) || canonicalRoot === canonicalBrowseRoot) {
    return { ok: false, status: 403, reason: 'the project root must be a child directory inside AF_PROJECT_BROWSE_ROOT' };
  }
  let canonicalWorkspaceRoot;
  try { canonicalWorkspaceRoot = canonicalizeFuturePath(workspaceRoot); }
  catch (err) { return { ok: false, status: 422, reason: `the server workspace root cannot be resolved safely: ${err.message}` }; }
  if (existsSync(canonicalWorkspaceRoot) && !statSync(canonicalWorkspaceRoot).isDirectory()) {
    return { ok: false, status: 422, reason: 'the server workspace root is not a directory' };
  }
  if (isContained(canonicalRoot, canonicalWorkspaceRoot) || isContained(canonicalWorkspaceRoot, canonicalRoot)) {
    return { ok: false, status: 422, reason: 'the server workspace root must not overlap the selected project root' };
  }

  // Resolve the configured alias once and use the target for both reads and writes. Atomic rename
  // through the alias would otherwise replace the symlink itself and split locks across aliases.
  const lockFile = `${canonicalRegistryFile}.project-registration.lock`;
  const owner = randomUUID();
  let lockFd = null;
  let lockCreated = false;
  try {
    lockFd = openSync(lockFile, 'wx', 0o600);
    lockCreated = true;
    writeSync(lockFd, owner);
    closeSync(lockFd);
    lockFd = null;
  } catch (err) {
    if (lockFd !== null) { try { closeSync(lockFd); } catch { /* lock acquisition failed */ } }
    if (lockCreated) { try { unlinkSync(lockFile); } catch { /* preserve the original failure */ } }
    if (err?.code === 'EEXIST') {
      return { ok: false, status: 409, reason: 'another project registration is in progress; retry after it finishes or remove a confirmed stale registration lock' };
    }
    return { ok: false, status: 500, reason: `the project registry lock could not be created: ${err.message}` };
  }

  try {
    const loaded = loadProjectRegistry({ file: canonicalRegistryFile });
    if (!loaded.ok) return { ok: false, status: 503, reason: loaded.reason };
    const claims = loaded.registry.projects.filter((project) => {
      try { return realpathSync(project.root) === canonicalRoot; }
      catch { return false; }
    });
    if (claims.length > 1) return { ok: false, status: 409, reason: 'multiple registered projects claim this directory; refusing to choose one' };
    if (loaded.digest !== expectedRegistryDigest) {
      const existing = claims[0] ?? null;
      const retry = existing ? alreadyRegisteredFromTemplate({
        existing, registry: loaded.registry, canonicalRoot, projectId, templateProjectId, templateProfileId,
        allowlist, acceptanceCommandAllowed,
      }) : null;
      if (retry) return { ...retry, registry_digest: loaded.digest };
      return { ok: false, status: 409, reason: 'the project registry changed; refresh the project list and choose the template again' };
    }
    if (claims.length === 1) {
      const retry = alreadyRegisteredFromTemplate({
        existing: claims[0], registry: loaded.registry, canonicalRoot, projectId, templateProjectId, templateProfileId,
        allowlist, acceptanceCommandAllowed,
      });
      if (retry) return { ...retry, registry_digest: loaded.digest };
      return { ok: false, status: 409, reason: 'the selected directory is already registered with a different project id or trusted profile' };
    }
    if (loaded.registry.projects.some((project) => project.project_id === projectId)) {
      return { ok: false, status: 409, reason: `project_id ${projectId} is already registered` };
    }

    const selected = resolveRegistrationTemplate({ registry: loaded.registry, templateProjectId, templateProfileId,
      root: canonicalRoot, allowlist, acceptanceCommandAllowed });
    if (!selected.ok) return { ok: false, status: 422, reason: selected.reason };
    const { templateProject, templateProfile } = selected;

    const nextProject = {
      project_id: projectId,
      root: canonicalRoot,
      workspace_root: canonicalWorkspaceRoot,
      acceptance_profiles: [templateProfile],
      registration_template: { project_id: templateProjectId, profile_id: templateProfileId },
    };
    // Keep configured change policy and tier from the trusted template so registration cannot
    // silently downgrade a constrained project to an empty policy.
    if (Object.hasOwn(templateProject, 'policy')) nextProject.policy = templateProject.policy;
    if (Object.hasOwn(templateProject, 'tier')) nextProject.tier = templateProject.tier;
    const registry = { ...loaded.registry, projects: [...loaded.registry.projects, nextProject] };
    const problems = validateRegistry(registry);
    if (problems.length) return { ok: false, status: 422, reason: `the resulting project registry would be invalid: ${problems.join('; ')}` };

    writeJsonAtomic(canonicalRegistryFile, registry);
    const saved = loadProjectRegistry({ file: canonicalRegistryFile });
    if (!saved.ok) return { ok: false, status: 500, reason: `the project registry was written but could not be reloaded: ${saved.reason}` };
    return {
      ok: true,
      project: { project_id: projectId, root: canonicalRoot, profiles: [templateProfile.profile_id] },
      template: { project_id: templateProjectId, profile_id: templateProfileId },
      registry_digest: saved.digest,
    };
  } catch (err) {
    return { ok: false, status: 500, reason: `project registration failed: ${err.message}` };
  } finally {
    try {
      if (readFileSync(lockFile, 'utf8') === owner) unlinkSync(lockFile);
    } catch { /* the lock is already absent or has been replaced */ }
  }
}

function alreadyRegisteredFromTemplate({ existing, registry, canonicalRoot, projectId, templateProjectId, templateProfileId, allowlist, acceptanceCommandAllowed }) {
  if (existing.project_id !== projectId) return null;
  const selected = resolveRegistrationTemplate({ registry, templateProjectId, templateProfileId, root: canonicalRoot, allowlist, acceptanceCommandAllowed });
  if (!selected.ok) return null;
  if (stableStringify(existing.registration_template ?? null)
    !== stableStringify({ project_id: templateProjectId, profile_id: templateProfileId })) return null;
  const existingProfiles = (existing.acceptance_profiles ?? []).filter((profile) => profile.profile_id === templateProfileId);
  if (existingProfiles.length !== 1 || stableStringify(existingProfiles[0]) !== stableStringify(selected.templateProfile)) return null;
  for (const key of ['policy', 'tier']) {
    if (Object.hasOwn(existing, key) !== Object.hasOwn(selected.templateProject, key)) return null;
    if (Object.hasOwn(existing, key) && stableStringify(existing[key]) !== stableStringify(selected.templateProject[key])) return null;
  }
  return {
    ok: true,
    created: false,
    project: { project_id: existing.project_id, root: canonicalRoot, profiles: (existing.acceptance_profiles ?? []).map((profile) => profile.profile_id) },
    template: { project_id: templateProjectId, profile_id: templateProfileId },
  };
}

function resolveRegistrationTemplate({ registry, templateProjectId, templateProfileId, root, allowlist, acceptanceCommandAllowed }) {
  const templateMatches = registry.projects.filter((project) => project.project_id === templateProjectId);
  if (templateMatches.length !== 1) return { ok: false, reason: 'the selected template project is missing or ambiguous' };
  const templateProject = templateMatches[0];
  const profileMatches = (templateProject.acceptance_profiles ?? []).filter((profile) => profile.profile_id === templateProfileId);
  if (profileMatches.length !== 1) return { ok: false, reason: 'the selected acceptance profile is missing or ambiguous' };
  const templateProfile = profileMatches[0];
  const acceptance = { command: templateProfile.acceptance.command, args: templateProfile.acceptance.args ?? [] };
  const allowed = typeof acceptanceCommandAllowed === 'function'
    ? acceptanceCommandAllowed(acceptance, allowlist)
    : { ok: false, reason: 'the acceptance allowlist checker is unavailable' };
  if (!allowed.ok) return { ok: false, reason: `the selected template acceptance is not allowed: ${allowed.reason}` };
  const compatibility = checkAcceptanceTemplateCompatibility({ root, acceptance, assets: templateProfile.assets ?? [] });
  if (!compatibility.ok) return { ok: false, reason: compatibility.reason };
  return { ok: true, templateProject, templateProfile };
}

/** Static checks only: registration never runs the selected acceptance command. */
function checkAcceptanceTemplateCompatibility({ root, acceptance, assets = [] }) {
  const command = acceptance.command;
  const args = acceptance.args ?? [];
  const missing = [];
  const isPathLike = (value) => typeof value === 'string' && !value.startsWith('-')
    && (value.includes('/') || value.includes('\\') || /\.[A-Za-z0-9]+$/.test(value));
  if (!isAbsolute(command) && isPathLike(command)) {
    const candidate = resolve(root, command);
    if (!isContained(root, candidate)) return { ok: false, reason: `the acceptance command path ${command} escapes the selected project root` };
    try {
      const real = realpathSync(candidate);
      if (!isContained(root, real) || !statSync(real).isFile()) {
        return { ok: false, reason: `the acceptance command path ${command} is not a project file` };
      }
    } catch { return { ok: false, reason: `the acceptance command file ${command} is missing from this directory` }; }
  }
  for (const arg of args) {
    if (!isPathLike(arg)) continue;
    if (/[?*\[\]{}]/.test(arg)) {
      return { ok: false, reason: `the selected acceptance template uses a path pattern (${arg}) that cannot be checked safely; register an exact-path template first` };
    }
    const candidate = resolve(root, arg);
    if (!isContained(root, candidate)) return { ok: false, reason: `the acceptance path ${arg} escapes the selected project root` };
    try {
      const real = realpathSync(candidate);
      if (!isContained(root, real)) return { ok: false, reason: `the acceptance path ${arg} resolves outside the selected project root` };
    } catch { missing.push(arg); }
  }
  if (missing.length) return { ok: false, reason: `the selected acceptance template requires file(s) missing from this directory: ${missing.join(', ')}` };

  for (const asset of assets) {
    const assetId = asset?.asset_id;
    if (typeof assetId !== 'string' || !assetId || assetId.includes('\0') || assetId.includes('\\') || isAbsolute(assetId)
      || assetId.split('/').some((part) => !part || part === '.' || part === '..')) {
      return { ok: false, reason: `the acceptance asset id ${String(assetId)} is not a safe relative file path and cannot be verified in the selected directory` };
    }
    const candidate = resolve(root, ...assetId.split('/'));
    if (!isContained(root, candidate)) return { ok: false, reason: `the acceptance asset path ${assetId} escapes the selected project root` };
    try {
      const real = realpathSync(candidate);
      if (!isContained(root, real)) return { ok: false, reason: `the acceptance asset path ${assetId} resolves outside the selected project root` };
      if (!statSync(real).isFile()) return { ok: false, reason: `the acceptance asset path ${assetId} is not a regular file` };
      if (statSync(real).size > 64 * 1024 * 1024) return { ok: false, reason: `the acceptance asset ${assetId} exceeds the 64 MiB verification limit` };
      const actualDigest = createHash('sha256').update(readFileSync(real)).digest('hex');
      if (actualDigest !== asset.digest) return { ok: false, reason: `the acceptance asset ${assetId} digest does not match the selected template` };
    } catch (err) {
      return { ok: false, reason: `the acceptance asset ${assetId} cannot be verified in the selected directory: ${err.message}` };
    }
  }

  const executable = command.split(/[\\/]/).pop().toLowerCase();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable) && args.some((arg) => ['test', 'run', 'check'].includes(arg))) {
    const packageFile = join(root, 'package.json');
    let pkg;
    try { pkg = JSON.parse(readFileSync(packageFile, 'utf8')); }
    catch { return { ok: false, reason: `the selected ${executable} acceptance template requires a readable package.json in this directory` }; }
    const scriptName = args.find((arg) => ['test', 'check'].includes(arg)) ?? 'test';
    if (typeof pkg.scripts?.[scriptName] !== 'string' || !pkg.scripts[scriptName].trim()) {
      return { ok: false, reason: `the selected ${executable} acceptance template requires package.json scripts.${scriptName}` };
    }
  }
  return { ok: true };
}

function registeredProjectIdsAt(root, registry) {
  const ids = [];
  for (const project of registry?.projects ?? []) {
    try { if (realpathSync(project.root) === root) ids.push(project.project_id); }
    catch { /* unavailable project roots do not match this canonical directory */ }
  }
  return ids;
}

/** Resolve a workspace path that may not exist yet, including symlinks in its existing prefix. */
function canonicalizeFuturePath(input) {
  let cursor = resolve(input);
  const suffix = [];
  while (true) {
    try {
      const existing = realpathSync(cursor);
      if (suffix.length && !statSync(existing).isDirectory()) throw new Error('an existing workspace path component is not a directory');
      return resolve(existing, ...suffix);
    }
    catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = dirname(cursor);
      if (parent === cursor) throw err;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
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
