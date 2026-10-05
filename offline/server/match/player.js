// PlayerState — one player's side of a match: funds, LP, shop, pieces (board / hand / temp), bonds and effects.
//
// Pieces (the m.private shape the client renders, js/ui/gameLogic.js):
//   chess { uid, kind: 'chess', id, golden, tier, items: [{ uid, id }], dir, row?, col? }
//   item  { uid, kind: 'item', id }
//   token { uid, kind: 'token', id, ownerUid, row?, col?, dir? }    a placeable summon of an owned operator
// Areas: board (pieces with row / col on the own field), hand (GEO.HAND_SIZE slots, null = empty) and temp
// (GEO.TEMP_SIZE overflow slots, server-filled only). Placement legality is the client's own rule set
// (js/ui/gameLogic.js canPlace — the online server's mirror), evaluated on this player's private view.
//
// Every state change marks the player dirty; Match.flush() pushes m.private / m.public afterwards.

import { GEO, ERR } from '../../../shared/constants.js';
import { rangeTiles } from '../../../js/ui/facing.js';
import { placementContext, canPlace, deployFieldOf, completesMerge, mergeTarget, handFull, equipMerges, itemAttaches } from '../../../js/ui/gameLogic.js';
import { ServerError } from './errors.js';
import { rollShopItem } from './pool.js';
import { computeBonds } from './bonds.js';

const isObj = (v) => !!v && typeof v === 'object';
const DIRS = ['UP', 'RIGHT', 'DOWN', 'LEFT'];

export class PlayerState {
  /**
   * @param {import('./Match.js').Match} match
   * @param {{ playerId: string, seat: number, name: string, isBot?: boolean, loadout?: object }} info
   */
  constructor(match, info) {
    this.match = match;
    this.data = match.data;
    this.playerId = info.playerId;
    this.seat = info.seat ?? 0;
    this.name = info.name || '博士';
    this.isBot = !!info.isBot;
    this.loadout = info.loadout || {};
    this.connected = true;
    this.alive = true;
    this.lp = this.data.economy.defaultStartLp ?? 28;
    this.funds = 0;
    this.pendingFunds = 0;
    this.ready = false;
    this.infoReady = false;
    this.bandId = null;
    this.autoplay = false;
    this.board = [];
    this.hand = new Array(GEO.HAND_SIZE).fill(null);
    this.temp = new Array(GEO.TEMP_SIZE).fill(null);
    this.shop = { level: 1, slots: [], frozen: false, freeRefreshes: 0, offers: [] };
    /** bondId → accumulated layers */
    this.layers = {};
    /** owned effect entries (bands, 机变 cards, items): { id, key?, name, desc, iconKind, iconId, counter?, battle, params, data } */
    this.effects = [];
    /** meta counters (ctx.counter / setCounter / incCounter) */
    this.counters = {};
    /** per-piece counters: uid → { key: n } */
    this.pieceCounters = {};
    this.roundStats = freshRoundStats();
    this.stats = { merges: 0, kills: 0, leaks: 0, lpLost: 0, damage: 0, bossDamage: 0, spent: 0, refreshes: 0, roundsPassed: 0, bestRound: 0 };
    this.bounties = [];
    this.deviceOverrides = {};
    this.tileOverrides = {};
    this.artsThisRound = 0;
    this.extraDeploy = 0;
    this.dirty = true;
    this.nextEnemies = [];
    this.lastBattle = null;
    this.status = 'acting';
  }

  // ---- ids & views -----------------------------------------------------------------------------------------------

  nextUid() { return this.match.nextUid(); }

  touch() { this.dirty = true; this._bondsCache = null; this.match.publicDirty = true; }

  /** Every owned piece with its area: [{ piece, area, idx? }]. */
  allPieces() {
    const out = [];
    for (const p of this.board) out.push({ piece: p, area: 'board' });
    this.hand.forEach((p, idx) => { if (p) out.push({ piece: p, area: 'hand', idx }); });
    this.temp.forEach((p, idx) => { if (p) out.push({ piece: p, area: 'temp', idx }); });
    return out;
  }

  find(uid) {
    for (const e of this.allPieces()) {
      if (e.piece.uid === uid) return e;
      if (e.piece.kind === 'chess') for (const it of e.piece.items || []) if (it.uid === uid) return { piece: it, area: 'equipped', holder: e.piece, holderArea: e.area };
    }
    return null;
  }

  deployCap() {
    const stage = this.match.stage;
    const base = this.data.economy.deployCap ?? 8;
    const limit = Number.isInteger(stage?.options?.characterLimit) ? stage.options.characterLimit : base;
    return Math.max(1, Math.min(limit, base) + this.extraDeploy);
  }

  deployCount() { return this.board.filter((p) => p.kind === 'chess').length; }

