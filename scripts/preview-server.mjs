import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturePort = Number(process.argv[2] || 47899);
const port = Number(process.argv[3] || 47898);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/preview.html') {
    let html = fs.readFileSync(path.join(root, 'fixtures', 'preview.html'), 'utf8');
    html = html.replace(/\/assets\/antigravity-quota\.(js|css)/g, '/renderer/antigravity-quota.$1');
    html = html.replace("Number(q.get('port') || 47899)", 'Number(q.get(\'port\') || ' + fixturePort + ')');
    res.writeHead(200, { 'content-type': types['.html'], 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  if (url.pathname.startsWith('/renderer/')) {
    const name = path.basename(url.pathname);
    if (name !== 'antigravity-quota.js' && name !== 'antigravity-quota.css') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const file = path.join(root, 'renderer', name);
    res.writeHead(200, { 'content-type': types[path.extname(name)], 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}).listen(port, '127.0.0.1', () => {
  process.stdout.write('preview on http://127.0.0.1:' + port + '/?port=' + fixturePort + '&open=1\n');
});
