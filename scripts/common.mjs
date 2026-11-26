import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

export const PLUGIN_VERSION = '2.3.0';
export const PLUGIN_NAME = 't3code-antigravity-quota';
export const STARTUP_LNK = 'T3 Antigravity Quota.lnk';
export const AUTO_HEAL_REG_NAME = 'T3AntigravityQuotaAutoHeal';
export const RUN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

export const DEFAULT_INSTALL_DIR = path.join(localAppData, 'Programs', 't3code');
export const PLUGIN_DIR = path.join(localAppData, PLUGIN_NAME);
export const PAYLOAD_DIR = path.join(PLUGIN_DIR, 'payload');
export const BACKUPS_DIR = path.join(PLUGIN_DIR, 'backups');
export const AUTO_HEAL_PID = path.join(PLUGIN_DIR, 'auto-heal.pid');
export const AUTO_HEAL_STATE = path.join(PLUGIN_DIR, 'auto-heal-state.json');
export const AUTO_HEAL_LOG = path.join(PLUGIN_DIR, 'auto-heal.log');
export const AUTO_HEAL_VBS = path.join(PLUGIN_DIR, 'launch-auto-heal.vbs');
export const STARTUP_DIR = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function runPowerShell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function listT3Processes(installDir) {
  const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
    const name = cells[0] || '';
    const pid = Number(cells[1]);
    if (/^T3 Code/i.test(name) && Number.isInteger(pid)) pids.push({ pid, name });
  }
  return { pids, installDir };
}

export function isT3InstallerRunning() {
  try {
    const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cells = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
      const name = cells[0] || '';
      if (/^(t3code|t3 code).*(setup|update|install)|^elevate\.exe$/i.test(name)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function stopT3() {
  const script = [
    '$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "T3 Code*" }',
    'foreach ($p in $procs) { try { $null = $p.CloseMainWindow() } catch {} }',
    'Start-Sleep -Milliseconds 1200',
    'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "T3 Code*" } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Milliseconds 800',
    '"closed"',
  ].join('; ');
  return runPowerShell(script).trim();
}

export async function findFreePort(start, end) {
  const net = await import('node:net');
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('no free port in range ' + start + '-' + end);
}

export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true });
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function findNodeExe() {
  const ordered = [];
  try {
    const where = execFileSync('where.exe', ['node'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/);
    for (const line of where) if (line.trim()) ordered.push(line.trim());
  } catch {
    /* ignore */
  }
  ordered.push(process.execPath);
  const seen = new Set();
  const unique = ordered.filter((p) => {
    if (!p) return false;
    const key = p.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const usable = unique.filter((p) => fs.existsSync(p) && /node\.exe$/i.test(p));
  const stable = usable.filter((p) => !/[\\/]WindowsApps[\\/]/i.test(p));
  return stable[0] || usable[0] || process.execPath;
}

export function t3Version(installDir) {
  const runtime = readJson(path.join(os.homedir(), '.t3', 'userdata', 'server-runtime.json'), null);
  if (runtime && typeof runtime.serverVersion === 'string') return runtime.serverVersion;
  return 'unknown';
}

export function t3VersionFromAsar(asarPath, readAsarHeader, walkFiles, readEntryData) {
  try {
    const h = readAsarHeader(asarPath);
    let pkgEntry = null;
    walkFiles(h.header, (p, e) => {
      if (p === 'package.json') pkgEntry = e;
    });
    if (pkgEntry) {
      const txt = readEntryData(asarPath, h.dataOffset, {
        size: Number(pkgEntry.size),
        offset: Number(pkgEntry.offset),
      }).toString('utf8');
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    /* fallback to server-runtime.json */
  }
  return t3Version();
}

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isAutoHealRunning() {
  try {
    const pid = Number(fs.readFileSync(AUTO_HEAL_PID, 'utf8').trim());
    return isPidAlive(pid);
  } catch {
    return false;
  }
}

export function stopAutoHeal() {
  try {
    if (fs.existsSync(AUTO_HEAL_PID)) {
      const pid = Number(fs.readFileSync(AUTO_HEAL_PID, 'utf8').trim());
      if (isPidAlive(pid) && pid !== process.pid) {
        try { process.kill(pid); } catch {}
      }
      try { fs.unlinkSync(AUTO_HEAL_PID); } catch {}
    }
  } catch {
    /* ignore */
  }
  try {
    const script = [
      '$hits = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "node.exe" -and $_.ProcessId -ne ' + process.pid + ' -and $_.CommandLine -and $_.CommandLine -like "*t3code-antigravity-quota*" -and $_.CommandLine -like "*auto-heal.mjs*" }',
      'foreach ($h in $hits) { Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue }',
      '"stopped=" + @($hits).Count',
    ].join('; ');
    return runPowerShell(script).trim();
  } catch {
    return 'stopped=0';
  }
}

function vbsQuote(value) {
  return String(value).replace(/"/g, '""');
}

export function writeAutoHealLauncher(installDir) {
  ensureDir(PLUGIN_DIR);
  const nodeExe = findNodeExe();
  const scriptPath = path.join(PAYLOAD_DIR, 'scripts', 'auto-heal.mjs');
  const cmd = '""' + vbsQuote(nodeExe) + '"" ""' + vbsQuote(scriptPath) + '"" --watch --install-dir ""' + vbsQuote(installDir) + '""';
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run "' + cmd + '", 0, False',
    '',
  ].join('\r\n');
  fs.writeFileSync(AUTO_HEAL_VBS, vbs, 'utf8');
  return AUTO_HEAL_VBS;
}

export function registerAutoHeal(installDir) {
  const vbsPath = writeAutoHealLauncher(installDir);
  const value = 'wscript.exe //B //Nologo "' + vbsPath + '"';
  execFileSync('reg.exe', ['add', RUN_REG_KEY, '/v', AUTO_HEAL_REG_NAME, '/t', 'REG_SZ', '/d', value, '/f'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { regKey: RUN_REG_KEY, regName: AUTO_HEAL_REG_NAME, vbsPath };
}

export function unregisterAutoHeal() {
  try {
    execFileSync('reg.exe', ['delete', RUN_REG_KEY, '/v', AUTO_HEAL_REG_NAME, '/f'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    /* ignore if absent */
  }
  try {
    if (fs.existsSync(AUTO_HEAL_VBS)) fs.unlinkSync(AUTO_HEAL_VBS);
  } catch {
    /* ignore */
  }
}

export function isAutoHealRegistered() {
  try {
    const out = execFileSync('reg.exe', ['query', RUN_REG_KEY, '/v', AUTO_HEAL_REG_NAME], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return out.includes(AUTO_HEAL_REG_NAME);
  } catch {
    return false;
  }
}

export function startAutoHealDetached(installDir) {
  const vbsPath = fs.existsSync(AUTO_HEAL_VBS) ? AUTO_HEAL_VBS : writeAutoHealLauncher(installDir);
  const child = spawn('wscript.exe', ['//B', '//Nologo', vbsPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return vbsPath;
}
