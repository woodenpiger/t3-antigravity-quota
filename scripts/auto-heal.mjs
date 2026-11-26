import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readAsarHeader, walkFiles, readEntryData } from './asar-lib.mjs';
import { MARK_START } from './inject-html.mjs';
import { BIN_MARK_START } from './patch-bin.mjs';
import {
  AUTO_HEAL_LOG,
  AUTO_HEAL_PID,
  AUTO_HEAL_STATE,
  DEFAULT_INSTALL_DIR,
  PAYLOAD_DIR,
  PLUGIN_DIR,
  ensureDir,
  findNodeExe,
  isPidAlive,
  isT3InstallerRunning,
  listT3Processes,
  readJson,
  t3VersionFromAsar,
  writeJson,
} from './common.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const option = (name, fallback) => {
  const idx = argv.indexOf('--' + name);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
};

const recordPath = path.join(PLUGIN_DIR, 'install-record.json');
const initialRecord = readJson(recordPath, null);
const installDir = option('install-dir', (initialRecord && initialRecord.t3InstallDir) || process.env.T3CODE_DIR || DEFAULT_INSTALL_DIR);
const asarPath = path.join(installDir, 'resources', 'server.asar');
const resourcesDir = path.dirname(asarPath);
const installScript = fs.existsSync(path.join(PAYLOAD_DIR, 'scripts', 'install.mjs'))
  ? path.join(PAYLOAD_DIR, 'scripts', 'install.mjs')
  : path.join(scriptDir, 'install.mjs');

const onceMode = flag('once') || !flag('watch');
const MAX_LOG_BYTES = 64 * 1024;

function log(message) {
  try {
    ensureDir(PLUGIN_DIR);
    if (fs.existsSync(AUTO_HEAL_LOG) && fs.statSync(AUTO_HEAL_LOG).size > MAX_LOG_BYTES) {
      const tail = fs.readFileSync(AUTO_HEAL_LOG, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2));
      fs.writeFileSync(AUTO_HEAL_LOG, tail, 'utf8');
    }
    fs.appendFileSync(AUTO_HEAL_LOG, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
  } catch {
    /* ignore log failures */
  }
}

function saveState(patch) {
  const prev = readJson(AUTO_HEAL_STATE, {});
  writeJson(AUTO_HEAL_STATE, Object.assign({}, prev, patch, { updatedAt: new Date().toISOString(), pid: process.pid }));
}

export function inspectAsarInjection(file) {
  if (!fs.existsSync(file)) return { exists: false, injected: false, version: 'missing' };
  try {
    const h = readAsarHeader(file);
    let idx = null;
    let bin = null;
    walkFiles(h.header, (p, e) => {
      if (p === 'apps/server/dist/client/index.html') idx = e;
      if (p === 'apps/server/dist/bin.mjs') bin = e;
    });
    if (!idx || !bin) return { exists: true, injected: false, version: 'invalid' };
    const html = readEntryData(file, h.dataOffset, { size: Number(idx.size), offset: Number(idx.offset) }).toString('utf8');
    const binTxt = readEntryData(file, h.dataOffset, { size: Number(bin.size), offset: Number(bin.offset) }).toString('utf8');
    const injected = html.includes(MARK_START) && binTxt.includes(BIN_MARK_START);
    const version = t3VersionFromAsar(file, readAsarHeader, walkFiles, readEntryData);
    return { exists: true, injected, version };
  } catch (err) {
    return { exists: true, injected: false, version: 'error', error: err && err.message ? err.message : String(err) };
  }
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableFile(file) {
  for (let i = 0; i < 12; i += 1) {
    if (!fs.existsSync(file)) {
      await waitMs(1000);
      continue;
    }
    const s1 = fs.statSync(file);
    await waitMs(1200);
    if (!fs.existsSync(file)) continue;
    const s2 = fs.statSync(file);
    if (s1.size > 1024 * 1024 && s1.size === s2.size && s1.mtimeMs === s2.mtimeMs && !isT3InstallerRunning()) {
      return true;
    }
  }
  return false;
}

let busy = false;
let pendingHeal = false;
let exitPollTimer = 0;
let debounceTimer = 0;
let watchers = [];

function clearExitPoll() {
  if (exitPollTimer) {
    clearInterval(exitPollTimer);
    exitPollTimer = 0;
  }
}

function ensureExitPoll() {
  if (onceMode || exitPollTimer) return;
  exitPollTimer = setInterval(() => {
    if (!pendingHeal) {
      clearExitPoll();
      return;
    }
    const running = listT3Processes(installDir);
    if (!running.pids.length && !isT3InstallerRunning()) {
      clearExitPoll();
      setTimeout(() => { void evaluate('t3-exited'); }, 900);
    }
  }, 8000);
  if (typeof exitPollTimer.unref === 'function') exitPollTimer.unref();
}

function shutdown(reason) {
  clearExitPoll();
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];
  try {
    if (fs.existsSync(AUTO_HEAL_PID)) {
      const pid = Number(fs.readFileSync(AUTO_HEAL_PID, 'utf8').trim());
      if (pid === process.pid) fs.unlinkSync(AUTO_HEAL_PID);
    }
  } catch {}
  log('exit (' + reason + ')');
  process.exit(0);
}

