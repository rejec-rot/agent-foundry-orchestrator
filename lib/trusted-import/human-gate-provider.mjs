// Verify a durable operator signature and its exact candidate/policy binding,
// then mint a fresh process-local trusted approval for the regular V2 entry.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { capsuleDigest } from '../json-identity.mjs';
import { sha256 } from './common.mjs';
import { approveHumanGate } from './human-gate.mjs';

export function humanApprovalBinding(task) {
  const ti=task.trusted_import;
  return {task_id:task.task_id,baseline_oid:ti.baseline_oid??null,manifest_digest:ti.manifest?.manifest_digest??null,
    snapshot_digest:ti.candidate_snapshot?.snapshot_digest??null,policy_digest:capsuleDigest(ti.policy??{}),
    acceptance_profile_digest:ti.acceptance?.acceptance_profile_digest??null,team_candidate:task.team_candidate??null};
}
function payloadFor(persisted) {
  const e=persisted.approval_evidence;
  return JSON.stringify({operator:e.operator,justification:e.justification,
    decisions:[...persisted.decisions].sort((a,b)=>a.path.localeCompare(b.path)).map(i=>({path:i.path,action:i.action,band:'D',selector_id:i.selector_id??null})),
    approved_at:e.approved_at,binding_context:e.binding_context});
}
export function verifyPersistedHumanApproval(task,env=process.env) {
  try {
    const approval=task.trusted_import?.human_approval,e=approval?.approval_evidence,key=env.AF_OPERATOR_KEY;
    if(!key || !e?.binding_context || !Array.isArray(approval.decisions) || !approval.decisions.length) return false;
    if(capsuleDigest(e.binding_context)!==capsuleDigest(humanApprovalBinding(task))) return false;
    const payload=payloadFor(approval);
    const signature=createHmac('sha256',key).update(payload).digest('hex');
    if(e.audit_digest!==sha256(payload) || !/^[0-9a-f]{64}$/.test(e.signature??'')) return false;
    return timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(e.signature,'hex'));
  } catch {return false;}
}
export function persistedHumanApprovalProvider(env=process.env) {
  return ({task})=>{
    if(!verifyPersistedHumanApproval(task,env)) return null;
    const saved=task.trusted_import.human_approval;
    return approveHumanGate({pendingDecisions:saved.decisions.map(d=>({...d,band:'D',decision:'WAITING_HUMAN'})),
      operatorIdentity:saved.approval_evidence.operator,justification:saved.approval_evidence.justification,bindingContext:humanApprovalBinding(task),
      operatorAuthenticator:({auditPayload})=>({verified:true,signature:createHmac('sha256',env.AF_OPERATOR_KEY).update(auditPayload).digest('hex'),keyId:env.AF_OPERATOR_KEY_ID??'local-operator-key'})});
  };
}
