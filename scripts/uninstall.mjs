import fs from 'node:fs';
import path from 'node:path';
import { readAsarHeader, walkFiles, readEntryData } from './asar-lib.mjs';
import { patchArchive } from './asar-patch.mjs';
import { MARK_START, stripHtml } from './inject-html.mjs';
import { BIN_MARK_START, stripBinMjs } from './patch-bin.mjs';
import {
  DEFAULT_INSTALL_DIR,
  PLUGIN_DIR,
  STARTUP_DIR,
  STARTUP_LNK,
  listT3Processes,
  readJson,
  runPowerShell,
  sha256File,
  stopAutoHeal,
  stopT3,
  unregisterAutoHeal,
} from './common.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const option = (name, fallback) => {
  const idx = argv.indexOf('--' + name);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
};

const record = readJson(path.join(PLUGIN_DIR, 'install-record.json'), null);
const installDir = option('install-dir', (record && record.t3InstallDir) || process.env.T3CODE_DIR || DEFAULT_INSTALL_DIR);
const asarPath = path.join(installDir, 'resources', 'server.asar');

if (!fs.existsSync(asarPath)) {
  console.error('ERROR: server.asar not found at ' + asarPath);
  process.exit(2);
}

const running = listT3Processes(installDir);
if (running.pids.length && !flag('close-t3')) {
  console.error('T3 Code is running (pids: ' + running.pids.map((p) => p.pid).join(', ') + '). Quit it, or pass --close-t3.');
  process.exit(3);
}
if (running.pids.length) console.log('closing T3 Code: ' + stopT3());

// Stop and unregister auto-heal guard + any legacy background helpers
console.log('auto-heal stop: ' + stopAutoHeal());
unregisterAutoHeal();

const stopScript = [
  '$hits = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine -like "*t3code-antigravity-quota*" }',
  'foreach ($h in $hits) { Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue }',
  '"stopped=" + @($hits).Count',
].join('; ');
try { console.log(runPowerShell(stopScript).trim()); } catch (err) { console.log('helper stop warning: ' + err.message); }

// Inspect live server.asar first so we NEVER overwrite a newer clean T3 update with an older backup
const header = readAsarHeader(asarPath);
let idx = null;
let bin = null;
walkFiles(header.header, (p, e) => {
  if (p === 'apps/server/dist/client/index.html') idx = e;
  if (p === 'apps/server/dist/bin.mjs') bin = e;
});
const liveHtml = idx ? readEntryData(asarPath, header.dataOffset, { size: Number(idx.size), offset: Number(idx.offset) }).toString('utf8') : '';
const liveBin = bin ? readEntryData(asarPath, header.dataOffset, { size: Number(bin.size), offset: Number(bin.offset) }).toString('utf8') : '';
const liveInjected = liveHtml.includes(MARK_START) || liveBin.includes(BIN_MARK_START);
const liveSha = sha256File(asarPath);

let restoreMode = 'none';
if (!liveInjected) {
  restoreMode = 'already-clean';
  console.log('server.asar is already clean; skipping restore to avoid downgrading T3 Code');
} else if (
  record &&
  record.backupPath &&
  fs.existsSync(record.backupPath) &&
  record.patchedSha256 &&
  liveSha === record.patchedSha256
) {
  const backupSha = sha256File(record.backupPath);
  if (backupSha !== record.preInstallSha256) {
    console.error('ERROR: backup hash mismatch, refusing to restore. backup=' + backupSha + ' expected=' + record.preInstallSha256);
    process.exit(4);
  }
  const tmp = path.join(path.dirname(asarPath), 'server.asar.restore-' + process.pid);
  fs.copyFileSync(record.backupPath, tmp);
  const tmpSha = sha256File(tmp);
  if (tmpSha !== record.preInstallSha256) {
    fs.unlinkSync(tmp);
    console.error('ERROR: restored copy hash mismatch');
    process.exit(4);
  }
  fs.renameSync(tmp, asarPath);
  restoreMode = 'backup';
} else {
  if (!idx) {
    console.error('ERROR: index.html not found; nothing to restore');
    process.exit(4);
  }
  const strippedHtml = stripHtml(liveHtml);
  const strippedBin = stripBinMjs(liveBin);
  const tmp = path.join(path.dirname(asarPath), 'server.asar.restore-' + process.pid);
  const patches = [{ path: 'apps/server/dist/client/index.html', content: Buffer.from(strippedHtml, 'utf8') }];
  if (bin) patches.push({ path: 'apps/server/dist/bin.mjs', content: Buffer.from(strippedBin, 'utf8') });
  patchArchive({
    sourcePath: asarPath,
    destPath: tmp,
    files: patches,
    removePaths: [
      'apps/server/dist/client/assets/antigravity-quota.js',
      'apps/server/dist/client/assets/antigravity-quota.css',
      'apps/server/dist/client/assets/antigravity-icon.png',
      'apps/server/dist/t3-ag-quota',
    ],
  });
  fs.renameSync(tmp, asarPath);
  restoreMode = 'stripped';
}

const asarSha = sha256File(asarPath);
console.log('restore_mode=' + restoreMode);
console.log('asar_sha256=' + asarSha);
if (restoreMode === 'backup' && record && record.preInstallSha256) {
  console.log('matches_preinstall=' + (asarSha === record.preInstallSha256));
  if (asarSha !== record.preInstallSha256) {
    console.error('ERROR: restored asar hash differs from recorded pre-install hash');
    process.exit(4);
  }
}

const lnk = path.join(STARTUP_DIR, STARTUP_LNK);
if (fs.existsSync(lnk)) {
  fs.unlinkSync(lnk);
  console.log('removed startup shortcut');
}

if (!flag('keep-files') && fs.existsSync(PLUGIN_DIR)) {
  const resolved = path.resolve(PLUGIN_DIR);
  const local = path.resolve(process.env.LOCALAPPDATA || '');
  if (!resolved.startsWith(local + path.sep)) {
    console.error('refusing to delete outside LOCALAPPDATA: ' + resolved);
  } else {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log('removed plugin dir ' + resolved);
  }
}

console.log('uninstall done. Start T3 Code to verify it launches normally.');