  /** The m.private view (also the input of the client's placement rules). */
  privateView() {
    const shop = this.shop;
    const offer = shop.offers[0] || null;
    const view = {
      playerId: this.playerId,
      alive: this.alive,
      lp: this.lp,
      funds: this.funds,
      pendingFunds: this.pendingFunds,
      ready: this.ready,
      canReady: this.temp.every((p) => !p),
      bandId: this.bandId,
      loadout: this.loadout,
      deployCap: this.deployCap(),
      deployCount: this.deployCount(),
      board: this.board.map(clonePiece),
      hand: this.hand.map((p) => (p ? clonePiece(p) : null)),
      temp: this.temp.map((p) => (p ? clonePiece(p) : null)),
      shop: {
        level: shop.level,
        maxLevel: this.maxShopLevel(),
        upgradePrice: this.upgradePrice(),
        refreshPrice: this.refreshPrice(),
        freeRefreshes: shop.freeRefreshes,
        frozen: shop.frozen,
        slots: shop.slots.map((s) => (s ? { ...s } : null)),
        rewardOffer: offer ? { ...offer, slots: offer.slots.map((s) => ({ ...s })), queued: shop.offers.length - 1 } : null,
      },
      bonds: this.bondEntries(),
      effects: this.effects.map(effectView),
      nextEnemies: this.nextEnemies,
      deviceOverrides: { ...this.deviceOverrides },
      tileOverrides: { ...this.tileOverrides },
      stats: { leaks: this.stats.leaks },
      autoplay: this.autoplay,
    };
    return view;
  }

  /** Placement context of the client's rules on the current state. */
  placement() {
    const pub = this.match.publicView();
    return placementContext({
      priv: this.privateView(),
      stage: this.match.stage,
      editable: true,
      field: deployFieldOf(pub, this.playerId),
      getChess: (id) => this.data.chess(id),
      getToken: (id) => this.data.token(id),
      getItem: (id) => this.data.item(id),
      getEffect: (id) => this.data.effect(id),
    });
  }

  // ---- shop ------------------------------------------------------------------------------------------------------

  maxShopLevel() {
    const m = this.match.mode;
    return Number.isInteger(m?.maxShopLevel) ? m.maxShopLevel : 6;
  }

  upgradePrice() {
    const prices = this.match.mode?.upgradePrices || [5, 8, 11, 12, 13];
    const p = prices[this.shop.level - 1];
    if (!Number.isFinite(p)) return 0;
    return Math.max(0, p - (this.counters['shop:upgradeDiscount'] || 0));
  }

  refreshPrice() {
    return this.shop.freeRefreshes > 0 ? 0 : (this.data.economy.refreshPrice ?? 1);
  }

  slotCounts() {
    const row = (this.match.mode?.shopSlots || {})[String(this.shop.level)] || { chess: 3, item: 1 };
    return { chess: row.chess ?? 3, item: row.item ?? 1 };
  }

  /** A shop slot for a chess id (price via onPrice modifiers). */
  chessSlot(id, extra = {}) {
    const base = this.data.chessPrice(id);
    const price = this.match.meta.price(this, { kind: 'chess', id, price: base });
    return { kind: 'chess', id, price, basePrice: base, sold: false, ...extra };
  }

  itemSlot(id, extra = {}) {
    const rec = this.data.item(id);
    const base = Number.isFinite(rec?.price) ? rec.price : 1;
    const price = this.match.meta.price(this, { kind: 'item', id, price: base });
    return { kind: 'item', id, price, basePrice: base, sold: false, ...extra };
  }

  /** Return the copies of unsold slots (all, or only the unfrozen ones) to the pool and empty them. */
  clearSlots({ keepFrozen = false } = {}) {
    const keep = [];
    for (const s of this.shop.slots) {
      if (!s) continue;
      if (keepFrozen && this.shop.frozen && !s.sold) { keep.push(s); continue; }
      if (!s.sold && s.kind === 'chess' && !s.noPool) this.match.pool.giveBack(s.id, 1);
    }
    this.shop.slots = keep;
  }

  /** Reroll every slot (copies of unsold chess go back first). */
  rollShop() {
    this.clearSlots();
    const { chess, item } = this.slotCounts();
    const rng = this.match.rng;
    const slots = [];
    for (let i = 0; i < chess; i++) {
      const id = this.match.pool.take(rng, { maxTier: this.shop.level });
      slots.push(id ? this.chessSlot(id) : null);
    }
    for (let i = 0; i < item; i++) {
      const id = rollShopItem(this.data, rng, { maxTier: this.shop.level });
      slots.push(id ? this.itemSlot(id) : null);
    }
    this.shop.slots = slots;
    this.touch();
  }

