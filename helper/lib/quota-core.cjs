'use strict';

/**
 * Pure quota normalization shared by the embedded hook, standalone helper, and unit tests.
 * Zero fs / network / Electron dependency.
 */

const VERSION = '2.3.2';
const REFRESH_VIA_T3 = '请在 T3 Code 里重新登录 Antigravity 或发送一次对话以刷新授权';

function round1(n) {
  return Math.round(n * 10) / 10;
}

function clampPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return round1(Math.min(100, Math.max(0, n)));
}

/** remainingFraction (0..1) -> remaining percent (0..100), never treated as used. */
function remainingFromFraction(fraction) {
  if (fraction === null || fraction === undefined || fraction === '' || typeof fraction === 'boolean') {
    return null;
  }
  const n = typeof fraction === 'number' ? fraction : Number(fraction);
  if (!Number.isFinite(n)) return null;
  return clampPct(n * 100);
}

function windowDurationMins(window) {
  if (window === '5h') return 300;
  if (window === 'weekly') return 10080;
  return null;
}

function parseResetTime(value) {
  if (value === null || value === undefined || value === '') return null;
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  } else if (value instanceof Date) {
    ms = value.getTime();
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const year = new Date(ms).getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return new Date(ms).toISOString();
}

/**
 * Matches T3 Code's summaryResetTime semantics:
 * Google's API emits a synthetic resetTime = requestedAt + windowDurationMins when
 * a quota window is 100% untouched (remainingFraction === 1 && !description).
 */
function summaryResetTime(bucket, durationMins, requestedAtMs) {
  const iso = parseResetTime(bucket && bucket.resetTime);
  if (!iso) return { resetsAt: null, untouched: false };
  const remaining = bucket && bucket.remainingFraction;
  const hasDescription = typeof bucket.description === 'string' && bucket.description.trim().length > 0;
  if (
    remaining === 1 &&
    !hasDescription &&
    typeof durationMins === 'number' &&
    typeof requestedAtMs === 'number' &&
    Math.abs(Date.parse(iso) - requestedAtMs - durationMins * 60_000) <= 60_000
  ) {
    return { resetsAt: null, untouched: true };
  }
  return { resetsAt: iso, untouched: false };
}

function poolKeyForBucketId(id) {
  if (id.startsWith('gemini-argon-')) return 'gemini-argon';
  if (id.startsWith('gemini-carbon-')) return 'gemini-carbon';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('3p-')) return '3p';
  return id || 'other';
}

function poolTitleForBucket(bucket, group) {
  const id = typeof bucket.bucketId === 'string' ? bucket.bucketId : '';
  const groupName = group && typeof group.displayName === 'string' ? group.displayName.trim() : '';
  if (id.startsWith('gemini-argon-')) return groupName || 'Gemini Argon';
  if (id.startsWith('gemini-carbon-')) return groupName || 'Gemini Carbon';
  if (id.startsWith('gemini-')) return 'Gemini';
  if (id.startsWith('3p-')) return 'Claude & GPT (shared)';
  return groupName || id || 'unknown';
}

/** Label rules matched to T3 Antigravity provider semantics. */
function labelForBucket(bucket, group) {
  const base = poolTitleForBucket(bucket, group);
  const window = typeof bucket.window === 'string' ? bucket.window : '';
  if (window === 'weekly') return base + ' · Weekly';
  if (window === '5h') return base + ' · 5-hour';
  return base;
}

function parseModelsListFromDescription(description) {
  if (typeof description !== 'string') return [];
  const idx = description.indexOf(':');
  const raw = idx >= 0 ? description.slice(idx + 1) : description;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function collectBuckets(payload) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (bucket && typeof bucket === 'object') out.push({ bucket, group });
    }
  }
  if (Array.isArray(payload.buckets)) {
    for (const bucket of payload.buckets) {
      if (bucket && typeof bucket === 'object') out.push({ bucket, group: null });
    }
  }
  return out;
}

