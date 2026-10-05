// Match — the phase machine of one solo match (PHASE in shared/constants.js; the flow the client renders, js/screens/
// game.js, js/ui/gameLogic.js):
//
//   INFO_CHECK (25 s, g.infoReady) → BAND_DRAFT (solo: untimed, g.band) → BATTLE_CHECK (3 s)
//   → per round r: ROUND_START (income, shop, round-start effects) → [SP_DRAFT on the mode's spRounds]
//     → PREP (solo: untimed; g.ready) → COMBAT | FINAL_ASSAULT | HIDDEN_CORE (client-side combat: b.start → b.result)
//     → SETTLE (LP, layers, funds) → next round / RESULT
//
// Client-side combat (DESIGN §14 of the remake): the browser simulates the player's battle with the served sim and
// reports it (b.progress ~1 Hz, b.result at the end); this server builds the BattleSpec (/sim/spec.js buildBattleSpec)
// and settles the result. Boss rounds share a boss HP pool the server owns (b.pool), and the merged team LP.
//
// The match is driven by tick(now) (deadlines) and by intents (handle). Every change marks views dirty; flush() pushes
// m.public to every player and m.private to the players whose state changed.

import { PHASE, GEO, ERR } from '../../../shared/constants.js';
import { buildBattleSpec } from '../../../sim/spec.js';
import { createRng, deriveSeed } from '../../../sim/rng.js';
import { ServerError } from './errors.js';
import { PlayerState, freshRoundStats } from './player.js';
import { Pool, drawBans } from './pool.js';
import { generateFactions, roundSpawns, previewOf } from './waves.js';
import { MetaHost } from './meta.js';
import { SpDraft } from './spdraft.js';

export { ServerError };

const SPEED = 2;
const ROUND_START_MS = 2200;
const SETTLE_MS = 3200;
const BATTLE_CHECK_MS = 3000;
/** A battle without a result this long after its time limit is settled from the last progress (no stall). */
const RESULT_GRACE_MS = 25000;

const isObj = (v) => !!v && typeof v === 'object';

export class Match {
  /**
   * @param {{ server?: any, data: import('../data.js').GameData, sim?: any, modeId: string, difficulty: string, roomMode: string,
   *   seed: number, players: Array<{ playerId: string, seat: number, name: string, isBot?: boolean, loadout?: object }>,
   *   now: () => number, log?: any, push: (playerId: string, msg: object) => void }} o
   */
  constructor(o) {
    this.data = o.data;
    this.sim = o.sim;
    this.now = o.now;
    this.log = o.log || console;
    this.pushFn = o.push;
    this.modeId = o.modeId;
    this.mode = this.data.mode(o.modeId) || {};
    this.difficulty = o.difficulty;
    this.roomMode = o.roomMode || 'solo';
    this.seed = o.seed >>> 0;
    this.rng = createRng(this.seed);
    this.uidSeq = 0;
    this.battleSeq = 0;
    this.phase = PHASE.INFO_CHECK;
    this.round = 0;
    this.deadline = 0;
    this.phaseAt = 0;
    this.startedAt = 0;
    this.over = false;
    this.paused = false;
    this.pausedAt = 0;
    this.publicDirty = true;
    this.players = (o.players || []).map((p) => new PlayerState(this, p));
    this.meta = new MetaHost(this);
    this.sp = null;
    this.battles = new Map();
    this.result = null;
    this.teamLp = null;
    this.bossHp = null;
    this.overtimeAt = 0;
    this.lastRound = this.mode.lastRound ?? 14;
    this.bossRound = this.mode.bossRound ?? this.lastRound;
    this.hiddenRound = this.mode.hiddenRound ?? null;
    this.hiddenReached = false;
    this.hiddenCleared = false;
    this.victory = false;
    this.draft = null;
    if (!o.restoring) this._setup();
  }

  _setup() {
    const mode = this.mode;
    // battlefield: weighted among the mode's stages
    const stages = (Array.isArray(mode.stages) ? mode.stages : []).map((id) => this.data.stage(id)).filter(Boolean);
    const st = this.rng.weighted(stages, (s) => Number(s.weight) || 1) || stages[0] || Object.values(this.data.stageMap)[0];
    this.stageId = st?.id || null;
    this.bossId = pickWeighted(this.rng, mode.bossWeights) || null;
    this.hiddenBossId = pickWeighted(this.rng, mode.hiddenBossWeights) || null;
    const bans = drawBans(this.data, mode, this.difficulty, this.rng);
    this.drawnDisabledBonds = bans.drawn;
    this.disabledBonds = bans.disabled;
    this.bannedChess = bans.banned;
    this.pool = new Pool(this.data, bans.banned);
    this.factions = generateFactions(this);
  }