  /** Fill slots up to the level's counts without rerolling (level-up, shop cleared at combat). */
  topUpShop() {
    const { chess, item } = this.slotCounts();
    const rng = this.match.rng;
    const cs = this.shop.slots.filter((s) => !s || s.kind !== 'item');
    const is = this.shop.slots.filter((s) => s && s.kind === 'item');
    while (cs.length < chess) {
      const id = this.match.pool.take(rng, { maxTier: this.shop.level });
      cs.push(id ? this.chessSlot(id) : null);
    }
    while (is.length < item) {
      const id = rollShopItem(this.data, rng, { maxTier: this.shop.level });
      is.push(id ? this.itemSlot(id) : null);
    }
    this.shop.slots = [...cs, ...is];
    this.touch();
  }

  /** Re-price the unsold slots (an onPrice modifier changed). */
  reprice() {
    for (const s of this.shop.slots) {
      if (!s || s.sold) continue;
      s.price = this.match.meta.price(this, { kind: s.kind, id: s.id, price: s.basePrice, slot: s });
    }
  }

  spend(n, reason = 'shop') {
    const v = Math.max(0, Math.trunc(n));
    if (v > this.funds) throw new ServerError(ERR.NO_FUNDS, '资金不足');
    this.funds -= v;
    if (v > 0) {
      this.roundStats.spent += v;
      this.stats.spent += v;
      this.match.meta.emit(this, 'onSpend', { amount: v, reason });
    }
    this.touch();
  }

  addFunds(n) {
    const v = Math.trunc(Number(n) || 0);
    if (!v) return;
    this.funds = Math.max(0, this.funds + v);
    this.touch();
  }

  // ---- gaining pieces ----------------------------------------------------------------------------------------------

  freeHandIdx() {
    // economy.handFillOrder 'rightToLeft'
    for (let i = this.hand.length - 1; i >= 0; i--) if (!this.hand[i]) return i;
    return -1;
  }

  freeTempIdx() { return this.temp.findIndex((p) => !p); }

  /** Put a loose piece in the hand, else the temp row; false when both are full. */
  stow(piece) {
    const h = this.freeHandIdx();
    if (h >= 0) { this.hand[h] = piece; this.touch(); return 'hand'; }
    const t = this.freeTempIdx();
    if (t >= 0) { this.temp[t] = piece; this.touch(); return 'temp'; }
    return null;
  }

  /** Remove a piece from wherever it is (board / hand / temp / equipped). Returns the area it left, or null. */
  detach(uid) {
    const bi = this.board.findIndex((p) => p.uid === uid);
    if (bi >= 0) { this.board.splice(bi, 1); this.touch(); return 'board'; }
    const hi = this.hand.findIndex((p) => p && p.uid === uid);
    if (hi >= 0) { this.hand[hi] = null; this.touch(); return 'hand'; }
    const ti = this.temp.findIndex((p) => p && p.uid === uid);
    if (ti >= 0) { this.temp[ti] = null; this.touch(); return 'temp'; }
    for (const e of this.allPieces()) {
      if (e.piece.kind !== 'chess') continue;
      const k = (e.piece.items || []).findIndex((it) => it.uid === uid);
      if (k >= 0) { e.piece.items.splice(k, 1); this.touch(); return 'equipped'; }
    }
    return null;
  }

  newChess(id) {
    const rec = this.data.chess(id);
    return { uid: this.nextUid(), kind: 'chess', id, golden: !!rec?.isGolden, tier: rec?.tier ?? 1, items: [], dir: 'RIGHT' };
  }

  /** Normal copies of a base chess owned now (board / hand / temp). */
  copiesOf(baseId) {
    return this.allPieces().filter((e) => e.piece.kind === 'chess' && !e.piece.golden && this.data.baseOf(e.piece.id) === baseId);
  }

  /**
   * Gain an operator: a merge when it completes one (economy.mergeCount copies → the elite, on the tile of the deployed
   * copy that deploys first, else in the hand), otherwise into the hand (temp on overflow).
   * The pool copy must already be out of the pool (shop slot, reward offer) — `fromPool` takes one now.
   * @returns {object|null} the piece gained (the elite after a merge), or null when there is no room
   */
  gainChess(id, { fromPool = false, golden = false, source = 'shop', silent = false } = {}) {
    let chessId = id;
    if (golden) chessId = this.data.goldenOf(id) || id;
    const rec = this.data.chess(chessId);
    if (!rec) return null;
    if (fromPool && !rec.isGolden && !this.match.pool.takeId(chessId)) {
      // the pool has no copy left: the effect still grants it (the official server lends one)
    }
    const priv = this.privateView();
    const getChess = (x) => this.data.chess(x);
    let piece = null;
    if (!rec.isGolden && completesMerge(priv, { kind: 'chess', id: chessId }, { getChess })) {
      piece = this._merge(chessId, source);
    } else {
      piece = this.newChess(chessId);
      if (!this.stow(piece)) {
        if (!rec.isGolden) this.match.pool.giveBack(chessId, 1);
        if (!silent) this.match.toast(this.playerId, '整备区已满，未能获得干员', 'warn');
        return null;
      }
      this._addTokensFor(piece);
    }
    this.roundStats.gainedChess += 1;
    this.match.meta.gained(this, piece, source);
    this.touch();
    return piece;
  }

