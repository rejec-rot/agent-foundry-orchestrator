// executor-error-classifier.mjs - PHASE 5-A Executor Error Classification
//
// Pure functional classifier: maps raw process exit evidence (stdout, stderr,
// exit_code, timedOut, spawn_error) into structured safety and retry semantics.
// The Scheduler only reads `retryable` and never parses executor error strings.

export const ERROR_CATEGORIES = Object.freeze({
  ACCOUNT_POLICY: 'ACCOUNT_POLICY',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH_FAILURE: 'AUTH_FAILURE',
  ENVIRONMENT_FAULT: 'ENVIRONMENT_FAULT',
  TRANSIENT_FAULT: 'TRANSIENT_FAULT',
  SUCCESS: 'SUCCESS',
});

export const SAFETY_ACTIONS = Object.freeze({
  OPEN_MANUAL_RESET: 'OPEN_MANUAL_RESET',
  COOLDOWN: 'COOLDOWN',
  NONE: 'NONE',
});

const PATTERNS = {
  ACCOUNT_POLICY: /403|TOS_VIOLATION|Terms of Service|ACCOUNT_DISABLED|account.*disabled|PERMISSION_DENIED/i,
  RATE_LIMIT: /429|ResourceExhausted|rate limit|quota exceeded|too many requests|daily.*(?:limit|quota)|limit.*reached/i,
  AUTH_FAILURE: /401|unauthorized|token expired|auth failed|invalid_token|authentication required/i,
  ENVIRONMENT_FAULT: /CWD_MISSING|ENOENT|binary missing|command not found|GOVERNANCE_DENIED|GOVERNANCE_ENV_REQUIRED|WRITE_CONFLICT|MAX_REVISIONS_EXCEEDED|TASK_ALREADY_RUNNING|SCHEDULER_AT_CAPACITY/i,
};

// stdout heuristics for account/policy refusals.
//
// Some executors report failures on stdout and keep stderr empty: codex runs
// with `--json` and emits JSON Lines there, so an account suspension or a ToS
// refusal can only ever appear on stdout. Matching stdout requires provider
// context, and a workspace test log that merely mentions a 403 must never trip
// the breaker.
// Provider account-state and billing refusals.
//
// These are NOT transient, and treating them as transient is the most dangerous
// direction of error: the account cannot serve requests until a human acts, so a
// retry burns budget, hides the problem, and (for a ban) contradicts the
// documented "403/account refusal => fail-closed, never silently retried"
// guarantee. Measured gaps this table closes:
//
//   OpenAI "account_deactivated"        -> was TRANSIENT/retryable (a BAN retried)
//                                         (the existing pattern only knew "disabled")
//   OpenAI "insufficient_quota"        -> was TRANSIENT/retryable
//   Anthropic "credit balance is too low" -> was TRANSIENT/retryable
//
// Matched against the WHOLE text, because providers disagree about the channel:
// codex runs with --json and writes provider failures to stdout. The
// workspace-test-log guard still applies to stdout-derived hits.
//
// Deliberately absent: a bare `402`. Any output containing the number 402
// ("402 bytes", "402ms") would trip the breaker, so payment signals must be
// textual.
const PROVIDER_ACCOUNT_REFUSAL = Object.freeze([
  // Account state: distinctive tokens. A workspace test log would not contain
  // these, so they are never suppressed.
  { re: /account[^\n]{0,32}(?:deactivated|deactived|disabled|suspended|banned|closed|terminated)/i, ambiguous: false },
  { re: /(?:organization|org)[^\n]{0,32}(?:deactivated|disabled|suspended|banned)/i, ambiguous: false },
  // Billing / quota: distinctive provider tokens.
  { re: /insufficient[_\s-]?quota/i, ambiguous: false },
  { re: /exceeded your current quota/i, ambiguous: false },
  { re: /credit balance is too low/i, ambiguous: false },
  { re: /no (?:credit|credits) (?:remaining|left)/i, ambiguous: false },
  // Prose-like payment wording. A workspace test may legitimately print
  // `assert "payment required" ...`, so on stdout these are ignored when the
  // output looks like a test-runner log. Suppressing them is the lesser evil:
  // a false breaker trip stops EVERY task, whereas a missed one only applies to
  // ambiguous prose that a real provider refusal rarely uses alone.
  { re: /billing[^\n]{0,24}(?:not[_ ]active|hard[_ ]limit|disabled|issue)/i, ambiguous: true },
  { re: /payment required|402\s+payment/i, ambiguous: true },
]);

/**
 * Whether stdout looks like a workspace test-runner log. Used only to suppress
 * the ambiguous prose patterns above.
 */