  get stage() { return this.data.stage(this.stageId); }

  nextUid() { return ++this.uidSeq; }

  player(playerId) { return this.players.find((p) => p.playerId === playerId) || null; }

  alivePlayers() { return this.players.filter((p) => p.alive); }

  // ---- pushes ------------------------------------------------------------------------------------------------------

  push(playerId, msg) { try { this.pushFn(playerId, msg); } catch (err) { this.log.warn('push failed', err); } }

  pushAll(msg) { for (const p of this.players) if (!p.isBot) this.push(p.playerId, msg); }

  toast(playerId, text, kind = 'info') { this.push(playerId, { t: 'm.toast', text, kind }); }

  ticker(text, { type = null, playerId = null, priority = 0 } = {}) { this.pushAll({ t: 'm.ticker', text, type, playerId, priority }); }

  /** Push the dirty views. */
  flush() {
    if (this.publicDirty) {
      this.publicDirty = false;
      this.pushAll({ t: 'm.public', ...this.publicView() });
    }
    for (const p of this.players) {
      if (!p.dirty || p.isBot) continue;
      p.dirty = false;
      this.push(p.playerId, { t: 'm.private', ...p.privateView() });
    }
  }

  /** Everything a reconnecting client needs again. */
  resync(playerId) {
    const p = this.player(playerId);
    this.push(playerId, { t: 'm.public', ...this.publicView() });
    if (p) this.push(playerId, { t: 'm.private', ...p.privateView() });
    if (this.result) this.push(playerId, { t: 'm.result', ...this.result });
    for (const b of this.battles.values()) {
      if (b.playerId !== playerId || b.settled) continue;
      this.push(playerId, this._startMsg(b));
    }
  }

  setConnected(playerId, on) {
    const p = this.player(playerId);
    if (p) { p.connected = on; this.publicDirty = true; }
  }

  setLoadout(playerId, loadout) {
    const p = this.player(playerId);
    if (p) { p.loadout = loadout || {}; p.touch(); this.flush(); }
  }

  dispose() {
    this.over = true;
  }

  publicView() {
    const mode = this.mode;
    return {
      phase: this.phase,
      round: this.round,
      deadline: this.paused ? this.deadline : this.deadline,
      serverNow: this.now(),
      modeId: this.modeId,
      difficulty: this.difficulty,
      lastRound: this.lastRound,
      bossRound: this.bossRound,
      hiddenRound: this.hiddenRound,
      stageId: this.stageId,
      bossId: this.bossId,
      hiddenBossId: this.hiddenBossId,
      factions: this.factions?.types || [],
      bannedChess: this.bannedChess,
      disabledBonds: this.disabledBonds,
      drawnDisabledBonds: this.drawnDisabledBonds,
      combatMode: 'client',
      paused: this.paused,
      pausedAt: this.paused ? this.pausedAt : null,
      teamLp: this.teamLp,
      bossHp: this.bossHp,
      overtimeAt: this.overtimeAt || null,
      draft: this.draft,
      sp: this.sp ? this.sp.publicView() : null,
      unite: null,
      speed: SPEED,
      players: this.players.map((p) => ({
        playerId: p.playerId, seat: p.seat, name: p.name, isBot: p.isBot, alive: p.alive, connected: p.connected,
        lp: p.lp, pendingLp: p.pendingLp ?? null, ready: this.phase === PHASE.INFO_CHECK ? p.infoReady : p.ready,
        status: p.status, fieldId: `n:${p.playerId}`, bandId: p.bandId, autoplay: p.autoplay, bonds: p.bondEntries(),
        shopLevel: p.shop.level, funds: p.funds,
      })),
      fields: [...this.battles.values()].filter((b) => b.round === this.round).map((b) => ({
        fieldId: b.fieldId, kind: b.kind, players: [b.playerId], live: !b.done, battleId: b.battleId,
        progress: { killed: b.progress.killed, total: b.progress.total, done: b.done },
      })),
      mode: { type: mode.type || 'SINGLE' },
    };
  }

  // ---- phase machine -----------------------------------------------------------------------------------------------

  setPhase(phase, ms = 0) {
    this.phase = phase;
    this.phaseAt = this.now();
    this.deadline = ms > 0 ? this.phaseAt + ms : 0;
    this.publicDirty = true;
    for (const p of this.players) p.touch();
  }

  begin(now) {
    this.startedAt = now;
    this.setPhase(PHASE.INFO_CHECK, (this.data.config.timers?.infoCheck ?? 25) * 1000);
  }

  tick(now) {
    if (this.over) return;
    if (this.paused) return;
    if (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) this._bossTick(now);
    if (this.deadline && now >= this.deadline) this._onDeadline(now);
    this.flush();
  }

