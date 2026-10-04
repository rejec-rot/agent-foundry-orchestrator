// Optional Jev-backed suggestions for Planner runs. Results are advisory records only;
// this module never writes team state or starts workers.
import { redactSecrets } from '../boundary-notify.mjs';
import {
  CONFIDENCE_BANDS,
  MAX_CHOICE_OPTIONS,
  decide,
  decisionModelConfig,
} from '../decision-model.mjs';
import { effortOptions } from './agent-options.mjs';

const KINDS = new Set(['plan', 'revise', 'coordinate']);
const EFFORTS = new Set(['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_CANDIDATES = MAX_CHOICE_OPTIONS;
const MAX_CATALOG_MODELS = 10_000;
const MAX_STATE_TEXT = 2_000;
const EXECUTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const REASONS = Object.freeze({
  off: '快速决策建议未启用；Planner按常规流程处理。',
  unconfigured: '快速决策服务未配置；Planner按常规流程处理。',
  unavailable: '快速决策服务暂不可用；Planner按常规流程处理。',
  invalid: '建议输入或类型化响应无效；Planner按常规流程处理。',
  suggested: '收到高置信度建议，供Planner参考。',
  low_confidence: '建议置信度不足，Planner按常规流程完成决策。',
});
const REVISION_FOCUS = Object.freeze({
  clarify_goal: '先澄清目标和约束',
  clarify_contract: '先补清验收条件和交付约定',
  repair_implementation: '先修正实现中的问题',
  align_dependencies: '先对齐现有任务之间的依赖关系',
});

function catalogModelName(value, env) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && value.trim() === value && !value.startsWith('-') && !value.startsWith('/') && !value.startsWith('\\')
    && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('://') && !/[\x00-\x1f\x7f]/.test(value)
    && !(typeof env?.AF_TYPESAFE_API_KEY === 'string' && env.AF_TYPESAFE_API_KEY && value.includes(env.AF_TYPESAFE_API_KEY));
}

function publicModelId(value, env) {
  if (typeof value !== 'string' || !PUBLIC_MODEL_ID.test(value) || value.includes('://') || /^(?:sk-|tk_|bearer\b)/i.test(value)) return null;
  if (typeof env?.AF_TYPESAFE_API_KEY === 'string' && env.AF_TYPESAFE_API_KEY && value.includes(env.AF_TYPESAFE_API_KEY)) return null;
  return value;
}

/** A deliberately small config view for Planner/UI use; it never exposes an endpoint or key. */
export function plannerDecisionConfig(env = process.env) {
  const cfg = decisionModelConfig(env);
  const enabled = cfg.mode === 'jev' && cfg.mode_valid;
  const configured = cfg.api_key_configured;
  const available = enabled && configured && /^https:\/\//i.test(cfg.endpoint);
  return {
    provider: 'jev',
    enabled,
    configured,
    model: publicModelId(cfg.model, env),
    available,
  };
}

function record(status, kind, started, details = {}) {
  const confidence = details.confidence ?? null;
  return {
    status,
    provider: 'jev',
    model: details.model ?? null,
    kind,
    confidence,
    recommendation: details.recommendation ?? null,
    reason: REASONS[status],
    duration_ms: Math.max(0, Date.now() - started),
    catalog_limited: details.catalog_limited ?? false,
    candidate_count: details.candidate_count ?? 0,
  };
}

function cleanText(value, env, maxLength = MAX_STATE_TEXT) {
  if (typeof value !== 'string') return '';
  let safe = redactSecrets(value, { maxLength: null });
  const apiKey = typeof env?.AF_TYPESAFE_API_KEY === 'string' ? env.AF_TYPESAFE_API_KEY : '';
  if (apiKey) safe = safe.split(apiKey).join('<redacted>');
  // Remove private absolute path tokens on both common path syntaxes. State contains no
  // path fields; this also catches paths embedded in goals, feedback and work descriptions.
  safe = safe.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>;,!?(){}\[\]]+/g, '<redacted-path>');
  safe = safe.replace(/\/(?:[^\s"'<>;,!?(){}\[\]]+\/)*[^\s"'<>;,!?(){}\[\]]+/g, (path) =>
    path === '/' ? path : '<redacted-path>');
  return safe.slice(0, maxLength);
}

function safeReviewFeedback(value, env) {
  if (typeof value === 'string') return cleanText(value, env, 4_000);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const list = (items) => Array.isArray(items)
    ? items.filter((item) => typeof item === 'string').slice(0, 12).map((item) => cleanText(item, env, 600))
    : [];
  return {
    decision: cleanText(value.decision ?? value.verdict ?? value.status, env, 80),
    summary: cleanText(value.summary, env, 1_200),
    issues: list(value.issues),
    required_changes: list(value.required_changes),
  };
}

function safeState(team, kind, env) {
  const planning = team?.planning && typeof team.planning === 'object' ? team.planning : {};
  const messages = Array.isArray(team?.messages) ? team.messages : [];
  const currentMessages = messages.filter((message) => message?.goal_revision === team?.goal_revision);
  const state = {
    task: cleanText(team?.goal, env, 8_000),
    operation: kind,
    operator_context: currentMessages
      .filter((message) => message?.from_agent_id === 'operator' && message?.to_agent_id === 'lead'
        && ['queued', 'received', 'applied'].includes(message?.status))
      .slice(-6).map((message) => cleanText(message?.message, env, 500)),
    current_feedback: currentMessages
      .filter((message) => message?.to_agent_id === 'lead' && message?.from_agent_id
        && !['operator', 'lead'].includes(message.from_agent_id)
        && ['queued', 'received'].includes(message?.status))
      .slice(-4).map((message) => cleanText(message?.message, env, 500)),
  };
  if (kind === 'coordinate') {
    state.work_items = (Array.isArray(team?.work_items) ? team.work_items : []).map((item) => ({
      work_item_id: item?.work_item_id,
      goal: cleanText(item?.goal, env),
      output_contract: cleanText(item?.output_contract, env),
      status: cleanText(item?.status, env, 80),
      blocked_reason: cleanText(item?.blocked_reason, env),
      review_feedback: cleanText(item?.review_feedback, env),
    }));
    state.review_feedback = safeReviewFeedback(team?.review_feedback, env);
  } else {
    state.work_items = (Array.isArray(team?.work_items) ? team.work_items : []).slice(0, 32).map((item) => ({
      work_item_id: item?.work_item_id,
      goal: cleanText(item?.goal, env),
      depends_on: Array.isArray(item?.depends_on) ? item.depends_on.filter((id) => typeof id === 'string' && EXECUTOR_ID.test(id)).slice(0, 32) : [],
      status: cleanText(item?.status, env, 80),
    }));
    const preferences = planning.worker_preferences;
    if (kind !== 'revise' && Array.isArray(preferences)) state.worker_preferences = preferences.slice(0, 8).map((profile) => ({
      executor_type: profile?.executor_type,
      model: profile?.model ?? null,
      effort: profile?.effort ?? null,
    }));
    if (kind === 'revise') {
      const request = (Array.isArray(team?.rework_requests) ? team.rework_requests : [])
        .find((candidate) => candidate?.status === 'queued');
      if (request) state.rework_request = {
        work_item_id: request.work_item_id,
        affected_items: Array.isArray(request.affected_items) ? request.affected_items.filter((id) => typeof id === 'string' && EXECUTOR_ID.test(id)).slice(0, 32) : [],
        feedback: cleanText(request.feedback, env, 2_000),
        agent_id: typeof request.agent_id === 'string' && EXECUTOR_ID.test(request.agent_id) ? request.agent_id : null,
      };
      state.worker_profiles = (Array.isArray(team?.members) ? team.members : [])
        .filter((member) => member?.role === 'worker').slice(0, 8).map((member) => ({
          executor_type: member.executor_type,
          model: member.model ?? null,
          effort: member.effort ?? null,
        }));
    }
  }
  return state;
}

function validProfileShape(profile) {
  return profile && typeof profile === 'object'
    && typeof profile.executor_type === 'string' && EXECUTOR_ID.test(profile.executor_type)
    && (profile.model === null || catalogModelName(profile.model))
    && (profile.effort === null || (typeof profile.effort === 'string' && EFFORTS.has(profile.effort)));
}

function catalogEntries(catalog, env) {
  if (!Array.isArray(catalog) || catalog.length > 128) return null;
  const entries = [];
  const seen = new Set();
  for (const entry of catalog) {
    const id = entry?.executor_type ?? entry?.id;
    if (typeof id !== 'string' || !EXECUTOR_ID.test(id) || seen.has(id)) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.models) && entry.models.length > MAX_CATALOG_MODELS) return null;
    seen.add(id);
    const models = Array.isArray(entry.models)
      ? entry.models.filter((model) => catalogModelName(model?.id, env))
      : [];
    entries.push({ ...entry, executor_type: id, models });
  }
  return entries;
}

