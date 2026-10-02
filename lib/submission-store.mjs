// Single submission ledger: PREPARED -> CREATING -> TASK_CREATED. Task lifecycle stays in tasks/.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireTaskLock, releaseTaskLock } from './tasklock.mjs';
import { writeJsonAtomic } from './store.mjs';
import { capsuleDigest } from './json-identity.mjs';

export const submissionKeyDigest = (key) => createHash('sha256').update(String(key).trim()).digest('hex').slice(0, 16);

export function withSubmissionKeyLock({dir,key},operation) {
  mkdirSync(dir,{recursive:true});const keyDigest=submissionKeyDigest(key);let owned;
  try {owned=acquireTaskLock(dir,`submission-${keyDigest}`,{orchestratorInstanceId:`submission-${process.pid}-${randomUUID()}`});}
  catch(err){return {ok:false,reason:`submission is being updated: ${err.message}`};}
  try{return operation({keyDigest,file:join(dir,`${keyDigest}.json`)});}
  finally{releaseTaskLock(dir,`submission-${keyDigest}`,owned.lock);}
}

export function readSubmissionRecord(file) {
  try { return { ok: true, record: JSON.parse(readFileSync(file, 'utf8')) }; }
  catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: true, record: null };
    return { ok: false, reason: `submission record unreadable: ${err.message}` };
  }
}

export function submissionRequestMetadata(spec) {
  return { profile_id: spec.profile_id ?? null, proposed_required: Array.isArray(spec.proposed_required) && spec.proposed_required.length ? spec.proposed_required : ['.'] };
}

/** Serialize creation and recording per key, including crash recovery of an incomplete creation. */
export function withSubmissionRecord({ dir, spec, capsule, stripped = [], now = Date.now() }, update = null) {
  return withSubmissionKeyLock({dir,key:spec.idempotency_key},({keyDigest,file})=>{
    const read = readSubmissionRecord(file);
    if (!read.ok) return read;
    const digest = capsuleDigest(capsule);
    const metadata = submissionRequestMetadata(spec);
    const requestDigest = capsuleDigest({ capsule, ...metadata });
    const duplicate = !!read.record;
    if (read.record && (read.record.spec_digest !== digest || (read.record.request_digest && read.record.request_digest !== requestDigest))) {
      return { ok: false, reason: `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC: key ${keyDigest} already recorded a different submission`, existing: { ...read.record, record_file: file } };
    }
    const record = read.record ?? {
      schema_version: 'af-submission-v1', idempotency_key_digest: keyDigest, spec_digest: digest,
      capsule, stripped_fields: stripped, state: 'PREPARED', started: false, recorded_at: new Date(now).toISOString(),
    };
    // Old PREPARED records remain readable; add the request identity at their next authorized write.
    record.request_digest ??= requestDigest;
    record.request_metadata ??= metadata;
    const persist = () => writeJsonAtomic(file, record);
    if (!duplicate) writeJsonAtomic(file, record, { noOverwrite: true });
    if (update) return update({ record, persist, file, keyDigest, duplicate });
    return { ok: true, duplicate, record: { ...record, record_file: file } };
  });
}