  _onDeadline(now) {
    switch (this.phase) {
      case PHASE.INFO_CHECK: this._toBandDraft(); break;
      case PHASE.BATTLE_CHECK: this._startRound(1); break;
      case PHASE.ROUND_START: this._afterRoundStart(); break;
      case PHASE.SETTLE: this._afterSettle(); break;
      case PHASE.COMBAT: this._combatTimeout(now); break;
      case PHASE.FINAL_ASSAULT:
      case PHASE.HIDDEN_CORE:
        // the level countdown only: the battle goes on (overtime drain)
        this.deadline = 0;
        this.publicDirty = true;
        break;
      default: this.deadline = 0;
    }
  }

  _toBandDraft() {
    const order = this.rng.shuffle(this.players.map((p) => p.playerId));
    this.draft = {
      order, turn: order[0], picks: {}, skipsLeft: Object.fromEntries(order.map((id) => [id, 0])),
      untimed: true, turnSeconds: null, turnDeadline: null,
    };
    this.setPhase(PHASE.BAND_DRAFT, 0);
  }

  _pickBand(p, bandId) {
    const band = this.data.band(bandId);
    if (!band) throw new ServerError(ERR.BAD_TARGET, '无效的策略');
    const type = this.mode.type || 'SINGLE';
    if (Array.isArray(band.modeTypeList) && !band.modeTypeList.includes(type)) throw new ServerError(ERR.BAD_TARGET, '该策略不可用于本模式');
    p.bandId = bandId;
    p.lp = Number.isFinite(band.totalHp) ? band.totalHp : p.lp;
    this.draft.picks[p.playerId] = bandId;
    const next = this.draft.order.find((id) => !this.draft.picks[id]);
    this.draft.turn = next || null;
    this.meta.bandPicked?.(p);
    p.touch();
    if (!next) this.setPhase(PHASE.BATTLE_CHECK, BATTLE_CHECK_MS);
  }

  _startRound(r) {
    this.round = r;
    for (const b of [...this.battles.values()]) if (b.round < r - 1) this.battles.delete(b.battleId);
    for (const p of this.alivePlayers()) {
      p.ready = false;
      p.status = 'acting';
      p.roundStats = freshRoundStats();
      p.artsThisRound = 0;
      p.pendingLp = null;
      // income: economy.income[r] (+ next-round funds of last round's effects)
      const econ = this.data.economy;
      const base = Array.isArray(econ.income) ? (econ.income[r] ?? econ.incomeCap ?? 12) : Math.min(3 + r, 12);
      const income = this.meta.income(p, base);
      p.addFunds(income + p.pendingFunds);
      p.pendingFunds = 0;
      // shop: a frozen shop keeps its unsold slots once (freeze.consumedAtRoundStart)
      if (p.shop.frozen) { p.shop.frozen = false; p.topUpShop(); } else p.rollShop();
      p.touch();
    }
    this.setPhase(PHASE.ROUND_START, ROUND_START_MS);
    for (const p of this.alivePlayers()) this.meta.roundStart(p);
    this._preparePreview();
  }

  _afterRoundStart() {
    const sp = Array.isArray(this.mode.spRounds) ? this.mode.spRounds : [];
    if (sp.includes(this.round)) {
      this.sp = new SpDraft(this, this.round);
      if (this.sp.ready()) { this.setPhase(PHASE.SP_DRAFT, 0); return; }
      this.sp = null;
    }
    this._toPrep();
  }

  _toPrep() {
    this.sp = null;
    this.setPhase(PHASE.PREP, 0);
    for (const p of this.alivePlayers()) this.meta.prepStart(p);
  }

  /** The player readies (or every player is ready): prep ends, battles start. */
  _maybeEndPrep() {
    if (this.phase !== PHASE.PREP) return;
    if (!this.alivePlayers().every((p) => p.ready || p.isBot)) return;
    this._endPrep();
  }

  _endPrep() {
    for (const p of this.alivePlayers()) {
      // the temp row is emptied (its pieces would block the next prep)
      for (let i = 0; i < p.temp.length; i++) {
        const piece = p.temp[i];
        if (!piece) continue;
        p.temp[i] = null;
        if (piece.kind === 'chess') { this.pool.giveBack(piece.id, this.pool.copiesOf(piece.id)); p.addFunds(this.data.chessSellPrice(piece.id)); }
      }
      this.meta.prepEnd(p);
      const kept = Array.isArray(this.data.economy.leftoverFundsKeptByBands) ? this.data.economy.leftoverFundsKeptByBands : ['band_cannot'];
      if (this.data.economy.leftoverFundsLost !== false && !kept.includes(p.bandId)) p.funds = 0;
      // the shop's unfrozen slots are cleared at combat start (economy.shopClearedAtCombatStart)
      if (!p.shop.frozen) p.clearSlots();
      p.touch();
    }
    this._startBattles();
  }

