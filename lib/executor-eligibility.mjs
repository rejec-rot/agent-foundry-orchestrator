// Shared eligibility policy. Callers choose priority and whether local health is required.
const get = (map, id) => map instanceof Map ? map.get(id) : map?.[id];

export function executorEligibility(id, task = {}, {
  adapters = null, capabilityMap = null, availabilityMap = null,
  runtimeGuard = null, disabled = [], requireHealth = false,
} = {}) {
  if (disabled.includes(id)) return { ok: false, reason: `OPERATOR_EXECUTOR_DISABLED: ${id} is disabled by the operator` };
  const adapter = adapters?.[id];
  if (adapters && !adapter) return { ok: false, reason: `unknown executor: ${id}` };
  if (adapter?.schedulable === false) return { ok: false, reason: `executor ${id} is not schedulable (${adapter.blocked_reason ?? 'user/blocked'})` };
  const cap = get(capabilityMap, id);
  if (task.requires_mcp) {
    const blocked = cap?.capabilities_audit?.mcp_unattended === 'BLOCKED' || adapter?.supportsMcpUnattended === false;
    const confirmed = cap?.capabilities_audit?.mcp_unattended === 'PASS' || adapter?.supportsMcpUnattended === true;
    if (blocked || (!confirmed && capabilityMap)) return { ok: false, reason: `executor ${id} does not support unattended MCP` };
  }
  if (task.compliance === 'enterprise' && cap?.platform !== 'cloud-enterprise' && id !== 'vertex-gemini') return { ok: false, reason: `executor ${id} does not satisfy enterprise compliance` };
  const avail = get(availabilityMap, id);
  if (avail?.reason && /account.*disabled|403|tos/i.test(avail.reason)) return { ok: false, reason: `executor ${id} is unavailable: ${avail.reason}` };
  if (avail?.availability_status === 'UNAVAILABLE') {
    const mcpOnly = /mcp/i.test(avail.blocker ?? '') && !/account|tos|disabled/i.test(avail.blocker ?? '');
    if (!mcpOnly || task.requires_mcp) return { ok: false, reason: `executor ${id} is unavailable: ${avail.blocker ?? avail.reason}` };
  }
  if (runtimeGuard) {
    // Read the circuit without projecting/persisting a cooldown during routing or preflight.
    const circuit = runtimeGuard.getCircuitState?.(id) ?? runtimeGuard[id];
    if (circuit) {
      const state = circuit.state ?? 'CLOSED';
      if (['OPEN_MANUAL_RESET', 'PROBING', 'HALF_OPEN'].includes(state)) return { ok: false, reason: `executor ${id} circuit is ${state}` };
      // Elapsed cooldown becomes HALF_OPEN in the guard and still needs explicit admission.
      if (state === 'OPEN_COOLDOWN') return { ok: false, reason: `executor ${id} is cooling down or awaiting recovery admission` };
    } else if (runtimeGuard.canExecute && !runtimeGuard.canExecute(id)) return { ok: false, reason: `executor ${id} is blocked by runtime safety` };
  }
  if (requireHealth) {
    try { if (adapter?.health?.().ok !== true) return { ok: false, reason: `executor ${id} is not healthy on this host` }; }
    catch (err) { return { ok: false, reason: `executor ${id} health check failed: ${err.message}` }; }
  }
  return { ok: true, reason: null };
}
