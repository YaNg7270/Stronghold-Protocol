// Local static server for the offline game: the mirrored client (./mirror) with the offline overlay (./offline).
//
//   node tools/serve.mjs [--port 8080] [--root mirror] [--host 127.0.0.1]
//
// Overlay:
//   /                 mirror/index.html patched by patchIndex(): the offline shim runs before the client, and the Google
//                     Fonts stylesheet is replaced by the local copy the mirror made (mirror/fonts/google/fonts.css)
//   /offline/*        files of ./offline (the shim and the in-browser game server)
//   everything else   ./mirror
// No /ws, no /healthz: the shim answers the game socket inside the page, and the client's build guard treats a missing
// /healthz as "unknown" (never reloads).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchIndex } from './patchIndex.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.atlas': 'text/plain; charset=utf-8', '.skel': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};

/**
 * Create the request handler.
 * @param {{ root: string, offline: string }} dirs
 */
export function createHandler({ root, offline }) {
  let indexCache = null;
  return (req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    if (p.includes('\0')) { res.writeHead(400).end(); return; }
    if (p === '/' || p === '/index.html') {
      if (!indexCache) indexCache = patchIndex(fs.readFileSync(path.join(root, 'index.html'), 'utf8'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(indexCache);
      return;
    }
    const base = p.startsWith('/offline/') ? offline : root;
    const rel = p.startsWith('/offline/') ? p.slice('/offline'.length) : p;
    const file = path.join(base, path.normalize(rel));
    if (!file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(repo, args.root || 'mirror');
  const offline = path.join(repo, 'offline');
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    console.error(`${root}/index.html not found — run \`npm run mirror\` first`);
    process.exit(1);
  }
  const port = Number(args.port || 8080);
  const host = args.host || '127.0.0.1';
  http.createServer(createHandler({ root, offline })).listen(port, host, () => {
    console.log(`卫戍协议 offline: http://${host}:${port}/`);
  });
}