function legalProfile(profile, entries, catalog, env) {
  if (!validProfileShape(profile)) return false;
  const entry = entries.find((candidate) => candidate.executor_type === profile.executor_type);
  if (!entry) return false;
  const models = entry.models.filter((candidate) => candidate && catalogModelName(candidate.id, env) && !candidate.configured_only);
  if (profile.model !== null && (!catalogModelName(profile.model, env) || !models.some((candidate) => candidate.id === profile.model))) return false;
  if (profile.model !== null && entry.supports_model === false) return false;
  if (profile.model === null && entry.requires_model === true) {
    const defaultModel = entry.default_model;
    if (typeof defaultModel !== 'string' || !models.some((candidate) => candidate.id === defaultModel)) return false;
  }
  if (profile.effort !== null) {
    const selectedModel = profile.model ?? entry.default_model;
    if (typeof selectedModel !== 'string') return false;
    const model = models.find((candidate) => candidate.id === selectedModel);
    if (!model || model.reasoning_status !== 'verified') return false;
    const exactEfforts = effortOptions(entry.executor_type, profile.model, { catalog });
    if (!exactEfforts.includes(profile.effort) || !EFFORTS.has(profile.effort)) return false;
  }
  return true;
}

function profileKey(profile) {
  return JSON.stringify([profile.executor_type, profile.model, profile.effort]);
}