  _preparePreview() {
    const row = this.mode.rounds?.[String(this.round)] || {};
    for (const p of this.alivePlayers()) {
      const w = roundSpawns(this, p, this.round, { bossLike: !!(row.isBoss || row.isHidden) });
      p.nextEnemies = previewOf(this, w.spawns, w.routes);
      p.touch();
    }
  }

  // ---- battles -------------------------------------------------------------------------------------------------------

  roundRow(r = this.round) { return this.mode.rounds?.[String(r)] || {}; }

  _startBattles() {
    const row = this.roundRow();
    const kind = row.isHidden ? 'hidden' : row.isBoss ? 'boss' : 'normal';
    const phase = kind === 'hidden' ? PHASE.HIDDEN_CORE : kind === 'boss' ? PHASE.FINAL_ASSAULT : PHASE.COMBAT;
    const now = this.now();
    if (kind === 'normal') {
      const tl = Number(row.combatTimeLimit ?? this.mode.combatTimeLimit?.[String(this.round)]) || 60;
      this.setPhase(phase, Math.round((tl / SPEED) * 1000) + 1500);
    } else {
      const level = Number(row.levelMaxPlayTime) || 120;
      this.setPhase(phase, level * 1000);
      const ot = Number(row.bossOvertimeAfter ?? this.data.config.bossOvertimeAfter) || 150;
      this.overtimeAt = now + ot * 1000;
      this._overtimeLost = 0;
      const boss = this.data.boss(kind === 'hidden' ? this.hiddenBossId : this.bossId);
      const scale = this.roomMode === 'solo' ? (this.data.config.bossHpScale?.solo ?? 0.25) : 1;
      const blood = Number(boss?.bloodPoint?.[this.difficulty]) || 100000;
      const max = Math.max(1, Math.round(blood * scale));
      this.bossHp = { hp: max, max };
      this.teamLp = this.alivePlayers().reduce((s, p) => s + p.lp, 0);
      this._teamLpStart = this.teamLp;
    }
    for (const p of this.alivePlayers()) {
      const b = this._buildBattle(p, kind);
      this.battles.set(b.battleId, b);
      p.status = 'combat';
      this.push(p.playerId, this._startMsg(b));
    }
    this.publicDirty = true;
  }

  _buildBattle(p, kind) {
    const row = this.roundRow();
    const battleId = `b${this.round}_${++this.battleSeq}`;
    const fieldId = `n:${p.playerId}`;
    const w = roundSpawns(this, p, this.round, { bossLike: kind !== 'normal' });
    const rect = kind === 'normal' ? { ...GEO.NORMAL_RECT } : { ...GEO.BOSS_RECT };
    const timeLimit = kind === 'normal' ? (Number(row.combatTimeLimit ?? w.maxPlayTime) || 60) : null;
    const dp = w.dp || this.data.config.dp || {};
    const input = this._playerInput(p, kind);
    const ev = { kind, spawns: w.spawns, routes: w.routes, side: 'L', input };
    this.meta.battleStart(p, ev);
    const spec = buildBattleSpec({
      battleId, fieldId, kind, seed: deriveSeed(this.seed, `${this.round}:${p.playerId}:${battleId}`), modeId: this.modeId,
      round: this.round, stageId: this.stageId, rect, timeLimit, players: [input], spawns: ev.spawns, routes: ev.routes,
      flags: { dpInit: dp.init ?? 10, dpPerSec: dp.perSec ?? 1, dpMax: dp.max ?? 99 }, enemyOverrides: w.overrides || {},
      waveId: w.waveId, bossId: kind === 'hidden' ? this.hiddenBossId : kind === 'boss' ? this.bossId : null, content: 'full',
      boss: kind !== 'normal' ? { poolHp: this.bossHp?.hp ?? 1, poolMax: this.bossHp?.max ?? 1 } : null,
    });
    return {
      battleId, fieldId, kind, playerId: p.playerId, round: this.round, spec, startAt: this.now(), done: false, settled: false,
      progress: { killed: 0, total: 0, leaks: 0, bossDmg: 0, gt: 0 }, result: null,
    };
  }

