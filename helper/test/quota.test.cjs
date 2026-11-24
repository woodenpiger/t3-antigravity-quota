'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../lib/quota-core.cjs');
const winProxy = require('../lib/win-proxy.cjs');
const { createQuotaRouteHandler } = require('../lib/quota-router.cjs');
const { createQuotaService, OAUTH_TOKEN_URL, QUOTA_PATH, MODELS_PATH, CODE_ASSIST_PATH } = require('../quota-service.cjs');

const NOW = Date.UTC(2026, 10, 22, 13, 0, 0);

const SUMMARY = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini 4 Hydrogen, Gemini 4 Argon',
      buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.42, resetTime: '2026-11-27T00:00:00Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-11-22T17:00:00Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
      buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: new Date(NOW + 300 * 60_000).toISOString() },
      ],
    },
  ],
};

const MODELS_PAYLOAD = {
  models: {
    'gemini-4-hydrogen-high': {
      displayName: 'Gemini 4 Hydrogen (High)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      recommended: true,
      supportsThinking: true,
      maxTokens: 1048576,
      quotaInfo: { remainingFraction: 0.78, resetTime: '2026-11-22T17:00:00Z' },
    },
    'gemini-4-hydrogen-low': {
      displayName: 'Gemini 4 Hydrogen (Low)',
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-22T17:00:00Z' },
    },
    'claude-opus-5-5-high': {
      displayName: 'Claude Opus 5.5 (High)',
      modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
      recommended: true,
      quotaInfo: { remainingFraction: 0.05, resetTime: '2026-11-27T00:00:00Z' },
    },
    'tab_flash_lite_preview': {
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      quotaInfo: { remainingFraction: 1 },
    },
  },
};

const ASSIST_PAYLOAD = {
  currentTier: { id: 'free-tier', name: 'Antigravity' },
  paidTier: {
    id: 'g1-pro-tier',
    name: 'Google AI Pro',
    availableCredits: [{ creditType: 'GOOGLE_ONE_AI', minimumCreditAmountForUsage: '50' }],
  },
  cloudaicompanionProject: 'aicode-consumers',
};

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't3ag-test-'));
}

function seedToken(root, hash, options) {
  const opts = options || {};
  const dir = path.join(root, hash, 'antigravity-acp');
  fs.mkdirSync(dir, { recursive: true });
  const token = {
    access_token: opts.accessToken || 'ya29.TEST-ACCESS-TOKEN-DO-NOT-LEAK',
    token_type: 'Bearer',
    expires_in: 3599,
    expiry: opts.expiry || new Date(NOW + 3600_000).toISOString(),
  };
  if (opts.refreshToken !== null) token.refresh_token = opts.refreshToken || '1//TEST-REFRESH-TOKEN-DO-NOT-LEAK';
  fs.writeFileSync(
    path.join(dir, 'antigravity-oauth-token'),
    JSON.stringify({ auth_method: opts.authMethod || 'consumer', id_token_email: opts.email || 'tester@example.com', token }),
  );
  if (opts.acp) fs.writeFileSync(path.join(dir, 'acp_token.json'), JSON.stringify(opts.acp));
  return dir;
}

function fakePost(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls);
  };
  fn.calls = calls;
  return fn;
}

function service(root, postJson, extra) {
  return createQuotaService(
    Object.assign(
      { accountsRoot: root, postJson, refreshViaAcp: null, now: () => NOW, timeoutMs: 10_000 },
      extra || {},
    ),
  );
}

test('normalizes groups[].buckets[], suppresses synthetic resetTime on untouched 100% windows', () => {
  const { windows } = core.normalizeQuotaPayload(SUMMARY, { nowMs: NOW });
  assert.equal(windows.length, 4);
  const weekly = windows.find((w) => w.id === 'gemini-weekly');
  assert.equal(weekly.label, 'Gemini · Weekly');
  assert.equal(weekly.remainingPct, 42);
  assert.equal(weekly.usedPct, 58);
  assert.deepEqual(weekly.poolModels, ['Gemini 4 Hydrogen', 'Gemini 4 Argon']);
  const untouched = windows.find((w) => w.id === '3p-5h');
  assert.equal(untouched.untouched, true);
  assert.equal(untouched.resetsAt, null);
});

test('accepts flat buckets[] only payloads', () => {
  const { windows } = core.normalizeQuotaPayload(
    { buckets: [{ bucketId: 'gemini-flash-5h', window: '5h', remainingFraction: 0.33 }] },
    { nowMs: NOW },
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, 'Gemini · 5-hour');
  assert.equal(windows[0].remainingPct, 33);
});

