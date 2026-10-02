// render.mjs - human-readable rendering for the read-only console views.
//
// Pure string building: no fs, no process, no network. It receives a model that has ALREADY
// been redacted, so a renderer can never leak a credential or an unredacted path.
//
// Presentation rules:
//   * an unverifiable source is announced in a banner, never omitted;
//   * a missing source is listed separately from an unverifiable one;
//   * truncation is announced, because a truncated view is an incomplete view;
//   * derived/aggregated values never replace the authoritative blocks they summarise.

// Terminal safety: model values are untrusted text (task fields, review reasons, provider
// messages). ESC/CSI sequences could rewrite the operator's screen, hide output or forge a
// prompt, so control characters are rendered as escapes and newlines as a visible marker.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
export function safeText(value) {
  if (value === null || value === undefined) return '—';
  return String(value)
    .replace(CONTROL, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/\r\n|\r|\n/g, '⏎');
}

const line = (label, value) => `  ${label}: ${safeText(value)}`;

function banner(model) {
  const out = [];
  const unverifiable = model.unverifiable ?? [];
  if (unverifiable.length > 0) {
    out.push('! UNVERIFIABLE — do not read this as "nothing to report":');
    for (const entry of unverifiable) out.push(`    ${safeText(entry.source)}: ${safeText(entry.reason ?? 'reason not recorded')}`);
  }
  const missing = model.missing ?? [];
  if (missing.length > 0) {
    out.push(`. missing sources (absent, not damaged): ${missing.map((entry) => safeText(entry.source)).join(', ')}`);
  }
  if ((model.truncations ?? []).length > 0) {
    out.push(`. truncated fields: ${model.truncations.map((entry) => `${safeText(entry.path)} (${entry.original_chars}→${entry.kept_chars})`).join(', ')}`);
  }
  return out;
}

function header(model) {
  return [
    `# ${safeText(model.schema)} @ ${safeText(model.generated_at)}`,
    `  path_mode: ${safeText(model.path_mode)} (credentials always redacted)`,
  ];
}

function overviewBody(model) {
  const out = ['', 'blocks:'];
  for (const [name, block] of Object.entries(model.blocks ?? {})) {
    out.push(`  [${safeText(block.read_status)}] ${safeText(name)} ← ${safeText(block.source)}${block.as_of ? ` @ ${safeText(block.as_of)}` : ''}${block.reason ? ` (${safeText(block.reason)})` : ''}`);
  }
  out.push('', `needs human (${(model.needs_human ?? []).length}):`);
  if ((model.needs_human ?? []).length === 0) out.push('  (none reported by the sources above)');
  for (const entry of model.needs_human ?? []) {
    out.push(`  - ${safeText(entry.task_id)}: state=${safeText(entry.state)} boundary=${safeText(entry.boundary_state)}`);
  }
  out.push('', `tasks (${(model.tasks ?? []).length}):`);
  for (const task of model.tasks ?? []) {
    out.push(`  - ${safeText(task.task_id)}: ${safeText(task.state)} | boundary=${safeText(task.boundary_state)} | lock_stale=${safeText(task.lock_stale)} | ${safeText(task.read_status)}`);
  }
  const correlation = model.correlation ?? {};
  out.push('', `correlation: alerts=${correlation.alert_count ?? 0} deliveries=${correlation.delivery_count ?? 0} pending=${correlation.pending_count ?? 0} unmatched=${(correlation.unmatched ?? []).length}`);
  for (const entry of correlation.unmatched ?? []) out.push(`  ~ ${safeText(entry.kind)}: ${safeText(entry.asset ?? entry.canonical_dir ?? entry.notify_key ?? entry.alert_id ?? '')}`);
  return out;
}

function taskBody(model) {
  const keys = model.keys ?? {};
  const out = ['', `task_id: ${safeText(model.task_id)}`, '', 'keys:'];
  out.push(line('canonical_dir', keys.canonical_dir));
  out.push(line('alert_id', keys.alert_id));
  out.push(line('recovery_id', keys.recovery_id));
  const blocks = model.blocks ?? {};
  out.push('', `task: [${safeText(blocks.task?.read_status)}] state=${safeText(blocks.task?.value?.state)} state_version=${safeText(blocks.task?.value?.state_version)}`);
  if (blocks.task?.reason) out.push(`  reason: ${safeText(blocks.task.reason)}`);
  out.push(`lock: [${safeText(blocks.lock?.read_status)}] stale=${safeText(blocks.lock?.value?.stale)}`);
  out.push(`alerts attached: ${(blocks.alerts?.value?.alerts ?? []).length}`);
  for (const alert of blocks.alerts?.value?.alerts ?? []) {
    out.push(`  - ${safeText(alert.alert_id)} ${safeText(alert.canonical_dir)} open=${safeText(alert.open)} occurrences=${safeText(alert.occurrences)}`);
  }
  out.push(`deliveries attached: ${(blocks.notify?.value?.deliveries ?? []).length} | pending=${(blocks.notify?.value?.pending ?? []).length} exhausted=${(blocks.notify?.value?.exhausted ?? []).length}`);
  out.push(`current recovery evidence: ${(blocks.recovery?.value?.current_recovery ?? []).length} (id ${safeText(blocks.recovery?.value?.current_recovery_id)})`);
  out.push(`asset history (other attempts, NOT current evidence): ${(blocks.recovery?.value?.asset_history ?? []).length}`);
  for (const record of blocks.recovery?.value?.asset_history ?? []) {
    out.push(`  ~ history ${safeText(record.phase)}: ${safeText(record.file)}`);
  }
  if ((model.unmatched ?? []).length > 0) {
    out.push('', 'unmatched (never guessed):');
    for (const entry of model.unmatched) {
      out.push(`  ~ ${safeText(entry.kind)}: ${safeText(entry.detail ?? entry.canonical_dir ?? entry.recovery_id ?? '')}`);
      if (entry.available_recovery_ids) out.push(`      available ids: ${safeText(entry.available_recovery_ids.join(', '))}`);
      if (entry.available_alert_ids) out.push(`      available alert ids: ${safeText(entry.available_alert_ids.join(', '))}`);
    }
  }
  return out;
}