  _playerInput(p, kind) {
    const getChess = (id) => this.data.chess(id);
    const units = [];
    for (const piece of p.board) {
      if (piece.kind === 'chess') {
        const rec = getChess(piece.id);
        const lo = resolveLoadoutSafe(p.loadout, rec, getChess);
        const u = { kind: 'chess', chessId: piece.id, uid: piece.uid, row: piece.row, col: piece.col, dir: piece.dir || 'RIGHT', items: (piece.items || []).map((it) => it.id) };
        if (Number.isInteger(lo.skillIndex)) u.skillIndex = lo.skillIndex;
        if (typeof lo.moduleId === 'string') u.moduleId = lo.moduleId;
        units.push(u);
      } else if (piece.kind === 'token') {
        units.push({ kind: 'token', tokenId: piece.id, uid: piece.uid, ownerUid: piece.ownerUid, row: piece.row, col: piece.col, dir: piece.dir || 'RIGHT' });
      }
    }
    return {
      playerId: p.playerId, seat: p.seat, side: 'L', colOffset: 0, bandId: p.bandId,
      bonds: p.battleBonds(),
      playerEffects: p.effects.filter((e) => e.battle).map((e) => ({ id: e.id, key: e.key, params: e.params || {}, data: e.data || {} })),
      lpForBoss: kind !== 'normal' ? p.lp : null,
      units,
    };
  }

  _startMsg(b) {
    const elapsed = Math.max(0, ((this.now() - b.startAt) / 1000) * SPEED);
    return {
      t: 'b.start', battleId: b.battleId, fieldId: b.fieldId, kind: b.kind, spec: b.spec, authoritative: !b.done,
      startAt: b.startAt, serverNow: this.now(), elapsed: b.done ? 0 : elapsed, speed: SPEED,
    };
  }

  _progress(p, msg) {
    const b = this.battles.get(msg.battleId);
    if (!b || b.playerId !== p.playerId || b.settled) return;
    b.progress = { ...b.progress, gt: msg.gt, killed: msg.killed, total: msg.total, leaks: msg.leaks ?? b.progress.leaks, bossDmg: msg.bossDmg ?? b.progress.bossDmg };
    if (b.kind === 'normal') {
      const cap = this.data.config.lpCapPerRound ?? 10;
      p.pendingLp = Math.min(cap, Math.max(0, Math.trunc(msg.leaks || 0)));
    } else {
      this._bossProgress(b);
    }
    this.publicDirty = true;
  }

  _bossProgress(b) {
    if (!this.bossHp) return;
    const dmg = Math.max(0, Number(b.progress.bossDmg) || 0);
    this.bossHp = { ...this.bossHp, hp: Math.max(0, this.bossHp.max - dmg) };
    const leaks = Math.max(0, Number(b.progress.leaks) || 0);
    this.teamLp = Math.max(0, (this._teamLpStart ?? 0) - leaks - (this._overtimeLost || 0));
    this.push(b.playerId, { t: 'b.pool', hp: this.bossHp.hp, max: this.bossHp.max, teamLp: this.teamLp, acked: { [b.fieldId]: dmg } });
    if (this.bossHp.hp <= 0 && !b.done) this.push(b.playerId, { t: 'b.end', battleId: b.battleId, fieldId: b.fieldId, reason: 'cleared' });
    if (this.teamLp <= 0 && !b.done) this.push(b.playerId, { t: 'b.end', battleId: b.battleId, fieldId: b.fieldId, reason: 'forced' });
  }

  _bossTick(now) {
    if (!this.overtimeAt || now < this.overtimeAt + 1000) return;
    const perSec = this.data.config.bossOvertimeDrainPerSec ?? 1;
    const lost = Math.floor((now - this.overtimeAt) / 1000) * perSec;
    if (lost !== this._overtimeLost) {
      this._overtimeLost = lost;
      for (const b of this.battles.values()) if (b.round === this.round && !b.settled) this._bossProgress(b);
      this.publicDirty = true;
    }
  }

  _result(p, msg) {
    const b = this.battles.get(msg.battleId);
    if (!b || b.playerId !== p.playerId) throw new ServerError(ERR.BAD_TARGET, 'unknown battle');
    if (b.settled || b.done) return {};
    b.done = true;
    b.result = msg.result;
    const pr = msg.result?.perPlayer?.[p.playerId];
    if (pr) b.progress = { ...b.progress, killed: pr.killed, total: pr.total, done: true };
    if (b.kind !== 'normal') {
      const pool = msg.result?.perPlayer?.[p.playerId];
      if (pool && Number.isFinite(pool.bossDamage)) b.progress.bossDmg = Math.max(b.progress.bossDmg || 0, pool.bossDamage);
      this._bossProgress(b);
    }
    p.status = 'done';
    this.publicDirty = true;
    this._maybeSettle();
    return {};
  }