test('remainingFraction 0 and 1 map to 0/100 with used inverted', () => {
  const { windows } = core.normalizeQuotaPayload(
    {
      buckets: [
        { bucketId: 'gemini-carbon-x', window: 'weekly', remainingFraction: 0 },
        { bucketId: 'gemini-carbon-y', window: 'weekly', remainingFraction: 1 },
      ],
    },
    { nowMs: NOW },
  );
  assert.equal(windows[0].remainingPct, 0);
  assert.equal(windows[0].usedPct, 100);
  assert.equal(windows[1].remainingPct, 100);
  assert.equal(windows[1].usedPct, 0);
});

test('invalid remainingFraction and illegal resetTime are null instead of fabricated', () => {
  const { windows } = core.normalizeQuotaPayload({ buckets: [{ bucketId: 'gemini-x', window: '5h', remainingFraction: 'oops' }] });
  assert.equal(windows[0].remainingPct, null);
  assert.equal(windows[0].usedPct, null);
  assert.equal(core.parseResetTime(null), null);
  assert.equal(core.parseResetTime('not-a-date'), null);
  assert.equal(core.parseResetTime('1970-01-01T00:00:00Z'), null);
});

test('normalizeAvailableModels deduplicates effort variants and skips tab models', () => {
  const { models, fallbackWindows } = core.normalizeAvailableModels(MODELS_PAYLOAD);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'Gemini 4 Hydrogen');
  assert.equal(models[0].remainingPct, 78);
  assert.equal(models[1].name, 'Claude Opus 5.5');
  assert.equal(models[1].remainingPct, 5);
  assert.equal(fallbackWindows.length, 2);
});

test('loadCodeAssist profile parses paidTier and credits', () => {
  const p = core.parseCodeAssistProfile(ASSIST_PAYLOAD);
  assert.equal(p.tierName, 'Google AI Pro');
  assert.equal(p.tierId, 'g1-pro-tier');
  assert.equal(p.projectId, 'aicode-consumers');
  assert.equal(p.credits[0].minAmount, '50');
});

test('no login files -> ok with empty accounts (renderer empty state)', async () => {
  const root = tempRoot();
  const svc = service(root, fakePost(() => { throw new Error('must not be called'); }));
  const payload = await svc.getQuota(true);
  assert.equal(payload.ok, true);
  assert.equal(payload.empty, true);
  assert.deepEqual(payload.accounts, []);
});

test('expired token without acp_token.json uses silent refreshViaAcp and succeeds', async () => {
  const root = tempRoot();
  const dir = seedToken(root, 'a'.repeat(64), { expiry: new Date(NOW - 3600_000).toISOString() });
  let acpCalls = 0;
  const refreshViaAcp = async (profileDir) => {
    acpCalls += 1;
    assert.equal(profileDir, path.dirname(dir));
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'antigravity-oauth-token'), 'utf8'));
    current.token.access_token = 'ya29.SILENT-ACP-REFRESHED';
    current.token.expiry = new Date(NOW + 3600_000).toISOString();
    fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), JSON.stringify(current));
    return { ok: true };
  };
  const post = fakePost((url, opts) => {
    assert.equal(opts.headers.authorization, 'Bearer ya29.SILENT-ACP-REFRESHED');
    if (url.endsWith(QUOTA_PATH)) return { status: 200, json: SUMMARY };
    if (url.endsWith(MODELS_PATH)) return { status: 200, json: MODELS_PAYLOAD };
    if (url.endsWith(CODE_ASSIST_PATH)) return { status: 200, json: ASSIST_PAYLOAD };
    return { status: 404, json: null };
  });
  const payload = await service(root, post, { refreshViaAcp }).getQuota(true);
  assert.equal(acpCalls, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.accounts[0].plan, 'Google AI Pro');
  assert.equal(payload.accounts[0].pools.length, 2);
  // 5h window reconciled to fresher 78% from fetchAvailableModels
  const g5h = payload.accounts[0].windows.find((w) => w.id === 'gemini-5h');
  assert.equal(g5h.remainingPct, 78);
});

test('expired token without refresh capability -> T3 refresh instruction, no fake refresh', async () => {
  const root = tempRoot();
  seedToken(root, 'a'.repeat(64), { expiry: new Date(NOW - 3600_000).toISOString(), refreshToken: null });
  const post = fakePost(() => { throw new Error('must not be called'); });
  const payload = await service(root, post).getQuota(true);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, core.REFRESH_VIA_T3);
  assert.equal(payload.needsT3Refresh, true);
  assert.equal(post.calls.length, 0);
});

