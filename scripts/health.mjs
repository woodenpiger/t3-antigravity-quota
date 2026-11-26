import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {
  AUTO_HEAL_STATE,
  DEFAULT_INSTALL_DIR,
  PLUGIN_DIR,
  isAutoHealRegistered,
  isAutoHealRunning,
  readJson,
} from './common.mjs';
import { inspectAsarInjection } from './auto-heal.mjs';

export function parseHealthArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let port = null;
  let installDir = null;
  let refresh = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--refresh') {
      refresh = true;
    } else if (a === '--install-dir' && args[i + 1]) {
      installDir = args[i + 1];
      i += 1;
    } else if (a === '--port' && args[i + 1]) {
      const p = Number(args[i + 1]);
      if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
      i += 1;
    } else if (/^\d+$/.test(a)) {
      const p = Number(a);
      if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
    }
  }
  return { port, installDir, refresh };
}

const isMain = process.argv[1] && path.basename(process.argv[1]).toLowerCase() === 'health.mjs';
if (isMain) {
  const parsed = parseHealthArgs(process.argv.slice(2));
  const record = readJson(path.join(PLUGIN_DIR, 'install-record.json'), null);
  const installDir = parsed.installDir || (record && record.t3InstallDir) || process.env.T3CODE_DIR || DEFAULT_INSTALL_DIR;
  const asarPath = path.join(installDir, 'resources', 'server.asar');
  const asarStatus = inspectAsarInjection(asarPath);
  const healState = readJson(AUTO_HEAL_STATE, null);

  console.log('=== T3 Antigravity Quota Health ===');
  console.log('t3_version=' + asarStatus.version + ' asar_injected=' + asarStatus.injected);
  console.log('auto_heal_registered=' + isAutoHealRegistered() + ' auto_heal_running=' + isAutoHealRunning() + (healState ? ' auto_heal_status=' + healState.status : ''));
  if (asarStatus.exists && !asarStatus.injected) {
    console.log('HINT: T3 Code updated to ' + asarStatus.version + '. Close T3 Code to trigger auto-heal, or run install.cmd.');
  }

  const t3Runtime = readJson(path.join(os.homedir(), '.t3', 'userdata', 'server-runtime.json'), null);
  const host = (t3Runtime && t3Runtime.host) || '127.0.0.1';
  const port = parsed.port || Number(t3Runtime && t3Runtime.port) || 3773;
  const prefix = parsed.port ? '' : '/__t3_ag_quota';
  const url = 'http://' + host + ':' + port + prefix + (parsed.refresh ? '/api/quota?refresh=1' : '/api/quota');

  http.get(url, { timeout: 30000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      console.log('HTTP ' + res.statusCode + ' ' + url);
      console.log(body);
    });
  }).on('error', (err) => {
    console.error('request failed: ' + err.message);
    process.exit(1);
  }).on('timeout', function () { this.destroy(new Error('timeout')); });
}