  _combatTimeout(now) {
    // the battle's time limit passed: wait a little longer for the result, then settle from the last progress
    const late = [...this.battles.values()].filter((b) => b.round === this.round && !b.done);
    if (!late.length) { this._maybeSettle(); return; }
    if (!this._graceUntil) { this._graceUntil = now + RESULT_GRACE_MS; this.deadline = this._graceUntil; return; }
    for (const b of late) {
      b.done = true;
      this.push(b.playerId, { t: 'b.end', battleId: b.battleId, fieldId: b.fieldId, reason: 'timeout' });
    }
    this._graceUntil = 0;
    this._maybeSettle();
  }

  _maybeSettle() {
    const cur = [...this.battles.values()].filter((b) => b.round === this.round);
    if (!cur.length || !cur.every((b) => b.done)) return;
    this._graceUntil = 0;
    this._settle(cur);
  }

  _settle(battles) {
    const row = this.roundRow();
    const bossLike = !!(row.isBoss || row.isHidden);
    for (const b of battles) {
      if (b.settled) continue;
      b.settled = true;
      const p = this.player(b.playerId);
      if (!p) continue;
      const pr = b.result?.perPlayer?.[p.playerId] || null;
      const counted = pr ? (pr.leaked || []).filter((l) => l && l.counted !== false).length : Math.max(0, Math.trunc(b.progress.leaks || 0));
      if (!bossLike) {
        const cap = this.data.config.lpCapPerRound ?? 10;
        const loss = Math.min(cap, counted);
        p.lp = Math.max(0, p.lp - loss);
        p.stats.leaks += counted;
        p.stats.lpLost += loss;
      }
      if (pr) {
        p.stats.kills += pr.killed || 0;
        p.stats.damage += pr.damageDealt || 0;
        p.stats.bossDamage += pr.bossDamage || 0;
        for (const [bondId, n] of Object.entries(pr.layerGains || {})) p.addLayers(bondId, n);
        if (pr.coins > 0) p.addFunds(Math.trunc(pr.coins));
      }
      this.meta.battleEnd?.(p, { battle: b, result: pr, perfect: !!pr?.perfect && counted === 0, leaks: counted });
      p.pendingLp = null;
      p.lastBattle = { round: this.round, kind: b.kind, killed: pr?.killed ?? b.progress.killed, total: pr?.total ?? b.progress.total, leaks: counted, perfect: !!pr?.perfect };
      p.touch();
    }
    if (bossLike) {
      const cleared = this.bossHp && this.bossHp.hp <= 0;
      // the merged team LP is what survives the boss round
      const lp = Math.max(0, this.teamLp ?? 0);
      for (const p of this.alivePlayers()) p.lp = lp;
      if (row.isHidden) { this.hiddenReached = true; this.hiddenCleared = !!cleared; }
      else this.victory = !!cleared;
      this._bossCleared = !!cleared;
      this.overtimeAt = 0;
    }
    for (const p of this.alivePlayers()) {
      if (p.lp <= 0) { p.alive = false; p.status = 'dead'; this.ticker(`${p.name} 的防线已被突破`, { type: 'DEAD', playerId: p.playerId }); }
      else {
        p.stats.roundsPassed = this.round;
        p.status = 'acting';
      }
      p.expireOffers();
      for (const bt of p.bounties) bt.roundsLeft -= 1;
      p.bounties = p.bounties.filter((bt) => bt.roundsLeft > 0);
    }
    this.setPhase(PHASE.SETTLE, SETTLE_MS);
  }

  _afterSettle() {
    const row = this.roundRow();
    if (!this.alivePlayers().length) { this._finish(); return; }
    if (row.isHidden) { this._finish(); return; }
    if (row.isBoss) {
      if (!this._bossCleared) { this._finish(); return; }
      if (this._hiddenUnlocked()) { this._startRound(this.hiddenRound); return; }
      this._finish();
      return;
    }
    if (this.round >= this.lastRound) { this._finish(); return; }
    this._startRound(this.round + 1);
  }

  /** 隐秘核心 (config.hiddenCore): only on its difficulties, with team LP left, when the mode has a hidden round. */
  _hiddenUnlocked() {
    const hc = this.data.config.hiddenCore || {};
    if (!this.hiddenRound || !this.hiddenBossId) return false;
    if (Array.isArray(hc.difficulties) && !hc.difficulties.includes(this.difficulty)) return false;
    const lp = this.alivePlayers().reduce((s, p) => s + p.lp, 0);
    return lp > (hc.minTeamLpExclusive ?? 0);
  }

