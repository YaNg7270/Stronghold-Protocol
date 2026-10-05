// 卫戍协议 offline launcher — serves the packaged game (./game next to this file / executable) on 127.0.0.1 and opens it
// in the default browser. Zero dependencies (CommonJS: also the entry of the Node single-executable build).
//
//   node launcher.cjs [--port 27527] [--no-open]
// Close the window (Ctrl+C) to stop.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

let sea = false;
try { sea = require('node:sea').isSea(); } catch { sea = false; }
const baseDir = sea ? path.dirname(process.execPath) : __dirname;
const root = path.join(baseDir, 'game');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

function args() {
  const a = process.argv.slice(2);
  const o = { port: 27527, open: true };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--port') o.port = Number(a[++i]) || o.port;
    else if (a[i] === '--no-open') o.open = false;
  }
  return o;
}

function handler(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (p.includes('\0')) { res.writeHead(400).end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(port, tries = 20) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && tries > 0) resolve(listen(port + 1, tries - 1));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

(async () => {
  const o = args();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    console.error(`找不到游戏文件：${root}\nGame files not found next to the launcher.`);
    process.exitCode = 1;
    setTimeout(() => {}, 10000);
    return;
  }
  const { port } = await listen(o.port);
  // the port is part of the page's origin: the save (IndexedDB) and settings live with it, so keep it stable
  const url = `http://127.0.0.1:${port}/`;
  console.log('卫戍协议：盟约 · 离线版');
  console.log(`已启动：${url}`);
  console.log('请在浏览器中游玩（推荐 Chrome / Edge）。关闭此窗口即退出。');
  if (port !== o.port) console.log(`注意：端口 ${o.port} 被占用，改用 ${port}（本机存档按端口区分）。`);
  if (o.open) openBrowser(url);
})().catch((err) => {
  console.error('启动失败：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
