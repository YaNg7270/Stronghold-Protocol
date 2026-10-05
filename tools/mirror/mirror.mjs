// Mirror the online game into ./mirror (client code, data, art, audio, fonts) so it can be served offline.
//
//   node tools/mirror/mirror.mjs [--base http://103.205.253.194:27527] [--out mirror] [--jobs 8] [--code-only]
//
// What is fetched:
//   1. the ES module graph from index.html (static imports, CSS url()s, quoted asset paths) plus the modules the
//      client loads through template strings (/sim/ entry points, content kits and domain modules),
//   2. /data/*.json (sim data, config, choices, bosses and both asset manifests),
//   3. every absolute path listed in /data/assets.json and /data/local-assets.json,
//   4. the Google Fonts stylesheet index.html links, rewritten to local files (mirror/fonts/google/).
//
// Downloads go through curl (it handles HTTPS_PROXY with CONNECT tunnelling, which plain-HTTP game servers need
// behind an egress proxy). Each file is verified against Content-Length and retried: the server sometimes answers
// 502 or cuts a 200 response short. Files already listed in mirror/.mirror.json with the same size are skipped, so
// an interrupted run can simply be started again.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || 'http://103.205.253.194:27527').replace(/\/$/, '');
const OUT = path.resolve(args.out || 'mirror');
const JOBS = Number(args.jobs || 8);
const PROXY = args['no-proxy'] ? null : (process.env.HTTPS_PROXY || process.env.https_proxy || null);
const TRIES = 6;

const SIM_DATA = ['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects'];
const EXTRA_DATA = ['config', 'choices', 'bosses', 'factions', 'assets', 'local-assets'];
const CONTENT_DOMAINS = ['tokens', 'devices', 'enemies', 'bosses', 'bonds', 'garrisons', 'items', 'bands', 'choices'];
const CODE_SEEDS = [
  '/', '/data.js', '/sim/spec.js', '/sim/simdata.js', '/sim/content/support/index.js',
  ...[1, 2, 3, 4, 5, 6].map((t) => `/sim/content/kits/tier${t}.js`),
  ...CONTENT_DOMAINS.map((n) => `/sim/content/${n}.js`),
  ...[...SIM_DATA, ...EXTRA_DATA].map((n) => `/data/${n}.json`),
];
// Google Fonts serves woff2 only to browsers it recognises.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const stateFile = path.join(OUT, '.mirror.json');
const state = readJson(stateFile) || { base: BASE, files: {} };
state.base = BASE;
let unsaved = 0;
function saveState() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 1));
  fs.renameSync(stateFile + '.tmp', stateFile);
  unsaved = 0;
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveState(); process.exit(130); });

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function localPath(p) {
  const clean = decodeURIComponent(p.split('?')[0]);
  return path.join(OUT, clean.endsWith('/') ? clean + 'index.html' : clean);
}

function curl(url, dest, { headers = [] } = {}) {
  const a = ['-sS', '-m', '180', '-D', '-', '-o', dest];
  if (PROXY) a.push('--proxytunnel', '-x', PROXY);
  for (const h of headers) a.push('-H', h);
  a.push(url);
  return new Promise((resolve) => {
    const p = spawn('curl', a);
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      const statuses = [...out.matchAll(/^HTTP\/\S+ (\d+)/gm)].map((m) => Number(m[1]));
      const lens = [...out.matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
      resolve({ code, status: statuses.at(-1) ?? 0, length: lens.length ? lens.at(-1) : null });
    });
  });
}