/**
 * Normalize a retrieveUserQuotaSummary response into renderer windows.
 * Accepts either groups[].buckets[] or a flat buckets[] array.
 */
function normalizeQuotaPayload(payload, opts) {
  const nowMs = (opts && opts.nowMs) || Date.now();
  const seen = new Set();
  const windows = [];
  let skipped = 0;
  for (const { bucket, group } of collectBuckets(payload)) {
    if (bucket.disabled === true) {
      skipped += 1;
      continue;
    }
    const id = typeof bucket.bucketId === 'string' ? bucket.bucketId : '';
    const window = typeof bucket.window === 'string' ? bucket.window : '';
    const key = (id || 'unknown') + '|' + window;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsedReset = parseResetTime(bucket.resetTime);
    // Protobuf3 omits scalar 0.0 on the wire when exhausted while keeping a valid resetTime
    const rawFraction = bucket.remainingFraction === undefined && parsedReset !== null
      ? 0
      : bucket.remainingFraction;
    const remainingPct = remainingFromFraction(rawFraction);
    const durationMins = windowDurationMins(window);
    const { resetsAt, untouched } = summaryResetTime(bucket, durationMins, nowMs);
    windows.push({
      id: id || key,
      poolKey: poolKeyForBucketId(id),
      poolTitle: poolTitleForBucket(bucket, group),
      poolModels: group ? parseModelsListFromDescription(group.description) : [],
      label: labelForBucket(bucket, group),
      remainingPct,
      usedPct: remainingPct === null ? null : round1(100 - remainingPct),
      resetsAt,
      untouched,
      windowDurationMins: durationMins,
      kind: window || 'other',
      description: typeof bucket.description === 'string' ? bucket.description : null,
      disabled: false,
    });
  }
  return { windows, skipped };
}

