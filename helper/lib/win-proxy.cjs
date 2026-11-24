'use strict';

/**
 * Dynamic proxy resolver for Windows + Node.js.
 * Reads process env proxies first, then falls back to Windows Registry Internet Settings
 * so reboots / post-login proxy clients (v2rayN, sing-box, Clash) work without env restarts.
 */

const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const CACHE_TTL_MS = 15_000;

let regCache = null;

function clearProxyCache() {
  regCache = null;
}

function parseProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) {
    text = 'http://' + text;
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed;
}

/**
 * Parse Windows Registry ProxyServer values such as:
 * - "127.0.0.1:10808"
 * - "http=127.0.0.1:10808;https=127.0.0.1:10808"
 * - "socks=127.0.0.1:10808" (ignored for HTTP CONNECT)
 */
function parseWindowsProxyServer(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('=')) {
    return parseProxyUrl(trimmed);
  }
  const map = new Map();
  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const scheme = part.slice(0, eq).trim().toLowerCase();
    const addr = part.slice(eq + 1).trim();
    if (addr) map.set(scheme, addr);
  }
  for (const preferred of ['https', 'http']) {
    if (map.has(preferred)) {
      const url = parseProxyUrl(map.get(preferred));
      if (url) return url;
    }
  }
  return null;
}

function shouldBypassHost(targetHost, bypassRaw) {
  const host = String(targetHost || '').trim().toLowerCase();
  if (!host || !bypassRaw) return false;
  const items = String(bypassRaw)
    .split(/[,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const item of items) {
    if (item === '*') return true;
    if (item === '<local>' && !host.includes('.')) return true;
    const bare = item.replace(/^\*\.?/, '').replace(/^\./, '');
    if (!bare) continue;
    if (host === bare || host.endsWith('.' + bare)) return true;
  }
  return false;
}

function queryRegistryProxy(execFileFn) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    const runner = execFileFn || execFile;
    runner(
      'reg.exe',
      ['query', REG_KEY],
      { windowsHide: true, timeout: 1500, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        let enabled = false;
        let server = '';
        let override = '';
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_\w+\s+(.+?)\s*$/i);
          if (!m) continue;
          const name = m[1].toLowerCase();
          const val = m[2].trim();
          if (name === 'proxyenable') enabled = val === '0x1' || val === '1';
          else if (name === 'proxyserver') server = val;
          else if (name === 'proxyoverride') override = val;
        }
        if (!enabled || !server) {
          resolve(null);
          return;
        }
        const url = parseWindowsProxyServer(server);
        resolve(url ? { url, override } : null);
      },
    );
  });
}

async function getRegistryProxy(opts) {
  const now = Date.now();
  if (!(opts && opts.forceRefresh) && regCache && now - regCache.at < CACHE_TTL_MS) {
    return regCache.value;
  }
  const value = await queryRegistryProxy(opts && opts.execFile);
  regCache = { at: now, value };
  return value;
}

function envProxyForHost(targetHost) {
  const env = process.env;
  const raw =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  if (!raw) return null;
  const url = parseProxyUrl(raw);
  if (!url) return null;
  if (shouldBypassHost(targetHost, env.NO_PROXY || env.no_proxy || '')) return null;
  return url;
}

async function resolveProxy(targetHost, opts) {
  const preferRegistry = opts && opts.preferRegistry;
  if (!preferRegistry) {
    const fromEnv = envProxyForHost(targetHost);
    if (fromEnv) return { url: fromEnv, source: 'env' };
  }
  const fromReg = await getRegistryProxy(opts);
  if (fromReg && !shouldBypassHost(targetHost, fromReg.override)) {
    return { url: fromReg.url, source: 'registry' };
  }
  if (preferRegistry) {
    const fromEnv = envProxyForHost(targetHost);
    if (fromEnv) return { url: fromEnv, source: 'env' };
  }
  return null;
}

async function getProxyEnvPatch(targetHost) {
  if (envProxyForHost(targetHost)) return {};
  const resolved = await resolveProxy(targetHost, { forceRefresh: true });
  if (!resolved) return {};
  const href = resolved.url.origin;
  return { HTTPS_PROXY: href, HTTP_PROXY: href };
}

module.exports = {
  parseProxyUrl,
  parseWindowsProxyServer,
  shouldBypassHost,
  resolveProxy,
  getProxyEnvPatch,
  clearProxyCache,
};