function profilesFor(entries, catalog, preferences = [], env) {
  const profiles = [];
  const seen = new Set();
  const byKey = new Map();
  const add = (profile) => {
    if (!legalProfile(profile, entries, catalog, env)) return false;
    const key = profileKey(profile);
    if (seen.has(key)) return true;
    seen.add(key);
    const candidate = { executor_type: profile.executor_type, model: profile.model, effort: profile.effort };
    profiles.push(candidate);
    byKey.set(key, candidate);
    return true;
  };

  // Human-selected profiles are inserted before the bounded catalog choices so truncation
  // can never erase them. Invalid/stale preferences are reported as an invalid advisory.
  for (const profile of preferences) {
    if (!add({ executor_type: profile.executor_type, model: profile.model ?? null, effort: profile.effort ?? null })) return null;
  }

  const variantGroups = [];
  for (const entry of entries) {
    add({ executor_type: entry.executor_type, model: null, effort: null });
    for (const model of entry.models.slice(0, MAX_CATALOG_MODELS)) {
      if (!model || !catalogModelName(model.id, env) || model.configured_only) continue;
      add({ executor_type: entry.executor_type, model: model.id, effort: null });
      const effortList = model.reasoning_status === 'verified'
        ? effortOptions(entry.executor_type, model.id, { catalog }).filter((effort) => EFFORTS.has(effort))
        : [];
      if (effortList.length) variantGroups.push({ executor_type: entry.executor_type, model: model.id, efforts: [...new Set(effortList)] });
    }
  }

  // Spread non-default effort variants across models before considering the next grade.
  const maxDepth = variantGroups.reduce((max, group) => Math.max(max, group.efforts.length), 0);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const group of variantGroups) {
      const effort = group.efforts[depth];
      if (effort !== undefined) add({ executor_type: group.executor_type, model: group.model, effort });
    }
  }
  return { profiles, byKey };
}

