// Link the mirrored client modules next to ./offline so the server's relative imports ('../../sim/spec.js',
// '../../shared/constants.js', '../../../js/ui/gameLogic.js') resolve in Node exactly as they do in the browser
// (where /offline/... sits next to /sim/, /shared/ and /js/). Run after `npm run mirror` (it does so itself).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirror = path.join(repo, process.argv[2] || 'mirror');
for (const name of ['sim', 'shared', 'js', 'data', 'data.js']) {
  const target = path.join(mirror, name);
  const link = path.join(repo, name);
  if (!fs.existsSync(target)) { console.warn(`skip ${name}: ${target} missing`); continue; }
  try { fs.lstatSync(link); fs.rmSync(link, { recursive: false, force: true }); } catch { /* absent */ }
  fs.symlinkSync(path.relative(repo, target), link);
}
console.log('linked sim/ shared/ js/ data/ data.js → mirror');