function evidenceBody(model) {
  const blocks = model.blocks ?? {};
  const out = ['', `task_id: ${safeText(model.task_id)}`, '', `review: [${safeText(blocks.review?.read_status)}] ${safeText(blocks.review?.value?.review_decision)} ${blocks.review?.value?.reasons ? `— ${safeText(blocks.review.value.reasons)}` : ''}`];
  out.push(`acceptance runs: [${safeText(blocks.acceptance?.read_status)}]`);
  for (const run of blocks.acceptance?.value ?? []) {
    out.push(`  - rev=${safeText(run.revision)} exit=${safeText(run.exit_code)} cmd=${safeText(run.command)}${run.failure_reason ? ` failure=${safeText(run.failure_reason)}` : ''}`);
  }
  const promotion = blocks.promotion?.value ?? {};
  out.push('', 'promotion:');
  out.push(line('baseline_oid', promotion.baseline_oid));
  out.push(line('new_commit_oid', promotion.new_commit_oid));
  out.push(line('patch_digest', promotion.patch_digest));
  out.push(line('tree_oid', promotion.tree_oid));
  out.push(line('acceptance_evidence_id', promotion.acceptance_evidence_id));
  out.push(line('canonical_ref', promotion.canonical_ref));
  if ((model.absent ?? []).length > 0) {
    out.push('', 'absent evidence (stated, not implied):');
    for (const entry of model.absent) out.push(`  ~ ${safeText(entry.part)}: [${safeText(entry.read_status)}] ${safeText(entry.reason)}`);
  }
  return out;
}

function exceptionsBody(model) {
  const out = ['', `retained boundaries (${(model.retained_boundaries ?? []).length}):`];
  for (const entry of model.retained_boundaries ?? []) {
    out.push(`  - ${safeText(entry.task_id)}: ${safeText(entry.boundary_state)} reason=${safeText(entry.reason)} [${safeText(entry.read_status)}]`);
  }
  out.push('', `open alerts (${(model.open_alerts ?? []).length}):`);
  for (const alert of model.open_alerts ?? []) out.push(`  - ${safeText(alert.alert_id)} ${safeText(alert.canonical_dir)} occurrences=${safeText(alert.occurrences)} severity=${safeText(alert.severity)}`);
  out.push('', `exhausted deliveries (${(model.exhausted_deliveries ?? []).length}) | failed deliveries (${(model.failed_deliveries ?? []).length}):`);
  for (const entry of [...(model.exhausted_deliveries ?? []), ...(model.failed_deliveries ?? [])]) {
    out.push(`  - ${safeText(entry.notify_key)} state=${safeText(entry.state ?? entry.status)} attempts=${safeText(entry.attempts)} last_error=${safeText(entry.last_error)}`);
  }
  out.push('', `recovery records (${(model.recovery_records ?? []).length})`);
  return out;
}

function auditBody(model) {
  // The audit record is printed as JSON, which already escapes control characters.
  return ['', `ref: ${safeText(model.ref)}`, `root: ${safeText(model.root)}`, '', JSON.stringify(model.record ?? {}, null, 2)];
}

/** Render one console model for a terminal. `json` mode never goes through here. */
export function renderHuman(model) {
  const out = [...header(model), ...banner(model)];
  switch (model.schema) {
    case 'af-console-overview-v1':
    case 'af-console-tasks-v1':
      out.push(...overviewBody(model));
      break;
    case 'af-console-task-v1':
      out.push(...taskBody(model));
      break;
    case 'af-console-evidence-v1':
      out.push(...evidenceBody(model));
      break;
    case 'af-console-exceptions-v1':
      out.push(...exceptionsBody(model));
      break;
    case 'af-console-audit-v1':
      out.push(...auditBody(model));
      break;
    default:
      out.push('', JSON.stringify(model, null, 2));
  }
  return out.join('\n');
}