/** Download one URL to a file, verified; returns 'ok' | 'skip' | 'missing' | 'fail'. */
async function download(url, dest, key, opts) {
  const known = state.files[key];
  if (known && fs.existsSync(dest) && fs.statSync(dest).size === known.size) return 'skip';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let last = null;
  for (let i = 0; i < TRIES; i++) {
    last = await curl(url, tmp, opts);
    if (last.code === 0 && last.status === 200) {
      const size = fs.statSync(tmp).size;
      if (last.length == null || last.length === size) {
        fs.renameSync(tmp, dest);
        state.files[key] = { size };
        if (++unsaved >= 100) saveState();
        return 'ok';
      }
    }
    if (last.status === 404) break;
    await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  fs.rmSync(tmp, { force: true });
  return last && last.status === 404 ? 'missing' : 'fail';
}

async function pool(items, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const tick = setInterval(() => process.stdout.write(`\r  ${done}/${items.length}`), 1000);
  await Promise.all(Array.from({ length: Math.min(JOBS, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      done++;
    }
  }));
  clearInterval(tick);
  process.stdout.write(`\r  ${done}/${items.length}\n`);
  return results;
}

// ---- 1. code graph ----------------------------------------------------------------------------------------------

const ASSET_EXT = '(?:js|mjs|css|json|png|jpg|jpeg|webp|gif|svg|atlas|skel|txt|mp3|ogg|wav|m4a|woff2?|ttf|otf|html|obj|fnt|bin|wasm)';
const REF_PATTERNS = [
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
  /import\s+['"]([^'"]+)['"]/g,
  /(?:href|src)\s*=\s*["']([^"'#?]+)/g,
  /url\(\s*['"]?([^'")?#]+)/g,
  new RegExp(`['"\`]((?:\\.{0,2}/)?[\\w./-]+\\.${ASSET_EXT})['"\`?]`, 'g'),
];
const TEXT_RE = /(\.(js|mjs|css|json|html)$|\/$)/;

function refsOf(p, text) {
  const dir = p.endsWith('/') ? p : posix.dirname(p) + '/';
  const out = new Set();
  for (const re of REF_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const r = m[1];
      if (/^(https?:|data:|\/\/)/.test(r) || ['preact', 'preact/hooks', 'htm'].includes(r) || r.includes('${')) continue;
      out.add(r.startsWith('/') ? posix.normalize(r) : posix.normalize(posix.join(dir, r)));
    }
  }
  return out;
}

async function crawlCode() {
  console.log('[1/4] code graph');
  const seen = new Map();
  let frontier = new Set(CODE_SEEDS);
  while (frontier.size) {
    const batch = [...frontier].filter((p) => !seen.has(p));
    frontier = new Set();
    const res = await pool(batch, (p) => download(BASE + p, localPath(p), p));
    batch.forEach((p, i) => seen.set(p, res[i]));
    for (const [i, p] of batch.entries()) {
      if (res[i] !== 'ok' && res[i] !== 'skip') continue;
      let text;
      try { text = fs.readFileSync(localPath(p), 'utf8'); } catch { continue; }
      for (const u of refsOf(p, text)) if (!seen.has(u) && TEXT_RE.test(u)) frontier.add(u);
    }
  }
  // Paths that only appear in comments 404 (or 502) — expected. Real modules must all be present.
  const failed = [...seen].filter(([, s]) => s === 'fail').map(([p]) => p);
  const realFailed = failed.filter((p) => CODE_SEEDS.includes(p));
  console.log(`  ${seen.size} code/data urls, ${[...seen.values()].filter((s) => s === 'ok' || s === 'skip').length} present`);
  if (realFailed.length) throw new Error(`required files failed: ${realFailed.join(', ')}`);
  return seen;
}

// ---- 2/3. manifests ------------------------------------------------------------------------------------------------

function manifestPaths() {
  const out = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string' && x.startsWith('/') && /\.\w{2,5}$/.test(x)) out.add(x);
  };
  for (const n of ['assets', 'local-assets']) {
    const j = readJson(localPath(`/data/${n}.json`));
    if (!j) throw new Error(`manifest /data/${n}.json missing or invalid`);
    walk(j);
  }
  return [...out].sort();
}

async function fetchAssets() {
  const list = manifestPaths();
  console.log(`[2/4] assets from manifests: ${list.length} files`);
  const res = await pool(list, (p) => download(BASE + encodeURI(p), localPath(p), p));
  const bad = list.filter((p, i) => res[i] === 'fail' || res[i] === 'missing');
  return bad.map((p) => `${res[list.indexOf(p)]} ${p}`);
}

// ---- 4. Google Fonts --------------------------------------------------------------------------------------------

async function fetchGoogleFonts() {
  console.log('[3/4] Google Fonts');
  const html = fs.readFileSync(localPath('/'), 'utf8');
  const m = html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"/);
  if (!m) { console.log('  no Google Fonts link'); return []; }
  const cssUrl = m[1].replace(/&amp;/g, '&');
  const cssFile = path.join(OUT, 'fonts/google/google-fonts.css');
  const r = await download(cssUrl, cssFile, 'google-fonts.css', { headers: [`User-Agent: ${BROWSER_UA}`] });
  if (r === 'fail' || r === 'missing') return ['google fonts css'];
  let css = fs.readFileSync(cssFile, 'utf8');
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((x) => x[1]))];
  const names = urls.map((u) => 'f/' + u.replace('https://fonts.gstatic.com/', '').replace(/[^\w.-]/g, '_'));
  const res = await pool(urls, (u) => download(u, path.join(OUT, 'fonts/google', names[urls.indexOf(u)]), u));
  urls.forEach((u, i) => { css = css.split(u).join(names[i]); });
  fs.writeFileSync(path.join(OUT, 'fonts/google/fonts.css'), css);
  return urls.filter((u, i) => res[i] === 'fail' || res[i] === 'missing');
}

// ---- main ---------------------------------------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const failures = [];
try {
  await crawlCode();
  if (!args['code-only']) failures.push(...(await fetchAssets()));
  failures.push(...(await fetchGoogleFonts()));
} finally {
  state.date = new Date().toISOString();
  const constants = (() => { try { return fs.readFileSync(localPath('/shared/constants.js'), 'utf8'); } catch { return ''; } })();
  state.appVersion = (constants.match(/APP_VERSION = '([^']+)'/) || [])[1] || null;
  saveState();
}
console.log('[4/4] done:', OUT, `(client ${state.appVersion})`);
if (failures.length) {
  console.log(`${failures.length} files could not be downloaded (run again to retry):`);
  for (const f of failures.slice(0, 50)) console.log('  ' + f);
  process.exitCode = 1;
}
