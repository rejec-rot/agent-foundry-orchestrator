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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CSRF_HEADER = 'x-af-csrf';
export const LOCAL_SESSION_COOKIE = 'af_local_session';
export const LOCAL_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

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

function loopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized;
  const parts = ipv4.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && Number(parts[0]) === 127;
}

/**
 * Resolve the exact local origin represented by this socket's Host header.
 * The Host port must name the actual local listening port; accepting arbitrary Host values here
 * would let a cookie issued for one local service be replayed against another one.
 */
function localRequestContext(req) {
  if (!loopbackAddress(req?.socket?.remoteAddress)) return null;
  const rawHost = req?.headers?.host;
  if (typeof rawHost !== 'string') return null;
  const hostMatch = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(rawHost);
  if (!hostMatch) return null;
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  let parsed;
  try { parsed = new URL(`${protocol}//${rawHost}`); } catch { return null; }
  const hostname = hostMatch[1].toLowerCase();
  const parsedHostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
    || (hostname === '[::1]' ? parsedHostname !== '::1' : parsedHostname !== hostname)) return null;
  const port = parsed.port ? Number(parsed.port) : (protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port !== Number(req.socket.localPort)) return null;
  const host = `${hostname}:${port}`;
  const origin = parsed.origin;
  return { host, origin };
}

function sameOriginRequest(req, context, { requireOrigin = true } = {}) {
  const fetchSite = req?.headers?.['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, reason: 'Sec-Fetch-Site must be same-origin for local authorization' };
  }
  if (req?.headers?.[CSRF_HEADER] !== '1') {
    return { ok: false, status: 403, reason: `the ${CSRF_HEADER}: 1 header is required for local authorization` };
  }
  const origin = req?.headers?.origin;
  if (requireOrigin && (typeof origin !== 'string' || origin !== context.origin)) {
    return { ok: false, status: 403, reason: `the Origin must match this local server (${context.origin})` };
  }
  return { ok: true, status: 200, reason: null };
}

/** Return whether a bearer token is configured and presented correctly, without applying CSRF. */
export function hasValidWriteToken(req, token) {
  if (!token?.configured) return false;
  const presented = presentedToken(req);
  return Boolean(presented && constantTimeEquals(presented, token.token));
}

/**
 * Process-local, statelessly signed browser sessions for one-click localhost authorization.
 * The HMAC key and bounded active-nonce map are intentionally created per server instance, so a
 * restart invalidates every cookie and revocation takes effect immediately.
 */
