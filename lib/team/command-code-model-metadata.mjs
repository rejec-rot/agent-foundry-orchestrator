// Static, read-only reader for the installed Command Code 1.73.0 model picker.
// The CLI bundle is data input only: this module never imports, evaluates, or
// executes it. Unknown syntax stays unknown instead of becoming a guessed list.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SUPPORTED_VERSION = '1.73.0';
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 1000;
const MAX_REGISTRY_ENTRIES = 1000;
const MAX_MAP_ENTRIES = 1000;
const MAX_ID_LENGTH = 500;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const isName = value => /^[A-Za-z_$][\w$]*$/.test(value);
const isModelId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\x00-\x1f\x7f]/.test(value);

function skipQuoted(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue; }
    if (source[i] === quote) return i + 1;
  }
  return -1;
}

function skipComment(source, start) {
  if (source.startsWith('//', start)) {
    const end = source.indexOf('\n', start + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source.startsWith('/*', start)) {
    const end = source.indexOf('*/', start + 2);
    return end < 0 ? -1 : end + 2;
  }
  return start;
}

// This scanner is deliberately limited to structural delimiters and quoted
// text. It does not parse JavaScript expressions or interpret their contents.
function balancedEnd(source, start) {
  const opener = source[start];
  const matching = { '{': '}', '[': ']', '(': ')' };
  if (!matching[opener]) return -1;
  const stack = [matching[opener]];
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') {
      i = skipQuoted(source, i) - 1;
      if (i < 0) return -1;
      continue;
    }
    if (char === '/') {
      const afterComment = skipComment(source, i);
      if (afterComment !== i) {
        if (afterComment < 0) return -1;
        i = afterComment - 1;
        continue;
      }
    }
    if (matching[char]) stack.push(matching[char]);
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function splitTopLevel(source) {
  const parts = [];
  const stack = [];
  const matching = { '{': '}', '[': ']', '(': ')' };
  let start = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') {
      i = skipQuoted(source, i) - 1;
      if (i < 0) return null;
      continue;
    }
    if (char === '/') {
      const afterComment = skipComment(source, i);
      if (afterComment !== i) {
        if (afterComment < 0) return null;
        i = afterComment - 1;
        continue;
      }
    }
    if (matching[char]) stack.push(matching[char]);
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) return null;
    } else if (char === ',' && stack.length === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (stack.length) return null;
  parts.push(source.slice(start).trim());
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

function decodeString(raw) {
  const text = raw.trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) return null;
  let output = '';
  for (let i = 1; i < text.length - 1; i += 1) {
    const char = text[i];
    if (char !== '\\') { output += char; continue; }
    i += 1;
    if (i >= text.length - 1) return null;
    const escaped = text[i];
    const simple = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (Object.hasOwn(simple, escaped)) { output += simple[escaped]; continue; }
    if (escaped === 'x' && /^[\da-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      output += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 3), 16)); i += 2; continue;
    }
    if (escaped === 'u' && /^[\da-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
      output += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16)); i += 4; continue;
    }
    return null;
  }
  return output;
}

function propertyColon(segment) {
  const stack = [];
  const matching = { '{': '}', '[': ']', '(': ')' };
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '"' || char === "'" || char === '`') {
      i = skipQuoted(segment, i) - 1;
      if (i < 0) return -1;
      continue;
    }
    if (char === '/') {
      const afterComment = skipComment(segment, i);
      if (afterComment !== i) {
        if (afterComment < 0) return -1;
        i = afterComment - 1;
        continue;
      }
    }
    if (matching[char]) stack.push(matching[char]);
    else if (char === '}' || char === ']' || char === ')') {
      if (stack.pop() !== char) return -1;
    } else if (char === ':' && stack.length === 0) return i;
  }
  return -1;
}

function propertyKey(raw) {
  const key = raw.trim();
  if (isName(key)) return key;
  if ((key[0] === '"' || key[0] === "'") && decodeString(key) !== null) return decodeString(key);
  return null;
}

