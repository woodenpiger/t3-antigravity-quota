'use strict';

/**
 * Shared HTTP route handler used by both the embedded T3 server hook and
 * the standalone dev/preview helper server. Never leaks tokens or accepts external origins.
 */

const core = require('./quota-core.cjs');

const ALLOWED_ORIGIN = /^(?:http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?|t3code:\/\/app)$/i;

function corsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : undefined;
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
  };
  if (!origin) return { headers, allowed: true };
  if (!ALLOWED_ORIGIN.test(origin)) return { headers, allowed: false };
  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-methods'] = 'GET, OPTIONS';
  headers['access-control-allow-headers'] = 'content-type, accept';
  headers['access-control-max-age'] = '600';
  return { headers, allowed: true };
}

function sendJson(req, res, status, payload) {
  const { headers, allowed } = corsHeaders(req);
  if (!allowed) {
    res.writeHead(403, Object.assign({}, headers, { 'content-type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ ok: false, error: 'origin not allowed' }));
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(
    status,
    Object.assign({}, headers, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }),
  );
  res.end(body);
}

/**
 * Attempt to handle `/health` and `/api/quota` (optionally prefixed with `prefix`).
 * Returns true if the request was handled, false otherwise.
 */
function createQuotaRouteHandler(service, options) {
  const opts = options || {};
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : '';
  const mode = opts.mode || 'standalone';
  const startedAt = Date.now();
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  return function handleQuotaRequest(req, res) {
    if (!req || !req.url) return false;
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return false;
    }
    const pathname = url.pathname;
    if (prefix && !pathname.startsWith(prefix)) return false;
    const subPath = prefix ? pathname.slice(prefix.length) || '/' : pathname;
    if (subPath !== '/health' && subPath !== '/api/quota') return false;

    if (req.method === 'OPTIONS') {
      const { headers, allowed } = corsHeaders(req);
      res.writeHead(allowed ? 204 : 403, headers);
      res.end();
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(req, res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }
    if (subPath === '/health') {
      sendJson(req, res, 200, {
        ok: true,
        mode,
        version: core.VERSION,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
      return true;
    }

    const refresh = url.searchParams.get('refresh') === '1';
    service
      .getQuota(refresh)
      .then((payload) => {
        const status = payload.ok ? 200 : 502;
        sendJson(req, res, status, payload);
        log('quota refresh=' + (refresh ? '1' : '0') + ' ok=' + payload.ok + ' accounts=' + (payload.accounts ? payload.accounts.length : 0));
      })
      .catch((err) => {
        const message = core.sanitizeError(err && err.message ? err.message : 'internal error');
        sendJson(req, res, 500, {
          ok: false,
          checkedAt: new Date().toISOString(),
          source: 'antigravity',
          accounts: [],
          error: message,
        });
        log('quota error: ' + message);
      });
    return true;
  };
}

module.exports = {
  ALLOWED_ORIGIN,
  corsHeaders,
  sendJson,
  createQuotaRouteHandler,
};
