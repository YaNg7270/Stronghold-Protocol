// Link the mirrored client modules next to ./offline so the server's relative imports ('../../sim/spec.js',
// '../../shared/constants.js', '../../../js/ui/gameLogic.js') resolve in Node exactly as they do in the browser
// (where /offline/... sits next to /sim/, /shared/ and /js/). Run after `npm run mirror` (it does so itself).
//
// Only the Node tests and tools need these links — playing (npm start, the packaged build) does not. On Windows a
// symbolic link needs Developer Mode or administrator rights, so directories become junctions (no rights needed) and
// the single file is copied. A failure only warns.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirror = path.join(repo, process.argv[2] || 'mirror');
const win = process.platform === 'win32';
let failed = 0;

for (const name of ['sim', 'shared', 'js', 'data', 'data.js']) {
  const target = path.join(mirror, name);
  const link = path.join(repo, name);
  if (!fs.existsSync(target)) { console.warn(`skip ${name}: ${target} missing`); continue; }
  try {
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isFile()) fs.rmSync(link, { force: true });
      else if (st.isDirectory()) {
        // an existing junction is removed as a link; a real directory is left alone
        try { fs.rmdirSync(link); } catch { console.warn(`skip ${name}: ${link} is a directory`); continue; }
      }
    } catch { /* absent */ }
    const isDir = fs.statSync(target).isDirectory();
    if (isDir) fs.symlinkSync(win ? target : path.relative(repo, target), link, win ? 'junction' : 'dir');
    else if (win) fs.copyFileSync(target, link);
    else fs.symlinkSync(path.relative(repo, target), link, 'file');
  } catch (err) {
    failed++;
    console.warn(`could not link ${name}: ${err.code || err.message}`);
  }
}

if (failed) console.warn('some links are missing: only the Node tests need them — the game itself runs without them (npm start)');
else console.log(`linked sim/ shared/ js/ data/ data.js → ${path.relative(repo, mirror) || mirror}`);
