// Offline game server — sessions, the solo room and message routing (protocol: shared/protocol.js, DESIGN §8 of the
// online remake). Pure ESM with injected environment (clock, timers, logger), so the same code runs in the browser's
// Worker (offline/worker.js) and in Node tests.
//
//   const server = new GameServer({ data, sim, now, setInterval, clearInterval, log, storage })
//   const conn = server.connect(send, close)    // send(obj) delivers one S2C message; close(code, reason)
//   conn.message(text); conn.closed()
//
// Sessions: `hello { name, token }` resumes the session of a known token (same playerId: the client keeps its room /
// match on screen and the server re-pushes them), otherwise starts a new one. The offline build plays solo rooms only
// (独立模拟); a co-op request is refused with a readable message.

import { PROTOCOL_VERSION, DIFFICULTIES, ERR, NAME_MAX_LEN, modeIdFor } from '../../shared/constants.js';
import { validateC2S, checkLoadout } from '../../shared/protocol.js';
import { Match, ServerError } from './match/Match.js';

const TICK_MS = 100;

/** Error with a code the client resolves through ERR_TEXT (shared/constants.js) or the message. */
export { ServerError };

const randomId = (rng, n = 12) => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += abc[Math.floor(rng() * abc.length)];
  return s;
};

export class GameServer {
  /**
   * @param {{ data: import('./data.js').GameData, sim: any, now?: () => number, random?: () => number,
   *   setInterval?: Function, clearInterval?: Function, log?: { info: Function, warn: Function, error: Function },
   *   storage?: { load: (key: string) => any, save: (key: string, value: any) => void } | null }} env
   */
  constructor(env) {
    this.env = env;
    this.data = env.data;
    this.sim = env.sim;
    this.now = env.now || (() => Date.now());
    this.random = env.random || Math.random;
    this.log = env.log || console;
    this.storage = env.storage || null;
    /** token → session */
    this.sessions = new Map();
    /** room code → room */
    this.rooms = new Map();
    this.connSeq = 0;
    this._timer = null;
    this._restore();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  start() {
    if (this._timer == null && this.env.setInterval) this._timer = this.env.setInterval(() => this.tick(), TICK_MS);
    return this;
  }

  stop() {
    if (this._timer != null && this.env.clearInterval) this.env.clearInterval(this._timer);
    this._timer = null;
  }

  /** Advance every running match to the current time (phase deadlines, timers). */
  tick() {
    const t = this.now();
    for (const room of this.rooms.values()) {
      if (!room.match) continue;
      try { room.match.tick(t); } catch (err) { this.log.error('match tick failed', err); }
      if (room.match.over && !room.closedAt) this._matchOver(room);
    }
    this._persist();
  }

  // ---- connections -------------------------------------------------------------------------------------------------

  /**
   * A new client socket.
   * @param {(msg: object) => void} send
   * @param {(code?: number, reason?: string) => void} [close]
   */
  connect(send, close = () => {}) {
    const conn = { id: ++this.connSeq, send, close, session: null, alive: true };
    return {
      message: (text) => this._onMessage(conn, text),
      closed: () => this._onClosed(conn),
    };
  }

  _onClosed(conn) {
    conn.alive = false;
    const s = conn.session;
    if (s && s.conn === conn) {
      s.conn = null;
      const room = this._roomOf(s);
      if (room) {
        const seat = room.seats.find((x) => x && x.playerId === s.playerId);
        if (seat) seat.connected = false;
        room.match?.setConnected(s.playerId, false);
      }
    }
  }

  _send(conn, msg) {
    if (!conn || !conn.alive) return;
    try { conn.send(msg); } catch (err) { this.log.warn('send failed', err); }
  }

  /** Push a message to a player's live socket (no-op when offline). */
  pushTo(playerId, msg) {
    for (const s of this.sessions.values()) if (s.playerId === playerId && s.conn) this._send(s.conn, msg);
  }

  _onMessage(conn, text) {
    let msg;
    try { msg = JSON.parse(String(text)); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const rid = msg.rid;
    const bad = validateC2S(msg);
    if (bad) { this._send(conn, { t: 'error', rid, code: ERR.BAD_MSG, msg: bad }); return; }
    if (msg.t === 'ping') { this._send(conn, { t: 'pong', c: msg.c, s: this.now() }); return; }
    if (msg.t === 'hello') { this._hello(conn, msg); return; }
    const s = conn.session;
    if (!s) { this._send(conn, { t: 'error', rid, code: ERR.BAD_MSG, msg: 'hello first' }); return; }
    let reply;
    try {
      reply = this._dispatch(s, msg);
    } catch (err) {
      if (err instanceof ServerError) {
        if (rid != null) this._send(conn, { t: 'error', rid, code: err.code, msg: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      } else {
        this.log.error(`handler ${msg.t} failed`, err);
        if (rid != null) this._send(conn, { t: 'error', rid, code: ERR.INTERNAL, msg: String(err && err.message || err) });
      }
      return;
    }
    // state first, then the reply: a client awaiting the request sees the new state when it resolves
    const room = this._roomOf(s);
    if (room?.match) room.match.flush();
    if (rid != null) this._send(conn, { t: 'ok', rid, ...(reply && typeof reply === 'object' ? reply : {}) });
  }

  _hello(conn, msg) {
    if (msg.version != null && msg.version !== PROTOCOL_VERSION) {
      this._send(conn, { t: 'error', rid: msg.rid, code: ERR.BAD_MSG, msg: '版本不一致', detail: 'protocol version mismatch' });
      return;
    }
    const name = String(msg.name).trim().slice(0, NAME_MAX_LEN) || '博士';
    let s = typeof msg.token === 'string' ? this.sessions.get(msg.token) : null;
    if (!s) {
      const token = randomId(this.random, 24);
      s = { token, playerId: `p_${randomId(this.random, 8)}`, name, conn: null, roomCode: null, loadout: null };
      this.sessions.set(token, s);
    }
    if (s.conn && s.conn !== conn) {
      // the same token connected again (a reload): the old socket is replaced
      const old = s.conn;
      old.alive = false;
      try { old.close(4001, 'session replaced'); } catch { /* ignore */ }
    }
    s.conn = conn;
    s.name = name;
    conn.session = s;
    this._send(conn, { t: 'welcome', rid: msg.rid, playerId: s.playerId, name: s.name, token: s.token, serverNow: this.now(), version: PROTOCOL_VERSION });
    // resync: room and match state of a resumed session
    const room = this._roomOf(s);
    if (room) {
      const seat = room.seats.find((x) => x && x.playerId === s.playerId);
      if (seat) { seat.connected = true; seat.name = s.name; }
      this._pushRoom(room);
      if (room.match) {
        room.match.setConnected(s.playerId, true);
        room.match.resync(s.playerId);
      }
    }
  }

  _roomOf(s) {
    return s && s.roomCode ? this.rooms.get(s.roomCode) || null : null;
  }

  // ---- dispatch ----------------------------------------------------------------------------------------------------

  _dispatch(s, msg) {
    const t = msg.t;
    if (t === 'room.create') return this._create(s, msg);
    if (t === 'room.join' || t === 'room.spectate') throw new ServerError('OFFLINE_SOLO', '离线版只能进行独立模拟');
    if (t === 'room.loadout') return this._loadout(s, msg);
    const room = this._roomOf(s);
    if (!room) {
      if (t === 'room.leave' || t === 'g.leave') throw new ServerError(ERR.NOT_IN_ROOM, '你不在房间中');
      throw new ServerError(ERR.NOT_IN_ROOM, '你不在房间中');
    }
    switch (t) {
      case 'room.leave': return this._leave(s, room);
      case 'room.ready': return this._roomReady(s, room, msg.ready);
      case 'room.setDifficulty': return this._setDifficulty(s, room, msg.difficulty);
      case 'room.addBot':
      case 'room.removeBot':
      case 'room.kick':
      case 'room.removeSpectator':
        throw new ServerError('OFFLINE_SOLO', '独立模拟中无法进行该操作');
      case 'room.start': return this._startMatch(s, room);
      default:
        if (!room.match) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
        if (t === 'g.leave') return this._leave(s, room);
        return room.match.handle(s.playerId, msg);
    }
  }

  _create(s, msg) {
    if (msg.mode !== 'solo') throw new ServerError('OFFLINE_SOLO', '离线版暂不支持同盟模拟，请选择「独立模拟」');
    if (!DIFFICULTIES.includes(msg.difficulty)) throw new ServerError(ERR.BAD_MSG, '无效的难度');
    const prev = this._roomOf(s);
    if (prev) this._leave(s, prev);
    let code;
    do { code = randomId(this.random, 4).toUpperCase(); } while (this.rooms.has(code));
    const room = {
      code, mode: 'solo', difficulty: msg.difficulty, hostId: s.playerId, createdAt: this.now(),
      seats: [{ seat: 0, playerId: s.playerId, name: s.name, isBot: false, ready: false, connected: true }],
      spectators: [], inMatch: false, match: null, closedAt: null,
    };
    this.rooms.set(code, room);
    s.roomCode = code;
    this._pushRoom(room);
    return { code };
  }

  _loadout(s, msg) {
    const res = checkLoadout(msg.entries, (id) => this.data.chess(id));
    if (!res.ok) throw new ServerError(res.error, '干员调配无效', res.detail);
    s.loadout = res.loadout;
    const room = this._roomOf(s);
    if (room?.match) room.match.setLoadout(s.playerId, s.loadout);
    return {};
  }

  _leave(s, room) {
    s.roomCode = null;
    if (room.match) { try { room.match.dispose(); } catch { /* ignore */ } }
    this.rooms.delete(room.code);
    this._persist(true);
    return {};
  }

  _roomReady(s, room, ready) {
    const seat = room.seats.find((x) => x && x.playerId === s.playerId);
    if (seat) seat.ready = !!ready;
    this._pushRoom(room);
    return {};
  }

  _setDifficulty(s, room, difficulty) {
    if (room.hostId !== s.playerId) throw new ServerError(ERR.NOT_HOST, '只有房主可以操作');
    if (room.inMatch) throw new ServerError(ERR.ROOM_STARTED, '模拟已开始');
    room.difficulty = difficulty;
    this._pushRoom(room);
    return {};
  }

  _startMatch(s, room) {
    if (room.hostId !== s.playerId) throw new ServerError(ERR.NOT_HOST, '只有房主可以操作');
    if (room.inMatch) throw new ServerError(ERR.ROOM_STARTED, '模拟已开始');
    const modeId = modeIdFor('solo', room.difficulty);
    const seed = Math.floor(this.random() * 0xffffffff) >>> 0;
    const players = room.seats.filter(Boolean).map((x) => {
      const sess = [...this.sessions.values()].find((q) => q.playerId === x.playerId);
      return { playerId: x.playerId, seat: x.seat, name: x.name, isBot: x.isBot, loadout: sess?.loadout || {} };
    });
    room.match = new Match({
      server: this, data: this.data, sim: this.sim, modeId, difficulty: room.difficulty, roomMode: room.mode,
      seed, players, now: this.now, log: this.log,
      push: (playerId, m) => this.pushTo(playerId, m),
    });
    room.inMatch = true;
    room.closedAt = null;
    for (const seat of room.seats) if (seat) seat.ready = false;
    this._pushRoom(room);
    room.match.begin(this.now());
    room.match.flush();
    return {};
  }

  _matchOver(room) {
    room.closedAt = this.now();
    room.inMatch = false;
    this._pushRoom(room);
  }

  _pushRoom(room) {
    const payload = {
      t: 'room.state', code: room.code, mode: room.mode, difficulty: room.difficulty, hostId: room.hostId,
      seats: room.seats.map((x) => (x ? { ...x } : null)), spectators: [], inMatch: room.inMatch,
      modeId: modeIdFor(room.mode, room.difficulty),
    };
    for (const seat of room.seats) if (seat && !seat.isBot) this.pushTo(seat.playerId, payload);
  }

  // ---- persistence (resume after a reload: P6) --------------------------------------------------------------------

  _persist(force = false) {
    if (!this.storage) return;
    const t = this.now();
    if (!force && this._savedAt && t - this._savedAt < 2000) return;
    this._savedAt = t;
    try {
      const sessions = [...this.sessions.values()].map((s) => ({ token: s.token, playerId: s.playerId, name: s.name, roomCode: s.roomCode, loadout: s.loadout }));
      const rooms = [...this.rooms.values()].map((r) => ({
        code: r.code, mode: r.mode, difficulty: r.difficulty, hostId: r.hostId, createdAt: r.createdAt,
        seats: r.seats, inMatch: r.inMatch, match: r.match && !r.match.over ? r.match.serialize() : null,
      }));
      this.storage.save('server', { v: 1, savedAt: t, sessions, rooms });
    } catch (err) {
      this.log.warn('persist failed', err);
    }
  }

  _restore() {
    if (!this.storage) return;
    let st = null;
    try { st = this.storage.load('server'); } catch { st = null; }
    if (!st || st.v !== 1) return;
    for (const s of st.sessions || []) this.sessions.set(s.token, { ...s, conn: null });
    for (const r of st.rooms || []) {
      const room = { ...r, spectators: [], match: null, closedAt: null };
      for (const seat of room.seats) if (seat && !seat.isBot) seat.connected = false;
      if (r.match) {
        try {
          room.match = Match.restore(r.match, {
            server: this, data: this.data, sim: this.sim, now: this.now, log: this.log,
            push: (playerId, m) => this.pushTo(playerId, m),
          });
        } catch (err) {
          this.log.warn('match restore failed', err);
          room.match = null;
          room.inMatch = false;
        }
      }
      this.rooms.set(room.code, room);
    }
  }
}