export function createLocalWriteSessionAuth({ now = () => Date.now(), ttlMs = LOCAL_SESSION_TTL_MS, maxSessions = 128 } = {}) {
  const key = randomBytes(32);
  const active = new Map();

  function purgeExpired(at = now()) {
    for (const [nonce, session] of active) {
      if (at - session.issued >= ttlMs || at < session.issued) active.delete(nonce);
    }
  }

  function cookieValue(req) {
    const raw = req?.headers?.cookie;
    if (typeof raw !== 'string') return null;
    for (const part of raw.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== LOCAL_SESSION_COOKIE) continue;
      return part.slice(separator + 1).trim();
    }
    return null;
  }

  function decode(req) {
    const context = localRequestContext(req);
    if (!context) return { ok: false, status: 403, reason: 'local authorization is only valid from loopback using localhost, 127.0.0.1 or [::1] on this server port' };
    const value = cookieValue(req);
    if (!value) return { ok: false, status: 401, reason: null };
    const [payloadText, signature, extra] = value.split('.');
    if (!payloadText || !signature || extra !== undefined) return { ok: false, status: 401, reason: 'the local authorization session is invalid' };
    const expected = createHmac('sha256', key).update(payloadText).digest('base64url');
    if (!constantTimeEquals(signature, expected)) return { ok: false, status: 401, reason: 'the local authorization session is invalid' };
    let claims;
    try { claims = JSON.parse(Buffer.from(payloadText, 'base64url').toString('utf8')); } catch { return { ok: false, status: 401, reason: 'the local authorization session is invalid' }; }
    if (!claims || Object.keys(claims).sort().join(',') !== 'issued,nonce'
      || !Number.isSafeInteger(claims.issued) || typeof claims.nonce !== 'string') {
      return { ok: false, status: 401, reason: 'the local authorization session is invalid' };
    }
    const at = now();
    purgeExpired(at);
    const activeSession = active.get(claims.nonce);
    if (!activeSession || at < claims.issued || at - claims.issued > ttlMs
      || activeSession.issued !== claims.issued) {
      return { ok: false, status: 401, reason: 'the local authorization session has expired or was revoked' };
    }
    if (activeSession.host !== context.host || activeSession.origin !== context.origin) {
      return { ok: false, status: 403, reason: 'the local authorization session is bound to a different local origin' };
    }
    return { ok: true, status: 200, reason: null, claims, context, activeSession };
  }

  function validateControlRequest(req) {
    const context = localRequestContext(req);
    if (!context) return { ok: false, status: 403, reason: 'local authorization is only available from loopback using localhost, 127.0.0.1 or [::1] on this server port' };
    return sameOriginRequest(req, context, { requireOrigin: true });
  }

  function issue(req) {
    const checked = validateControlRequest(req);
    if (!checked.ok) return checked;
    const context = localRequestContext(req);
    const at = now();
    purgeExpired(at);
    const prior = decode(req);
    const priorNonce = prior.ok ? prior.claims.nonce : null;
    if (active.size - (priorNonce ? 1 : 0) >= maxSessions) return { ok: false, status: 503, reason: 'the local authorization session limit has been reached; revoke or wait for an existing session to expire' };
    if (priorNonce) active.delete(priorNonce);
    const claims = { issued: at, nonce: randomBytes(18).toString('base64url') };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', key).update(payload).digest('base64url');
    active.set(claims.nonce, { ...claims, host: context.host, origin: context.origin });
    const secure = req.socket.encrypted ? '; Secure' : '';
    return {
      ok: true,
      status: 200,
      reason: null,
      cookie: `${LOCAL_SESSION_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Strict${secure}`,
      nonce: claims.nonce,
    };
  }

  function authorizeRequest(req) {
    const value = cookieValue(req);
    if (!value) return { ok: false, status: 401, reason: null };
    const decoded = decode(req);
    if (!decoded.ok) return decoded;
    const context = decoded.context;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (isWrite) {
      const checked = sameOriginRequest(req, context, { requireOrigin: true });
      if (!checked.ok) return checked;
    } else {
      const fetchSite = req?.headers?.['sec-fetch-site'];
      if (fetchSite !== undefined && fetchSite !== 'same-origin') {
        return { ok: false, status: 403, reason: 'Sec-Fetch-Site must be same-origin for local authorization' };
      }
    }
    return decoded;
  }

  function revoke(req) {
    const checked = validateControlRequest(req);
    if (!checked.ok) return checked;
    const decoded = decode(req);
    if (decoded.ok) active.delete(decoded.claims.nonce);
    return { ok: true, status: 200, reason: null, cookie: `${LOCAL_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${req.socket.encrypted ? '; Secure' : ''}` };
  }

  return {
    isLocalRequest: (req) => Boolean(localRequestContext(req)),
    validateControlRequest,
    issue,
    authorizeRequest,
    isAuthorized: (req) => authorizeRequest(req).ok,
    revoke,
    clearCookie: (req) => `${LOCAL_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${req?.socket?.encrypted ? '; Secure' : ''}`,
  };
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
export function authorizeWrite({ req, token, expectedHosts = [], localSessionAuth = null } = {}) {
  if (!token?.configured) {
    return { ok: false, status: 403, reason: `writes are disabled: ${token?.reason ?? 'no token configured'}` };
  }

  const bearerAuthorized = hasValidWriteToken(req, token);
  let sessionAuthorized = false;
  if (!bearerAuthorized && localSessionAuth) {
    const result = localSessionAuth.authorizeRequest(req);
    sessionAuthorized = result.ok;
    if (!sessionAuthorized && result.reason) return { ok: false, status: result.status, reason: result.reason };
  }
  if (!bearerAuthorized && !sessionAuthorized) {
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
  if (sessionAuthorized && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (typeof origin !== 'string' || origin.length === 0)) {
    return { ok: false, status: 403, reason: 'the Origin header is required for a local authorization session' };
  }

  return { ok: true, status: 200, reason: null };
}
