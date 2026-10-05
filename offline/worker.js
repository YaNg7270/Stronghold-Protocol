// The offline game server's Worker (started by offline/shim.js).
//
// Loads /data/*.json once, installs it into the sim (the same frozen data the client's battle runner uses), restores
// the saved server state from IndexedDB (a reload or a closed tab resumes the running match: P6) and bridges the shim's
// sockets to GameServer:
//   shim → worker  { id, type: 'connect' | 'msg' | 'close', data? }
//   worker → shim  { id, type: 'open' | 'msg' | 'close', data?, code?, reason? }  ·  { type: 'log', level, args }

import { loadGameData } from './server/data.js';
import { GameServer } from './server/index.js';
import { installSim } from './server/sim.js';
import { openStore } from './server/storage.js';

const post = (m) => self.postMessage(m);
const log = {
  info: (...a) => post({ type: 'log', level: 'info', args: a.map(String) }),
  warn: (...a) => post({ type: 'log', level: 'warn', args: a.map(String) }),
  error: (...a) => post({ type: 'log', level: 'error', args: a.map((x) => (x && x.stack) || String(x)) }),
};

const conns = new Map();
const queue = [];
let server = null;

function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (!server) { queue.push(m); return; }
  if (m.type === 'connect') {
    const id = m.id;
    const conn = server.connect(
      (obj) => post({ id, type: 'msg', data: JSON.stringify(obj) }),
      (code, reason) => { conns.delete(id); post({ id, type: 'close', code, reason }); },
    );
    conns.set(id, conn);
    post({ id, type: 'open' });
  } else if (m.type === 'msg') {
    conns.get(m.id)?.message(m.data);
  } else if (m.type === 'close') {
    const c = conns.get(m.id);
    conns.delete(m.id);
    c?.closed();
  }
}

self.onmessage = (ev) => onMessage(ev.data);

async function boot() {
  const data = await loadGameData(async (name) => {
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(`/data/${name}.json`, { cache: 'no-cache' });
        if (res.ok) return await res.json();
        if (res.status === 404) return null;
      } catch { /* retry */ }
    }
    return null;
  });
  const sim = await installSim(data);
  const storage = await openStore('stronghold-offline');
  server = new GameServer({
    data, sim, log, storage,
    now: () => Date.now(),
    random: Math.random,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  }).start();
  log.info('offline game server ready');
  for (const m of queue.splice(0)) onMessage(m);
}

boot().catch((err) => {
  log.error('offline game server failed to start', err);
  for (const m of queue.splice(0)) if (m.type === 'connect') post({ id: m.id, type: 'close', code: 1011, reason: 'server failed to start' });
});
