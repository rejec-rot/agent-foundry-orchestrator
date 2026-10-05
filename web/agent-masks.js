/**
 * Original angular masks for executor identities.
 *
 * A mask belongs to the executor, never its role, model, state, or list position.
 * Eye apertures are real transparent cutouts, so the artwork works on both the
 * paper and ink surfaces without a background-colour dependency.
 */
const masks = {
  cline: {
    id: 'fox', name: '狐影',
    silhouette: 'M6 6 24 18 32 15 40 18 58 6 53 31 46 47 32 58 18 47 11 31Z',
    eyes: 'M14 26 28 30 24 36 17 33Z M50 26 36 30 40 36 47 33Z',
    cuts: 'M19 41 29 45 25 48Z M45 41 35 45 39 48Z M29 38H35L32 42Z',
    accent: 'M30 49H34L32 53Z',
  },
  'command-code': {
    id: 'visor', name: '先锋',
    silhouette: 'M4 23 13 16H51L60 23 55 41 44 48 37 44 32 36 27 44 20 48 9 41Z',
    eyes: 'M12 25H27L25 35H15Z M37 25H52L49 35H39Z',
    cuts: 'M13 19H26L25 21H12Z M38 19H51L52 21H39Z M10 38 22 41 21 44 12 40Z M54 38 42 41 43 44 52 40Z',
    accent: 'M29 20H35L32 25Z',
  },
  dsh: {
    id: 'oni', name: '鬼角',
    silhouette: 'M8 3 23 17 32 13 41 17 56 3 52 28 58 35 49 49 32 59 15 49 6 35 12 28Z',
    eyes: 'M14 27 29 30 25 36 17 33Z M50 27 35 30 39 36 47 33Z',
    cuts: 'M20 43 25 41 29 44 32 41 35 44 39 41 44 43 40 50 36 47 32 51 28 47 24 50Z M29 20 32 17 35 20 32 25Z',
    accent: 'M29 35H35L32 40Z',
  },
  pi: {
    id: 'owl', name: '夜枭',
    silhouette: 'M7 17 18 9 32 15 46 9 57 17 54 39 46 49 32 60 18 49 10 39Z',
    eyes: 'M14 23 22 19 29 25 27 35 18 37 12 31Z M50 23 42 19 35 25 37 35 46 37 52 31Z',
    cuts: 'M17 42 25 42 28 46 23 48Z M47 42 39 42 36 46 41 48Z',
    features: 'M20 25H24V31H20Z M40 25H44V31H40Z',
    accent: 'M29 37H35L32 46Z',
  },
  qoder: {
    id: 'cat', name: '猫刃',
    silhouette: 'M9 4 25 18H39L55 4 54 36 47 48 32 56 17 48 10 36Z',
    eyes: 'M14 26 28 28 25 34 17 33Z M50 26 36 28 39 34 47 33Z',
    cuts: 'M12 38 23 40 22 43 14 42Z M52 38 41 40 42 43 50 42Z M14 45 24 45 25 48 18 47Z M50 45 40 45 39 48 46 47Z M29 37H35L32 41Z',
    accent: 'M31 43H33V49H31Z',
  },
  codex: {
    id: 'raven', name: '渡鸦',
    silhouette: 'M2 16 20 20 32 10 44 20 62 16 53 38 42 44 32 61 22 44 11 38Z',
    eyes: 'M12 25 28 29 24 35 17 34Z M52 25 36 29 40 35 47 34Z',
    cuts: 'M9 21 19 24 17 27 11 25Z M55 21 45 24 47 27 53 25Z M22 40 29 43 27 47Z M42 40 35 43 37 47Z',
    accent: 'M30 35H34L36 44 32 52 28 44Z',
  },
  claude: {
    id: 'corona', name: '日冕',
    silhouette: 'M7 22 10 11 18 17 23 5 32 14 41 5 46 17 54 11 57 22 54 39 44 51 32 58 20 51 10 39Z',
    eyes: 'M14 27 28 29 26 35 14 33Z M50 27 36 29 38 35 50 33Z',
    cuts: 'M17 40H25L28 44 23 47Z M47 40H39L36 44 41 47Z M28 49H36L32 53Z',
    accent: 'M32 18 36 22 32 26 28 22Z',
  },
  antigravity: {
    id: 'orbit', name: '悬轨',
    silhouette: 'M2 25 10 14 12 23 14 14 23 6H41L50 14 52 23 54 14 62 25 53 35 49 45 40 52H24L15 45 11 35Z',
    eyes: 'M16 24H28L26 35H17Z M36 24H48L47 35H38Z',
    cuts: 'M21 11H43L46 15H18Z M21 43H43L39 47H25Z M14 37H22L23 40H17Z M50 37H42L41 40H47Z',
    accent: 'M30 22H34V36L32 40 30 36Z',
  },
  kiro: {
    id: 'stag', name: '林角',
    silhouette: 'M10 3 19 12 16 2 23 9 26 20 32 23 38 20 41 9 48 2 45 12 54 3 51 20 44 28 48 37 41 48 32 58 23 48 16 37 20 28 13 20Z',
    eyes: 'M21 29 29 32 27 38 20 35Z M43 29 35 32 37 38 44 35Z',
    cuts: 'M22 42 28 44 27 49 24 46Z M42 42 36 44 37 49 40 46Z',
    accent: 'M32 39 36 43 32 50 28 43Z',
  },
  opencode: {
    id: 'split', name: '裂面',
    silhouette: 'M9 20 4 8 24 15 36 3 43 17 59 22 54 41 44 49 32 59 20 50 13 39Z',
    eyes: 'M15 26 28 28 25 35 17 33Z M39 24 51 28 47 35 37 33Z',
    cuts: 'M35 16 39 18 30 51 27 53Z M18 41 26 43 24 47Z M39 41 46 39 43 46 37 49Z',
    accent: 'M41 17 46 18 44 23 39 21Z',
  },
  gemini: {
    id: 'twins', name: '双星',
    silhouette: 'M2 28 10 19 15 4 24 14 32 23 40 14 49 4 54 19 62 28 52 35 53 46 42 48 32 59 22 48 11 46 12 35Z',
    eyes: 'M14 25 22 20 28 27 22 34 14 31Z M50 25 42 20 36 27 42 34 50 31Z',
    cuts: 'M30 28H34V47L32 52 30 47Z M17 39 26 40 23 45 18 43Z M47 39 38 40 41 45 46 43Z',
    accent: 'M20 13 25 17 22 21 18 17Z M44 13 39 17 42 21 46 17Z',
  },
  'qwen-code': {
    id: 'cloud', name: '云纹',
    silhouette: 'M4 25 10 18V11H22L26 5H39L44 12H53L60 21 57 37 49 48 38 53 32 58 24 51 14 48 7 36Z',
    eyes: 'M14 28 28 30 25 36 17 35Z M50 28 36 30 39 36 47 35Z',
    cuts: 'M13 17H24L27 11H38L42 17H50V21H39L35 16H30L27 21H13Z M20 44H44L39 48H25Z',
    accent: 'M29 37H35L37 41H27Z',
  },
  aider: {
    id: 'stitch', name: '缝刃',
    silhouette: 'M11 10 46 5 57 19 52 43 39 52 25 59 14 47 6 26Z',
    eyes: 'M14 25 29 27 24 35 17 33Z M40 26 50 29 46 35 36 34Z',
    cuts: 'M35 14 38 15 35 22 32 21Z M31 24 34 25 31 32 28 31Z M27 34 30 35 27 42 24 41Z M23 44 26 45 23 52 20 51Z M35 43 45 40 42 46 33 49Z',
    accent: 'M40 13 44 12 29 48 26 50Z',
  },
  goose: {
    id: 'longbill', name: '长喙',
    silhouette: 'M9 15 24 8H40L55 15 51 33 42 37 35 59H29L22 37 13 33Z',
    eyes: 'M15 24 28 25 25 32 17 30Z M49 24 36 25 39 32 47 30Z',
    cuts: 'M18 13H46L44 16H20Z M23 36 29 38 27 45Z M41 36 35 38 37 45Z',
    accent: 'M30 34H34V53L32 56 30 53Z',
  },
  copilot: {
    id: 'winghelm', name: '翼盔',
    silhouette: 'M2 7 18 19 24 10H40L46 19 62 7 57 28 48 36V44L39 54H25L16 44V36L7 28Z',
    eyes: 'M20 25H29L27 32H20Z M35 25H44V32H37Z',
    cuts: 'M9 17 17 23 15 27 11 24Z M55 17 47 23 49 27 53 24Z M22 40H42V44H22Z',
    accent: 'M29 14H35V21H29Z',
  },
};