function profileCriteria(profiles) {
  const criteria = {};
  const map = new Map();
  for (let i = 0; i < profiles.length; i += 1) {
    const key = `profile_${i + 1}`;
    const profile = profiles[i];
    const model = profile.model === null ? 'executor default' : profile.model;
    const effort = profile.effort === null ? 'executor default' : profile.effort;
    criteria[key] = `${profile.executor_type}; model=${model}; effort=${effort}`;
    map.set(key, profile);
  }
  return { criteria, map };
}

function confidenceOf(answer) {
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return null;
  return typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null;
}

function answerFor(answers, name, criteria) {
  const answer = answers?.[name];
  const confidence = confidenceOf(answer);
  if (confidence === null || !Object.hasOwn(criteria, answer.choice)) return null;
  return { choice: answer.choice, confidence };
}

function statusesForConfidence(confidence) {
  if (confidence >= CONFIDENCE_BANDS.HIGH) return 'suggested';
  return 'low_confidence';
}

/**
 * Ask Jev for typed Planner hints. The call is one-shot, timeout/cancellation-aware and
 * strictly advisory. It never returns prompt text, raw answers, endpoints, credentials or
 * provider errors.
 */
export async function proposePlannerDecision({ team, kind, catalog, env = process.env, decideImpl = decide, signal } = {}) {
  const started = Date.now();
  if (!KINDS.has(kind)) {
    const safeKind = typeof kind === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(kind) ? kind : 'unknown';
    return record('off', safeKind, started);
  }

  const cfg = decisionModelConfig(env);
  const configuredModel = publicModelId(cfg.model, env);
  const finish = (status, details = {}) => record(status, kind, started, { model: configuredModel, ...details });
  if (cfg.mode !== 'jev' || !cfg.mode_valid) return finish('off');
  if (!cfg.api_key_configured) return finish('unconfigured');
  if (!/^https:\/\//i.test(cfg.endpoint)) return finish('unavailable');
  if (!team || typeof team !== 'object') return finish('invalid');

  const questions = {};
  let workerCount = null;
  let preferences = [];
  let profilePool = null;
  let profileQuestionCriteria = null;
  let pinnedChoiceKeys = [];
  let catalogLimited = false;
  let candidateCount = 0;
  let expectedRetry = [];
  let queuedRequest = null;

  if (kind === 'coordinate') {
    const workItems = Array.isArray(team.work_items) ? team.work_items : [];
    if (!workItems.length || workItems.length > 32) return finish('invalid');
    const seenIds = new Set();
    for (const item of workItems) {
      const id = item?.work_item_id;
      if (typeof id !== 'string' || !EXECUTOR_ID.test(id) || seenIds.has(id)) return finish('invalid');
      seenIds.add(id);
      expectedRetry.push(id);
      questions[`retry_${id}`] = {
        type: 'choice',
        instructions: 'Should this existing work item be included in the suggested rework set? Choose yes or no, and report confidence in that choice.',
        criteria: { yes: '建议将此工作项加入返工集合', no: '建议保留此工作项当前结果' },
      };
    }
    candidateCount = workItems.length;
  } else {
    const entries = catalogEntries(catalog, env);
    if (!entries?.length) return finish('invalid');
    const planning = team.planning && typeof team.planning === 'object' ? team.planning : {};
    const hasPreferences = Object.hasOwn(planning, 'worker_preferences');
    if (hasPreferences) {
      if (!Array.isArray(planning.worker_preferences) || planning.worker_preferences.length < 1 || planning.worker_preferences.length > 8) return finish('invalid');
      preferences = planning.worker_preferences;
      if (preferences.some((profile) => !profile || typeof profile !== 'object' || !validProfileShape({
        executor_type: profile.executor_type,
        model: profile.model ?? null,
        effort: profile.effort ?? null,
      }))) return finish('invalid');
      workerCount = preferences.length;
    }

    if (kind === 'revise') {
      const workItems = Array.isArray(team.work_items) ? team.work_items : [];
      if (!workItems.length || workItems.length > 32) return finish('invalid');
      const existingIds = new Set();
      for (const item of workItems) {
        if (typeof item?.work_item_id !== 'string' || !EXECUTOR_ID.test(item.work_item_id) || existingIds.has(item.work_item_id)) return finish('invalid');
        existingIds.add(item.work_item_id);
      }
      queuedRequest = (Array.isArray(team.rework_requests) ? team.rework_requests : [])
        .find((request) => request?.status === 'queued') ?? null;
      const affected = queuedRequest?.affected_items;
      if (!queuedRequest || typeof queuedRequest.work_item_id !== 'string' || !existingIds.has(queuedRequest.work_item_id)
        || !Array.isArray(affected) || !affected.length || affected.length > 32
        || affected.some((id) => typeof id !== 'string' || !EXECUTOR_ID.test(id) || !existingIds.has(id))
        || new Set(affected).size !== affected.length || !affected.includes(queuedRequest.work_item_id)) return finish('invalid');
      expectedRetry = [...affected];
      const workers = (Array.isArray(team.members) ? team.members : []).filter((member) => member?.role === 'worker');
      if (!workers.length || workers.length > 8) return finish('invalid');
      preferences = workers.map((member) => ({
        executor_type: member.executor_type,
        model: member.model ?? null,
        effort: member.effort ?? null,
      }));
      workerCount = preferences.length;
      questions.revision_focus = {
        type: 'choice',
        instructions: 'Choose one finite revision focus that helps the Planner answer the queued change request while preserving its existing task graph and worker assignments. Report confidence in this focus.',
        criteria: { ...REVISION_FOCUS },
      };
    }

    const generated = profilesFor(entries, catalog, preferences, env);
    if (!generated || !generated.profiles.length) return finish('invalid');
    profilePool = generated.profiles;
    candidateCount = profilePool.length;
    catalogLimited = candidateCount > MAX_CANDIDATES;
    profilePool = profilePool.slice(0, MAX_CANDIDATES);
    const allCriteria = profileCriteria(profilePool);
    profileQuestionCriteria = allCriteria.criteria;

    if (workerCount === null) {
      const countCriteria = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`count_${index + 1}`, `${index + 1} workers`]));
      questions.worker_count = {
        type: 'choice',
        instructions: 'Choose the number of Workers that best fits the task, between 1 and 8. Report confidence in the selected count.',
        criteria: countCriteria,
      };
      workerCount = 8; // ask profile questions in one request, then use only the chosen prefix
    }

    const questionCount = preferences.length || 8;
    for (let index = 0; index < questionCount; index += 1) {
      const name = `worker_${index + 1}`;
      let criteria = profileQuestionCriteria;
      if (preferences.length) {
        const preferenceIndex = profilePool.findIndex((p) => profileKey(p) === profileKey({
          executor_type: preferences[index].executor_type,
          model: preferences[index].model ?? null,
          effort: preferences[index].effort ?? null,
        }));
        const key = `profile_${preferenceIndex + 1}`;
        if (!Object.hasOwn(profileQuestionCriteria, key)) return finish('invalid');
        pinnedChoiceKeys.push(key);
        criteria = { [key]: profileQuestionCriteria[key] };
      }
      questions[name] = {
        type: 'choice',
        instructions: preferences.length
          ? kind === 'revise'
            ? 'This Worker profile is already part of the active plan. Select the only provided profile and report confidence that it remains suitable; do not change the team composition.'
            : 'The operator fixed this Worker profile. Select the only provided profile and report confidence that it fits the task; do not change it.'
          : 'Choose the best legal executor/model/effort profile for this Worker from the catalog. Profiles may be reused. Report confidence in the selected profile.',
        criteria,
      };
    }
  }

  const state = safeState(team, kind, env);
  if (kind === 'coordinate') {
    // The mapping is explicit in state and every question names one existing work item ID.
    state.work_item_ids = expectedRetry;
  }

  let decision;
  try {
    if (signal?.aborted) return finish('unavailable', { catalog_limited: catalogLimited, candidate_count: candidateCount });
    const decisionEnv = { ...env, AF_TYPESAFE_TIMEOUT_MS: String(Math.min(cfg.timeout_ms, 3_000)) };
    decision = await decideImpl({ state, questions, env: decisionEnv, signal, deps: { maxRetries: 0 } });
  } catch {
    return finish('unavailable', { catalog_limited: catalogLimited, candidate_count: candidateCount });
  }
  if (!decision || decision.ok !== true || !decision.answers || typeof decision.answers !== 'object') {
    const status = decision?.provider === 'off' ? 'off'
      : /AF_TYPESAFE_API_KEY/i.test(String(decision?.reason ?? '')) ? 'unconfigured'
        : 'unavailable';
    return finish(status, { catalog_limited: catalogLimited, candidate_count: candidateCount });
  }

  const confidences = [];
  let recommendation;
  if (kind === 'coordinate') {
    const retryIds = [];
    for (const id of expectedRetry) {
      const criteria = questions[`retry_${id}`].criteria;
      const answer = answerFor(decision.answers, `retry_${id}`, criteria);
      if (!answer) return finish('invalid', { catalog_limited: false, candidate_count: candidateCount });
      confidences.push(answer.confidence);
      if (answer.choice === 'yes') retryIds.push(id);
    }
    recommendation = { worker_count: null, workers: [], retry_work_item_ids: retryIds };
  } else {
    if (preferences.length) {
      for (let index = 0; index < preferences.length; index += 1) {
        const name = `worker_${index + 1}`;
        const criteria = questions[name].criteria;
        const answer = answerFor(decision.answers, name, criteria);
        if (!answer || answer.choice !== pinnedChoiceKeys[index]) return finish('invalid', { catalog_limited: catalogLimited, candidate_count: candidateCount });
        confidences.push(answer.confidence);
      }
      let revisionFocus = null;
      if (kind === 'revise') {
        const focusAnswer = answerFor(decision.answers, 'revision_focus', questions.revision_focus.criteria);
        if (!focusAnswer) return finish('invalid', { catalog_limited: catalogLimited, candidate_count: candidateCount });
        revisionFocus = focusAnswer.choice;
        confidences.push(focusAnswer.confidence);
      }
      recommendation = {
        worker_count: preferences.length,
        workers: preferences.map((profile) => ({
          executor_type: profile.executor_type,
          model: profile.model ?? null,
          effort: profile.effort ?? null,
        })),
        retry_work_item_ids: kind === 'revise' ? expectedRetry : [],
        ...(kind === 'revise' ? { revision_focus: revisionFocus } : {}),
      };
    } else {
      const count = answerFor(decision.answers, 'worker_count', questions.worker_count.criteria);
      if (!count || !/^count_[1-8]$/.test(count.choice)) return finish('invalid', { catalog_limited: catalogLimited, candidate_count: candidateCount });
      const chosenCount = Number(count.choice.slice('count_'.length));
      confidences.push(count.confidence);
      const workers = [];
      for (let index = 0; index < chosenCount; index += 1) {
        const answer = answerFor(decision.answers, `worker_${index + 1}`, profileQuestionCriteria);
        if (!answer) return finish('invalid', { catalog_limited: catalogLimited, candidate_count: candidateCount });
        const profile = profilePool[Number(answer.choice.slice('profile_'.length)) - 1];
        if (!profile || answer.choice !== `profile_${Number(answer.choice.slice('profile_'.length))}`) return finish('invalid', { catalog_limited: catalogLimited, candidate_count: candidateCount });
        confidences.push(answer.confidence);
        workers.push({ executor_type: profile.executor_type, model: profile.model, effort: profile.effort });
      }
      recommendation = { worker_count: chosenCount, workers, retry_work_item_ids: [] };
    }
  }

  const confidence = Math.min(...confidences);
  const status = statusesForConfidence(confidence);
  return finish(status, {
    confidence,
    recommendation: confidence < CONFIDENCE_BANDS.MEDIUM ? null : recommendation,
    catalog_limited: catalogLimited,
    candidate_count: candidateCount,
  });
}