  _finish() {
    const now = this.now();
    const roundsPassed = Math.max(0, ...this.players.map((p) => p.stats.roundsPassed));
    const victory = this.victory;
    this.result = {
      victory, roundsPassed, lastRound: this.lastRound, hiddenCleared: this.hiddenCleared, hiddenReached: this.hiddenReached,
      difficulty: this.difficulty, modeId: this.modeId, bossId: this.bossId, hiddenBossId: this.hiddenBossId,
      durationMs: now - this.startedAt, teamLp: this.round >= this.bossRound ? this.teamLp : null,
      players: this.players.map((p) => ({
        playerId: p.playerId, seat: p.seat, name: p.name, isBot: p.isBot, alive: p.alive, lp: p.lp, bandId: p.bandId,
        roundsPassed: p.stats.roundsPassed,
        title: null,
        lineup: p.board.filter((x) => x.kind === 'chess').map((x) => ({ kind: 'chess', id: x.id, golden: !!x.golden, tier: x.tier })),
        bonds: p.bondEntries().filter((b) => b.active || b.layers > 0).map((b) => ({ bondId: b.bondId, layers: b.layers, active: b.active })),
        stats: { ...p.stats },
        trophies: 0,
        reward: rewardOf(this.data.config, roundsPassed, this.difficulty, this.mode.type),
      })),
    };
    this.setPhase(PHASE.RESULT, 0);
    this.pushAll({ t: 'm.result', ...this.result });
    this.over = true;
    this.flush();
  }

  // ---- intents -------------------------------------------------------------------------------------------------------

