// The offline game server's worker (started by offline/shim.js) — a SharedWorker when the browser has one (every tab
// of the game talks to the same server and the same save), else a dedicated Worker.
//
// Loads /data/*.json once, installs it into the sim (the same frozen data the client's battle runner uses), restores
// the saved server state from IndexedDB (a reload or a closed tab resumes the running match) and bridges the shim's
// sockets to GameServer:
//   page → worker  { id, type: 'connect' | 'msg' | 'close', data? }
//   worker → page  { id, type: 'open' | 'msg' | 'close', data?, code?, reason? }  ·  { type: 'log', level, args }

// No static imports: the server's module graph has top-level await (sim/content/index.js), and a message (or a
// SharedWorker connect) that arrives while a module is still evaluating would find no handler and be lost. The
// handlers below are installed synchronously; the server is imported in boot() and the early messages are queued.

/** Connected pages: each is a MessagePort-like { postMessage }. */
const pages = new Set();
const conns = new Map();
const queue = [];
let server = null;
let pageSeq = 0;

const broadcast = (m) => { for (const pg of pages) { try { pg.port.postMessage(m); } catch { /* closed */ } } };
const log = {
  info: (...a) => broadcast({ type: 'log', level: 'info', args: a.map(String) }),
  warn: (...a) => broadcast({ type: 'log', level: 'warn', args: a.map(String) }),
  error: (...a) => broadcast({ type: 'log', level: 'error', args: a.map((x) => (x && x.stack) || String(x)) }),
};

function onMessage(pg, m) {
  if (!m || typeof m !== 'object') return;
  if (!server) { queue.push([pg, m]); return; }
  const key = `${pg.id}:${m.id}`;
  if (m.type === 'connect') {
    const conn = server.connect(
      (obj) => pg.port.postMessage({ id: m.id, type: 'msg', data: JSON.stringify(obj) }),
      (code, reason) => { conns.delete(key); pg.port.postMessage({ id: m.id, type: 'close', code, reason }); },
    );
    conns.set(key, conn);
    pg.port.postMessage({ id: m.id, type: 'open' });
  } else if (m.type === 'msg') {
    conns.get(key)?.message(m.data);
  } else if (m.type === 'close') {
    const c = conns.get(key);
    conns.delete(key);
    c?.closed();
  } else if (m.type === 'bye') {
    // the page is going away (pagehide): its sockets are closed
    for (const [k, c] of [...conns]) if (k.startsWith(`${pg.id}:`)) { conns.delete(k); c.closed(); }
    pages.delete(pg);
  }
}

function attach(port) {
  const pg = { id: ++pageSeq, port };
  pages.add(pg);
  port.onmessage = (ev) => onMessage(pg, ev.data);
  if (typeof port.start === 'function') port.start();
}

if (typeof SharedWorkerGlobalScope !== 'undefined' && self instanceof SharedWorkerGlobalScope) {
  self.onconnect = (ev) => attach(ev.ports[0]);
} else {
  attach(self);
}

async function boot() {
  const [{ loadGameData }, { GameServer }, { installSim }, { openStore }] = await Promise.all([
    import('./server/data.js'), import('./server/index.js'), import('./server/sim.js'), import('./server/storage.js'),
  ]);
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
  for (const [pg, m] of queue.splice(0)) onMessage(pg, m);
}

boot().catch((err) => {
  log.error('offline game server failed to start', err);
  for (const [pg, m] of queue.splice(0)) if (m.type === 'connect') pg.port.postMessage({ id: m.id, type: 'close', code: 1011, reason: 'server failed to start' });
});
