/**
 * Embedded Antigravity quota HTTP route hook for T3 Code's server.asar.
 * Loaded once from apps/server/dist/bin.mjs when starting the T3 server daemon.
 * Intercepts `/__t3_ag_quota/*` directly on T3's own HTTP server so the plugin
 * survives reboots, port changes, and never depends on external Startup tasks.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HOOK_FLAG = Symbol.for('t3.ag.quota.httpHookInstalled');

if (!globalThis[HOOK_FLAG]) {
  globalThis[HOOK_FLAG] = true;
  const require = createRequire(import.meta.url);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const baseDir = fs.existsSync(path.join(dir, 'quota-service.cjs'))
    ? dir
    : path.resolve(dir, '..', 'helper');
  const { httpsPostJson } = require(path.join(baseDir, 'lib', 'http-post.cjs'));
  const { createQuotaService, defaultAccountsRoot } = require(path.join(baseDir, 'quota-service.cjs'));
  const { createQuotaRouteHandler } = require(path.join(baseDir, 'lib', 'quota-router.cjs'));

  const service = createQuotaService({
    accountsRoot: defaultAccountsRoot(),
    postJson: httpsPostJson,
    timeoutMs: 9_000,
    cacheTtlMs: 60_000,
    minForceIntervalMs: 15_000,
  });

  const handleQuota = createQuotaRouteHandler(service, {
    prefix: '/__t3_ag_quota',
    mode: 'embedded',
  });

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function patchedServerEmit(event, ...args) {
    if (event === 'request' && args.length >= 2) {
      try {
        if (handleQuota(args[0], args[1])) return true;
      } catch {
        /* fall through to T3 server if unexpected error */
      }
    }
    return origEmit.apply(this, [event, ...args]);
  };
}