test('summary failure falls back to fetchAvailableModels windows', async () => {
  const root = tempRoot();
  seedToken(root, 'f'.repeat(64));
  const post = fakePost((url) => {
    if (url.endsWith(QUOTA_PATH)) return { status: 500, json: null };
    if (url.endsWith(MODELS_PATH)) return { status: 200, json: MODELS_PAYLOAD };
    if (url.endsWith(CODE_ASSIST_PATH)) return { status: 200, json: ASSIST_PAYLOAD };
    return { status: 500, json: null };
  });
  const payload = await service(root, post).getQuota(true);
  assert.equal(payload.ok, true);
  assert.equal(payload.accounts[0].windows.length, 2);
  assert.equal(payload.accounts[0].models.length, 2);
});

test('expired token with acp_token.json -> refresh grant then quota, tokens never returned', async () => {
  const root = tempRoot();
  seedToken(root, 'b'.repeat(64), {
    expiry: new Date(NOW - 3600_000).toISOString(),
    acp: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'csecret', refresh_token: '1//acp-refresh', project_id: 'proj-123' },
  });
  const post = fakePost((url, opts) => {
    if (url === OAUTH_TOKEN_URL) return { status: 200, json: { access_token: 'ya29.REFRESHED-SECRET', expires_in: 3599 } };
    assert.equal(opts.headers.authorization, 'Bearer ya29.REFRESHED-SECRET');
    assert.deepEqual(JSON.parse(opts.body), { project: 'proj-123' });
    if (url.endsWith(QUOTA_PATH)) return { status: 200, json: SUMMARY };
    if (url.endsWith(MODELS_PATH)) return { status: 200, json: MODELS_PAYLOAD };
    return { status: 200, json: ASSIST_PAYLOAD };
  });
  const payload = await service(root, post).getQuota(true);
  assert.equal(payload.ok, true);
  assert.equal(payload.accounts.length, 1);
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes('ya29.'), 'access token leaked into payload');
  assert.ok(!serialized.includes('TEST-REFRESH-TOKEN'), 'refresh token leaked into payload');
  assert.ok(!serialized.includes('csecret'), 'client secret leaked into payload');
});

test('HTTP 500 from all endpoints -> explicit error, no windows fabricated', async () => {
  const root = tempRoot();
  seedToken(root, 'c'.repeat(64));
  const payload = await service(root, fakePost(() => ({ status: 500, json: null }))).getQuota(true);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /500/);
  assert.deepEqual(payload.accounts, []);
});

test('timeout -> timeout error surface, no crash', async () => {
  const root = tempRoot();
  seedToken(root, 'd'.repeat(64));
  const post = fakePost(() => {
    const err = new Error('socket hang up');
    err.code = 'ETIMEDOUT';
    throw err;
  });
  const payload = await service(root, post).getQuota(true);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /超时/);
});

test('cache TTL 45s, refresh=1 bypasses cache, failures keep stale data', async () => {
  const root = tempRoot();
  seedToken(root, 'e'.repeat(64));
  let mode = 'ok';
  const post = fakePost((url) => {
    if (mode === 'fail') return { status: 500, json: null };
    if (url.endsWith(QUOTA_PATH)) return { status: 200, json: SUMMARY };
    return { status: 404, json: null };
  });
  let clock = NOW;
  const svc = createQuotaService({ accountsRoot: root, postJson: post, refreshViaAcp: null, now: () => clock, timeoutMs: 10_000 });
  await svc.getQuota(true);
  const callsAfterFirst = post.calls.length;
  clock = NOW + 20_000;
  const cached = await svc.getQuota(false);
  assert.equal(cached.cached, true);
  assert.equal(post.calls.length, callsAfterFirst);
  clock = NOW + 60_000;
  mode = 'fail';
  const stale = await svc.getQuota(false);
  assert.equal(stale.stale, true);
  assert.equal(stale.ok, true);
  assert.equal(stale.accounts[0].windows.length, 4);
  assert.match(stale.error, /500/);
});

