import fs from 'node:fs';

export function readAsarHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(16);
    const n = fs.readSync(fd, head, 0, 16, 0);
    if (n < 16) throw new Error('asar too small');
    const sizeField = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const dataOffset = 8 + sizeField;
    if (jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) throw new Error('unexpected header length ' + jsonLen);
    if (dataOffset < 16 + jsonLen) throw new Error('inconsistent header offsets');
    const jsonBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, dataOffset, jsonLen, sizeField };
  } finally {
    fs.closeSync(fd);
  }
}

export function walkFiles(header, visit) {
  const walk = (node, prefix) => {
    for (const name of Object.keys(node)) {
      const child = node[name];
      const p = prefix ? prefix + '/' + name : name;
      if (child && typeof child === 'object' && child.files) walk(child.files, p);
      else visit(p, child);
    }
  };
  walk(header.files, '');
}

export function readEntryData(filePath, dataOffset, entry) {
  const out = Buffer.alloc(entry.size);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, out, 0, entry.size, dataOffset + entry.offset);
  } finally {
    fs.closeSync(fd);
  }
  return out;
}