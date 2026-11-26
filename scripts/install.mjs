import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readAsarHeader, walkFiles, readEntryData } from './asar-lib.mjs';
import { patchArchive } from './asar-patch.mjs';
import { injectHtml, stripHtml, MARK_START } from './inject-html.mjs';
import { injectBinMjs, stripBinMjs, BIN_MARK_START } from './patch-bin.mjs';
import {
  BACKUPS_DIR,
  DEFAULT_INSTALL_DIR,
  PAYLOAD_DIR,
  PLUGIN_DIR,
  PLUGIN_VERSION,
  STARTUP_DIR,
  STARTUP_LNK,
  copyTree,
  ensureDir,
  listT3Processes,
  readJson,
  registerAutoHeal,
  runPowerShell,
  sha256File,
  startAutoHealDetached,
  stopAutoHeal,
  stopT3,
  t3VersionFromAsar,
  timestamp,
  unregisterAutoHeal,
  writeJson,
} from './common.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const option = (name, fallback) => {
  const idx = argv.indexOf('--' + name);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
};

const installDir = option('install-dir', process.env.T3CODE_DIR || DEFAULT_INSTALL_DIR);
const asarPath = path.join(installDir, 'resources', 'server.asar');
const fromAutoHeal = flag('from-auto-heal');
const noAutoHeal = flag('no-auto-heal');

function fail(message, code) {
  console.error('ERROR: ' + message);
  process.exit(code || 4);
}

export function isCleanAsar(file) {
  try {
    const h = readAsarHeader(file);
    let idx = null;
    let bin = null;
    walkFiles(h.header, (p, e) => {
      if (p === 'apps/server/dist/client/index.html') idx = e;
      if (p === 'apps/server/dist/bin.mjs') bin = e;
    });
    if (!idx) return false;
    const html = readEntryData(file, h.dataOffset, { size: Number(idx.size), offset: Number(idx.offset) }).toString('utf8');
    const binTxt = bin
      ? readEntryData(file, h.dataOffset, { size: Number(bin.size), offset: Number(bin.offset) }).toString('utf8')
      : '';
    return !html.includes(MARK_START) && !binTxt.includes(BIN_MARK_START);
  } catch {
    return false;
  }
}

/**
 * Pure source-selection decision to guarantee T3 Code updates NEVER get downgraded by stale backups.
 */
export function chooseInstallSource({ liveIsClean, liveVersion, previousRecord, backupExists, backupShaMatches, backupIsClean }) {
  if (liveIsClean) {
    return { mode: 'live-clean', useBackup: false };
  }
  if (
    previousRecord &&
    previousRecord.t3Version === liveVersion &&
    backupExists &&
    backupShaMatches &&
    backupIsClean
  ) {
    return { mode: 'verified-backup', useBackup: true };
  }
  return { mode: 'live-strip', useBackup: false };
}

function pruneOldBackups(dir, keepCount) {
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => n.startsWith('server.asar.bak-'))
      .map((n) => ({ name: n, full: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = keepCount; i < files.length; i += 1) {
      try { fs.unlinkSync(files[i].full); } catch {}
    }
  } catch {
    /* ignore */
  }
}

