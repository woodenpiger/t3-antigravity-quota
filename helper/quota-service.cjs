'use strict';

/**
 * Antigravity quota aggregation service.
 * Reads local T3 Antigravity credentials, silently renews expired tokens via acp_token.json
 * or agy.exe ACP handshake, and fetches summary + model breakdown + plan tier in parallel.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./lib/quota-core.cjs');
const { refreshViaAcp } = require('./lib/agy-refresh.cjs');

const DAILY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
const PROD_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const ENDPOINTS = [DAILY_ENDPOINT, PROD_ENDPOINT];
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USER_AGENT =
  'antigravity/hub/2.24.0 (aidev_client; os_type=win32; arch=x64; cl=963137146)';
const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary';
const MODELS_PATH = '/v1internal:fetchAvailableModels';
const CODE_ASSIST_PATH = '/v1internal:loadCodeAssist';

const ASSIST_TTL_MS = 30 * 60_000;
const MODELS_TTL_MS = 5 * 60_000;
const ACP_COOLDOWN_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

function endpointsForAuthMethod(authMethod) {
  if (authMethod === 'oauth-business') return [PROD_ENDPOINT, DAILY_ENDPOINT];
  return [DAILY_ENDPOINT, PROD_ENDPOINT];
}

function defaultAccountsRoot() {
  if (process.env.T3_AG_ACCOUNTS_ROOT) return process.env.T3_AG_ACCOUNTS_ROOT;
  return path.join(os.homedir(), '.t3', 'userdata', 'providers', 'antigravity');
}

function readJson(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function listAccounts(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const accounts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(root, entry.name);
    const acpDir = path.join(profileDir, 'antigravity-acp');
    const tokenFile = path.join(acpDir, 'antigravity-oauth-token');
    if (!fs.existsSync(tokenFile)) continue;
    accounts.push({
      hash: entry.name,
      profileDir,
      tokenFile,
      acpFile: path.join(acpDir, 'acp_token.json'),
    });
  }
  return accounts;
}

function readAccountToken(account) {
  const parsed = readJson(account.tokenFile);
  if (!parsed.ok) return { ok: false, error: '无法读取 Antigravity 登录文件' };
  const root = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const token = root.token && typeof root.token === 'object' ? root.token : null;
  if (!token || typeof token.access_token !== 'string' || !token.access_token) {
    return { ok: false, error: 'Antigravity 登录文件缺少 access_token' };
  }
  const acp = fs.existsSync(account.acpFile) ? readJson(account.acpFile) : { ok: false };
  return {
    ok: true,
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === 'string' ? token.refresh_token : null,
    expiryMs: core.parseExpiry(token.expiry),
    email: typeof root.id_token_email === 'string' ? root.id_token_email : null,
    authMethod: typeof root.auth_method === 'string' ? root.auth_method : null,
    acp: acp.ok && acp.value && typeof acp.value === 'object' ? acp.value : null,
    secrets: [token.access_token, token.refresh_token].filter(Boolean),
  };
}

async function refreshViaOAuthSecret(acp, token, deps) {
  const clientId = acp && typeof acp.client_id === 'string' ? acp.client_id : '';
  const clientSecret = acp && typeof acp.client_secret === 'string' ? acp.client_secret : '';
  const refreshToken =
    (token && token.refreshToken) || (acp && typeof acp.refresh_token === 'string' ? acp.refresh_token : '');
  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, error: core.REFRESH_VIA_T3, needsT3Refresh: true };
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();
  let res;
  try {
    res = await deps.postJson(OAUTH_TOKEN_URL, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body,
      timeoutMs: deps.timeoutMs,
    });
  } catch (err) {
    const reason = err && err.code === 'ETIMEDOUT' ? '刷新登录超时' : '刷新登录失败';
    return { ok: false, error: core.sanitizeError(reason, token.secrets) };
  }
  const json = res && res.json;
  if (!res || res.status < 200 || res.status >= 300 || !json || typeof json.access_token !== 'string') {
    const status = res ? String(res.status) : 'network';
    return {
      ok: false,
      error: core.sanitizeError('刷新登录失败（HTTP ' + status + '）', token.secrets),
    };
  }
  const expiresIn = Number(json.expires_in);
  const expiryMs = Number.isFinite(expiresIn) ? deps.now() + expiresIn * 1000 : null;
  return {
    ok: true,
    accessToken: json.access_token,
    expiryMs,
    secrets: token.secrets.concat([json.access_token]),
  };
}

async function postInternalApi(apiPath, accessToken, projectId, deps, secrets, authMethod) {
  const body = projectId ? JSON.stringify({ project: projectId }) : '{}';
  const endpoints = endpointsForAuthMethod(authMethod);
  const startedAt = deps.now();
  let lastStatus = null;
  let lastError = null;
  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    const elapsed = Math.max(0, deps.now() - startedAt);
    const remainingBudget = deps.timeoutMs - elapsed;
    if (i > 0 && remainingBudget < 2_500) break;
    const perCallTimeout = Math.max(2_500, i === 0 ? deps.timeoutMs : remainingBudget);
    let res;
    try {
      res = await deps.postJson(endpoint + apiPath, {
        headers: {
          authorization: 'Bearer ' + accessToken,
          'user-agent': USER_AGENT,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        timeoutMs: perCallTimeout,
      });
    } catch (err) {
      lastError = err && err.code === 'ETIMEDOUT' ? '请求额度超时' : '连接额度服务失败';
      if (err && err.code === 'ETIMEDOUT' && (deps.now() - startedAt) >= Math.floor(deps.timeoutMs * 0.65)) {
        break;
      }
      continue;
    }
    lastStatus = res ? res.status : null;
    if (res && res.status >= 200 && res.status < 300 && res.json) return { ok: true, json: res.json };
    if (res && res.status === 401) return { ok: false, status: 401, error: '登录已失效，正在尝试刷新或请重新登录' };
    if (res && res.status === 403) return { ok: false, status: 403, error: '当前账号无权访问额度接口（403）' };
    if (res && res.status === 429) return { ok: false, status: 429, error: '请求过于频繁，已进入防频控冷却保护（429）' };
  }
  if (lastStatus !== null) {
    return { ok: false, status: lastStatus, error: '额度接口返回 HTTP ' + lastStatus };
  }
  return { ok: false, status: 0, error: core.sanitizeError(lastError || '额度接口不可达', secrets) };
}

async function obtainAccessToken(account, initialToken, deps, forceRefresh, acctState, manualRefresh) {
  const nowMs = deps.now();
  if (
    !forceRefresh &&
    acctState.oauth &&
    acctState.oauth.accessToken &&
    !core.isExpired(acctState.oauth.expiryMs, nowMs)
  ) {
    return {
      ok: true,
      accessToken: acctState.oauth.accessToken,
      secrets: acctState.oauth.secrets,
      refreshed: false,
    };
  }
  const expired = forceRefresh || core.isExpired(initialToken.expiryMs, nowMs);
  if (!expired) {
    return {
      ok: true,
      accessToken: initialToken.accessToken,
      secrets: initialToken.secrets,
      refreshed: false,
    };
  }
  if (initialToken.acp) {
    const viaAcpJson = await refreshViaOAuthSecret(initialToken.acp, initialToken, deps);
    if (viaAcpJson.ok) {
      acctState.oauth = {
        accessToken: viaAcpJson.accessToken,
        expiryMs: viaAcpJson.expiryMs || (nowMs + 50 * 60_000),
        secrets: viaAcpJson.secrets,
      };
      return { ok: true, accessToken: viaAcpJson.accessToken, secrets: viaAcpJson.secrets, refreshed: true };
    }
    return viaAcpJson;
  }
  if (!initialToken.refreshToken || typeof deps.refreshViaAcp !== 'function') {
    return { ok: false, error: core.REFRESH_VIA_T3, needsT3Refresh: true };
  }
  const tokenFingerprint = `${initialToken.refreshToken || ''}:${initialToken.accessToken || ''}:${initialToken.expiryDate || ''}`;
  if (acctState.acpRevokedToken && acctState.acpRevokedToken !== tokenFingerprint) {
    acctState.acpRevokedToken = '';
    acctState.acpCooldownUntil = 0;
  }
  const hasRevokedAuth = Boolean(acctState.acpRevokedToken && acctState.acpRevokedToken === tokenFingerprint);
  if (acctState.acpCooldownUntil && nowMs < acctState.acpCooldownUntil && (!manualRefresh || hasRevokedAuth)) {
    return { ok: false, error: core.REFRESH_VIA_T3, needsT3Refresh: true };
  }
  if (manualRefresh && !hasRevokedAuth) acctState.acpCooldownUntil = 0;
  const acpRes = await deps.refreshViaAcp(account.profileDir, {
    authMethod: initialToken.authMethod === 'oauth-business' ? 'oauth-business' : 'oauth-personal',
    timeoutMs: Math.min(deps.timeoutMs, 7_000),
  });
  if (!acpRes || !acpRes.ok) {
    const needsT3Refresh = !acpRes || acpRes.needsT3Refresh !== false;
    if (needsT3Refresh) {
      acctState.acpRevokedToken = tokenFingerprint;
      acctState.acpCooldownUntil = deps.now() + 5 * 60_000;
    } else {
      acctState.acpRevokedToken = '';
      acctState.acpCooldownUntil = deps.now() + ACP_COOLDOWN_MS;
    }
    return {
      ok: false,
      error: (acpRes && acpRes.error) || core.REFRESH_VIA_T3,
      needsT3Refresh,
    };
  }
  acctState.acpRevokedToken = '';
  const reloaded = readAccountToken(account);
  if (!reloaded.ok) {
    acctState.acpCooldownUntil = deps.now() + ACP_COOLDOWN_MS;
    return { ok: false, error: reloaded.error, needsT3Refresh: true };
  }
  const combinedSecrets = initialToken.secrets.concat(reloaded.secrets);
  acctState.oauth = {
    accessToken: reloaded.accessToken,
    expiryMs: reloaded.expiryMs || (deps.now() + 50 * 60_000),
    secrets: combinedSecrets,
  };
  acctState.acpCooldownUntil = 0;
  return {
    ok: true,
    accessToken: reloaded.accessToken,
    secrets: combinedSecrets,
    refreshed: true,
  };
}

async function fetchAccount(account, deps, acctState, manualRefresh) {
  const nowStart = deps.now();
  if (acctState.rateLimitUntil && nowStart < acctState.rateLimitUntil) {
    return {
      ok: false,
      label: 'Antigravity',
      error: '已触发官方接口频控保护，稍后自动恢复',
      rateLimited: true,
    };
  }

  const token = readAccountToken(account);
  if (!token.ok) return { ok: false, label: 'Antigravity', error: token.error };
  const label = token.email || 'Antigravity';
  const authMethod = token.authMethod;
  const cachedProjectId = acctState.assist && acctState.assist.value ? acctState.assist.value.projectId : null;
  const projectId =
    (token.acp && typeof token.acp.project_id === 'string' && token.acp.project_id) || cachedProjectId || null;

  let auth = await obtainAccessToken(account, token, deps, false, acctState, manualRefresh);
  if (!auth.ok) {
    return { ok: false, label, email: token.email, error: auth.error, needsT3Refresh: auth.needsT3Refresh === true };
  }

  const needModels = !acctState.models || (nowStart - acctState.models.at >= MODELS_TTL_MS);
  const needAssist = !acctState.assist || (nowStart - acctState.assist.at >= ASSIST_TTL_MS);

  const runCalls = (accessToken, secrets) => Promise.all([
    postInternalApi(QUOTA_PATH, accessToken, projectId, deps, secrets, authMethod),
    needModels
      ? postInternalApi(MODELS_PATH, accessToken, projectId, deps, secrets, authMethod).catch(() => ({ ok: false }))
      : Promise.resolve({ ok: true, json: acctState.models.raw, fromCache: true }),
    needAssist
      ? postInternalApi(CODE_ASSIST_PATH, accessToken, projectId, deps, secrets, authMethod).catch(() => ({ ok: false }))
      : Promise.resolve({ ok: true, json: acctState.assist.raw, fromCache: true }),
  ]);

  let [summary, modelsRes, assistRes] = await runCalls(auth.accessToken, auth.secrets);

  if (!summary.ok && summary.status === 401 && !auth.refreshed) {
    acctState.oauth = null;
    const retryAuth = await obtainAccessToken(account, token, deps, true, acctState, manualRefresh);
    if (retryAuth.ok) {
      auth = retryAuth;
      [summary, modelsRes, assistRes] = await runCalls(auth.accessToken, auth.secrets);
    }
  }

  if (!summary.ok && (summary.status === 429 || summary.status === 403)) {
    acctState.rateLimitUntil = deps.now() + RATE_LIMIT_BACKOFF_MS;
  }

  // Fallback to fresh fetchAvailableModels only when summary returned no windows and models came from cache/failed
  const nowMs = deps.now();
  const normalizedSummary = summary && summary.ok
    ? core.normalizeQuotaPayload(summary.json, { nowMs })
    : { windows: [], skipped: 0 };

  if (!normalizedSummary.windows.length && (!modelsRes || !modelsRes.ok || modelsRes.fromCache)) {
    modelsRes = await postInternalApi(MODELS_PATH, auth.accessToken, projectId, deps, auth.secrets, authMethod).catch(() => ({ ok: false }));
  }

  if (modelsRes && modelsRes.ok && !modelsRes.fromCache && modelsRes.json) {
    acctState.models = { raw: modelsRes.json, at: nowMs };
  }
  if (assistRes && assistRes.ok && !assistRes.fromCache && assistRes.json) {
    acctState.assist = { raw: assistRes.json, value: core.parseCodeAssistProfile(assistRes.json), at: nowMs };
  }

  const parsedModels = modelsRes && modelsRes.ok && modelsRes.json
    ? core.normalizeAvailableModels(modelsRes.json, { nowMs })
    : { models: [], fallbackWindows: [] };

  const rawWindows = normalizedSummary.windows.length
    ? normalizedSummary.windows
    : parsedModels.fallbackWindows;

  if (!rawWindows.length) {
    const errText = (!summary.ok && summary.error) || '未检测到额度窗口（响应为空）';
    return {
      ok: false,
      label,
      email: token.email,
      error: errText,
      needsT3Refresh: summary && summary.status === 401,
    };
  }

  const pools = core.buildAccountPools(rawWindows, parsedModels.models);
  const reconciledWindows = pools.flatMap((p) => p.windows);
  const reconciledModels = core.reconcileModelsWithPools(parsedModels.models, pools);
  const assist = (assistRes && assistRes.ok && assistRes.json)
    ? core.parseCodeAssistProfile(assistRes.json)
    : (acctState.assist ? acctState.assist.value : null);
  const plan = (assist && assist.tierName) || token.authMethod || null;

  return {
    ok: true,
    label,
    email: token.email,
    plan,
    tierId: assist ? assist.tierId : null,
    projectId: (assist && assist.projectId) || projectId,
    credits: assist ? assist.credits : [],
    refreshedToken: auth.refreshed,
    windows: reconciledWindows,
    pools,
    models: reconciledModels,
    skipped: normalizedSummary.skipped,
  };
}

function createQuotaService(options) {
  const opts = options || {};
  const deps = {
    accountsRoot: opts.accountsRoot || defaultAccountsRoot(),
    postJson: opts.postJson,
    refreshViaAcp: opts.refreshViaAcp === undefined ? refreshViaAcp : opts.refreshViaAcp,
    now: opts.now || (() => Date.now()),
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10_000,
  };
  if (typeof deps.postJson !== 'function') throw new Error('createQuotaService needs postJson');
  const cacheTtlMs = typeof opts.cacheTtlMs === 'number' ? opts.cacheTtlMs : 45_000;
  const minForceIntervalMs = typeof opts.minForceIntervalMs === 'number' ? opts.minForceIntervalMs : 0;
  const stateByAccount = new Map();
  let cache = null;
  let inflight = null;

  function accountState(hash) {
    let st = stateByAccount.get(hash);
    if (!st) {
      st = { oauth: null, assist: null, models: null, acpCooldownUntil: 0, rateLimitUntil: 0 };
      stateByAccount.set(hash, st);
    }
    return st;
  }

  async function collect(manualRefresh) {
    const accounts = listAccounts(deps.accountsRoot);
    if (!accounts.length) {
      return {
        ok: true,
        checkedAt: new Date(deps.now()).toISOString(),
        source: 'antigravity',
        accounts: [],
        empty: true,
      };
    }
    const results = [];
    const errors = [];
    for (const account of accounts) {
      const result = await fetchAccount(account, deps, accountState(account.hash), manualRefresh);
      if (result.ok) {
        results.push({
          label: result.label,
          plan: result.plan,
          tierId: result.tierId,
          projectId: result.projectId,
          credits: result.credits,
          email: result.email || null,
          windows: result.windows,
          pools: result.pools,
          models: result.models,
        });
      } else {
        errors.push({
          label: result.label,
          error: result.error,
          needsT3Refresh: result.needsT3Refresh === true,
        });
      }
    }
    const checkedAt = new Date(deps.now()).toISOString();
    if (!results.length) {
      return {
        ok: false,
        checkedAt,
        source: 'antigravity',
        accounts: [],
        error: errors[0] ? errors[0].error : '未检测到可用额度',
        needsT3Refresh: errors.some((e) => e.needsT3Refresh),
      };
    }
    return {
      ok: true,
      checkedAt,
      source: 'antigravity',
      accounts: results,
      error: errors.length ? errors.map((e) => e.label + '：' + e.error).join('；') : null,
    };
  }

  async function getQuota(arg) {
    const refresh = typeof arg === 'object' && arg !== null ? Boolean(arg.refresh) : Boolean(arg);
    const nowMs = deps.now();
    if (cache) {
      const ageMs = nowMs - cache.at;
      if (!refresh && ageMs < cacheTtlMs) {
        return Object.assign({}, cache.payload, { cached: true, ageMs });
      }
      if (refresh && minForceIntervalMs > 0 && ageMs < minForceIntervalMs) {
        return Object.assign({}, cache.payload, { cached: true, ageMs, rateProtected: true });
      }
    }
    if (inflight) return inflight;
    const hardDeadlineMs = Math.max(deps.timeoutMs + 8_500, 18_000);
    let guardTimer = null;
    const task = (async () => {
      try {
        const payload = await Promise.race([
          collect(refresh),
          new Promise((_, reject) => {
            guardTimer = setTimeout(() => {
              const e = new Error('请求额度超时');
              e.code = 'ETIMEDOUT';
              reject(e);
            }, hardDeadlineMs);
          }),
        ]);
        if (payload.ok) {
          cache = { at: deps.now(), payload };
          return payload;
        }
        if (cache) {
          return Object.assign({}, cache.payload, {
            stale: true,
            cached: true,
            error: payload.error,
            needsT3Refresh: payload.needsT3Refresh === true,
            ageMs: deps.now() - cache.at,
          });
        }
        return payload;
      } catch (err) {
        const message = core.sanitizeError(err && err.message ? err.message : '额度服务内部错误');
        if (cache) {
          return Object.assign({}, cache.payload, {
            stale: true,
            cached: true,
            error: message,
            ageMs: deps.now() - cache.at,
          });
        }
        return {
          ok: false,
          checkedAt: new Date(deps.now()).toISOString(),
          source: 'antigravity',
          accounts: [],
          error: message,
        };
      } finally {
        if (guardTimer) clearTimeout(guardTimer);
        if (inflight === task) inflight = null;
      }
    })();
    inflight = task;
    return task;
  }

  return {
    getQuota,
    accountsRoot: deps.accountsRoot,
    resetCache: () => {
      cache = null;
      stateByAccount.clear();
    },
  };
}

module.exports = {
  ENDPOINTS,
  OAUTH_TOKEN_URL,
  USER_AGENT,
  QUOTA_PATH,
  MODELS_PATH,
  CODE_ASSIST_PATH,
  defaultAccountsRoot,
  listAccounts,
  readAccountToken,
  createQuotaService,
};
