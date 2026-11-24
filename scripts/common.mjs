import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const PLUGIN_NAME = 't3code-antigravity-quota';
export const STARTUP_LNK = 'T3 Antigravity Quota.lnk';
export const DEFAULT_INSTALL_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 't3code');
export const PLUGIN_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), PLUGIN_NAME);
export const STARTUP_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');

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

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}