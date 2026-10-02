// lib/trusted-import/policy.mjs
//
// Trusted Policy Bundle & JSON Pointer Selector Verification (§5, §5.1, §5.3).
// Handles policy canonicalization, glob matching against allowed/forbidden/protected
// rules, and normalized JSON subtree comparison for `protected_json` (TI-19).

import { HardDenyError, sha256 } from './common.mjs';
import { matchPathPattern } from './projection.mjs';

function canonicalJson(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Standard default trusted policy structure.
 */
export const DEFAULT_TRUSTED_POLICY = Object.freeze({
  allowed_root: Object.freeze(['src/**', 'tests/**', 'package.json', 'README.md']),
  forbidden: Object.freeze([
    '.git/**',
    'tasks/**',
    'runtime/**',
    'contracts/**',
    'config/**',
    'lib/**',
    'af-admin.mjs',
    'orchestrator.mjs',
  ]),
  protected_paths: Object.freeze([
    '.github/workflows/**',
    'SECURITY.md',
    'NOTICE.md',
  ]),
  protected_json: Object.freeze([
    'package.json#/scripts',
    'package.json#/packageManager',
  ]),
  projection: Object.freeze({
    exclude: Object.freeze(['.env', 'secrets/**', '**/*.pem', '**/*.key']),
    synthesize_dirs: Object.freeze(['tmp']),
  }),
  import: Object.freeze({
    deny: Object.freeze(['.env', 'secrets/**', '**/*.pem', '**/*.key']),
  }),
});

/**
 * Canonicalize a policy bundle and compute its immutable bundle_digest (C5).
 *
 * @param {object} policy
 * @returns {object} Frozen canonical policy with bundle_digest
 */
export function canonicalizePolicy(policy = {}) {
  const merged = {
    allowed_root: [...(policy.allowed_root || DEFAULT_TRUSTED_POLICY.allowed_root)].sort(),
    forbidden: [...(policy.forbidden || DEFAULT_TRUSTED_POLICY.forbidden)].sort(),
    protected_paths: [...(policy.protected_paths || DEFAULT_TRUSTED_POLICY.protected_paths)].sort(),
    protected_json: [...(policy.protected_json || DEFAULT_TRUSTED_POLICY.protected_json)].sort(),
    projection: {
      exclude: [...(policy.projection?.exclude || DEFAULT_TRUSTED_POLICY.projection.exclude)].sort(),
      synthesize_dirs: [...(policy.projection?.synthesize_dirs || DEFAULT_TRUSTED_POLICY.projection.synthesize_dirs)].sort(),
    },
    import: {
      deny: [...(policy.import?.deny || DEFAULT_TRUSTED_POLICY.import.deny)].sort(),
    },
  };

  const canonicalString = JSON.stringify(merged);
  const bundleDigest = sha256(canonicalString);

  return Object.freeze({
    ...merged,
    bundle_digest: bundleDigest,
    section_digests: Object.freeze({
      allowed_root: sha256(JSON.stringify(merged.allowed_root)),
      forbidden: sha256(JSON.stringify(merged.forbidden)),
      protected_paths: sha256(JSON.stringify(merged.protected_paths)),
      protected_json: sha256(JSON.stringify(merged.protected_json)),
      projection: sha256(JSON.stringify(merged.projection)),
      import: sha256(JSON.stringify(merged.import)),
    }),
  });
}

/**
 * Resolve a JSON Pointer (RFC 6901 subset) on an object.
 * @param {any} root
 * @param {string} pointer - e.g. "/scripts" or "/nested/field"
 * @returns {any}
 */
export function resolveJsonPointer(root, pointer) {
  if (!pointer || pointer === '#' || pointer === '/' || pointer === '') {
    return root;
  }
  const clean = pointer.startsWith('#') ? pointer.slice(1) : pointer;
  const segments = clean.split('/').filter(Boolean);

  let current = root;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    const unescaped = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    current = current[unescaped];
  }
  return current;
}

/**
 * Check whether a change to a JSON file modifies protected subtrees (TI-19).
 * Parses both old and new content to compare normalized JSON values.
 * Merely reformatting / re-indenting does NOT trigger protection.
 * Invalid JSON fails closed as B(i) Hard Deny.
 *
 * @param {object} options
 * @param {string} options.path - File path (e.g. 'package.json')
 * @param {string|Buffer|null} options.oldContent - Baseline content
 * @param {string|Buffer|null} options.newContent - Candidate content
 * @param {string[]} [options.protectedJsonSelectors] - e.g. ['package.json#/scripts']
 * @returns {{ hitProtected: boolean, selector: string|null, reason: string|null }}
 */
export function evaluateProtectedJson({
  path,
  oldContent,
  newContent,
  protectedJsonSelectors = [],
}) {
  const applicableSelectors = protectedJsonSelectors.filter((sel) => {
    const [file] = sel.split('#');
    return file === path;
  });

  if (applicableSelectors.length === 0) {
    return { hitProtected: false, selector: null, reason: null };
  }

  // Parse baseline JSON
  let oldJson = null;
  if (oldContent !== null && oldContent !== undefined) {
    try {
      const text = Buffer.isBuffer(oldContent) ? oldContent.toString('utf8') : String(oldContent);
      oldJson = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      throw new HardDenyError(`Baseline contains invalid JSON in "${path}": ${err.message}`, {
        code: 'INVALID_JSON_SYNTAX',
        path,
        source: 'baseline',
      });
    }
  }

  // Parse candidate JSON (fail-closed if invalid syntax, TI-19)
  let newJson = null;
  if (newContent !== null && newContent !== undefined) {
    try {
      const text = Buffer.isBuffer(newContent) ? newContent.toString('utf8') : String(newContent);
      newJson = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      throw new HardDenyError(`Candidate produced invalid JSON in "${path}": ${err.message}`, {
        code: 'INVALID_JSON_SYNTAX',
        path,
        source: 'candidate',
      });
    }
  }

  for (const selector of applicableSelectors) {
    const [, pointer] = selector.split('#');
    const oldSub = resolveJsonPointer(oldJson, pointer);
    const newSub = resolveJsonPointer(newJson, pointer);

    // Deep canonical comparison of normalized subtrees. A shallow JSON
    // replacer silently omitted keys nested below the protected object.
    const oldCanonical = canonicalJson(oldSub);
    const newCanonical = canonicalJson(newSub);

    if (oldCanonical !== newCanonical) {
      return {
        hitProtected: true,
        selector,
        reason: `Protected JSON field altered at ${selector}`,
      };
    }
  }

  return { hitProtected: false, selector: null, reason: null };
}
