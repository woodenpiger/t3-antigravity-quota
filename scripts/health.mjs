import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readJson } from './common.mjs';

const t3Runtime = readJson(path.join(os.homedir(), '.t3', 'userdata', 'server-runtime.json'), null);
const host = (t3Runtime && t3Runtime.host) || '127.0.0.1';
const port = Number(process.argv[2] || (t3Runtime && t3Runtime.port) || 3773);
const prefix = process.argv[2] ? '' : '/__t3_ag_quota';
const url = 'http://' + host + ':' + port + prefix + (process.argv.includes('--refresh') ? '/api/quota?refresh=1' : '/api/quota');

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
