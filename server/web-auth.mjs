// web-auth.mjs - the write-path authentication and origin checks (V2-FRONTEND-PLAN §7.3).
//
// "The control-plane API must not be an unauthenticated command entry." Reads stay open on
// loopback, but every WRITE now needs three independent things:
//
//   1. a bearer token from a private file (never shipped in the repo, never echoed back), compared
//      in constant time;
//   2. a custom header (`x-af-csrf`) that a cross-origin browser form cannot set without a CORS
//      preflight we never grant - the cheap, reliable CSRF guard for a loopback service;
//   3. an Origin that matches the server's own, when the browser sends one at all.
//
// A missing token configuration means writes are DISABLED, not "open": the server refuses to
// expose a mutating route it cannot authenticate.

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CSRF_HEADER = 'x-af-csrf';

/**
 * Resolve the write token. `AF_WEB_TOKEN_FILE` (preferred: keeps the secret out of the process
 * environment) or `AF_WEB_TOKEN`.
 * @returns {{ configured: boolean, token: string|null, source: string|null, reason: string|null }}
 */
export function resolveWriteToken(env = process.env) {
  const file = env.AF_WEB_TOKEN_FILE;
  if (file) {
    try {
      const token = readFileSync(file, 'utf8').trim();
      if (!token) return { configured: false, token: null, source: file, reason: `the token file ${file} is empty` };
      return { configured: true, token, source: file, reason: null };
    } catch (err) {
      return { configured: false, token: null, source: file, reason: `the token file ${file} could not be read: ${err.message}` };
    }
  }
  const inline = env.AF_WEB_TOKEN;
  if (inline && inline.trim()) return { configured: true, token: inline.trim(), source: 'AF_WEB_TOKEN', reason: null };
  return { configured: false, token: null, source: null, reason: 'no write token is configured (set AF_WEB_TOKEN_FILE)' };
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Constant-time token comparison, tolerant of the two sane header spellings. */
export function presentedToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const direct = req.headers?.['x-af-token'];
  return typeof direct === 'string' ? direct.trim() : null;
}

/**
 * Authorise one write request.
 * @returns {{ ok: boolean, status: number, reason: string|null }}
 */
export function authorizeWrite({ req, token, expectedHosts = [] } = {}) {
  if (!token?.configured) {
    return { ok: false, status: 403, reason: `writes are disabled: ${token?.reason ?? 'no token configured'}` };
  }

  const presented = presentedToken(req);
  if (!presented || !constantTimeEquals(presented, token.token)) {
    return { ok: false, status: 401, reason: 'a valid write token is required (Authorization: Bearer <token>)' };
  }

  // A cross-origin <form> can POST without a preflight, so require a header only fetch() can set.
  const csrf = req.headers?.[CSRF_HEADER];
  if (csrf !== '1') {
    return { ok: false, status: 403, reason: `the ${CSRF_HEADER}: 1 header is required (a cross-origin form cannot set it without a preflight we never grant)` };
  }

  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    const allowed = new Set(expectedHosts.map((host) => `http://${host}`).concat(expectedHosts.map((host) => `https://${host}`)));
    if (!allowed.has(origin)) return { ok: false, status: 403, reason: `the Origin ${origin} does not match this server` };
  }

  return { ok: true, status: 200, reason: null };
}