function syncPersistentPayload() {
  ensureDir(PAYLOAD_DIR);
  const dirs = ['renderer', 'scripts', 'helper'];
  for (const sub of dirs) {
    const srcDir = path.join(projectRoot, sub);
    const dstDir = path.join(PAYLOAD_DIR, sub);
    if (!fs.existsSync(srcDir)) continue;
    fs.rmSync(dstDir, { recursive: true, force: true });
    copyTree(srcDir, dstDir);
  }
  // Remove unit tests and fixture mocks from runtime payload to keep it minimal
  fs.rmSync(path.join(PAYLOAD_DIR, 'helper', 'test'), { recursive: true, force: true });
  try { fs.unlinkSync(path.join(PAYLOAD_DIR, 'helper', 'fixture-server.cjs')); } catch {}
  try { fs.unlinkSync(path.join(PAYLOAD_DIR, 'scripts', 'preview-server.mjs')); } catch {}
  try { fs.unlinkSync(path.join(PAYLOAD_DIR, 'scripts', 'test-asar-copy.mjs')); } catch {}
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.platform !== 'win32') fail('only Windows is supported', 2);
  if (!fs.existsSync(asarPath)) fail('server.asar not found at ' + asarPath, 2);

  const running = listT3Processes(installDir);
  if (running.pids.length && !flag('close-t3')) {
    console.error('T3 Code is running (pids: ' + running.pids.map((p) => p.pid).join(', ') + ').');
    console.error('Quit T3 Code completely, then re-run: node scripts/install.mjs');
    process.exit(3);
  }
  if (running.pids.length) {
    console.log('closing T3 Code: ' + stopT3());
    const still = listT3Processes(installDir);
    if (still.pids.length) fail('T3 Code still running (pids: ' + still.pids.map((p) => p.pid).join(', ') + ')', 3);
  }

  // Stop any legacy standalone helper processes and remove legacy Startup shortcut
  if (!fromAutoHeal) {
    try {
      const stopLegacy = [
        '$hits = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine -like "*t3code-antigravity-quota*" -and $_.CommandLine -notlike "*auto-heal.mjs*" }',
        'foreach ($h in $hits) { Stop-Process -Id $h.ProcessId -Force -ErrorAction SilentlyContinue }',
        '"stopped=" + @($hits).Count',
      ].join('; ');
      console.log('legacy helper cleanup: ' + runPowerShell(stopLegacy).trim());
    } catch {}
    const legacyLnk = path.join(STARTUP_DIR, STARTUP_LNK);
    if (fs.existsSync(legacyLnk)) {
      try { fs.unlinkSync(legacyLnk); } catch {}
      console.log('removed legacy startup shortcut: ' + legacyLnk);
    }
  }

  ensureDir(PLUGIN_DIR);
  ensureDir(BACKUPS_DIR);
  const recordPath = path.join(PLUGIN_DIR, 'install-record.json');
  const previous = readJson(recordPath, null);
  const version = t3VersionFromAsar(asarPath, readAsarHeader, walkFiles, readEntryData);
  const currentSha = sha256File(asarPath);
  const liveIsClean = isCleanAsar(asarPath);

  const prevBackupExists = !!(previous && previous.backupPath && fs.existsSync(previous.backupPath));
  const prevBackupSha = prevBackupExists ? sha256File(previous.backupPath) : null;
  const decision = chooseInstallSource({
    liveIsClean,
    liveVersion: version,
    previousRecord: previous,
    backupExists: prevBackupExists,
    backupShaMatches: !!(prevBackupSha && previous && prevBackupSha === previous.preInstallSha256),
    backupIsClean: prevBackupExists && isCleanAsar(previous.backupPath),
  });

  let sourcePath = asarPath;
  let preInstallSha256 = currentSha;
  let backupPath = null;

  if (decision.useBackup) {
    sourcePath = previous.backupPath;
    preInstallSha256 = prevBackupSha;
    backupPath = previous.backupPath;
    console.log('reusing verified backup for T3 ' + version + ': ' + backupPath);
  } else if (decision.mode === 'live-clean') {
    backupPath = path.join(BACKUPS_DIR, 'server.asar.bak-' + version + '-' + timestamp());
    console.log('backing up clean T3 ' + version + ' server.asar -> ' + backupPath);
    fs.copyFileSync(asarPath, backupPath);
    const backupSha = sha256File(backupPath);
    if (backupSha !== currentSha) fail('backup verification failed');
    console.log('backup sha256=' + backupSha);
    pruneOldBackups(BACKUPS_DIR, 2);
  } else {
    // Live server.asar was already patched and matching backup is absent; strip markers cleanly in-place
    console.log('re-patching existing injected T3 ' + version + ' server.asar (stripping prior markers)');
  }

  const sourceHeader = readAsarHeader(sourcePath);
  let sourceIndexEntry = null;
  let sourceBinEntry = null;
  let sourceUnpacked = 0;
  walkFiles(sourceHeader.header, (p, e) => {
    if (e.unpacked) sourceUnpacked += 1;
    if (p === 'apps/server/dist/client/index.html') sourceIndexEntry = e;
    if (p === 'apps/server/dist/bin.mjs') sourceBinEntry = e;
  });
  if (!sourceIndexEntry || !sourceBinEntry) fail('expected entries not found inside asar');

  const rawIndex = readEntryData(sourcePath, sourceHeader.dataOffset, {
    size: Number(sourceIndexEntry.size),
    offset: Number(sourceIndexEntry.offset),
  }).toString('utf8');
  const rawBin = readEntryData(sourcePath, sourceHeader.dataOffset, {
    size: Number(sourceBinEntry.size),
    offset: Number(sourceBinEntry.offset),
  }).toString('utf8');
  const sourceIndex = stripHtml(rawIndex);
  const sourceBin = stripBinMjs(rawBin);

  const js = fs.readFileSync(path.join(projectRoot, 'renderer', 'antigravity-quota.js'));
  const css = fs.readFileSync(path.join(projectRoot, 'renderer', 'antigravity-quota.css'));
  const hook = fs.readFileSync(path.join(projectRoot, 'scripts', 'ag-quota-hook.mjs'));
  const quotaService = fs.readFileSync(path.join(projectRoot, 'helper', 'quota-service.cjs'));
  const quotaCore = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'quota-core.cjs'));
  const quotaRouter = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'quota-router.cjs'));
  const httpPost = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'http-post.cjs'));
  const winProxy = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'win-proxy.cjs'));
  const agyRefresh = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'agy-refresh.cjs'));

  const buildTag = crypto.createHash('sha256').update(js).update(css).update(hook).digest('hex').slice(0, 10);
  const injectedIndex = Buffer.from(injectHtml(sourceIndex, null, buildTag), 'utf8');
  const patchedBin = Buffer.from(injectBinMjs(sourceBin), 'utf8');
  console.log('t3Version=' + version + ' pluginVersion=' + PLUGIN_VERSION + ' buildTag=' + buildTag);

  const filesToPatch = [
    { path: 'apps/server/dist/bin.mjs', content: patchedBin },
    { path: 'apps/server/dist/t3-ag-quota/hook.mjs', content: hook },
    { path: 'apps/server/dist/t3-ag-quota/quota-service.cjs', content: quotaService },
    { path: 'apps/server/dist/t3-ag-quota/lib/quota-core.cjs', content: quotaCore },
    { path: 'apps/server/dist/t3-ag-quota/lib/quota-router.cjs', content: quotaRouter },
    { path: 'apps/server/dist/t3-ag-quota/lib/http-post.cjs', content: httpPost },
    { path: 'apps/server/dist/t3-ag-quota/lib/win-proxy.cjs', content: winProxy },
    { path: 'apps/server/dist/t3-ag-quota/lib/agy-refresh.cjs', content: agyRefresh },
    { path: 'apps/server/dist/client/index.html', content: injectedIndex },
    { path: 'apps/server/dist/client/assets/antigravity-quota.js', content: js },
    { path: 'apps/server/dist/client/assets/antigravity-quota.css', content: css },
  ];

  const tmpAsar = path.join(path.dirname(asarPath), 'server.asar.tmp-' + process.pid);
  try {
    const result = patchArchive({ sourcePath, destPath: tmpAsar, files: filesToPatch });
    console.log('patched tmp=' + tmpAsar + ' entries=' + result.entries + ' regions=' + result.uniqueRegions + ' bytes=' + result.fileBytes);

    const check = readAsarHeader(tmpAsar);
    let idx = null;
    let bin = null;
    let unpacked = 0;
    let count = 0;
    let hasJs = false;
    let hasCss = false;
    let hasHook = false;
    walkFiles(check.header, (p, e) => {
      count += 1;
      if (e.unpacked) unpacked += 1;
      if (p === 'apps/server/dist/client/index.html') idx = e;
      if (p === 'apps/server/dist/bin.mjs') bin = e;
      if (p.endsWith('assets/antigravity-quota.js')) hasJs = true;
      if (p.endsWith('assets/antigravity-quota.css')) hasCss = true;
      if (p === 'apps/server/dist/t3-ag-quota/hook.mjs') hasHook = true;
    });
    const htmlText = readEntryData(tmpAsar, check.dataOffset, { size: Number(idx.size), offset: Number(idx.offset) }).toString('utf8');
    const binText = readEntryData(tmpAsar, check.dataOffset, { size: Number(bin.size), offset: Number(bin.offset) }).toString('utf8');
    if (!htmlText.includes(MARK_START) || !binText.includes(BIN_MARK_START)) fail('injection verification failed');
    if (!hasJs || !hasCss || !hasHook) fail('asset verification failed');
    if (unpacked !== sourceUnpacked) fail('unpacked count changed: ' + unpacked + ' (expected ' + sourceUnpacked + ')');
    console.log('verify ok entries=' + count + ' unpacked=' + unpacked + ' marker=yes hook=yes assets=yes');

    fs.renameSync(tmpAsar, asarPath);
  } catch (err) {
    try { if (fs.existsSync(tmpAsar)) fs.unlinkSync(tmpAsar); } catch {}
    fail('asar patch failed: ' + (err && err.message ? err.message : err));
  }

  const patchedSha256 = sha256File(asarPath);
  const record = {
    version: PLUGIN_VERSION,
    mode: 'embedded',
    t3Version: version,
    installedAt: new Date().toISOString(),
    t3InstallDir: installDir,
    asarPath,
    backupPath,
    preInstallSha256,
    patchedSha256,
    buildTag,
    pluginDir: PLUGIN_DIR,
    autoHeal: !noAutoHeal,
  };
  writeJson(recordPath, record);

  // Persist self-contained payload & register zero-polling update auto-heal guard
  if (!fromAutoHeal) {
    syncPersistentPayload();
    if (noAutoHeal) {
      stopAutoHeal();
      unregisterAutoHeal();
      console.log('auto-heal: disabled (--no-auto-heal)');
    } else {
      stopAutoHeal();
      const reg = registerAutoHeal(installDir);
      startAutoHealDetached(installDir);
      console.log('auto-heal: registered (' + reg.regName + ') and started');
    }
  }

  console.log('preInstallSha256=' + preInstallSha256);
  console.log('patchedSha256=' + patchedSha256);
  console.log('installed v' + PLUGIN_VERSION + ' (embedded + auto-heal). Launch T3 Code (Beta).');
}
