// Shared acceptance policy for submission and execution. Only this process's Node path
// aliases 'node'; arbitrary absolute paths with the same basename gain no authorization.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const POLICY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Trusted acceptance commands: `config/acceptance-allowlist.json` or AF_ACCEPTANCE_ALLOWLIST. */
export function acceptanceAllowlistFile(env = process.env, cwd = POLICY_ROOT) {
  return env.AF_ACCEPTANCE_ALLOWLIST || join(cwd, 'config', 'acceptance-allowlist.json');
}

/** Strict read: a corrupt allowlist is a refusal, never "no commands allowed" and never "any". */
export function loadAcceptanceAllowlist({ file = acceptanceAllowlistFile() } = {}) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { ok: false, configured: false, allowed: [], reason: `acceptance allowlist not found at ${file}` };
    return { ok: false, configured: true, allowed: [], reason: `acceptance allowlist unreadable: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.allowed)) return { ok: false, configured: true, allowed: [], reason: 'acceptance allowlist has no "allowed" array' };
    if (parsed.allowed.some((entry) => !entry || typeof entry.command !== 'string' || !entry.command.length || (entry.args_prefix !== undefined && (!Array.isArray(entry.args_prefix) || entry.args_prefix.some((arg) => typeof arg !== 'string'))))) {
      return { ok: false, configured: true, allowed: [], reason: 'invalid acceptance allowlist entry' };
    }
    const allowed = parsed.allowed
      .filter((entry) => entry && typeof entry.command === 'string' && entry.command.length > 0)
      .map((entry) => ({ command: entry.command, args_prefix: Array.isArray(entry.args_prefix) ? entry.args_prefix.map(String) : [] }));
    return { ok: true, configured: true, allowed, reason: null, file };
  } catch (err) {
    return { ok: false, configured: true, allowed: [], reason: `acceptance allowlist is not valid JSON: ${err.message}` };
  }
}

/** An acceptance command matches when the command equals an entry and its args start with the prefix. */
export function acceptanceCommandAllowed(acceptance, allowlist) {
  if (!acceptance || typeof acceptance.command !== 'string' || acceptance.command.length === 0) {
    return { ok: false, reason: 'acceptance.command is required' };
  }
  const args = Array.isArray(acceptance.args) ? acceptance.args.map(String) : [];
  if (acceptance.args !== undefined && !Array.isArray(acceptance.args)) return { ok: false, reason: 'acceptance.args must be an array' };
  const entry = (allowlist?.allowed ?? []).find((candidate) => (candidate.command === acceptance.command || (acceptance.command === process.execPath && candidate.command === 'node'))
    && candidate.args_prefix.every((value, index) => args[index] === value));
  if (!entry) return { ok: false, reason: `acceptance command is not on the allowlist: ${acceptance.command} ${args.join(' ')}`.trim() };
  return { ok: true, entry };
}