  _merge(chessId, source) {
    const base = this.data.baseOf(chessId);
    const need = this.data.mergeCountOf(base);
    const goldenId = this.data.goldenOf(base);
    const priv = this.privateView();
    const target = mergeTarget(priv, chessId, (x) => this.data.chess(x));
    const copies = this.copiesOf(base);
    // the copy on the target tile first, then temp, hand and the rest of the board
    const order = { temp: 0, hand: 1, board: 2 };
    copies.sort((a, b) => {
      const ta = target && a.area === 'board' && a.piece.row === target.row && a.piece.col === target.col ? -1 : order[a.area];
      const tb = target && b.area === 'board' && b.piece.row === target.row && b.piece.col === target.col ? -1 : order[b.area];
      return ta - tb;
    });
    const used = copies.slice(0, need - 1);
    const items = [];
    const counts = {};
    for (const e of used) {
      for (const it of e.piece.items || []) items.push(it);
      const pc = this.pieceCounters[e.piece.uid];
      if (pc) for (const [k, v] of Object.entries(pc)) counts[k] = Math.max(counts[k] || 0, v);
      this._removeTokensOf(e.piece.uid);
      this.detach(e.piece.uid);
      delete this.pieceCounters[e.piece.uid];
    }
    const elite = this.newChess(goldenId);
    if (Object.keys(counts).length) this.pieceCounters[elite.uid] = counts;
    const per = this.data.economy.equipPerChess ?? 2;
    elite.items = items.slice(0, per);
    for (const it of items.slice(per)) this.stow({ uid: it.uid, kind: 'item', id: it.id });
    if (target) {
      elite.row = target.row; elite.col = target.col; elite.dir = target.dir || 'RIGHT';
      this.board.push(elite);
    } else if (!this.stow(elite)) {
      // no room at all (the copies freed at least one slot unless they were all on the board)
      this.board.push({ ...elite, row: used[0]?.piece.row ?? 9, col: used[0]?.piece.col ?? 2 });
    }
    this._addTokensFor(elite);
    this.stats.merges += 1;
    this.match.ticker(`${this.name} 晋升了 ${this.data.chess(goldenId)?.name || ''}`, { type: 'MERGE', playerId: this.playerId });
    this.queuePromotionReward();
    this.match.meta.emit(this, 'onMerge', { piece: elite, source });
    return elite;
  }

  /** Placeable summons of an operator: one token piece each (tokens.json placeable, owners include the chess). */
  _addTokensFor(piece) {
    const rec = this.data.chess(piece.id);
    for (const tid of Array.isArray(rec?.tokens) ? rec.tokens : []) {
      const t = this.data.token(tid);
      if (!t || t.placeable !== true) continue;
      const exists = this.allPieces().some((e) => e.piece.kind === 'token' && e.piece.ownerUid === piece.uid && e.piece.id === tid);
      if (exists) continue;
      this.stow({ uid: this.nextUid(), kind: 'token', id: tid, ownerUid: piece.uid, count: Number.isInteger(t.count) ? t.count : 1 });
    }
  }

  _removeTokensOf(ownerUid) {
    for (const e of this.allPieces()) if (e.piece.kind === 'token' && e.piece.ownerUid === ownerUid) this.detach(e.piece.uid);
  }

  /** Gain an item: merges into the golden item when it completes a pair, otherwise into the hand / temp. */
  gainItem(id, { source = 'shop', silent = false } = {}) {
    const rec = this.data.item(id);
    if (!rec) return null;
    const priv = this.privateView();
    const n = this.data.economy.itemMergeCount ?? 2;
    if (completesMerge(priv, { kind: 'item', id }, { getItem: (x) => this.data.item(x), itemMergeCount: n })) {
      return this._mergeItem(id);
    }
    const piece = { uid: this.nextUid(), kind: 'item', id };
    if (!this.stow(piece)) {
      if (!silent) this.match.toast(this.playerId, '整备区已满，未能获得装备', 'warn');
      return null;
    }
    this.match.meta.emit(this, 'onGain', { kind: 'item', piece, source });
    return piece;
  }

