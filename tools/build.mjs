// Build the portable offline package:
//
//   node tools/build.mjs [--out dist/stronghold-offline] [--exe win-x64,linux-x64,darwin-arm64,...]
//
// dist/stronghold-offline/
//   game/                 the mirrored client + data + art, the offline server (game/offline/) and the patched index.html
//   launcher.cjs          zero-dependency local server + browser opener (node launcher.cjs)
//   启动游戏.bat / start.sh / start.command   run the launcher with an installed Node (≥ 20), or the executable
//   stronghold-offline.exe / -linux / -macos  (--exe) Node single-executable builds of the launcher: no Node needed
//   README.txt
//
// Files are hard-linked from ./mirror when possible (no second copy of the ~360 MB of art on the same disk).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchIndex } from './patchIndex.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d; };
const out = path.resolve(repo, opt('out', 'dist/stronghold-offline'));
const mirror = path.join(repo, 'mirror');
const game = path.join(out, 'game');

if (!fs.existsSync(path.join(mirror, 'index.html'))) {
  console.error('mirror/ is missing — run `npm run mirror` first');
  process.exit(1);
}

function place(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.rmSync(dst, { force: true }); } catch { /* absent */ }
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
}

function copyTree(src, dst, skip = () => false) {
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (skip(s, ent)) continue;
    if (ent.isDirectory()) n += copyTree(s, d, skip);
    else if (ent.isFile()) { place(s, d); n++; }
  }
  return n;
}

console.log(`building ${path.relative(repo, out)}`);
fs.rmSync(out, { recursive: true, force: true });
const nMirror = copyTree(mirror, game, (s) => s.endsWith('.part') || path.basename(s) === '.mirror.json');
const nOffline = copyTree(path.join(repo, 'offline'), path.join(game, 'offline'));
fs.rmSync(path.join(game, 'index.html'), { force: true });
fs.writeFileSync(path.join(game, 'index.html'), patchIndex(fs.readFileSync(path.join(mirror, 'index.html'), 'utf8')));
fs.copyFileSync(path.join(repo, 'tools', 'launcher.cjs'), path.join(out, 'launcher.cjs'));

const appVersion = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(mirror, '.mirror.json'), 'utf8')).appVersion; } catch { return null; }
})();
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

// the .bat stays ASCII (cmd reads it in the OEM code page); executables have ASCII names
fs.writeFileSync(path.join(out, '启动游戏.bat'), [
  '@echo off',
  'cd /d "%~dp0"',
  'if exist "stronghold-offline.exe" (',
  '  "stronghold-offline.exe"',
  ') else (',
  '  node launcher.cjs',
  ')',
  'pause',
  '',
].join('\r\n'));
const sh = ['#!/bin/sh', 'cd "$(dirname "$0")"', 'for f in ./stronghold-offline-linux ./stronghold-offline-macos; do [ -x "$f" ] && exec "$f" "$@"; done', 'exec node launcher.cjs "$@"', ''].join('\n');
fs.writeFileSync(path.join(out, 'start.sh'), sh, { mode: 0o755 });
fs.writeFileSync(path.join(out, 'start.command'), sh, { mode: 0o755 });
fs.writeFileSync(path.join(out, 'README.txt'), [
  '卫戍协议：盟约 · 离线版',
  '',
  `客户端版本 ${appVersion || '?'} · 离线服务器 ${pkg.version}`,
  '',
  '启动：',
  '  Windows：双击「启动游戏.bat」（或 stronghold-offline.exe）',
  '  macOS：双击 start.command；Linux：运行 ./start.sh',
  '  没有可执行文件时需要安装 Node.js 20 以上版本（https://nodejs.org）',
  '启动后会自动打开浏览器（推荐 Chrome / Edge），地址为 http://127.0.0.1:27527/',
  '关闭启动器窗口即退出。存档保存在浏览器中（按地址区分），关闭页面后再次打开可继续未完成的对局。',
  '',
  '说明：本离线版只支持「独立模拟」。游戏素材版权归上海鹰角网络 / Yostar 所有，网页复刻属于原作者，仅供个人离线游玩，请勿分发。',
  '',
].join('\n'));

console.log(`  game files: ${nMirror} mirrored + ${nOffline} offline`);

// ---- optional single executables (Node SEA) --------------------------------------------------------------------------

const exe = opt('exe', null);
if (exe) {
  const targets = String(exe === true ? `${process.platform}-${process.arch}` : exe).split(',').map((s) => s.trim()).filter(Boolean);
  const work = path.join(repo, 'dist', '.sea');
  fs.mkdirSync(work, { recursive: true });
  const blob = path.join(work, 'launcher.blob');
  fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify({ main: path.join(repo, 'tools', 'launcher.cjs'), output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea-config.json')], { stdio: 'inherit' });
  const version = process.version;
  for (const t of targets) {
    const [plat, arch] = t.split('-');
    const isWin = plat === 'win32' || plat === 'win';
    const base = await nodeBinary(work, version, isWin ? 'win' : plat, arch);
    const name = isWin ? 'stronghold-offline.exe' : plat === 'darwin' ? 'stronghold-offline-macos' : 'stronghold-offline-linux';
    const dst = path.join(out, name);
    fs.copyFileSync(base, dst);
    const args = [path.join(repo, 'node_modules', 'postject', 'dist', 'cli.js'), dst, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
    if (plat === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
    execFileSync(process.execPath, args, { stdio: 'inherit' });
    if (!isWin) fs.chmodSync(dst, 0o755);
    console.log(`  executable: ${path.relative(repo, dst)} (${t})`);
  }
}

/** The node binary of a platform for the SEA (this machine's own, or downloaded from nodejs.org). */
async function nodeBinary(work, version, plat, arch) {
  if (plat === process.platform && arch === process.arch) return process.execPath;
  const dir = path.join(work, `node-${version}-${plat}-${arch}`);
  const bin = path.join(dir, plat === 'win' ? 'node.exe' : 'node');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(dir, { recursive: true });
  if (plat === 'win') {
    const url = `https://nodejs.org/dist/${version}/win-${arch}/node.exe`;
    execFileSync('curl', ['-fsSL', '-o', bin, url], { stdio: 'inherit' });
  } else {
    const tgz = path.join(work, `node-${version}-${plat}-${arch}.tar.gz`);
    execFileSync('curl', ['-fsSL', '-o', tgz, `https://nodejs.org/dist/${version}/node-${version}-${plat}-${arch}.tar.gz`], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=2', `node-${version}-${plat}-${arch}/bin/node`], { stdio: 'inherit' });
  }
  return bin;
}
