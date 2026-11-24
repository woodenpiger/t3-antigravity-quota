'use strict';

/**
 * Zero-dependency HTTPS JSON POST with dynamic env + Windows Registry proxy tunneling.
 * Never logs or exposes proxy credentials or bearer tokens.
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { resolveProxy, clearProxyCache } = require('./win-proxy.cjs');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function timeoutError() {
  const err = new Error('upstream timeout');
  err.code = 'ETIMEDOUT';
  return err;
}

function connectViaProxy(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { host: host + ':' + port };
    if (proxy.username || proxy.password) {
      const user = decodeURIComponent(proxy.username || '');
      const pass = decodeURIComponent(proxy.password || '');
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: host + ':' + port,
      headers,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const err = new Error('proxy CONNECT failed with ' + res.statusCode);
        err.code = 'EPROXY';
        reject(err);
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(timeoutError()));
    req.on('error', reject);
    req.end();
  });
}

function tlsOverSocket(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    const timer = setTimeout(() => secure.destroy(timeoutError()), timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class TunnelAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this._tunnelSocket = socket;
  }
  createConnection() {
    return this._tunnelSocket;
  }
}

function dispatch(client, target, opts, timeoutMs, extra) {
  const body = typeof opts.body === 'string' ? opts.body : '';
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      fn(value);
    };
    const wallTimer = setTimeout(() => {
      const err = timeoutError();
      if (req) {
        try { req.destroy(err); } catch { /* ignore */ }
      }
      done(reject, err);
    }, timeoutMs);
    req = client.request(
      Object.assign(
        {
          host: target.hostname,
          port: Number(target.port || 443),
          path: target.pathname + target.search,
          method: opts.method || 'POST',
          headers: Object.assign({}, opts.headers, {
            'content-length': Buffer.byteLength(body),
            'accept-encoding': 'identity',
          }),
          timeout: timeoutMs,
        },
        extra || {},
      ),
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            const err = new Error('response too large');
            err.code = 'ETOOLARGE';
            req.destroy(err);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          done(resolve, { status: res.statusCode || 0, json, bytes: size });
        });
        res.on('error', (err) => done(reject, err));
      },
    );
    req.on('timeout', () => req.destroy(timeoutError()));
    req.on('error', (err) => done(reject, err));
    req.end(body);
  });
}

async function sendWithProxy(target, opts, timeoutMs, proxy) {
  if (!proxy) {
    return dispatch(https, target, opts, timeoutMs, null);
  }
  const tunnel = await connectViaProxy(proxy, target.hostname, Number(target.port || 443), timeoutMs);
  const secure = await tlsOverSocket(tunnel, target.hostname, timeoutMs);
  const agent = new TunnelAgent(secure);
  try {
    return await dispatch(https, target, opts, timeoutMs, { agent });
  } finally {
    secure.destroy();
  }
}

function isProxyTransportError(err) {
  if (!err || !err.code) return false;
  return err.code === 'ECONNREFUSED' || err.code === 'EPROXY' || err.code === 'ETIMEDOUT';
}

async function httpsPostJson(url, options) {
  const opts = options || {};
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 10_000;
  const target = new URL(url);
  const resolved = await resolveProxy(target.hostname);
  try {
    return await sendWithProxy(target, opts, timeoutMs, resolved ? resolved.url : null);
  } catch (err) {
    if (!isProxyTransportError(err)) throw err;
    clearProxyCache();
    const fresh = await resolveProxy(target.hostname, { forceRefresh: true, preferRegistry: true });
    const prevHref = resolved ? resolved.url.origin : null;
    const nextHref = fresh ? fresh.url.origin : null;
    if (nextHref === prevHref) {
      if (!resolved) throw err;
      // Configured proxy may be down while direct access works; try direct once.
      return sendWithProxy(target, opts, Math.min(timeoutMs, 5000), null);
    }
    return sendWithProxy(target, opts, timeoutMs, fresh ? fresh.url : null);
  }
}

module.exports = { httpsPostJson };
