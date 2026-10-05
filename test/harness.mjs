// Test harness: the offline GameServer in Node with a headless client.
//
//   const h = await createHarness({ seed })
//   const c = h.client('博士')            // a socket: c.request(t, fields) → reply, c.state = { room, pub, priv, result }
//   await h.runBattles(c)                 // simulate every b.start the client got (the real sim, like js/battle/runner.js)
//   h.advance(ms)                         // move the fake clock and tick the server
//
// The clock is fake (h.now), so phase timers are driven by advance().

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../offline/server/data.js';
import { GameServer } from '../offline/server/index.js';
import { installSim } from '../offline/server/sim.js';
import { memoryStore } from '../offline/server/storage.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let shared = null;
async function sharedData() {
  if (!shared) {
    shared = (async () => {
      const data = await loadGameData(async (n) => {
        const f = path.join(repo, 'mirror', 'data', `${n}.json`);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      });
      const sim = await installSim(data);
      return { data, sim };
    })();
  }
  return shared;
}

/** Deterministic Math.random replacement. */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createHarness({ seed = 1, storage = null, start = 1_800_000_000_000 } = {}) {
  const { data, sim } = await sharedData();
  const h = { data, sim, now: start, clients: [] };
  const log = { info() {}, warn: (...a) => console.warn('[server]', ...a), error: (...a) => console.error('[server]', ...a) };
  h.server = new GameServer({ data, sim, log, storage: storage || memoryStore(), now: () => h.now, random: seeded(seed) });
  h.advance = (ms) => {
    const step = 100;
    for (let t = 0; t < ms; t += step) { h.now += Math.min(step, ms - t); h.server.tick(); }
  };
  h.client = (name = '博士') => {
    const c = { name, rid: 0, pending: new Map(), inbox: [], starts: [], state: { room: null, pub: null, priv: null, result: null, welcome: null }, closed: false };
    c.conn = h.server.connect((msg) => {
      c.inbox.push(msg);
      if (msg.t === 'welcome') c.state.welcome = msg;
      if (msg.t === 'room.state') c.state.room = msg;
      if (msg.t === 'm.public') c.state.pub = msg;
      if (msg.t === 'm.private') c.state.priv = msg;
      if (msg.t === 'm.result') c.state.result = msg;
      if (msg.t === 'b.start') c.starts.push(msg);
      if ((msg.t === 'ok' || msg.t === 'error' || msg.t === 'welcome') && msg.rid != null && c.pending.has(msg.rid)) {
        const done = c.pending.get(msg.rid);
        c.pending.delete(msg.rid);
        done(msg);
      }
    }, () => { c.closed = true; });
    c.send = (t, fields = {}) => c.conn.message(JSON.stringify({ ...fields, t }));
    c.request = (t, fields = {}) => {
      const rid = ++c.rid;
      let reply = null;
      c.pending.set(rid, (m) => { reply = m; });
      c.conn.message(JSON.stringify({ ...fields, t, rid }));
      if (!reply) throw new Error(`no reply to ${t}`);
      return reply;
    };
    c.ok = (t, fields = {}) => {
      const r = c.request(t, fields);
      if (r.t !== 'ok') throw new Error(`${t} refused: ${r.code} ${r.msg}`);
      return r;
    };
    c.hello = (token) => c.request('hello', { name, version: 1, ...(token ? { token } : {}) });
    h.clients.push(c);
    return c;
  };

  /** Simulate the client's pending battles to the end and report them (b.progress + b.result). */
  h.runBattles = (c, { maxSteps = 60 * 60 * 30 } = {}) => {
    const out = [];
    while (c.starts.length) {
      const msg = c.starts.shift();
      if (!msg.authoritative) continue;
      const battle = sim.spec.createBattleFromSpec(msg.spec, sim.ds, { logger: { error() {}, warn() {}, info() {}, debug() {} }, recordEvents: false });
      const meter = sim.spec.attachLpMeter(battle);
      let steps = 0;
      while (!battle.finished && steps < maxSteps) { battle.step(); steps++; }
      const p = sim.spec.battleProgress(battle);
      const prog = { battleId: msg.battleId, gt: Math.min(1e5, p.gt), killed: Math.min(p.killed, p.total), total: p.total, done: true, leaks: msg.kind === 'normal' ? p.leaks : meter.lp };
      if (msg.kind !== 'normal' && battle.sharedBoss) prog.bossDmg = battle.sharedBoss.cum || 0;
      c.send('b.progress', prog);
      const result = sim.spec.fitResult(sim.spec.compactResult(battle.result()), { bossLike: msg.kind !== 'normal', battleId: msg.battleId });
      const r = c.request('b.result', { battleId: msg.battleId, result });
      out.push({ msg, result, reply: r, steps, time: battle.time });
    }
    return out;
  };
  return h;
}
