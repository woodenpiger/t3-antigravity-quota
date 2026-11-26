import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readAsarHeader, walkFiles, readEntryData } from './asar-lib.mjs';
import { patchArchive } from './asar-patch.mjs';
import { injectHtml, stripHtml, MARK_START } from './inject-html.mjs';
import { injectBinMjs, stripBinMjs, BIN_MARK_START } from './patch-bin.mjs';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const src = process.argv[2];
const outDir = process.argv[3];
const copyPath = path.join(outDir, 'server.asar.copy');
const patchedPath = path.join(outDir, 'server.asar.patched');
const restoredPath = path.join(outDir, 'server.asar.restored');
fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(copyPath) || fs.statSync(copyPath).size !== fs.statSync(src).size) {
  console.log('copying source asar ...');
  fs.copyFileSync(src, copyPath);
}

const original = readAsarHeader(copyPath);
let originalCount = 0;
let originalUnpacked = 0;
let indexEntry = null;
let binEntry = null;
let bigEntry = null;
walkFiles(original.header, (p, e) => {
  originalCount += 1;
  if (e.unpacked) originalUnpacked += 1;
  if (p === 'apps/server/dist/client/index.html') indexEntry = e;
  if (p === 'apps/server/dist/bin.mjs') binEntry = e;
  if (!e.unpacked && Number(e.size) > 4 * 1024 * 1024 && !bigEntry) bigEntry = { path: p, entry: e };
});

const originalIndex = readEntryData(copyPath, original.dataOffset, { size: Number(indexEntry.size), offset: Number(indexEntry.offset) }).toString('utf8');
const originalBin = readEntryData(copyPath, original.dataOffset, { size: Number(binEntry.size), offset: Number(binEntry.offset) }).toString('utf8');

const injectedHtml = Buffer.from(injectHtml(originalIndex, null, 'testbuild'), 'utf8');
const patchedBin = Buffer.from(injectBinMjs(originalBin), 'utf8');
const js = fs.readFileSync(path.join(projectRoot, 'renderer', 'antigravity-quota.js'));
const css = fs.readFileSync(path.join(projectRoot, 'renderer', 'antigravity-quota.css'));
const hook = fs.readFileSync(path.join(projectRoot, 'scripts', 'ag-quota-hook.mjs'));
const quotaService = fs.readFileSync(path.join(projectRoot, 'helper', 'quota-service.cjs'));
const quotaCore = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'quota-core.cjs'));
const quotaRouter = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'quota-router.cjs'));
const httpPost = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'http-post.cjs'));
const winProxy = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'win-proxy.cjs'));
const agyRefresh = fs.readFileSync(path.join(projectRoot, 'helper', 'lib', 'agy-refresh.cjs'));

const t0 = Date.now();
const result = patchArchive({
  sourcePath: copyPath,
  destPath: patchedPath,
  files: [
    { path: 'apps/server/dist/bin.mjs', content: patchedBin },
    { path: 'apps/server/dist/t3-ag-quota/hook.mjs', content: hook },
    { path: 'apps/server/dist/t3-ag-quota/quota-service.cjs', content: quotaService },
    { path: 'apps/server/dist/t3-ag-quota/lib/quota-core.cjs', content: quotaCore },
    { path: 'apps/server/dist/t3-ag-quota/lib/quota-router.cjs', content: quotaRouter },
    { path: 'apps/server/dist/t3-ag-quota/lib/http-post.cjs', content: httpPost },
    { path: 'apps/server/dist/t3-ag-quota/lib/win-proxy.cjs', content: winProxy },
    { path: 'apps/server/dist/t3-ag-quota/lib/agy-refresh.cjs', content: agyRefresh },
    { path: 'apps/server/dist/client/index.html', content: injectedHtml },
    { path: 'apps/server/dist/client/assets/antigravity-quota.js', content: js },
    { path: 'apps/server/dist/client/assets/antigravity-quota.css', content: css },
  ],
});
console.log('patched in ' + (Date.now() - t0) + 'ms ' + JSON.stringify(result));

const patched = readAsarHeader(patchedPath);
let entries = 0, unpacked = 0, offsetsString = 0;
let pIndex = null, pBin = null, pJs = null, pCss = null, pHook = null;
walkFiles(patched.header, (p, e) => {
  entries += 1;
  if (e.unpacked) { unpacked += 1; return; }
  if (typeof e.offset === 'string') offsetsString += 1;
  if (p === 'apps/server/dist/client/index.html') pIndex = e;
  if (p === 'apps/server/dist/bin.mjs') pBin = e;
  if (p.endsWith('assets/antigravity-quota.js')) pJs = e;
  if (p.endsWith('assets/antigravity-quota.css')) pCss = e;
  if (p === 'apps/server/dist/t3-ag-quota/hook.mjs') pHook = e;
});

function hashOf(file, headerInfo, e) {
  return crypto.createHash('sha256').update(readEntryData(file, headerInfo.dataOffset, { size: Number(e.size), offset: Number(e.offset) })).digest('hex');
}

const indexData = readEntryData(patchedPath, patched.dataOffset, { size: Number(pIndex.size), offset: Number(pIndex.offset) }).toString('utf8');
const binData = readEntryData(patchedPath, patched.dataOffset, { size: Number(pBin.size), offset: Number(pBin.offset) }).toString('utf8');
console.log('entries=' + entries + ' unpacked=' + unpacked + ' offsetsString=' + offsetsString);
console.log('index_marker=' + indexData.includes(MARK_START) + ' bin_marker=' + binData.includes(BIN_MARK_START));
console.log('integrity_ok=' + (
  hashOf(patchedPath, patched, pIndex) === pIndex.integrity.hash &&
  hashOf(patchedPath, patched, pBin) === pBin.integrity.hash &&
  hashOf(patchedPath, patched, pJs) === pJs.integrity.hash &&
  hashOf(patchedPath, patched, pCss) === pCss.integrity.hash &&
  hashOf(patchedPath, patched, pHook) === pHook.integrity.hash
));

// Verify strip/uninstall roundtrip cleanly removes all injected files and markers
patchArchive({
  sourcePath: patchedPath,
  destPath: restoredPath,
  files: [
    { path: 'apps/server/dist/client/index.html', content: Buffer.from(stripHtml(indexData), 'utf8') },
    { path: 'apps/server/dist/bin.mjs', content: Buffer.from(stripBinMjs(binData), 'utf8') },
  ],
  removePaths: [
    'apps/server/dist/client/assets/antigravity-quota.js',
    'apps/server/dist/client/assets/antigravity-quota.css',
    'apps/server/dist/t3-ag-quota',
  ],
});
const restored = readAsarHeader(restoredPath);
let restoredCount = 0;
walkFiles(restored.header, () => { restoredCount += 1; });
console.log('original_entries=' + originalCount + ' original_unpacked=' + originalUnpacked + ' restored_entries=' + restoredCount + ' matches_original_entries=' + (restoredCount === originalCount) + ' unpacked_preserved=' + (unpacked === originalUnpacked));