  handle(playerId, msg) {
    const p = this.player(playerId);
    if (!p) throw new ServerError(ERR.NOT_IN_ROOM, '你不在该模拟中');
    const t = msg.t;
    // battle reports
    if (t === 'b.progress') { this._progress(p, msg); return {}; }
    if (t === 'b.result') return this._result(p, msg);
    if (t === 'g.emote') { this.pushAll({ t: 'm.emote', playerId, id: msg.id }); return {}; }
    if (t === 'g.watch') return {};
    if (t === 'g.unitStats') { this.push(playerId, { t: 'm.unitStats', seq: msg.seq ?? 0, round: this.round, units: [] }); return {}; }
    if (t === 'g.pause') return this._pause(!!msg.on);
    if (t === 'g.autoplay') { p.autoplay = !!msg.on; p.touch(); return {}; }
    if (!p.alive) throw new ServerError(ERR.ELIMINATED, '你已被淘汰');
    switch (t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
        p.infoReady = true;
        this.publicDirty = true;
        if (this.players.every((x) => x.infoReady || x.isBot)) this._toBandDraft();
        return {};
      case 'g.bandFocus': return {};
      case 'g.band':
        if (this.phase !== PHASE.BAND_DRAFT) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
        if (p.bandId) throw new ServerError(ERR.ALREADY, '已完成该操作');
        this._pickBand(p, msg.bandId);
        return {};
      case 'g.bandSkip': throw new ServerError(ERR.WRONG_PHASE, '独立模拟中无法跳过');
      case 'g.choice':
        if (this.phase !== PHASE.SP_DRAFT || !this.sp) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
        this.sp.pick(p, msg.idx);
        if (this.sp.done()) this._toPrep();
        return {};
      default: break;
    }
    // prep intents
    const prepPhases = [PHASE.PREP, PHASE.SP_DRAFT, PHASE.ROUND_START];
    if (!prepPhases.includes(this.phase)) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
    if (t === 'g.ready') {
      if (this.phase !== PHASE.PREP) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
      if (msg.ready && p.temp.some(Boolean)) throw new ServerError(ERR.TEMP_NOT_EMPTY, '临时整备区不为空');
      p.ready = !!msg.ready;
      p.status = p.ready ? 'ready' : 'acting';
      p.touch();
      this._maybeEndPrep();
      return {};
    }
    if (p.ready) throw new ServerError(ERR.WRONG_PHASE, '已准备就绪，取消准备后才能操作');
    switch (t) {
      case 'g.buy': return p.buy(msg.slot);
      case 'g.refresh': return p.refresh();
      case 'g.freeze': return p.freeze();
      case 'g.levelUp': return p.levelUp();
      case 'g.sell': return p.sell(msg.uid);
      case 'g.move': return p.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return p.equip(msg.itemUid, msg.targetUid, msg.replaceUid);
      case 'g.art': return p.art(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return p.destroy(msg.uid);
      case 'g.reward': return p.reward(msg.idx);
      default: throw new ServerError(ERR.BAD_MSG, `unsupported ${t}`);
    }
  }

  _pause(on) {
    const battlePhases = [PHASE.COMBAT, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE];
    if (!battlePhases.includes(this.phase)) throw new ServerError(ERR.WRONG_PHASE, '当前阶段无法进行该操作');
    if (on === this.paused) return {};
    const now = this.now();
    if (on) {
      this.paused = true;
      this.pausedAt = now;
    } else {
      const d = Math.max(0, now - this.pausedAt);
      this.paused = false;
      if (this.deadline) this.deadline += d;
      if (this.overtimeAt) this.overtimeAt += d;
      if (this._graceUntil) this._graceUntil += d;
      for (const b of this.battles.values()) if (!b.done) b.startAt += d;
    }
    this.publicDirty = true;
    return {};
  }

  // ---- persistence -------------------------------------------------------------------------------------------------

  serialize() {
    const plain = (o) => JSON.parse(JSON.stringify(o));
    return plain({
      v: 1, modeId: this.modeId, difficulty: this.difficulty, roomMode: this.roomMode, seed: this.seed, rngState: this.rng.state(),
      uidSeq: this.uidSeq, battleSeq: this.battleSeq, phase: this.phase, round: this.round, deadline: this.deadline,
      phaseAt: this.phaseAt, startedAt: this.startedAt, paused: this.paused, pausedAt: this.pausedAt,
      stageId: this.stageId, bossId: this.bossId, hiddenBossId: this.hiddenBossId, drawnDisabledBonds: this.drawnDisabledBonds,
      disabledBonds: this.disabledBonds, bannedChess: this.bannedChess, pool: this.pool.serialize(), factions: this.factions,
      draft: this.draft, sp: this.sp ? this.sp.serialize() : null, teamLp: this.teamLp, bossHp: this.bossHp,
      overtimeAt: this.overtimeAt, overtimeLost: this._overtimeLost || 0, teamLpStart: this._teamLpStart ?? null,
      hiddenReached: this.hiddenReached, hiddenCleared: this.hiddenCleared, victory: this.victory, bossCleared: !!this._bossCleared,
      battles: [...this.battles.values()],
      players: this.players.map((p) => {
        const o = {};
        for (const k of Object.keys(p)) if (k !== 'match' && k !== 'data') o[k] = p[k];
        return o;
      }),
    });
  }

  static restore(st, env) {
    const m = new Match({ ...env, modeId: st.modeId, difficulty: st.difficulty, roomMode: st.roomMode, seed: st.seed, players: [], restoring: true });
    m.rng = createRng(st.rngState >>> 0);
    for (const k of ['uidSeq', 'battleSeq', 'phase', 'round', 'deadline', 'phaseAt', 'startedAt', 'paused', 'pausedAt', 'stageId', 'bossId',
      'hiddenBossId', 'drawnDisabledBonds', 'disabledBonds', 'bannedChess', 'factions', 'draft', 'teamLp', 'bossHp', 'overtimeAt',
      'hiddenReached', 'hiddenCleared', 'victory']) m[k] = st[k];
    m._overtimeLost = st.overtimeLost || 0;
    m._teamLpStart = st.teamLpStart;
    m._bossCleared = !!st.bossCleared;
    m.pool = new Pool(m.data, st.bannedChess, st.pool);
    m.players = st.players.map((ps) => {
      const p = new PlayerState(m, { playerId: ps.playerId, seat: ps.seat, name: ps.name, isBot: ps.isBot, loadout: ps.loadout });
      Object.assign(p, ps);
      p.connected = false;
      p.dirty = true;
      return p;
    });
    for (const b of st.battles || []) m.battles.set(b.battleId, b);
    if (st.sp) m.sp = SpDraft.restore(m, st.sp);
    // a paused battle stays paused; a running one continues where the clock says (deadlines are absolute)
    m.publicDirty = true;
    return m;
  }
}

function pickWeighted(rng, weights) {
  if (!isObj(weights)) return null;
  const keys = Object.keys(weights);
  return rng.weighted(keys, (k) => Number(weights[k]) || 0) || null;
}

function resolveLoadoutSafe(loadout, rec, getChess) {
  try {
    // shared/protocol.js resolveLoadout, imported lazily to keep this module's import list short
    return resolveLoadoutFn(loadout, rec, getChess);
  } catch {
    return { skillIndex: null, moduleId: null };
  }
}

import { resolveLoadout as resolveLoadoutFn } from '../../../shared/protocol.js';

function rewardOf(config, roundsPassed, difficulty, type) {
  const r = config.rewards || {};
  const rows = Array.isArray(r.baseByRoundsPassed) ? r.baseByRoundsPassed : [];
  const row = [...rows].reverse().find((x) => x.round <= roundsPassed);
  if (!row) return 0;
  const df = r.difficultyFactor?.[difficulty] ?? 1;
  const mf = r.modeFactor?.[type || 'SINGLE'] ?? 1;
  return Math.round(row.count * df * mf);
}