function modelFamilyFor(modelId, model) {
  const provider = model && model.modelProvider;
  if (provider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-')) return 'Gemini';
  if (provider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-')) return 'Claude';
  if (provider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-')) return 'GPT';
  return null;
}

function baseModelDisplayName(modelId, model) {
  const raw = model && typeof model.displayName === 'string' ? model.displayName.trim() : '';
  if (raw) {
    return raw.replace(/\s*\((?:Low|Medium|High|XHigh|Extra Low|Thinking)\)\s*$/i, '').trim();
  }
  return modelId;
}

/**
 * Normalize fetchAvailableModels into:
 * 1) deduplicated per-model availability rows for detail inspection
 * 2) T3-compatible fallback quota windows when summary has none
 */
function normalizeAvailableModels(payload) {
  const modelsMap = payload && typeof payload === 'object' && payload.models && typeof payload.models === 'object'
    ? payload.models
    : {};
  const byName = new Map();
  const familyBuckets = new Map();

  for (const [modelId, model] of Object.entries(modelsMap)) {
    if (!model || typeof model !== 'object') continue;
    if (/^tab_/i.test(modelId)) continue;
    const family = modelFamilyFor(modelId, model);
    if (!family) continue;

    const primaryQuota = model.quotaInfo || null;
    const weeklyQuota = model.weeklyQuotaInfo || null;
    const effective = primaryQuota || weeklyQuota;
    if (!effective) continue;

    const resetsAt = parseResetTime(effective.resetTime);
    const rawEffFraction = effective.remainingFraction === undefined && resetsAt !== null
      ? 0
      : effective.remainingFraction;
    const remainingPct = remainingFromFraction(rawEffFraction);
    if (remainingPct === null) continue;

    const hasDisplayName = typeof model.displayName === 'string' && model.displayName.trim().length > 0;
    if (hasDisplayName) {
      const name = baseModelDisplayName(modelId, model);
      const poolKey = family === 'Gemini' ? 'gemini' : '3p';
      const existing = byName.get(name);
      if (!existing || remainingPct < existing.remainingPct || (!existing.recommended && model.recommended)) {
        byName.set(name, {
          id: modelId,
          name,
          family,
          poolKey,
          remainingPct,
          usedPct: round1(100 - remainingPct),
          resetsAt,
          recommended: Boolean(model.recommended),
          supportsThinking: Boolean(model.supportsThinking),
          maxTokens: typeof model.maxTokens === 'number' ? model.maxTokens : null,
        });
      }
    }

    const poolKey = family === 'Gemini' ? 'gemini' : '3p';
    for (const [suffix, quota] of [['quota', primaryQuota], ['weekly', weeklyQuota]]) {
      if (!quota) continue;
      const qReset = parseResetTime(quota.resetTime);
      const qRaw = quota.remainingFraction === undefined && qReset !== null ? 0 : quota.remainingFraction;
      const pct = remainingFromFraction(qRaw);
      if (pct === null) continue;
      const fid = family.toLowerCase() + '-' + suffix;
      const prev = familyBuckets.get(fid);
      if (!prev || pct < prev.remainingPct) {
        familyBuckets.set(fid, {
          id: fid,
          poolKey,
          poolTitle: family,
          poolModels: [],
          label: family + ' · ' + (suffix === 'weekly' ? 'Weekly' : 'Reported quota'),
          remainingPct: pct,
          usedPct: round1(100 - pct),
          resetsAt: qReset,
          untouched: false,
          windowDurationMins: suffix === 'weekly' ? 10080 : null,
          kind: suffix === 'weekly' ? 'weekly' : 'other',
          description: null,
          disabled: false,
        });
      }
    }
  }

  const order = { Gemini: 0, Claude: 1, GPT: 2 };
  const models = Array.from(byName.values()).sort((a, b) => {
    const fo = (order[a.family] ?? 9) - (order[b.family] ?? 9);
    if (fo !== 0) return fo;
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { models, fallbackWindows: Array.from(familyBuckets.values()) };
}

function parseCodeAssistProfile(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const paid = payload.paidTier && typeof payload.paidTier === 'object' ? payload.paidTier : null;
  const current = payload.currentTier && typeof payload.currentTier === 'object' ? payload.currentTier : null;
  const tierName = (paid && typeof paid.name === 'string' && paid.name) || (current && typeof current.name === 'string' && current.name) || null;
  const tierId = (paid && typeof paid.id === 'string' && paid.id) || (current && typeof current.id === 'string' && current.id) || null;
  const projectId = typeof payload.cloudaicompanionProject === 'string' ? payload.cloudaicompanionProject : null;
  const credits = paid && Array.isArray(paid.availableCredits)
    ? paid.availableCredits.map((c) => ({
        type: c && typeof c.creditType === 'string' ? c.creditType : 'AI',
        minAmount: c && c.minimumCreditAmountForUsage != null ? String(c.minimumCreditAmountForUsage) : null,
      }))
    : [];
  return { tierName, tierId, projectId, credits };
}

/**
 * Group normalized windows by model pool and enrich each pool's 5h window
 * if fetchAvailableModels shows an even fresher consumption reading for the same resetTime.
 */
function buildAccountPools(windows, models) {
  const poolsMap = new Map();
  for (const w of windows || []) {
    const key = w.poolKey || w.id;
    let pool = poolsMap.get(key);
    if (!pool) {
      pool = {
        key,
        title: w.poolTitle || w.label,
        models: Array.isArray(w.poolModels) ? w.poolModels.slice() : [],
        windows: [],
      };
      poolsMap.set(key, pool);
    }
    const copy = Object.assign({}, w);
    if (copy.kind === '5h' && Array.isArray(models) && models.length) {
      const matching = models.filter((m) => m.poolKey === key && m.resetsAt && copy.resetsAt && Math.abs(Date.parse(m.resetsAt) - Date.parse(copy.resetsAt)) <= 120_000);
      if (matching.length) {
        const minModelPct = Math.min(...matching.map((m) => m.remainingPct));
        if (minModelPct < copy.remainingPct) {
          copy.remainingPct = minModelPct;
          copy.usedPct = round1(100 - minModelPct);
        }
      }
    }
    pool.windows.push(copy);
  }
  const kindOrder = { '5h': 0, weekly: 1, other: 2 };
  for (const pool of poolsMap.values()) {
    pool.windows.sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9));
  }
  return Array.from(poolsMap.values());
}

/**
 * Reconcile per-model chips against their shared pool's effective remaining ceiling,
 * and preserve pool-declared models (e.g. when a pool hits 0% and upstream omits model quotaInfo).
 */
function reconcileModelsWithPools(models, pools) {
  const poolCeiling = new Map();
  for (const pool of pools || []) {
    let minPct = null;
    for (const w of pool.windows || []) {
      if (typeof w.remainingPct === 'number' && Number.isFinite(w.remainingPct)) {
        if (minPct === null || w.remainingPct < minPct) minPct = w.remainingPct;
      }
    }
    if (minPct !== null) poolCeiling.set(pool.key, minPct);
  }

  const out = [];
  const seenNames = new Set();
  for (const m of models || []) {
    const ceiling = poolCeiling.has(m.poolKey) ? poolCeiling.get(m.poolKey) : null;
    const pct = ceiling !== null && typeof m.remainingPct === 'number'
      ? Math.min(m.remainingPct, ceiling)
      : m.remainingPct;
    const copy = Object.assign({}, m, {
      remainingPct: pct,
      usedPct: typeof pct === 'number' ? round1(100 - pct) : m.usedPct,
    });
    out.push(copy);
    if (copy.name) seenNames.add(copy.name.toLowerCase());
  }

  for (const pool of pools || []) {
    const ceiling = poolCeiling.has(pool.key) ? poolCeiling.get(pool.key) : null;
    if (ceiling === null || !Array.isArray(pool.models)) continue;
    for (const rawName of pool.models) {
      const name = String(rawName || '').trim();
      if (!name || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());
      const family = /^claude/i.test(name) ? 'Claude' : /^gpt/i.test(name) ? 'GPT' : 'Gemini';
      out.push({
        id: name.toLowerCase().replace(/\s+/g, '-'),
        name,
        family,
        poolKey: pool.key,
        remainingPct: ceiling,
        usedPct: round1(100 - ceiling),
        resetsAt: null,
        recommended: true,
        supportsThinking: true,
        maxTokens: null,
      });
    }
  }
  return out;
}

function lowestRemaining(windows) {
  let best = null;
  for (const w of windows || []) {
    if (typeof w.remainingPct !== 'number' || !Number.isFinite(w.remainingPct)) continue;
    if (!best || w.remainingPct < best.remainingPct) best = w;
  }
  return best;
}

function parseExpiry(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isExpired(expiryMs, nowMs, skewMs) {
  if (expiryMs === null || expiryMs === undefined) return false;
  const skew = typeof skewMs === 'number' ? skewMs : 60_000;
  return expiryMs - skew <= nowMs;
}

const TOKEN_LIKE = /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

/** Strip anything token-shaped from text that may reach logs or the renderer. */
function sanitizeError(text, secrets) {
  let out = String(text == null ? '' : text).replace(TOKEN_LIKE, '$1[redacted]');
  out = out.replace(/ya29\.[A-Za-z0-9\-._~+/]+=*/g, '[redacted]');
  out = out.replace(/1\/\/[A-Za-z0-9\-._~+/]{10,}/g, '[redacted]');
  for (const secret of secrets || []) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out.slice(0, 400);
}

module.exports = {
  VERSION,
  REFRESH_VIA_T3,
  clampPct,
  remainingFromFraction,
  windowDurationMins,
  labelForBucket,
  collectBuckets,
  summaryResetTime,
  normalizeQuotaPayload,
  normalizeAvailableModels,
  parseCodeAssistProfile,
  buildAccountPools,
  reconcileModelsWithPools,
  lowestRemaining,
  parseResetTime,
  parseExpiry,
  isExpired,
  sanitizeError,
  round1,
};
