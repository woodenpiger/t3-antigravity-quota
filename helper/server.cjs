'use strict';

/**
 * Standalone / dev HTTP server for T3 Antigravity Quota.
 * In production, T3 Code loads the embedded hook directly on its own HTTP server;
 * this standalone server remains available for fixture previews, tests, and local dev.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { httpsPostJson } = require('./lib/http-post.cjs');
const { createQuotaService, defaultAccountsRoot } = require('./quota-service.cjs');
const { ALLOWED_ORIGIN, corsHeaders, sendJson, createQuotaRouteHandler } = require('./lib/quota-router.cjs');

const VERSION = '2.0.0';
const STATIC_FILES = {
  '/assets/antigravity-quota.js': ['antigravity-quota.js', 'application/javascript; charset=utf-8'],
  '/assets/antigravity-quota.css': ['antigravity-quota.css', 'text/css; charset=utf-8'],
};

function log(line) {
  const target = process.env.T3_AG_LOG;
  const text = '[' + new Date().toISOString() + '] ' + line + '\n';
  if (target) {
    try {
      fs.appendFileSync(target, text);
      return;
    } catch {
      /* fall through to stdout */
    }
  }
  process.stdout.write(text);
}

function resolvePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port' && argv[i + 1]) {
      const port = Number(argv[i + 1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
  }
  if (process.env.T3_AG_QUOTA_PORT) {
    const port = Number(process.env.T3_AG_QUOTA_PORT);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return 47821;
}

function sendStatic(req, res, fileInfo) {
  const { headers, allowed } = corsHeaders(req);
  if (!allowed) {
    res.writeHead(403, headers);
    res.end('origin not allowed');
    return;
  }
  const file = path.join(__dirname, '..', 'renderer', fileInfo[0]);
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    res.writeHead(404, Object.assign({}, headers, { 'content-type': 'text/plain; charset=utf-8' }));
    res.end('not found');
    return;
  }
  res.writeHead(
    200,
    Object.assign({}, headers, {
      'content-type': fileInfo[1],
      'content-length': data.length,
    }),
  );
  res.end(data);
}

function createServer(service) {
  const handleQuota = createQuotaRouteHandler(service, { mode: 'standalone', log });
  return http.createServer((req, res) => {
    if (handleQuota(req, res)) return;
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
      sendStatic(req, res, STATIC_FILES[url.pathname]);
      return;
    }
    sendJson(req, res, 404, { ok: false, error: 'not found' });
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version')) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  const port = resolvePort(argv);
  const host = '127.0.0.1';
  const service = createQuotaService({
    accountsRoot: defaultAccountsRoot(),
    postJson: httpsPostJson,
    timeoutMs: 10_000,
    cacheTtlMs: 45_000,
  });
  const server = createServer(service);
  server.on('error', (err) => {
    log('helper failed to bind ' + host + ':' + port + ' -> ' + (err && err.code ? err.code : 'error'));
    process.exit(err && err.code === 'EADDRINUSE' ? 2 : 1);
  });
  server.listen(port, host, () => {
    log('helper listening on http://' + host + ':' + port + ' v' + VERSION);
  });
  const shutdown = (signal) => {
    log('helper stopping (' + signal + ')');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { VERSION, httpsPostJson, createServer, resolvePort, ALLOWED_ORIGIN };
