// boundary-alerts.mjs - A1b: durable, queryable, escalating alerts for retained boundaries.
//
// A retained boundary locks the canonical repo and the CAS store until an operator
// recovers it. Before this module that state existed only inside the task record, so a
// forgotten task could hold the repository indefinitely with nothing raising its hand.
//
// Scope (deliberately explicit):
//   - durable: append-only JSONL plus a per-path streak state file, both re-readable;
//   - queryable: `af-admin boundary alerts` lists what is currently open;
//   - escalating: repeated retains for the same path raise `severity` to `escalated`
//     once the streak reaches the threshold, so a loop cannot retry silently;
//   - resolved automatically when the same path is released successfully.
// External notification (webhook/e-mail/chat) is NOT implemented here.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_FILE = join(ROOT, 'runtime', 'boundary-alerts.jsonl');

/** Alert log path (env-overridable so tests never touch the production log). */
export function boundaryAlertsFile() {
  return process.env.AF_BOUNDARY_ALERTS_FILE || DEFAULT_FILE;
}

/** Streak state path, derived from the log path. */
export function boundaryAlertsStateFile(file = boundaryAlertsFile()) {
  return `${file}.state.json`;
}

/** How many consecutive retains for one path escalate the alert. */
export function alertEscalationThreshold() {
  const raw = Number(process.env.AF_BOUNDARY_ALERT_ESCALATE_AFTER ?? 3);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

function readState(file) {
  const stateFile = boundaryAlertsStateFile(file);
  if (!existsSync(stateFile)) return {};
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  const stateFile = boundaryAlertsStateFile(file);
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function appendEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

/**
 * Record that a boundary was retained for a path.
 *
 * @param {object} params
 * @param {string} params.canonicalDir - the path that stays locked (alert key).
 * @param {string} [params.casDir]
 * @param {string} [params.taskId]
 * @param {string} params.boundaryState - e.g. PROTECTION_RETAINED_PENDING_RECOVERY
 * @param {string} [params.reason]
 * @param {object} [params.scopeDecision]
 * @param {string} [params.file]
 * @returns {{ alert_id: string, occurrences: number, severity: 'warning'|'escalated', escalated: boolean, file: string, threshold: number }}
 */
export function recordBoundaryAlert({
  canonicalDir,
  casDir = null,
  taskId = null,
  boundaryState = 'PROTECTION_RETAINED_PENDING_RECOVERY',
  reason = null,
  scopeDecision = null,
  file = boundaryAlertsFile(),
} = {}) {
  if (!canonicalDir) throw new Error('recordBoundaryAlert requires canonicalDir');
  const at = new Date().toISOString();
  const threshold = alertEscalationThreshold();
  const state = readState(file);
  const previous = state[canonicalDir] ?? { occurrences: 0 };
  const occurrences = previous.occurrences + 1;
  const escalated = occurrences >= threshold;
  const alertId = escalated ? (previous.alert_id ?? randomUUID()) : randomUUID();

  state[canonicalDir] = {
    alert_id: alertId,
    occurrences,
    severity: escalated ? 'escalated' : 'warning',
    first_seen: previous.first_seen ?? at,
    last_seen: at,
    task_id: taskId,
    boundary_state: boundaryState,
    reason,
    open: true,
    resolved_at: null,
  };
  writeState(file, state);

  appendEvent(file, {
    event: 'boundary_retained',
    alert_id: alertId,
    at,
    canonical_dir: canonicalDir,
    cas_dir: casDir,
    task_id: taskId,
    boundary_state: boundaryState,
    reason,
    scope_decision: scopeDecision
      ? {
        decision: scopeDecision.decision,
        reason: scopeDecision.reason,
        attempts: scopeDecision.attempts,
        quiesce_confirmed: scopeDecision.quiesce_confirmed ?? null,
        anomalies: (scopeDecision.anomalies ?? []).map((a) => ({ class: a.class, code: a.code ?? null })),
      }
      : null,
    occurrences,
    severity: escalated ? 'escalated' : 'warning',
    threshold,
  });

  return { alert_id: alertId, occurrences, severity: escalated ? 'escalated' : 'warning', escalated, file, threshold };
}

/**
 * Close the alert for a path after a successful release, and record the resolution.
 *
 * @param {object} params
 * @returns {{ resolved: boolean, occurrences: number, file: string }}
 */
export function resolveBoundaryAlert({ canonicalDir, reason = null, taskId = null, file = boundaryAlertsFile() } = {}) {
  if (!canonicalDir) throw new Error('resolveBoundaryAlert requires canonicalDir');
  const state = readState(file);
  const previous = state[canonicalDir];
  if (!previous || previous.open !== true) return { resolved: false, occurrences: previous?.occurrences ?? 0, file };

  const at = new Date().toISOString();
  state[canonicalDir] = { ...previous, open: false, resolved_at: at, resolved_reason: reason };
  writeState(file, state);
  appendEvent(file, {
    event: 'boundary_released',
    alert_id: previous.alert_id,
    at,
    canonical_dir: canonicalDir,
    task_id: taskId,
    reason,
    previous_occurrences: previous.occurrences,
  });
  return { resolved: true, occurrences: previous.occurrences, file };
}

/**
 * List alerts that are currently open (latest state per path).
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {boolean} [options.includeResolved=false]
 * @returns {object[]}
 */
export function listBoundaryAlerts({ file = boundaryAlertsFile(), includeResolved = false } = {}) {
  const state = readState(file);
  return Object.entries(state)
    .map(([canonicalDir, entry]) => ({ canonical_dir: canonicalDir, ...entry }))
    .filter((entry) => includeResolved || entry.open === true)
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
}

/** Format the open alerts for the operator CLI. */
export function formatBoundaryAlerts(alerts, { file = boundaryAlertsFile() } = {}) {
  if (alerts.length === 0) return `boundary alerts: none open (log: ${file})`;
  const lines = [`boundary alerts: ${alerts.length} open (log: ${file})`];
  for (const a of alerts) {
    lines.push(`- [${a.severity}] ${a.canonical_dir}`);
    lines.push(`    occurrences=${a.occurrences} task=${a.task_id ?? 'n/a'} since=${a.first_seen} last=${a.last_seen}`);
    lines.push(`    state=${a.boundary_state} reason=${a.reason ?? 'n/a'}`);
  }
  return lines.join('\n');
}

/** Read the raw event log (append-only history, newest last). */
export function readBoundaryAlertEvents({ file = boundaryAlertsFile() } = {}) {
  return readEvents(file);
}