async function evaluate(trigger) {
  if (busy) return;
  busy = true;
  try {
    // Stop cleanly if the plugin was uninstalled
    if (!fs.existsSync(recordPath)) {
      if (!onceMode) shutdown('uninstalled');
      return;
    }

    if (trigger === 'fs-watch') {
      const stable = await waitForStableFile(asarPath);
      if (!stable) {
        log('server.asar not stable yet after ' + trigger);
        return;
      }
    }

    const status = inspectAsarInjection(asarPath);
    if (!status.exists) {
      saveState({ status: 'asar-missing', pendingHeal: false, installDir });
      return;
    }
    if (status.injected) {
      pendingHeal = false;
      clearExitPoll();
      saveState({ status: 'healthy', t3Version: status.version, pendingHeal: false, installDir });
      if (trigger !== 'startup') log('verified healthy (' + status.version + ', trigger=' + trigger + ')');
      return;
    }

    // Injection missing -> T3 Code was updated!
    const running = listT3Processes(installDir);
    if (running.pids.length || isT3InstallerRunning()) {
      pendingHeal = true;
      saveState({
        status: 'pending-exit',
        t3Version: status.version,
        pendingHeal: true,
        detectedAt: new Date().toISOString(),
        installDir,
      });
      log('update detected (T3 ' + status.version + ') while T3 is running; waiting for T3 exit to auto-heal');
      ensureExitPoll();
      return;
    }

    // T3 is closed: re-apply injection safely right now
    log('auto-healing T3 Code ' + status.version + ' (trigger=' + trigger + ')...');
    const nodeExe = findNodeExe();
    const out = execFileSync(nodeExe, [installScript, '--from-auto-heal', '--install-dir', installDir], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    const after = inspectAsarInjection(asarPath);
    pendingHeal = !after.injected;
    saveState({
      status: after.injected ? 'healed' : 'heal-failed',
      t3Version: after.version,
      pendingHeal,
      lastHealedAt: new Date().toISOString(),
      installDir,
    });
    log('auto-heal finished injected=' + after.injected + ' version=' + after.version + ' | ' + out.trim().split(/\r?\n/).slice(-1)[0]);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log('auto-heal error: ' + msg);
    saveState({ status: 'error', error: msg, pendingHeal, installDir });
  } finally {
    busy = false;
  }
}

function scheduleCheck(trigger) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = 0;
    void evaluate(trigger);
  }, 1800);
}

function attachWatchers() {
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];

  const watchTargets = [resourcesDir, installDir];
  for (const dir of watchTargets) {
    if (!fs.existsSync(dir)) continue;
    try {
      const w = fs.watch(dir, { persistent: true }, (_eventType, filename) => {
        const name = filename ? String(filename).toLowerCase() : '';
        if (!name || name === 'server.asar' || name === 'resources') {
          scheduleCheck('fs-watch');
        }
      });
      w.on('error', () => {
        setTimeout(() => { attachWatchers(); scheduleCheck('rewatch'); }, 3000);
      });
      watchers.push(w);
    } catch {
      /* ignore watch error */
    }
  }
}

function acquireSingleInstance() {
  ensureDir(PLUGIN_DIR);
  try {
    if (fs.existsSync(AUTO_HEAL_PID)) {
      const existing = Number(fs.readFileSync(AUTO_HEAL_PID, 'utf8').trim());
      if (existing && existing !== process.pid && isPidAlive(existing)) {
        return false;
      }
    }
  } catch {
    /* ignore */
  }
  fs.writeFileSync(AUTO_HEAL_PID, String(process.pid) + '\n', 'utf8');
  return true;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (onceMode) {
    evaluate('once').then(() => process.exit(0));
  } else {
    if (!acquireSingleInstance()) {
      process.exit(0);
    }
    log('auto-heal watcher started pid=' + process.pid + ' installDir=' + installDir);
    process.on('SIGTERM', () => shutdown('sigterm'));
    process.on('SIGINT', () => shutdown('sigint'));
    attachWatchers();
    void evaluate('startup');
  }
}