  _mergeItem(id, extraUid = null) {
    const rec = this.data.item(id);
    const goldenId = rec.upgradeChessId || rec.goldenId;
    const need = Number.isInteger(rec.upgradeNum) ? rec.upgradeNum : (this.data.economy.itemMergeCount ?? 2);
    // copies: loose ones first, then equipped ones
    const loose = this.allPieces().filter((e) => e.piece.kind === 'item' && e.piece.id === id && e.piece.uid !== extraUid);
    const worn = [];
    for (const e of this.allPieces()) if (e.piece.kind === 'chess') for (const it of e.piece.items || []) if (it.id === id && it.uid !== extraUid) worn.push({ it, holder: e.piece });
    let left = need - 1;
    let holder = null;
    for (const w of worn) { if (left <= 0) break; holder = holder || w.holder; this.detach(w.it.uid); left--; }
    for (const e of loose) { if (left <= 0) break; this.detach(e.piece.uid); left--; }
    if (extraUid != null) this.detach(extraUid);
    const golden = { uid: this.nextUid(), kind: 'item', id: goldenId };
    // a merged item stays where an equipped copy was (on its carrier), else goes to the hand
    if (holder && (holder.items || []).length < (this.data.economy.equipPerChess ?? 2) && itemAttaches(this.data.item(goldenId))) {
      holder.items.push({ uid: golden.uid, id: goldenId });
      this.touch();
    } else if (!this.stow(golden)) {
      return null;
    }
    this.match.meta.emit(this, 'onGain', { kind: 'item', piece: golden, source: 'merge' });
    this.touch();
    return golden;
  }

  // ---- reward offers -------------------------------------------------------------------------------------------------

