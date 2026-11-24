import fs from 'node:fs';
import crypto from 'node:crypto';
import { readAsarHeader, walkFiles } from './asar-lib.mjs';

const BLOCK_SIZE = 4194304;

export function integrityFor(buf) {
  const blocks = [];
  for (let off = 0; off < buf.length; off += BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(buf.subarray(off, Math.min(off + BLOCK_SIZE, buf.length))).digest('hex'));
  }
  if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function ensureDir(header, dirPath) {
  const parts = dirPath.split('/').filter(Boolean);
  let node = header.files;
  for (const part of parts) {
    if (!node[part]) node[part] = { files: {} };
    if (!node[part].files) throw new Error('path is a file, not a directory: ' + dirPath);
    node = node[part].files;
  }
  return node;
}

function putFile(header, filePath, content) {
  const parts = filePath.split('/').filter(Boolean);
  const name = parts.pop();
  const dir = ensureDir(header, parts.join('/'));
  dir[name] = {
    size: content.length,
    offset: '0',
    integrity: integrityFor(content),
  };
}

function headerToBuffer(header) {
  let json = JSON.stringify(header);
  while ((16 + json.length) % 4 !== 0) json += ' ';
  const jsonLen = Buffer.byteLength(json, 'utf8');
  const headerBuf = Buffer.alloc(8 + jsonLen);
  headerBuf.writeUInt32LE(4 + jsonLen, 0);
  headerBuf.writeUInt32LE(jsonLen, 4);
  headerBuf.write(json, 8, 'utf8');
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBuf.length, 4);
  return Buffer.concat([prefix, headerBuf]);
}

/**
 * Rebuild an asar preserving unpacked entries, per-file integrity and shared
 * (deduped) data regions. `files` is [{ path, content }] with asar-root paths.
 * `removePaths` optionally strips stale paths/directories before packing.
 */
function deletePath(header, relPath) {
  const parts = relPath.split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  let node = header.files;
  for (const part of parts) {
    if (!node[part] || !node[part].files) return;
    node = node[part].files;
  }
  delete node[name];
}

export function patchArchive({ sourcePath, destPath, files, removePaths, onProgress }) {
  const { header, dataOffset } = readAsarHeader(sourcePath);
  for (const rp of removePaths || []) deletePath(header, rp);
  const sourceSize = fs.statSync(sourcePath).size;
  const priorByPath = new Map();
  walkFiles(header, (p, e) => {
    if (!e.unpacked) priorByPath.set(p, { oldOffset: Number(e.offset), oldSize: Number(e.size) });
  });

  const replacements = new Map(files.map((f) => [f.path, f.content]));
  let added = 0;
  for (const { path } of files) {
    if (!priorByPath.has(path)) {
      putFile(header, path, replacements.get(path));
      added += 1;
    }
  }

  const regions = new Map();
  const plan = [];
  let cursor = 0;
  const ordered = [];
  walkFiles(header, (p, e) => { if (!e.unpacked) ordered.push({ path: p, entry: e }); });

  for (const item of ordered) {
    const replacement = replacements.get(item.path);
    let key;
    let region;
    if (replacement !== undefined) {
      key = 'content:' + item.path;
      region = regions.get(key);
      if (!region) {
        region = { size: replacement.length, content: replacement, newOffset: cursor };
        regions.set(key, region);
        cursor += replacement.length;
      }
      item.entry.size = replacement.length;
      item.entry.integrity = integrityFor(replacement);
    } else {
      const prior = priorByPath.get(item.path);
      if (!prior) throw new Error('missing prior entry for ' + item.path);
      key = 'region:' + prior.oldOffset + ':' + prior.oldSize;
      region = regions.get(key);
      if (!region) {
        region = { size: prior.oldSize, oldOffset: prior.oldOffset, newOffset: cursor };
        regions.set(key, region);
        cursor += prior.oldSize;
      }
      item.entry.size = prior.oldSize;
    }
    item.entry.offset = String(region.newOffset);
    plan.push(item);
  }

  const headerBuf = headerToBuffer(header);
  const destFd = fs.openSync(destPath, 'w');
  const srcFd = fs.openSync(sourcePath, 'r');
  try {
    fs.writeSync(destFd, headerBuf, 0, headerBuf.length, 0);
    let written = headerBuf.length;
    const chunk = Buffer.alloc(1024 * 1024);
    let index = 0;
    for (const region of regions.values()) {
      if (region.content) {
        fs.writeSync(destFd, region.content, 0, region.content.length, written);
        written += region.content.length;
      } else {
        let remaining = region.size;
        let srcPos = dataOffset + region.oldOffset;
        while (remaining > 0) {
          const n = Math.min(chunk.length, remaining);
          fs.readSync(srcFd, chunk, 0, n, srcPos);
          fs.writeSync(destFd, chunk, 0, n, written);
          srcPos += n;
          written += n;
          remaining -= n;
        }
      }
      index += 1;
      if (onProgress && index % 500 === 0) onProgress(index, regions.size);
    }
    fs.ftruncateSync(destFd, written);
  } finally {
    fs.closeSync(srcFd);
    fs.closeSync(destFd);
  }
  return {
    destPath,
    added,
    entries: plan.length,
    uniqueRegions: regions.size,
    headerBytes: headerBuf.length,
    dataBytes: cursor,
    fileBytes: headerBuf.length + cursor,
    sourceBytes: sourceSize,
  };
}