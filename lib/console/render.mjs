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

const line = (label, value) => `  ${label}: ${value === null || value === undefined ? '—' : value}`;

function banner(model) {
  const out = [];
  const unverifiable = model.unverifiable ?? [];
  if (unverifiable.length > 0) {
    out.push('! UNVERIFIABLE — do not read this as "nothing to report":');
    for (const entry of unverifiable) out.push(`    ${entry.source}: ${entry.reason ?? 'reason not recorded'}`);
  }
  const missing = model.missing ?? [];
  if (missing.length > 0) {
    out.push(`. missing sources (absent, not damaged): ${missing.map((entry) => entry.source).join(', ')}`);
  }
  if ((model.truncations ?? []).length > 0) {
    out.push(`. truncated fields: ${model.truncations.map((entry) => `${entry.path} (${entry.original_chars}→${entry.kept_chars})`).join(', ')}`);
  }
  return out;
}

function header(model) {
  return [
    `# ${model.schema} @ ${model.generated_at}`,
    `  path_mode: ${model.path_mode} (credentials always redacted)`,
  ];
}

function overviewBody(model) {
  const out = ['', 'blocks:'];
  for (const [name, block] of Object.entries(model.blocks ?? {})) {
    out.push(`  [${block.read_status}] ${name} ← ${block.source}${block.as_of ? ` @ ${block.as_of}` : ''}${block.reason ? ` (${block.reason})` : ''}`);
  }
  out.push('', `needs human (${(model.needs_human ?? []).length}):`);
  if ((model.needs_human ?? []).length === 0) out.push('  (none reported by the sources above)');
  for (const entry of model.needs_human ?? []) {
    out.push(`  - ${entry.task_id}: state=${entry.state ?? '—'} boundary=${entry.boundary_state ?? '—'}`);
  }
  out.push('', `tasks (${(model.tasks ?? []).length}):`);
  for (const task of model.tasks ?? []) {
    out.push(`  - ${task.task_id}: ${task.state ?? '—'} | boundary=${task.boundary_state ?? '—'} | lock_stale=${task.lock_stale ?? '—'} | ${task.read_status}`);
  }
  const correlation = model.correlation ?? {};
  out.push('', `correlation: alerts=${correlation.alert_count ?? 0} deliveries=${correlation.delivery_count ?? 0} pending=${correlation.pending_count ?? 0} unmatched=${(correlation.unmatched ?? []).length}`);
  for (const entry of correlation.unmatched ?? []) out.push(`  ~ ${entry.kind}: ${entry.asset ?? entry.canonical_dir ?? entry.notify_key ?? entry.alert_id ?? ''}`);
  return out;
}

function taskBody(model) {
  const keys = model.keys ?? {};
  const out = ['', 'keys:'];
  out.push(line('canonical_dir', keys.canonical_dir));
  out.push(line('alert_id', keys.alert_id));
  out.push(line('recovery_id', keys.recovery_id));
  const blocks = model.blocks ?? {};
  out.push('', `task: [${blocks.task?.read_status}] state=${blocks.task?.value?.state ?? '—'} state_version=${blocks.task?.value?.state_version ?? '—'}`);
  if (blocks.task?.reason) out.push(`  reason: ${blocks.task.reason}`);
  out.push(`lock: [${blocks.lock?.read_status}] stale=${blocks.lock?.value?.stale ?? '—'}`);
  out.push(`alerts attached: ${(blocks.alerts?.value?.alerts ?? []).length}`);
  for (const alert of blocks.alerts?.value?.alerts ?? []) {
    out.push(`  - ${alert.alert_id ?? '—'} ${alert.canonical_dir ?? ''} open=${alert.open} occurrences=${alert.occurrences ?? '—'}`);
  }
  out.push(`deliveries attached: ${(blocks.notify?.value?.deliveries ?? []).length} | pending=${(blocks.notify?.value?.pending ?? []).length} exhausted=${(blocks.notify?.value?.exhausted ?? []).length}`);
  out.push(`recovery records attached: ${(blocks.recovery?.value?.records ?? []).length}`);
  if ((model.unmatched ?? []).length > 0) {
    out.push('', 'unmatched (never guessed):');
    for (const entry of model.unmatched) out.push(`  ~ ${entry.kind}: ${entry.detail ?? entry.canonical_dir ?? entry.recovery_id ?? ''}`);
  }
  return out;
}

function evidenceBody(model) {
  const blocks = model.blocks ?? {};
  const out = ['', `review: [${blocks.review?.read_status}] ${blocks.review?.value?.review_decision ?? '—'} ${blocks.review?.value?.reasons ? `— ${blocks.review.value.reasons}` : ''}`];
  out.push(`acceptance runs: [${blocks.acceptance?.read_status}]`);
  for (const run of blocks.acceptance?.value ?? []) {
    out.push(`  - rev=${run.revision ?? '—'} exit=${run.exit_code ?? '—'} cmd=${run.command ?? '—'}${run.failure_reason ? ` failure=${run.failure_reason}` : ''}`);
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
    for (const entry of model.absent) out.push(`  ~ ${entry.part}: [${entry.read_status}] ${entry.reason}`);
  }
  return out;
}

function exceptionsBody(model) {
  const out = ['', `retained boundaries (${(model.retained_boundaries ?? []).length}):`];
  for (const entry of model.retained_boundaries ?? []) {
    out.push(`  - ${entry.task_id}: ${entry.boundary_state} reason=${entry.reason ?? '—'} [${entry.read_status}]`);
  }
  out.push('', `open alerts (${(model.open_alerts ?? []).length}):`);
  for (const alert of model.open_alerts ?? []) out.push(`  - ${alert.alert_id ?? '—'} ${alert.canonical_dir ?? ''} occurrences=${alert.occurrences ?? '—'} severity=${alert.severity ?? '—'}`);
  out.push('', `exhausted deliveries (${(model.exhausted_deliveries ?? []).length}) | failed deliveries (${(model.failed_deliveries ?? []).length}):`);
  for (const entry of [...(model.exhausted_deliveries ?? []), ...(model.failed_deliveries ?? [])]) {
    out.push(`  - ${entry.notify_key ?? '—'} state=${entry.state ?? entry.status ?? '—'} attempts=${entry.attempts ?? '—'} last_error=${entry.last_error ?? '—'}`);
  }
  out.push('', `recovery records (${(model.recovery_records ?? []).length})`);
  return out;
}

function auditBody(model) {
  return ['', `ref: ${model.ref ?? '—'}`, `root: ${model.root ?? '—'}`, '', JSON.stringify(model.record ?? {}, null, 2)];
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