  /** 晋升奖励 (research 00 §3): 3 free operators of tier min(level + 1, 6). */
  queuePromotionReward() {
    const ro = this.data.economy.rewardOffer || {};
    const count = ro.count ?? 3;
    const tier = Math.min(ro.maxTier ?? 6, this.shop.level + (ro.tierOffset ?? 1));
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = this.match.pool.take(this.match.rng, { minTier: tier, maxTier: tier }) || this.match.pool.take(this.match.rng, { maxTier: tier });
      if (id) ids.push(id);
    }
    if (ids.length) this.offerChess(ids, { source: 'merge', tier, fromPool: true });
  }

  /**
   * Queue a free pick-one offer. Chess ids drawn from the pool (`fromPool`) give back the copies not picked.
   * @param {string[]|null} ids @param {{ source?: string, label?: string|null, tier?: number|null, fromPool?: boolean }} o
   */
  offerChess(ids, { source = 'special', label = null, tier = null, fromPool = false } = {}) {
    let list = Array.isArray(ids) ? ids.filter((x) => this.data.chess(x)) : [];
    if (!list.length && tier) {
      const n = (this.data.economy.rewardOffer || {}).count ?? 3;
      for (let i = 0; i < n; i++) { const id = this.match.pool.take(this.match.rng, { minTier: tier, maxTier: tier }); if (id) list.push(id); }
      fromPool = true;
    }
    if (!list.length) return;
    const slots = list.map((id) => ({ kind: 'chess', id, price: 0, basePrice: this.data.chessPrice(id), sold: false }));
    this.shop.offers.push({ source, label, tier, slots, fromPool, round: this.match.round });
    this.touch();
  }

  offerItems(ids, { source = 'special', label = null } = {}) {
    const list = (Array.isArray(ids) ? ids : []).filter((x) => this.data.item(x));
    if (!list.length) return;
    const slots = list.map((id) => ({ kind: 'item', id, price: 0, basePrice: this.data.item(id)?.price ?? 1, sold: false }));
    this.shop.offers.push({ source, label, slots, fromPool: false, round: this.match.round });
    this.touch();
  }

  /** Drop an offer, giving back the copies of the operators not taken. */
  _closeOffer(offer) {
    if (offer.fromPool) for (const s of offer.slots) if (s.kind === 'chess' && !s.sold) this.match.pool.giveBack(s.id, 1);
    this.shop.offers = this.shop.offers.filter((o) => o !== offer);
    this.touch();
  }

  expireOffers() {
    for (const o of [...this.shop.offers]) this._closeOffer(o);
  }

  // ---- intents (g.*) -----------------------------------------------------------------------------------------------

  buy(idx) {
    const s = this.shop.slots[idx];
    if (!s) throw new ServerError(ERR.BAD_TARGET, '无效的目标');
    if (s.sold) throw new ServerError(ERR.SOLD_OUT, '已售出');
    if (s.price > this.funds) throw new ServerError(ERR.NO_FUNDS, '资金不足');
    const priv = this.privateView();
    const lookups = { getChess: (x) => this.data.chess(x), getItem: (x) => this.data.item(x), itemMergeCount: this.data.economy.itemMergeCount ?? 2 };
    if (handFull(priv) && this.temp.every(Boolean) && !completesMerge(priv, s, lookups)) throw new ServerError(ERR.HAND_FULL, '整备区已满');
    if (handFull(priv) && !completesMerge(priv, s, lookups)) throw new ServerError(ERR.HAND_FULL, '整备区已满');
    this.spend(s.price, 'buy');
    s.sold = true;
    this.roundStats.buys += 1;
    let got;
    if (s.kind === 'item') {
      const golden = this.match.meta.consumeBuiltin(this, 'effect:builtin_next_buy_golden_item');
      const rec = this.data.item(s.id);
      got = this.gainItem(golden && rec?.goldenId && this.data.item(rec.goldenId) ? rec.goldenId : s.id, { source: 'shop' });
    } else {
      const elite = this.match.meta.consumeBuiltin(this, 'effect:builtin_next_buy_elite');
      if (elite) {
        // 升华: the purchased operator arrives as its elite (its copy stays out of the pool)
        got = this.gainChess(s.id, { golden: true, source: 'shop' });
      } else {
        got = this.gainChess(s.id, { source: 'shop' });
      }
    }
    this.match.meta.emit(this, 'onBuy', { slot: s, idx, piece: got, price: s.price });
    this.touch();
    return {};
  }

  reward(idx) {
    const offer = this.shop.offers[0];
    if (!offer) throw new ServerError(ERR.BAD_TARGET, '当前没有可选择的奖励');
    const s = offer.slots[idx];
    if (!s || s.sold) throw new ServerError(ERR.BAD_TARGET, '无效的目标');
    const priv = this.privateView();
    const lookups = { getChess: (x) => this.data.chess(x), getItem: (x) => this.data.item(x), itemMergeCount: this.data.economy.itemMergeCount ?? 2 };
    if (handFull(priv) && !completesMerge(priv, s, lookups) && this.temp.every(Boolean)) throw new ServerError(ERR.HAND_FULL, '整备区已满');
    s.sold = true;
    if (s.kind === 'item') this.gainItem(s.id, { source: 'reward' });
    else {
      if (!offer.fromPool) this.match.pool.takeId(s.id);
      this.gainChess(s.id, { source: 'reward' });
    }
    this._closeOffer(offer);
    return {};
  }

  refresh({ manual = true } = {}) {
    const price = this.refreshPrice();
    if (price > this.funds) throw new ServerError(ERR.NO_FUNDS, '资金不足');
    if (this.shop.freeRefreshes > 0) this.shop.freeRefreshes -= 1;
    else this.spend(price, 'refresh');
    this.shop.frozen = false;
    this.rollShop();
    if (manual) {
      this.roundStats.refreshes += 1;
      this.stats.refreshes += 1;
      this.match.meta.emit(this, 'onRefresh', { manual: true });
    }
    this.touch();
    return {};
  }

  freeze() {
    this.shop.frozen = !this.shop.frozen;
    this.touch();
    return {};
  }

  levelUp() {
    if (this.shop.level >= this.maxShopLevel()) throw new ServerError(ERR.MAX_LEVEL, '调度中心已达最高等级');
    const price = this.upgradePrice();
    if (price > this.funds) throw new ServerError(ERR.NO_FUNDS, '资金不足');
    this.spend(price, 'levelUp');
    this.shop.level += 1;
    this.topUpShop();
    this.match.meta.emit(this, 'onLevelUp', { level: this.shop.level });
    this.touch();
    return {};
  }

  sell(uid) {
    const e = this.find(uid);
    if (!e) throw new ServerError(ERR.BAD_TARGET, '找不到该单位');
    const p = e.piece;
    if (e.area === 'equipped') throw new ServerError(ERR.BAD_TARGET, '装备无法出售');
    if (p.kind === 'item') throw new ServerError(ERR.BAD_TARGET, '装备无法出售');
    if (p.kind === 'token') throw new ServerError(ERR.BAD_TARGET, '召唤物无法出售');
    const price = this.data.chessSellPrice(p.id);
    this._removeTokensOf(p.uid);
    this.detach(uid);
    for (const it of p.items || []) this.stow({ uid: it.uid, kind: 'item', id: it.id });
    this.match.pool.giveBack(p.id, this.match.pool.copiesOf(p.id));
    this.roundStats.sells += 1;
    const ev = this.match.meta.sold(this, p, e.area, { piece: { ...p, area: e.area }, gain: price, kind: 'chess' });
    this.addFunds(Math.max(0, Math.trunc(Number(ev?.gain ?? price) || 0)));
    delete this.pieceCounters[uid];
    this.touch();
    return {};
  }

  destroy(uid) {
    const e = this.find(uid);
    if (!e) throw new ServerError(ERR.BAD_TARGET, '找不到该单位');
    if (e.area === 'equipped') throw new ServerError(ERR.BAD_TARGET, '已装备的道具无法销毁');
    if (e.piece.kind !== 'item') throw new ServerError(ERR.BAD_TARGET, '只能销毁道具');
    this.detach(uid);
    const refund = this.data.economy.itemDestroyRefund ?? 0;
    if (refund) this.addFunds(refund);
    this.match.meta.destroyed(this, e.piece, 'player');
    this.touch();
    return {};
  }

  /** g.move { uid, to, dir }: the client's placement rules decide; the action is applied here. */
  move(uid, to, dir) {
    const ctx = this.placement();
    const target = to.area === 'hand' ? { area: 'hand', idx: to.idx } : to.area === 'board' ? { area: 'board', row: to.row, col: to.col } : to;
    const res = canPlace(ctx, uid, target);
    if (!res.ok) throw new ServerError(res.code || ERR.BAD_TILE, res.reason || '无法部署在该位置');
    const src = ctx.pieces.get(uid);
    const piece = this.find(uid).piece;
    const d = DIRS.includes(dir) ? dir : null;
    if (res.action === 'orient') { piece.dir = d || piece.dir || 'RIGHT'; this.touch(); return {}; }
    if (res.action === 'equip') {
      const occ = target.area === 'hand' ? this.hand[target.idx] : this.board.find((p) => p.row === target.row && p.col === target.col);
      return this.equip(uid, occ.uid, null);
    }
    if (res.action === 'art') return this.art(uid, target.row, target.col, d);
    if (target.area === 'board') {
      const occ = this.board.find((p) => p.row === target.row && p.col === target.col) || null;
      const fromBoard = src.area === 'board';
      const [sr, sc] = [piece.row, piece.col];
      const srcArea = src.area;
      const srcIdx = src.idx;
      this.detach(uid);
      if (occ) {
        this.detach(occ.uid);
        if (fromBoard) {
          if (occ.kind === 'token' && occ.ownerUid === piece.uid) this.stow(stripPos(occ));
          else { occ.row = sr; occ.col = sc; this.board.push(occ); }
        } else {
          this._returnToBench(stripPos(occ), srcArea, srcIdx);
          if (occ.kind === 'chess') this._recallTokens(occ.uid);
        }
      }
      piece.row = target.row; piece.col = target.col;
      piece.dir = d || (fromBoard ? piece.dir : 'RIGHT') || 'RIGHT';
      this.board.push(piece);
      if (fromBoard && piece.kind === 'chess') this._recallTokens(piece.uid);
      this.touch();
      return {};
    }
    // → hand slot
    const idx = target.idx;
    const occ = this.hand[idx];
    const fromBoard = src.area === 'board';
    const [sr, sc] = [piece.row, piece.col];
    const srcArea = src.area;
    const srcIdx = src.idx;
    this.detach(uid);
    const bare = stripPos(piece);
    if (!occ) {
      this.hand[idx] = bare;
    } else if (fromBoard && piece.kind === 'chess' && occ.kind === 'chess') {
      this.hand[idx] = null;
      occ.row = sr; occ.col = sc; occ.dir = 'RIGHT';
      this.board.push(occ);
      this.hand[idx] = bare;
    } else if (fromBoard) {
      // withdrawn into any free slot
      if (!this.stow(bare)) { piece.row = sr; piece.col = sc; this.board.push(piece); throw new ServerError(ERR.HAND_FULL, '整备区已满'); }
    } else {
      this.hand[idx] = bare;
      this._returnToBench(occ, srcArea, srcIdx);
    }
    if (fromBoard && piece.kind === 'chess') this._recallTokens(piece.uid);
    this.touch();
    return {};
  }

  /** A swapped-out piece goes where the mover came from (hand slot / temp slot), else any free slot. */
  _returnToBench(piece, area, idx) {
    if (area === 'hand' && Number.isInteger(idx) && !this.hand[idx]) { this.hand[idx] = piece; return; }
    if (area === 'temp' && Number.isInteger(idx) && !this.temp[idx]) { this.temp[idx] = piece; return; }
    this.stow(piece);
  }

  /** An operator left the board: its deployed summons return to the hand. */
  _recallTokens(ownerUid) {
    if (this.board.some((p) => p.uid === ownerUid)) return;
    for (const t of this.board.filter((p) => p.kind === 'token' && p.ownerUid === ownerUid)) {
      this.detach(t.uid);
      this.stow(stripPos(t));
    }
  }

  /** g.equip { itemUid, targetUid, replaceUid? } */
  equip(itemUid, targetUid, replaceUid) {
    const ie = this.find(itemUid);
    const te = this.find(targetUid);
    if (!ie || ie.piece.kind !== 'item' || ie.area === 'equipped') throw new ServerError(ERR.BAD_TARGET, '无效的目标');
    if (!te || te.piece.kind !== 'chess') throw new ServerError(ERR.BAD_TARGET, '装备只能配发给干员');
    const item = ie.piece;
    const rec = this.data.item(item.id);
    if (rec?.itemType === 'MAGIC') throw new ServerError(ERR.BAD_TARGET, '该道具需要放置在战场上使用');
    const holder = te.piece;
    // a pair completes a merge: merged instead of equipped
    const ctx = this.placement();
    if (equipMerges(ctx, itemUid, this.data.economy.itemMergeCount ?? 2)) {
      this._mergeItem(item.id, itemUid);
      return {};
    }
    if (!itemAttaches(rec)) {
      // consumed on equip (the effect is the item's meta handler)
      this.detach(itemUid);
      this.match.meta.equipped(this, item, holder, { consumed: true });
      this.touch();
      return {};
    }
    const per = this.data.economy.equipPerChess ?? 2;
    if ((holder.items || []).length >= per) {
      const ri = Number.isInteger(replaceUid) ? holder.items.findIndex((x) => x.uid === replaceUid) : 0;
      if (ri < 0) throw new ServerError(ERR.BAD_TARGET, '无效的目标');
      const [old] = holder.items.splice(ri, 1);
      this.match.meta.destroyed(this, { uid: old.uid, kind: 'item', id: old.id }, 'replace');
    }
    this.detach(itemUid);
    holder.items.push({ uid: item.uid, id: item.id });
    this.touch();
    this.match.meta.equipped(this, item, holder, { consumed: false });
    this.touch();
    return {};
  }

  /** Equip without the shop rules (meta equipDirect). */
  equipDirect(itemUid, holderUid) {
    const ie = this.find(itemUid);
    const he = this.find(holderUid);
    if (!ie || !he || he.piece.kind !== 'chess' || ie.area === 'equipped') return false;
    if ((he.piece.items || []).length >= (this.data.economy.equipPerChess ?? 2)) return false;
    this.detach(itemUid);
    he.piece.items.push({ uid: ie.piece.uid, id: ie.piece.id });
    this.touch();
    this.touch();
    return true;
  }

  /** g.art { itemUid, row, col, dir }: an Arts (MAGIC) item used on a board tile. */
  art(itemUid, row, col, dir) {
    const ie = this.find(itemUid);
    if (!ie || ie.piece.kind !== 'item' || ie.area === 'equipped') throw new ServerError(ERR.BAD_TARGET, '无效的目标');
    const rec = this.data.item(ie.piece.id);
    if (rec?.itemType !== 'MAGIC') throw new ServerError(ERR.BAD_TARGET, '请将装备拖拽至干员身上');
    const max = this.data.economy.maxArtsPerRound ?? 2;
    if (this.artsThisRound >= max) throw new ServerError(ERR.ALREADY, `每回合最多使用${max}次画卷类道具`);
    const d = DIRS.includes(dir) ? dir : 'RIGHT';
    const grid = Array.isArray(rec.rangeGrid) && rec.rangeGrid.length ? rec.rangeGrid : [[0, 0]];
    const tiles = rangeTiles(grid, row, col, d);
    const targets = tiles.map(([r, c]) => this.board.find((p) => p.row === r && p.col === c)).filter(Boolean);
    const ev = { item: ie.piece, row, col, dir: d, tiles, targets: targets.map(clonePiece), error: null };
    this.match.meta.emit(this, 'onArt', ev, { item: ie.piece });
    if (ev.error) throw new ServerError(ev.error, ev.detail || '无效的目标');
    this.detach(itemUid);
    this.artsThisRound += 1;
    this.roundStats.arts += 1;
    this.touch();
    return {};
  }

  // ---- bonds -------------------------------------------------------------------------------------------------------

  bondEntries() {
    if (!this._bondsCache) this._bondsCache = computeBonds(this.match, this);
    return this._bondsCache;
  }

  /** Bond state map for the battle spec: { bondId: { count, active, tier, layers } }. */
  battleBonds() {
    const out = {};
    for (const b of this.bondEntries()) out[b.bondId] = { count: b.count, active: !!b.active, tier: b.tier, layers: b.layers };
    for (const [id, n] of Object.entries(this.layers)) if (!out[id] && n > 0) out[id] = { count: 0, active: false, tier: 0, layers: n };
    return out;
  }

  bondActive(id) { return this.bondEntries().some((b) => b.bondId === id && b.active); }

  bondCount(id) { return this.bondEntries().find((b) => b.bondId === id)?.count ?? 0; }

  /** Add bond layers (≤ BOND_LAYER_CAP); `requireActive`: only an active bond gains. Returns the layers added. */
  addLayers(bondId, n, { requireActive = false } = {}) {
    if (!this.data.bond(bondId) || !(n > 0)) return 0;
    if (requireActive && !this.bondActive(bondId)) return 0;
    const before = this.layers[bondId] || 0;
    const add = Math.max(0, Math.min(n, 999 - before));
    if (!add) return 0;
    this.layers[bondId] = before + add;
    this.match.meta.layersAdded(this, bondId, add, before);
    this.touch();
    return add;
  }
}

export function freshRoundStats() {
  return { refreshes: 0, buys: 0, sells: 0, spent: 0, gainedChess: 0, arts: 0 };
}

function clonePiece(p) {
  const o = { ...p };
  if (Array.isArray(p.items)) o.items = p.items.map((it) => ({ ...it }));
  return o;
}

function stripPos(p) {
  const o = { ...p };
  delete o.row;
  delete o.col;
  if (o.kind === 'chess') o.dir = 'RIGHT';
  return o;
}

function effectView(e) {
  return {
    id: e.id, key: e.key ?? null, name: e.name ?? '', desc: e.desc ?? '', iconKind: e.iconKind ?? null, iconId: e.iconId ?? null,
    counter: Number.isFinite(e.counter) ? e.counter : null, counterText: e.counterText ?? null, params: e.params ?? null,
  };
}

export { isObj, clonePiece };