const STDOUT_TEST_RUNNER_LOG =
  /(?:^|\n)\s*(?:✔|✖|ℹ)\s|AssertionError|\btest\(|\b(?:pass|fail)\s+\d+\b/i;

/**
 * Match a provider account/billing refusal, applying the ambiguity rule.
 * @param {string} errText - spawn_error + stderr (authoritative channel).
 * @param {string} stdout - captured stdout.
 * @returns {{inErr: boolean, inOut: boolean}} where the refusal was seen.
 */
function matchProviderAccountRefusal(errText, stdout) {
  const stdoutIsTestLog = STDOUT_TEST_RUNNER_LOG.test(stdout) || STDOUT_WORKSPACE_TEST_LOG.test(stdout);
  return {
    inErr: PROVIDER_ACCOUNT_REFUSAL.some(({ re }) => re.test(errText)),
    inOut: PROVIDER_ACCOUNT_REFUSAL.some(({ re, ambiguous }) => re.test(stdout) && !(ambiguous && stdoutIsTestLog)),
  };
}

/** Billing/quota refusal, for a reason an operator can act on. */
const BILLING_SIGNAL =
  /insufficient[_\s-]?quota|quota|billing|credit balance|payment required|402\s+payment/i;

/** Account STATE refusal (banned / suspended / closed), as opposed to a ToS case. */
const ACCOUNT_STATE_SIGNAL =
  /account[^\n]{0,32}(?:deactivated|deactived|disabled|suspended|banned|closed|terminated)|(?:organization|org)[^\n]{0,32}(?:deactivated|disabled|suspended|banned)/i;

const STDOUT_POLICY_VIOLATION =
  /403|forbidden|permission[_ ]?denied|terms of service|tos[_\s-]?violation|account[^\n]{0,24}(?:disabled|suspended|banned)/i;
const STDOUT_PROVIDER_CONTEXT =
  /provider|api|model|account|unexpected status|forbidden|permission[_ ]?denied|terms of service|tos[_\s-]?violation/i;
const STDOUT_WORKSPACE_TEST_LOG =
  /✔|✖|\b(?:test|tests|suite|assert|assertionerror)\b[^\n]{0,60}(?:403|forbidden|permission[_ ]?denied)/i;

export function classifyExecutionError(executorType, {
  exit_code = 0,
  stdout = '',
  stderr = '',
  timedOut = false,
  spawn_error = null,
} = {}) {
  // If exit is clean and no timeout/spawn error
  if (exit_code === 0 && !timedOut && !spawn_error) {
    return {
      category: ERROR_CATEGORIES.SUCCESS,
      retryable: false,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: null,
    };
  }

  if (timedOut) {
    return {
      category: ERROR_CATEGORIES.TRANSIENT_FAULT,
      retryable: true,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: 'timeout',
    };
  }

  const errText = `${spawn_error || ''}\n${stderr || ''}`;
  const fullText = `${errText}\n${stdout || ''}`;
  const text = fullText;

  // Account/policy refusal is fail-closed and must never be downgraded to a
  // retryable transient fault just because the evidence arrived on stdout.
  const { inErr: providerRefusalInErr, inOut: providerRefusalInOut } = matchProviderAccountRefusal(errText, stdout);

  const accountPolicyHit =
    PATTERNS.ACCOUNT_POLICY.test(errText)
    || /(?:TOS_VIOLATION|Terms of Service|ACCOUNT_DISABLED|account.*disabled)/i.test(fullText)
    || providerRefusalInErr
    || providerRefusalInOut
    || (STDOUT_POLICY_VIOLATION.test(stdout)
        && STDOUT_PROVIDER_CONTEXT.test(fullText)
        && !STDOUT_WORKSPACE_TEST_LOG.test(stdout));

  if (accountPolicyHit) {
    // Name the family: an operator seeing "billing" knows to add credit, whereas
    // "policy" points at a ToS/ban review.
    const refusalText = `${errText}\n${stdout}`;
    const billing = BILLING_SIGNAL.test(refusalText) && PROVIDER_ACCOUNT_REFUSAL.some(({ re }) => re.test(refusalText));
    const accountState = ACCOUNT_STATE_SIGNAL.test(refusalText);
    // The reason decides what the operator does next, so name the family precisely
    // instead of reporting every refusal as "403/TOS".
    const reason = billing
      ? 'account billing or quota refusal - human action required (add credit / raise quota)'
      : accountState
        ? 'account state refusal (deactivated/disabled/suspended/banned) - operator admission required'
        : 'account or policy violation detected (403/TOS_VIOLATION)';
    return {
      category: ERROR_CATEGORIES.ACCOUNT_POLICY,
      retryable: false,
      safety_action: SAFETY_ACTIONS.OPEN_MANUAL_RESET,
      reason,
    };
  }

  // Rate limit: Check errText (stderr + spawn_error) first.
  // In stdout, only match if it is an explicit provider error and not a workspace test log.
  const isRateLimit = PATTERNS.RATE_LIMIT.test(errText)
    || (PATTERNS.RATE_LIMIT.test(fullText)
        && !/✔.*(?:429|rate\s*limit)|(?:test|tests|suite|pass|fail).*(?:429|rate\s*limit)/i.test(stdout)
        && /(?:provider|api|model|quota|rate\s*limit|resourceexhausted|daily.*limit)/i.test(fullText));

  if (isRateLimit) {
    return {
      category: ERROR_CATEGORIES.RATE_LIMIT,
      retryable: false,
      safety_action: SAFETY_ACTIONS.COOLDOWN,
      reason: 'rate limit or quota exceeded (429)',
    };
  }

  if (PATTERNS.AUTH_FAILURE.test(text)) {
    return {
      category: ERROR_CATEGORIES.AUTH_FAILURE,
      retryable: false,
      safety_action: SAFETY_ACTIONS.OPEN_MANUAL_RESET,
      reason: 'authentication failure or token expired (401)',
    };
  }

  if (PATTERNS.ENVIRONMENT_FAULT.test(text)) {
    return {
      category: ERROR_CATEGORIES.ENVIRONMENT_FAULT,
      retryable: false,
      safety_action: SAFETY_ACTIONS.NONE,
      reason: spawn_error || 'environment or binary fault',
    };
  }

  // Fallback: transient execution error (process crash, syntax failure, timeout, network glitch)
  return {
    category: ERROR_CATEGORIES.TRANSIENT_FAULT,
    retryable: true,
    safety_action: SAFETY_ACTIONS.NONE,
    reason: timedOut ? 'timeout' : (spawn_error || stderr || `exit ${exit_code}`),
  };
}