function parseProperty(segment) {
  const text = segment.trim();
  if (!text) return null;
  const colon = propertyColon(text);
  if (colon >= 0) {
    const key = propertyKey(text.slice(0, colon));
    return key === null ? null : { key, value: text.slice(colon + 1).trim(), kind: 'value' };
  }
  const getter = text.match(/^(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (getter) return { key: getter[1], kind: 'dynamic' };
  const method = text.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (method) return { key: method[1], kind: 'dynamic' };
  return null;
}

function literalArray(raw) {
  const text = raw.trim();
  if (text[0] !== '[') return null;
  const end = balancedEnd(text, 0);
  if (end !== text.length) return null;
  return splitTopLevel(text.slice(1, -1));
}

function effortArray(raw) {
  const items = literalArray(raw);
  if (!items || items.length > 10) return null;
  const values = [];
  for (const item of items) {
    const value = decodeString(item);
    if (!EFFORTS.has(value) || values.includes(value)) return null;
    values.push(value);
  }
  return values;
}

function assignmentMatches(source, name, rhsPattern = '') {
  if (!isName(name)) return [];
  const pattern = new RegExp(`(?:^|[;,])\\s*(?:(?:var|let|const)\\s+)?${name}\\s*=\\s*${rhsPattern}`, 'g');
  return [...source.matchAll(pattern)];
}

function assignedLiteral(source, name, opener) {
  const matches = assignmentMatches(source, name, `\\${opener}`);
  if (matches.length !== 1) return null;
  const match = matches[0];
  const start = match.index + match[0].length - 1;
  const end = balancedEnd(source, start);
  return end < 0 ? null : source.slice(start, end);
}

function assignedString(source, name) {
  const matches = assignmentMatches(source, name, '(?:"|\')');
  if (matches.length !== 1) return null;
  const match = matches[0];
  const start = match.index + match[0].length - 1;
  const end = skipQuoted(source, start);
  return end < 0 ? null : decodeString(source.slice(start, end));
}

function functionBodies(source, name) {
  if (!isName(name)) return [];
  const pattern = new RegExp(`\\bfunction\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
  const bodies = [];
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    const end = balancedEnd(source, open);
    if (end < 0) return [];
    bodies.push(source.slice(open + 1, end - 1));
  }
  return bodies;
}

function uniqueFunctionBody(source, name) {
  const bodies = functionBodies(source, name);
  return bodies.length === 1 ? bodies[0] : null;
}

function parseObjectProperties(raw) {
  const text = raw.trim();
  if (text[0] !== '{') return null;
  const end = balancedEnd(text, 0);
  if (end !== text.length) return null;
  const segments = splitTopLevel(text.slice(1, -1));
  if (!segments) return null;
  return segments.filter(Boolean).map(parseProperty);
}

function stringConstant(source, raw) {
  const text = raw.trim();
  if (text[0] === '"' || text[0] === "'") return decodeString(text);
  return isName(text) ? assignedString(source, text) : null;
}

function parseStaticArray(source, raw, mode) {
  const items = literalArray(raw);
  if (!items || items.length > MAX_REGISTRY_ENTRIES) return null;
  const out = [];
  for (const item of items) {
    if (mode === 'efforts') {
      const values = effortArray(item) ?? (isName(item.trim()) ? effortArray(assignedLiteral(source, item.trim(), '[') ?? '') : null);
      if (!values) return null;
      out.push(values);
    } else {
      const value = stringConstant(source, item);
      if (!isModelId(value)) return null;
      out.push(value);
    }
  }
  return out;
}

function parseModelRecord(source, raw) {
  const properties = parseObjectProperties(raw);
  if (!properties) return null;
  let id = null, idCount = 0, idMalformed = false;
  let effortCount = 0, efforts = null, effortMalformed = false;
  for (const property of properties) {
    if (!property) {
      idMalformed = true;
      effortMalformed = true;
      continue;
    }
    if (property.key === 'id') {
      idCount += 1;
      if (property.kind !== 'value') idMalformed = true;
      else id = stringConstant(source, property.value);
    }
    if (property.key === 'reasoningEfforts') {
      effortCount += 1;
      if (property.kind !== 'value') effortMalformed = true;
      else {
        efforts = effortArray(property.value);
        if (!efforts) effortMalformed = true;
      }
    }
  }
  if (idCount !== 1 || idMalformed || !isModelId(id)) return null;
  return {
    id,
    effortsKind: effortCount === 0 ? (effortMalformed ? 'unknown' : 'absent') : effortCount === 1 && !effortMalformed ? 'explicit' : 'unknown',
    efforts,
  };
}

function parseCatalog(source, symbol) {
  const raw = assignedLiteral(source, symbol, '{');
  const properties = raw ? parseObjectProperties(raw) : null;
  if (!properties || properties.length === 0 || properties.length > MAX_REGISTRY_ENTRIES) return null;
  const records = [];
  const keys = new Set();
  for (const property of properties) {
    if (!property || property.kind !== 'value' || property.key === null) return null;
    if (keys.has(property.key)) return null;
    keys.add(property.key);
    const record = parseModelRecord(source, property.value);
    if (!record) return null;
    records.push(record);
  }
  return records;
}

function parseMapDeclaration(source, symbol) {
  if (!isName(symbol)) return null;
  const pattern = new RegExp(`(?:^|[;,])\\s*(?:(?:var|let|const)\\s+)?${symbol}\\s*=\\s*new\\s+Map\\s*\\(`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf('(');
  const end = balancedEnd(source, open);
  if (end < 0) return null;
  const entries = literalArray(source.slice(open + 1, end - 1));
  if (!entries || entries.length > MAX_MAP_ENTRIES) return null;
  const mapped = new Map();
  for (const entryRaw of entries) {
    const entry = literalArray(entryRaw);
    if (!entry || entry.length !== 2) return null;
    const key = stringConstant(source, entry[0]);
    if (!isModelId(key) || mapped.has(key)) return null;
    const valueRaw = entry[1].trim();
    const values = effortArray(valueRaw) ?? (isName(valueRaw) ? effortArray(assignedLiteral(source, valueRaw, '[') ?? '') : null);
    mapped.set(key, values === null ? { unknown: true } : { efforts: values });
  }
  return mapped;
}

function parseStaticStringObject(source, symbol) {
  const raw = assignedLiteral(source, symbol, '{');
  const properties = raw ? parseObjectProperties(raw) : null;
  if (!properties || properties.length > MAX_REGISTRY_ENTRIES) return null;
  const result = new Map();
  for (const property of properties) {
    if (!property || property.kind !== 'value' || result.has(property.key)) return null;
    const value = stringConstant(source, property.value);
    if (!isModelId(value)) return null;
    result.set(property.key.toLowerCase(), value);
  }
  return result;
}

function parseCanonicalIdSet(source, symbol) {
  if (!isName(symbol)) return null;
  const pattern = new RegExp(`(?:^|[;,])\\s*(?:(?:var|let|const)\\s+)?${symbol}\\s*=\\s*new\\s+Set\\s*\\(`, 'g');
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const open = match.index + match[0].lastIndexOf('(');
  const end = balancedEnd(source, open);
  if (end < 0) return null;
  const values = parseStaticArray(source, source.slice(open + 1, end - 1), 'strings');
  if (!values || values.length === 0) return null;
  const byLowercase = new Map();
  for (const value of values) if (!byLowercase.has(value.toLowerCase())) byLowercase.set(value.toLowerCase(), value);
  return byLowercase;
}

function singleCapture(source, regex) {
  const matches = [...source.matchAll(regex)];
  return matches.length === 1 ? matches[0][1] : null;
}

function validatePickerStructure(source) {
  const allOptionsBody = uniqueFunctionBody(source, 'getAllModelOptions');
  const catalogSymbol = allOptionsBody && singleCapture(allOptionsBody, /^\s*return\s+Object\.values\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?\s*$/g);
  if (!catalogSymbol) return null;

  const groupsBody = uniqueFunctionBody(source, 'getModelGroupsInOrder');
  if (!groupsBody || !/^\s*return\s+groupModelsByDisplayOrder\(getAllModelOptions\(\)\.filter\(e=>!e\.hidden\)\)\s*;?\s*$/.test(groupsBody)) return null;
  const buildGroupsBody = uniqueFunctionBody(source, 'buildModelGroups');
  if (!buildGroupsBody?.startsWith(`const t=Object.values(${catalogSymbol}).filter(e=>!e.hidden),n=[];`)) return null;
  const normalGroup = singleCapture(source, /\bvar\s+[A-Za-z_$][\w$]*=buildModelGroups\("co"\),([A-Za-z_$][\w$]*)=buildModelGroups\("normal"\)/g);
  if (!normalGroup) return null;
  const pickerGroupsBody = uniqueFunctionBody(source, 'buildModelPickerGroups');
  if (!pickerGroupsBody?.startsWith('const t=e.normalModeGroups.flatMap(e=>e.models)')) return null;
  const catalogPickerBody = uniqueFunctionBody(source, 'buildCatalogModelPickerGroups');
  if (!catalogPickerBody?.includes(`buildModelPickerGroups({normalModeGroups:${normalGroup}})`)) return null;
  if (!source.includes('const n=useCustomModelsReady(),o=mt(()=>buildCatalogModelPickerGroups(),[n])')) return null;

  const effortGetterBody = uniqueFunctionBody(source, 'getSupportedEfforts');
  const effortCompact = effortGetterBody?.replace(/\s+/g, '') ?? '';
  const fallbackMapSymbol = singleCapture(effortCompact, /^const\w+=canonicalizeModelId\(\{model:"string"==typeof\w+\?\w+:\w+\.model\}\);return([A-Za-z_$][\w$]*)\.get\(\w+\)\?\?null$/g);
  if (!fallbackMapSymbol) return null;
  const pickerEffort = 'const e=z.model.reasoningEfforts??getSupportedEfforts(z.model.id)??[];return it.createElement(Y_,{modelLabel:z.model.label,supportedEfforts:e';
  const selectionEffort = 'const n=t.model.reasoningEfforts??getSupportedEfforts(t.model.id);if(!c&&n&&n.length>0)return K(t),void V("effort")';
  if (source.split(pickerEffort).length !== 2 || !source.includes(selectionEffort)) return null;

  const displayBody = uniqueFunctionBody(source, 'displayModelId');
  const displayCompact = displayBody?.replace(/\s+/g, '') ?? '';
  const suffixSymbol = singleCapture(displayCompact, /^return\w+\.replace\(([A-Za-z_$][\w$]*),""\)\.toLowerCase\(\)$/g);
  if (!suffixSymbol || source.split(`${suffixSymbol}=/[-@]\\d{8}$/`).length !== 2) return null;
  const formatterBody = uniqueFunctionBody(source, 'formatModelListText');
  if (!formatterBody?.includes('displayModelId(e.id)')) return null;
  const listBody = uniqueFunctionBody(source, 'formatModelList');
  if (!listBody?.includes('formatModelListText({') || !listBody.includes('getModelGroupsInOrder()')) return null;

  const canonicalBody = uniqueFunctionBody(source, 'canonicalizeModelId')?.replace(/\s+/g, '') ?? '';
  const canonicalNames = canonicalBody.match(/^const\{model:([A-Za-z_$][\w$]*)\}=e;if\(!\1\)return\1;const\w+=tryResolveCanonical\(\1\);if\(\w+\)return\w+;const\w+=\1\.replace\(([A-Za-z_$][\w$]*),""\);return\w+===\1\?\1:tryResolveCanonical\(\w+\)\?\?\1$/);
  if (!canonicalNames || canonicalNames[2] !== suffixSymbol) return null;
  const findBody = uniqueFunctionBody(source, 'findKnownById')?.replace(/\s+/g, '') ?? '';
  const knownSymbol = singleCapture(findBody, /^for\(const\w+of([A-Za-z_$][\w$]*)\)if\(\w+\.toLowerCase\(\)===\w+\)return\w+$/g);
  const tryBody = uniqueFunctionBody(source, 'tryResolveCanonical')?.replace(/\s+/g, '') ?? '';
  const aliasSymbol = singleCapture(tryBody, /^returnfindKnownById\(\(([A-Za-z_$][\w$]*)\[\w+\.toLowerCase\(\)\]\?\?\w+\)\.toLowerCase\(\)\)$/g);
  if (!knownSymbol || !aliasSymbol) return null;

  const catalog = parseCatalog(source, catalogSymbol);
  const fallbackMap = parseMapDeclaration(source, fallbackMapSymbol);
  const aliases = parseStaticStringObject(source, aliasSymbol);
  const knownIds = parseCanonicalIdSet(source, knownSymbol);
  if (!catalog || !fallbackMap || !aliases || !knownIds) return null;
  return { catalog, fallbackMap, aliases, knownIds, suffixSymbol };
}

function canonicalizeModelId(id, { aliases, knownIds }) {
  const resolve = candidate => {
    const mapped = aliases.get(candidate.toLowerCase()) ?? candidate;
    return knownIds.get(mapped.toLowerCase()) ?? null;
  };
  const direct = resolve(id);
  if (direct) return direct;
  const stripped = id.replace(/[-@]\d{8}$/, '');
  if (stripped === id) return id;
  return resolve(stripped) ?? id;
}

function normalizeDisplayId(id) {
  return id.replace(/[-@]\d{8}$/, '').toLowerCase();
}

function safeModelId(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(model, 'id');
  return descriptor && Object.hasOwn(descriptor, 'value') && isModelId(descriptor.value) ? descriptor.value : null;
}

function packageFiles(binary) {
  try {
    if (typeof binary !== 'string' || binary.length === 0 || binary.length > 4096) return null;
    const resolved = realpathSync(binary);
    const dist = dirname(resolved), root = dirname(dist);
    if (basename(dist) !== 'dist' || basename(root) !== 'command-code' || basename(dirname(root)) !== 'node_modules') return null;
    if (resolved !== join(root, 'dist', 'index.mjs')) return null;
    const manifestPath = join(root, 'package.json'), cliPath = join(root, 'dist', 'cli.mjs');
    if (realpathSync(manifestPath) !== manifestPath || realpathSync(cliPath) !== cliPath) return null;
    const manifestStat = statSync(manifestPath), bundleStat = statSync(cliPath);
    if (!manifestStat.isFile() || manifestStat.size > MAX_PACKAGE_JSON_BYTES || !bundleStat.isFile() || bundleStat.size > MAX_BUNDLE_BYTES) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest?.name !== 'command-code' || manifest?.version !== SUPPORTED_VERSION || manifest?.main !== 'dist/cli.mjs' || manifest?.bin?.['command-code'] !== 'dist/index.mjs') return null;
    return { root, manifest, source: readFileSync(cliPath, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * Read exact reasoning-effort options from the installed Command Code picker.
 * `models` is the parsed result of that binary's metadata-only --list-models.
 * Returns one projection per input model, or null if the package or the picker
 * source cannot be tied to the supported static registry structure.
 */
export function queryCommandCodeModelMetadata({ binary, models } = {}) {
  if (!Array.isArray(models) || models.length > MAX_MODELS) return null;
  const ids = models.map(safeModelId);
  if (ids.some(id => !id)) return null;

  const files = packageFiles(binary);
  if (!files) return null;
  const parsed = validatePickerStructure(files.source);
  if (!parsed) return null;

  const duplicateListed = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  const listedNormalizedCounts = new Map();
  for (const id of ids) {
    const key = normalizeDisplayId(id);
    listedNormalizedCounts.set(key, (listedNormalizedCounts.get(key) ?? 0) + 1);
  }

  const byDisplayId = new Map();
  const ambiguousDisplayIds = new Set();
  for (const record of parsed.catalog) {
    const displayId = normalizeDisplayId(record.id);
    if (byDisplayId.has(displayId)) ambiguousDisplayIds.add(displayId);
    else {
      let result;
      if (record.effortsKind === 'explicit') {
        result = { efforts: record.efforts, source: 'Command Code picker model record' };
      } else if (record.effortsKind === 'unknown') {
        result = null;
      } else {
        const canonical = canonicalizeModelId(record.id, parsed);
        const fallback = parsed.fallbackMap.get(canonical);
        result = fallback ? (fallback.unknown ? null : { efforts: fallback.efforts, source: 'Command Code picker fallback map' })
          : { efforts: [], source: 'Command Code picker empty default' };
      }
      byDisplayId.set(displayId, result);
    }
  }

  return models.map((model, index) => {
    const id = ids[index], key = normalizeDisplayId(id);
    const metadata = duplicateListed.has(id) || listedNormalizedCounts.get(key) !== 1 || ambiguousDisplayIds.has(key)
      ? null : byDisplayId.get(key) ?? null;
    if (!metadata) return { id, reasoning_efforts: [], reasoning_status: 'unverified', reasoning_control: 'unknown', reasoning_source: null };
    const efforts = [...metadata.efforts];
    return {
      id,
      reasoning_efforts: efforts,
      reasoning_status: 'verified',
      reasoning_control: efforts.length ? 'effort' : 'none',
      reasoning_source: metadata.source,
    };
  });
}