test('win-proxy parses Windows ProxyServer formats and bypass lists', () => {
  assert.equal(winProxy.parseWindowsProxyServer('127.0.0.1:10808').origin, 'http://127.0.0.1:10808');
  assert.equal(winProxy.parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891').origin, 'http://127.0.0.1:7891');
  assert.equal(winProxy.parseWindowsProxyServer('socks=127.0.0.1:1080'), null);
  assert.equal(winProxy.shouldBypassHost('localhost', '<local>;*.corp'), true);
  assert.equal(winProxy.shouldBypassHost('daily-cloudcode-pa.googleapis.com', '<local>;*.corp'), false);
});

test('quota-router enforces prefix and local/t3code origins', () => {
  const handler = createQuotaRouteHandler({ getQuota: async () => ({ ok: true, accounts: [] }) }, { prefix: '/__t3_ag_quota', mode: 'embedded' });
  const mockRes = () => {
    let status = 0;
    let headers = {};
    let body = '';
    return {
      writeHead(s, h) { status = s; headers = h; },
      end(b) { body = String(b || ''); },
      result() { return { status, headers, body }; },
    };
  };
  assert.equal(handler({ url: '/api/threads', method: 'GET', headers: {} }, mockRes()), false);
  const badOrigin = mockRes();
  assert.equal(handler({ url: '/__t3_ag_quota/health', method: 'GET', headers: { origin: 'https://evil.example' } }, badOrigin), true);
  assert.equal(badOrigin.result().status, 403);
  const okOrigin = mockRes();
  assert.equal(handler({ url: '/__t3_ag_quota/health', method: 'GET', headers: { origin: 't3code://app' } }, okOrigin), true);
  assert.equal(okOrigin.result().status, 200);
  assert.equal(okOrigin.result().headers['access-control-allow-origin'], 't3code://app');
  assert.equal(JSON.parse(okOrigin.result().body).mode, 'embedded');
});

test('sanitizeError strips bearer tokens and long token shapes', () => {
  const out = core.sanitizeError('boom Bearer ya29.abcdefghijklmnop and 1//xyzxyzxyzxyzxyzxyz', []);
  assert.ok(!out.includes('ya29.abcdefghijklmnop'));
  assert.ok(!out.includes('1//xyzxyzxyzxyzxyzxyz'));
});

test('protobuf3 omitted remainingFraction with valid resetTime maps to 0% and preserves exhausted models', () => {
  const exhaustedSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models: Gemini 4 Carbon, Gemini 4 Neon',
        buckets: [{ bucketId: 'gemini-5h', window: '5h', resetTime: '2026-11-22T17:00:00Z' }],
      },
    ],
  };
  const { windows } = core.normalizeQuotaPayload(exhaustedSummary, { nowMs: NOW });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].remainingPct, 0);
  assert.equal(windows[0].usedPct, 100);

  const { models } = core.normalizeAvailableModels({
    models: {
      'gemini-4-carbon-high': {
        displayName: 'Gemini 4 Carbon (High)',
        modelProvider: 'MODEL_PROVIDER_GOOGLE',
        quotaInfo: { resetTime: '2026-11-22T17:00:00Z' },
      },
    },
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].remainingPct, 0);

  const pools = core.buildAccountPools(windows, models);
  const reconciled = core.reconcileModelsWithPools(models, pools);
  assert.equal(reconciled.length, 2);
  assert.ok(reconciled.every((m) => m.remainingPct === 0));
});

test('anti-ban compliance: caches loadCodeAssist & fetchAvailableModels, enforces minForceIntervalMs and 429 backoff', async () => {
  const root = tempRoot();
  seedToken(root, 'f'.repeat(64));
  let hitSummary = 0;
  let hitModels = 0;
  let hitAssist = 0;
  let return429 = false;
  const post = fakePost((url) => {
    if (return429) return { status: 429, json: null };
    if (url.endsWith(QUOTA_PATH)) { hitSummary += 1; return { status: 200, json: SUMMARY }; }
    if (url.endsWith(MODELS_PATH)) { hitModels += 1; return { status: 200, json: MODELS_PAYLOAD }; }
    if (url.endsWith('/v1internal:loadCodeAssist')) { hitAssist += 1; return { status: 200, json: ASSIST_PAYLOAD }; }
    return { status: 404, json: null };
  });
  let clock = NOW;
  const svc = createQuotaService({
    accountsRoot: root,
    postJson: post,
    refreshViaAcp: null,
    now: () => clock,
    timeoutMs: 5_000,
    cacheTtlMs: 60_000,
    minForceIntervalMs: 15_000,
  });

  const first = await svc.getQuota(true);
  assert.equal(first.ok, true);
  assert.equal(hitSummary, 1);
  assert.equal(hitModels, 1);
  assert.equal(hitAssist, 1);

  // Rapid manual refresh within 15s returns rateProtected cached snapshot (0 upstream calls)
  clock += 3_000;
  const rapid = await svc.getQuota(true);
  assert.equal(rapid.rateProtected, true);
  assert.equal(hitSummary, 1);

  // Refresh after 20s fetches ONLY summary; models (5m TTL) & assist (30m TTL) stay cached
  clock += 20_000;
  const second = await svc.getQuota(true);
  assert.equal(second.ok, true);
  assert.equal(hitSummary, 2);
  assert.equal(hitModels, 1);
  assert.equal(hitAssist, 1);

  // 429 triggers 5-minute circuit breaker without hammering upstream
  clock += 20_000;
  return429 = true;
  const limited = await svc.getQuota(true);
  assert.equal(limited.stale, true);
  const callsAfter429 = post.calls.length;
  clock += 20_000;
  await svc.getQuota(true);
  assert.equal(post.calls.length, callsAfter429, 'circuit breaker must block upstream calls during 429 cooldown');
});
