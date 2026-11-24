'use strict';

/**
 * Silent token renewal via T3 Code's installed Antigravity ACP runtime (agy.exe).
 * Never extracts OAuth secrets, never opens a browser, and only renews an existing
 * refresh_token through the official ACP initialize + authenticate handshake.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getProxyEnvPatch } = require('./win-proxy.cjs');

const BROWSER_MARKER = '__T3_AG_BROWSER__';

function findAgyExecutable() {
  const envBin = process.env.T3_AG_AGY_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  const versionsDir = path.join(os.homedir(), '.t3', 'tools', 'antigravity-acp', 'win32-x64', 'versions');
  try {
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const exe = path.join(versionsDir, d.name, 'agy.exe');
        if (!fs.existsSync(exe)) return null;
        return { exe, mtimeMs: fs.statSync(exe).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (entries.length) return entries[0].exe;
  } catch {
    /* ignore */
  }
  return null;
}

function buildBrowserSuppressCommand() {
  const exec = process.execPath.replaceAll('\\', '/');
  const script = `process.stderr.write("${BROWSER_MARKER}\\n");process.exit(1)`;
  const quote = (v) => `'${v.replaceAll("'", `'"'"'`)}'`;
  return [exec, '-e', script, '--', '%s'].map(quote).join(' ');
}

function authMethodIdFor(authMethod) {
  if (authMethod === 'oauth-business') return 'oauth-business';
  return 'oauth-personal';
}

async function refreshViaAcp(profileDir, opts) {
  const options = opts || {};
  const agyExe = findAgyExecutable();
  if (!agyExe) {
    return {
      ok: false,
      needsT3Refresh: true,
      error: '未找到 Antigravity 运行时，请在 T3 Code 中使用一次 Antigravity',
    };
  }
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 8_000;
  const proxyPatch = await getProxyEnvPatch('oauth2.googleapis.com').catch(() => ({}));
  const env = Object.assign({}, process.env, proxyPatch, {
    GEMINI_HOME: profileDir,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    ELECTRON_RUN_AS_NODE: '1',
    BROWSER: buildBrowserSuppressCommand(),
  });

  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    let browserTriggered = false;
    const child = spawn(
      agyExe,
      ['acp', '--gemini-dir', profileDir, '--app-data-dir', 'antigravity-acp'],
      {
        cwd: profileDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child.stdin) child.stdin.destroy(); } catch { /* ignore */ }
      try { if (child.stdout) child.stdout.destroy(); } catch { /* ignore */ }
      try { if (child.stderr) child.stderr.destroy(); } catch { /* ignore */ }
      try {
        if (!child.killed) child.kill();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, needsT3Refresh: false, error: '静默刷新登录超时，请重试' });
    }, timeoutMs);

    child.on('error', () => {
      finish({ ok: false, needsT3Refresh: true, error: '无法启动 Antigravity 登录刷新进程' });
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (text.includes(BROWSER_MARKER) || text.includes('https://accounts.google.com/')) {
        browserTriggered = true;
        finish({
          ok: false,
          needsT3Refresh: true,
          error: 'Antigravity 授权已失效，请在 T3 Code 连接设置中重新登录',
        });
      }
    });

    child.stdout.on('data', (chunk) => {
      buf += String(chunk);
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ ok: false, needsT3Refresh: true, error: 'Antigravity 初始化失败，请重新登录' });
            return;
          }
          child.stdin.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 2,
              method: 'authenticate',
              params: { methodId: authMethodIdFor(options.authMethod) },
            }) + '\n',
          );
        } else if (msg.id === 2) {
          if (msg.error || browserTriggered) {
            finish({
              ok: false,
              needsT3Refresh: true,
              error: 'Antigravity 授权已失效，请在 T3 Code 连接设置中重新登录',
            });
          } else {
            finish({ ok: true });
          }
        }
      }
    });

    child.on('exit', () => {
      if (!settled) {
        finish({
          ok: false,
          needsT3Refresh: true,
          error: 'Antigravity 登录刷新意外退出，请在 T3 Code 中重新登录',
        });
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 't3-code', title: 'T3 Code', version: '0.1.11' },
        },
      }) + '\n',
    );
  });
}

module.exports = { findAgyExecutable, refreshViaAcp };