// Unknown executors receive a stable design from a separate small repertoire.
// FNV-1a uses only their normalized ID: discovery order has no visual effect.
// This is a four-family fallback, so different unknown IDs can share a mask.
const unknownMasks = [
  {
    id: 'nomad', name: '旅面',
    silhouette: 'M9 16 22 7 32 12 42 7 55 16 52 40 42 51 32 58 22 51 12 40Z',
    eyes: 'M16 25 28 27 25 35 17 33Z M48 25 36 27 39 35 47 33Z',
    cuts: 'M20 43H27L26 48Z M44 43H37L38 48Z',
    accent: 'M29 18H35L32 23Z',
  },
  {
    id: 'sentinel', name: '卫面',
    silhouette: 'M14 8H50L57 20 52 45 40 54 32 59 24 54 12 45 7 20Z',
    eyes: 'M15 26H28L25 34H17Z M36 26H49L47 34H39Z',
    cuts: 'M17 13H47V17H17Z M24 44H40L36 49H28Z',
    accent: 'M30 20H34V38H30Z',
  },
  {
    id: 'viper', name: '蛇面',
    silhouette: 'M5 22 15 8 27 16 32 11 37 16 49 8 59 22 50 43 39 47 32 59 25 47 14 43Z',
    eyes: 'M13 24 28 28 24 35 17 32Z M51 24 36 28 40 35 47 32Z',
    cuts: 'M19 41 28 42 25 48Z M45 41 36 42 39 48Z',
    accent: 'M29 37H35L34 45 32 48 30 45Z',
  },
  {
    id: 'harlequin', name: '菱面',
    silhouette: 'M32 3 42 16 56 18 51 39 42 48 32 60 22 48 13 39 8 18 22 16Z',
    eyes: 'M16 25 28 29 23 36 17 32Z M48 25 36 29 41 36 47 32Z',
    cuts: 'M20 41 26 43 25 47Z M44 41 38 43 39 47Z M28 50H36L32 54Z',
    accent: 'M32 14 36 20 32 26 28 20Z',
  },
];

