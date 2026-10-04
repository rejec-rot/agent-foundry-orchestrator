// An immutable, sequenced journal is the sole team lifecycle truth.
// Intake/commands are durable files; only the leased controller commits changes.
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../store.mjs';
import { capsuleDigest } from '../json-identity.mjs';
import { acquireTaskLock, releaseTaskLock } from '../tasklock.mjs';
import { requireId, teamError, text } from './model.mjs';

export const teamsRoot = runtimeDir => join(runtimeDir, 'teams');
export const teamDir = (runtimeDir, id) => join(teamsRoot(runtimeDir), requireId(id));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
export function readTeam(runtimeDir, id) {
  const dir = join(teamDir(runtimeDir, id), 'journal');
  let names;
  try { names = readdirSync(dir).filter(n => /^\d{10}\.json$/.test(n)).sort(); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  let previous = null;
  for (let i = 0; i < names.length; i++) {
    const event = json(join(dir, names[i]));
    const { checksum, ...record } = event;
    if (event.sequence !== i + 1 || event.previous_checksum !== (previous?.checksum ?? null)
        || checksum !== capsuleDigest(record) || event.state.team_id !== id || event.state.sequence !== event.sequence) {
      throw teamError(`team journal is unverifiable at ${names[i]}`, 'TEAM_JOURNAL_CORRUPT');
    }
    previous = event;
  }
  if (!previous) return null;
  return { ...previous.state, journal_checksum: previous.checksum };
}
export function commitTeam(runtimeDir, state, type, detail, assertOwnership) {
  if (typeof assertOwnership !== 'function') throw teamError('controller ownership required');
  assertOwnership();
  const current = readTeam(runtimeDir, state.team_id);
  if ((current?.sequence ?? 0) !== state.sequence) throw teamError('team sequence changed', 'TEAM_VERSION_CONFLICT');
  const sequence = state.sequence + 1;
  const { journal_checksum, ...clean } = state;
  const record = { sequence, previous_checksum: current?.journal_checksum ?? null, type, detail,
    at: new Date().toISOString(), state: { ...clean, sequence, updated_at: new Date().toISOString() } };
  const dir = join(teamDir(runtimeDir, state.team_id), 'journal');
  mkdirSync(dir, { recursive: true });
  if (!writeJsonAtomic(join(dir, `${String(sequence).padStart(10, '0')}.json`), { ...record, checksum: capsuleDigest(record) }, { noOverwrite: true })) {
    throw teamError('team commit conflict', 'TEAM_VERSION_CONFLICT');
  }
  return { ...record.state, journal_checksum: capsuleDigest(record) };
}
export function createTeamRecord(runtimeDir, state) {
  const dir = teamsRoot(runtimeDir); mkdirSync(dir, { recursive: true });
  const owned = acquireTaskLock(dir, state.team_id, { orchestratorInstanceId: `team-intake-${randomUUID()}` });
  try {
    const existing = readTeam(runtimeDir, state.team_id);
    return existing ?? commitTeam(runtimeDir, state, 'created', null, () => {});
  } finally { releaseTaskLock(dir, state.team_id, owned.lock); }
}
export function listTeams(runtimeDir) {
  try { return readdirSync(teamsRoot(runtimeDir), { withFileTypes: true }).filter(d => d.isDirectory() && /^TEAM-/.test(d.name)).map(d => readTeam(runtimeDir, d.name)).filter(Boolean); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
export function submitTeamCommand({ runtimeDir, teamId, command, commandId = `CMD-${randomUUID()}`, actor = 'operator' }) {
  requireId(teamId); requireId(commandId);
  const team = readTeam(runtimeDir, teamId);
  if (!team) throw teamError('no such team', 'TEAM_NOT_FOUND');
  if (!['start','message','adjust','replan','retry','pause','resume','cancel','deliver','propose_plan','approve_plan','configure_agents'].includes(command?.type)) throw teamError('unknown team command');
  if (['message','adjust','replan'].includes(command.type)) text(command.message ?? command.goal, 'command message');
  if (command.type === 'adjust' && (!requireId(command.work_item_id) || !Number.isInteger(command.expected_revision))) throw teamError('adjust needs expected_revision');
  const dir = join(teamDir(runtimeDir, teamId), 'inbox'); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${commandId}.json`);
  const payload = { command_id: commandId, team_id: teamId, actor: text(actor, 'actor', 128), command };
  const record = { ...payload, payload_digest: capsuleDigest(payload), created_at: new Date().toISOString() };
  if (!writeJsonAtomic(file, record, { noOverwrite: true })) {
    const previous = json(file);
    if (previous.payload_digest !== record.payload_digest) throw teamError('command id reused with different content', 'TEAM_VERSION_CONFLICT');
  }
  return { ok: true, team_id: teamId, command_id: commandId, status: team.commands[commandId]?.status ?? 'queued' };
}
export function pendingCommands(runtimeDir, team) {
  const dir = join(teamDir(runtimeDir, team.team_id), 'inbox');
  try { return readdirSync(dir).filter(n => n.endsWith('.json')).map(n => {
    const record=json(join(dir,n));
    const {payload_digest,created_at,...payload}=record;
    if(n!==`${record.command_id}.json` || record.team_id!==team.team_id || !created_at || payload_digest!==capsuleDigest(payload)) {
      throw teamError(`command inbox is unverifiable at ${n}`,'TEAM_INBOX_CORRUPT');
    }
    return record;
  })
    .filter(c => !['applied','rejected'].includes(team.commands[c.command_id]?.status))
    .sort((a,b) => a.created_at.localeCompare(b.created_at) || a.command_id.localeCompare(b.command_id)); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
export function teamView(runtimeDir, id) {
  const team = readTeam(runtimeDir, id);
  if (!team) return null;
  const commands = pendingCommands(runtimeDir, team).map(c => ({ command_id: c.command_id, type: c.command.type, message: c.command.message ?? c.command.goal ?? null,
    target_agent_id: c.command.agent_id ?? null, work_item_id: c.command.work_item_id ?? null, ...team.commands[c.command_id], status: team.commands[c.command_id]?.status ?? 'queued' }));
  const applied = Object.entries(team.commands).filter(([,c]) => ['applied','rejected'].includes(c.status)).map(([command_id,c]) => ({ command_id,...c }));
  return { schema_version: team.schema_version, team_id: id, goal: team.goal, goal_revision: team.goal_revision,
    sequence: team.sequence, state: team.state, paused_from_state:team.paused_from_state??null, failure_reason: team.failure_reason, delivery_task_id: team.delivery_task_id,
    planning: team.planning ?? null, plan_revision: team.plan_revision, work_revision:team.work_revision, rework_requests: team.rework_requests ?? [],
    planner_decisions:team.planner_decisions??[],
    members: team.members, work_items: team.work_items, messages: team.messages,
    runs: team.runs.map(({ workspace_dir, owner_token, ...r }) => r),
    delivery_runs: team.delivery_runs.map(({owner_token,...r})=>r),
    artifacts: team.artifacts.map(a => ({ artifact_id: a.artifact_id, work_item_id: a.work_item_id, revision: a.revision, run_id: a.run_id, summary: a.summary, manifest: a.manifest })),
    integration: team.integration ? { artifact_id: team.integration.artifact_id, conflicts: team.integration.conflicts } : null,
    delivery: team.delivery, commands: [...commands, ...applied].slice(-100), updated_at: team.updated_at };
}