const escapeAttribute = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function executorKey(executorId) {
  const key = String(executorId ?? '').trim().toLowerCase() || 'unknown';
  return key === 'cmd' ? 'command-code' : key;
}

function maskFor(executorId) {
  const key = executorKey(executorId);
  if (Object.hasOwn(masks, key)) return { key, mask: masks[key] };
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619) >>> 0;
  }
  return { key, mask: unknownMasks[hash % unknownMasks.length] };
}

/** The fixed motif identifier for an executor (cmd aliases command-code). */
export function agentMaskId(executorId) {
  return maskFor(executorId).mask.id;
}

/** A display name for the executor's original mask. */
export function agentMaskName(executorId) {
  return maskFor(executorId).mask.name;
}

/**
 * Return decorative inline SVG HTML. Pair it with the executor's visible name.
 * Options: numeric size in CSS pixels, and an optional escaped className.
 */
export function agentMask(executorId, { size = 32, className = '' } = {}) {
  const { key, mask } = maskFor(executorId);
  const requestedSize = Number(size);
  const dimension = Number.isFinite(requestedSize) && requestedSize > 0 ? Math.min(256, Math.max(12, requestedSize)) : 32;
  const classes = ['agent-mask', className].filter(Boolean).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${escapeAttribute(classes)}" width="${dimension}" height="${dimension}" viewBox="0 0 64 64" data-executor="${escapeAttribute(key)}" data-mask="${mask.id}" aria-hidden="true" focusable="false"><path class="agent-mask__face" fill="currentColor" fill-rule="evenodd" d="${mask.silhouette} ${mask.eyes} ${mask.cuts ?? ''}"/><path class="agent-mask__accent" fill="currentColor" d="${mask.accent}"/><path class="agent-mask__eyes" fill="transparent" d="${mask.eyes}"/>${mask.features ? `<path class="agent-mask__feature" fill="currentColor" d="${mask.features}"/>` : ''}</svg>`;
}
