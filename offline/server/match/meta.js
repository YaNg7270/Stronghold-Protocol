// Meta host — the prep-side effect dispatcher of the match (the online server's server/match/effectsMeta.js, rebuilt
// from the contract the served content modules use: sim/content/*/meta.js, sim/content/choices.js, docs/META.md as
// those modules describe it).
//
// Registry (one handler object per key; a handler is { onRoundStart?, onPrepStart?, onPrepEnd?, onRefresh?, onBuy?,
// onSold?, onPrice?, onSpend?, onIncome?, onLevelUp?, onGain?, onMerge?, onEquip?, onArt?, onDestroy?, onLayers?,
// onBattleStart?, onChoicePick?, run? }):
//   global:<name>      every player, first in every dispatch
//   band:<bandId>      the player's strategy
//   bond:<bondId>      every bond the player has members or layers in (handlers check `active` themselves)
//   item:<key>         every EQUIPPED item (key = id without _a/_b); ctx.source = { kind: 'item', piece, holder }
//   effect refs        player.effects entries with a `key` naming a handler (choice:<id>, effect:<builtin>);
//                      ctx.source = { kind: 'effect', ref }
//   garrison:<key>     特质 of owned chess, by the garrison's eventType: SERVER_PREP_START (onRoundStart), SERVER_PREP_FIN
//                      (onPrepEnd), SERVER_REFRESH_SHOP (onRefresh), SERVER_GAIN (the gained piece), SERVER_CHESS_SOLD
//                      (the sold piece), SERVER_PRICE (the priced shop chess). conditionkey character_target_inboard →
//                      board pieces only, otherwise board and hand (where: 'board' | 'hand'). SERVER_GAIN repeats ×2 while
//                      投资人 is active (×3 from its 100-layer milestone, bond_layer_char_garrison_bonus).
//   choice:<id>        a 机变 card's pick (onChoicePick) and its effect ref's own hooks
// Built-ins (registered first; the content modules wrap some of them): the consume-on-equip items, 博士投影, 商业包装方案,
// 突变细胞, the Arts' bounty fallback, and the effect refs 升华 / 整备 / 精打细算玩偶 / 博士投影.

import { itemKeyOf } from '../../../sim/content/support/index.js';
import { metaBonds } from '../../../sim/content/support/meta.js';
import { BOND_LAYER_CAP } from '../../../shared/constants.js';
import { isShopItem } from '../../../sim/simdata.js';
import { rollShopItem, idList } from './pool.js';

const isObj = (v) => !!v && typeof v === 'object';
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d);
const int = (v, d = 0) => Math.trunc(num(v, d));
const MAX_DEPTH = 8;

const GARRISON_EVENT = Object.freeze({
  onRoundStart: 'SERVER_PREP_START',
  onPrepEnd: 'SERVER_PREP_FIN',
  onRefresh: 'SERVER_REFRESH_SHOP',
});

export class Registry {
  constructor() { this.map = new Map(); this.globals = []; }
  _set(key, h) { if (isObj(h)) this.map.set(key, h); }
  band(id, h) { this._set(`band:${id}`, h); }
  bond(id, h) { this._set(`bond:${id}`, h); }
  item(key, h) { this._set(`item:${itemKeyOf(key)}`, h); }
  garrison(key, h) { this._set(`garrison:${key}`, h); }
  choice(id, h) { this._set(`choice:${id}`, h); }
  effect(key, h) { this._set(key.startsWith('effect:') ? key : `effect:${key}`, h); }
  global(name, h) {
    if (!isObj(h)) return;
    const key = `global:${name}`;
    if (!this.map.has(key)) this.globals.push(key);
    this.map.set(key, h);
  }
  get(key) { return this.map.get(key) || null; }
}

export class MetaHost {
  constructor(match) {
    this.match = match;
    this.data = match.data;
    this.registry = new Registry();
    this.depth = 0;
    registerBuiltins(this.registry, this);
    const content = match.sim?.content;
    if (content && typeof content.registerAllMeta === 'function') {
      try { content.registerAllMeta(this.registry); } catch (err) { match.log.warn('registerAllMeta failed', err); }
    }
    this.gd = makeGd(this.data, match);
  }

  // ---- dispatch ----------------------------------------------------------------------------------------------------

  /** The handlers a hook reaches for a player, in order: [{ handler, source }]. */
  _targets(player) {
    const out = [];
    const r = this.registry;
    for (const key of r.globals) out.push({ handler: r.get(key), source: { kind: 'global', key } });
    if (player.bandId) { const h = r.get(`band:${player.bandId}`); if (h) out.push({ handler: h, source: { kind: 'band', bandId: player.bandId } }); }
    const bonds = new Set(player.bondEntries().map((b) => b.bondId));
    for (const id of Object.keys(player.layers)) bonds.add(id);
    for (const id of bonds) { const h = r.get(`bond:${id}`); if (h) out.push({ handler: h, source: { kind: 'bond', bondId: id } }); }
    for (const e of player.allPieces()) {
      if (e.piece.kind !== 'chess') continue;
      for (const it of e.piece.items || []) {
        const h = r.get(`item:${itemKeyOf(it.id)}`);
        if (h) out.push({ handler: h, source: { kind: 'item', piece: { uid: it.uid, kind: 'item', id: it.id }, holder: viewOf(e.piece, e.area), area: e.area } });
      }
    }
    for (const ref of player.effects) {
      if (!ref.key) continue;
      const h = r.get(ref.key);
      if (h) out.push({ handler: h, source: { kind: 'effect', ref } });
    }
    return out;
  }

  /** Call `hook` on every handler of the player (plus the garrisons the hook maps to). */
  emit(player, hook, ev = {}, extra = null) {
    if (!player || !player.alive) return ev;
    if (this.depth >= MAX_DEPTH) return ev;
    this.depth++;
    try {
      for (const { handler, source } of this._targets(player)) {
        const fn = handler[hook];
        if (typeof fn !== 'function') continue;
        this._call(player, handler, fn, { ...source, ...(extra || {}) }, ev, hook);
      }
      const event = GARRISON_EVENT[hook];
      if (event) this._garrisonsOnEvent(player, event, hook, ev);
    } finally {
      this.depth--;
    }
    return ev;
  }

  _call(player, handler, fn, source, ev, label) {
    const ctx = this.ctx(player, source);
    try { fn.call(handler, ctx, ev); } catch (err) { this.match.log.warn(`meta ${label} failed`, err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : err); }
    return ctx;
  }

  // ---- garrisons -----------------------------------------------------------------------------------------------------

  garrisonsOfPiece(piece) {
    const rec = this.data.chess(piece.id);
    return (Array.isArray(rec?.garrisonIds) ? rec.garrisonIds : []).map((gid) => this.data.garrison(gid)).filter(Boolean);
  }

  /** Run one garrison record of a piece. `hook`: the handler's specific hook, else `run`. Returns 1 when it ran. */
  _runGarrison(player, piece, g, where, hook, ev, asPiece = null) {
    const h = this.registry.get(`garrison:${g.effectKey}`);
    if (!h) return 0;
    const fn = (hook && typeof h[hook] === 'function') ? h[hook] : typeof h.run === 'function' ? h.run : null;
    if (!fn) return 0;
    const self = asPiece || piece;
    const source = { kind: 'garrison', piece: viewOf(self, where), garrisonId: g.garrisonId, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where };
    this._call(player, h, fn, source, ev || {}, `garrison ${g.effectKey}`);
    return 1;
  }

  /** Every owned piece's garrisons of `event` (board, and hand unless board-only). */
  _garrisonsOnEvent(player, event, hook, ev) {
    const list = [];
    for (const p of player.board) if (p.kind === 'chess') list.push([p, 'board']);
    for (const p of player.hand) if (p && p.kind === 'chess') list.push([p, 'hand']);
    for (const [piece, where] of list) {
      for (const g of this.garrisonsOfPiece(piece)) {
        if (g.eventType !== event) continue;
        if (where === 'hand' && g.bbStr?.conditionkey === 'character_target_inboard') continue;
        this._runGarrison(player, piece, g, where, hook === 'onRefresh' ? 'onRefresh' : null, ev);
      }
    }
  }

  /** 投资人 repeat of SERVER_GAIN garrisons. */
  investRepeat(player) {
    const b = player.bondEntries().find((x) => x.bondId === 'investShip');
    if (!b || !b.active) return 1;
    const ms = (this.data.bond('investShip')?.layerMilestones || []).find((m) => m.effect === 'bond_layer_char_garrison_bonus');
    return ms && b.layers >= (ms.layer || 100) ? 3 : 2;
  }

  /** ctx.triggerGarrisons: run a piece's garrisons of `event` once more (as `asUid`'s own when given). */
  triggerGarrisons(player, uid, event, { asUid = null } = {}) {
    const e = player.find(uid);
    if (!e || e.piece.kind !== 'chess' || this.depth >= MAX_DEPTH) return 0;
    const as = asUid != null ? player.find(asUid) : null;
    const where = (as || e).area === 'board' ? 'board' : 'hand';
    const reps = event === 'SERVER_GAIN' ? this.investRepeat(player) : 1;
    let n = 0;
    this.depth++;
    try {
      for (const g of this.garrisonsOfPiece(e.piece)) {
        if (g.eventType !== event) continue;
        for (let k = 0; k < reps; k++) n += this._runGarrison(player, e.piece, g, where, event === 'SERVER_REFRESH_SHOP' ? 'onRefresh' : null, { trigger: true }, as ? as.piece : null);
      }
    } finally { this.depth--; }
    return n;
  }

  // ---- match entry points ------------------------------------------------------------------------------------------

  /** Shop price after the SERVER_PRICE garrisons of the priced chess and every onPrice modifier. */
  price(player, ev) {
    const pev = { ...ev, price: num(ev.price, 0) };
    if (ev.kind === 'chess') {
      for (const g of this.garrisonsOfPiece({ id: ev.id })) {
        if (g.eventType !== 'SERVER_PRICE') continue;
        const h = this.registry.get(`garrison:${g.effectKey}`);
        if (h && typeof h.onPrice === 'function') {
          const source = { kind: 'garrison', piece: { uid: 0, kind: 'chess', id: ev.id }, garrisonId: g.garrisonId, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where: 'shop' };
          const prev = this._pricingEv;
          this._pricingEv = pev;
          try { this._call(player, h, h.onPrice, source, pev, 'garrison price'); } finally { this._pricingEv = prev; }
        }
      }
    }
    const prev = this._pricingEv;
    this._pricingEv = pev;
    try { this.emit(player, 'onPrice', pev); } finally { this._pricingEv = prev; }
    return Math.max(0, Math.trunc(pev.price));
  }

  /** A piece was gained: onGain + its SERVER_GAIN garrisons (×投资人). */
  gained(player, piece, source) {
    if (!piece) return;
    if (piece.kind === 'chess') {
      const reps = this.investRepeat(player);
      const e = player.find(piece.uid);
      const where = e?.area === 'board' ? 'board' : 'hand';
      this.depth++;
      try {
        for (const g of this.garrisonsOfPiece(piece)) {
          if (g.eventType !== 'SERVER_GAIN') continue;
          for (let k = 0; k < reps; k++) this._runGarrison(player, piece, g, where, null, { source });
        }
      } finally { this.depth--; }
    }
    this.emit(player, 'onGain', { kind: piece.kind, piece: viewOf(piece), source });
  }

  /** A piece was sold (already removed): its SERVER_CHESS_SOLD garrisons, then onSold (ev.gain may be changed). */
  sold(player, piece, area, ev) {
    this.depth++;
    try {
      for (const g of this.garrisonsOfPiece(piece)) {
        if (g.eventType !== 'SERVER_CHESS_SOLD') continue;
        const h = this.registry.get(`garrison:${g.effectKey}`);
        if (!h) continue;
        const fn = typeof h.onSold === 'function' ? h.onSold : typeof h.run === 'function' ? h.run : null;
        if (!fn) continue;
        const source = { kind: 'garrison', piece: viewOf(piece, area), garrisonId: g.garrisonId, garrison: g, bb: g.bb || {}, bbStr: g.bbStr || {}, where: area };
        this._call(player, h, fn, source, ev, `garrison sold ${g.effectKey}`);
      }
    } finally { this.depth--; }
    this.emit(player, 'onSold', ev);
    return ev;
  }

  /** An item was equipped (`consumed`: a consume-on-equip item, gone already). */
  equipped(player, item, holder, { consumed }) {
    const h = this.registry.get(`item:${itemKeyOf(item.id)}`);
    const ev = { item: { uid: item.uid, kind: 'item', id: item.id }, target: viewOf(holder), consumed };
    if (h && typeof h.onEquip === 'function') {
      this._call(player, h, h.onEquip, { kind: 'item', piece: ev.item, holder: viewOf(holder) }, ev, `item equip ${item.id}`);
    }
    // the other handlers (bands / bonds) see the equip too, without the item's own handler a second time
    this.depth++;
    try {
      for (const { handler, source } of this._targets(player)) {
        if (handler === h || typeof handler.onEquip !== 'function') continue;
        this._call(player, handler, handler.onEquip, source, ev, 'onEquip');
      }
    } finally { this.depth--; }
  }

  /** An Arts item is used (g.art): its own handler, then everyone's onArt. `ev.error` refuses the use. */
  art(player, item, ev) {
    const h = this.registry.get(`item:${itemKeyOf(item.id)}`);
    if (h && typeof h.onArt === 'function') this._call(player, h, h.onArt, { kind: 'item', piece: { uid: item.uid, kind: 'item', id: item.id }, holder: null }, ev, `item art ${item.id}`);
    if (ev.error) return ev;
    this.depth++;
    try {
      for (const { handler, source } of this._targets(player)) {
        if (handler === h || typeof handler.onArt !== 'function') continue;
        this._call(player, handler, handler.onArt, source, ev, 'onArt');
      }
    } finally { this.depth--; }
    return ev;
  }

  /** A loose item was destroyed (reason 'player' | 'replace'): its own handler, then everyone's onDestroy. */
  destroyed(player, item, reason) {
    const ev = { item: { uid: item.uid, kind: 'item', id: item.id }, reason };
    const h = this.registry.get(`item:${itemKeyOf(item.id)}`);
    if (h && typeof h.onDestroy === 'function') this._call(player, h, h.onDestroy, { kind: 'item', piece: ev.item, holder: null }, ev, `item destroy ${item.id}`);
    this.depth++;
    try {
      for (const { handler, source } of this._targets(player)) {
        if (handler === h || typeof handler.onDestroy !== 'function') continue;
        this._call(player, handler, handler.onDestroy, source, ev, 'onDestroy');
      }
    } finally { this.depth--; }
  }

  layersAdded(player, bondId, n, before) { this.emit(player, 'onLayers', { bondId, n, before }); }

  roundStart(player) { this.emit(player, 'onRoundStart', {}); }

  prepStart(player) { this.emit(player, 'onPrepStart', {}); }

  prepEnd(player) { this.emit(player, 'onPrepEnd', {}); }

  battleStart(player, ev) { this.emit(player, 'onBattleStart', ev); }

  income(player, base) {
    const ev = this.emit(player, 'onIncome', { income: base });
    return Math.max(0, int(ev.income, base));
  }

  bandPicked(player) {
    const band = this.data.band(player.bandId);
    if (!band) return;
    player.effects = player.effects.filter((e) => e.iconKind !== 'band');
    player.effects.unshift({
      id: `band:${band.bandId}`, name: band.effectName || band.name, desc: band.desc || '', iconKind: 'band', iconId: band.iconId || band.bandId,
      battle: false, params: band.params || {}, data: { bandId: band.bandId },
    });
  }

  /** A 机变 card was picked: its handler's onChoicePick (items fall back to the item itself). */
  choicePick(player, card) {
    const h = this.registry.get(`choice:${card.id}`);
    if (h && typeof h.onChoicePick === 'function') {
      this._call(player, h, h.onChoicePick, { kind: 'choice', card }, { card, forTeammate: false }, `choice ${card.id}`);
      return;
    }
    if (card.kind === 'item' && this.data.item(card.id)) player.gainItem(card.id, { source: 'choice' });
  }

  /** After a battle: bounty payouts (perfect), post-battle transforms (突变细胞). */
  battleEnd(player, { result, perfect }) {
    for (const b of player.bounties) {
      if (b.payout === 'perfect' && perfect && b.coin > 0) {
        player.pendingFunds += b.coin;
        this.match.toast(player.playerId, `【${b.name}】完美作战，下回合获得${b.coin}资金`, 'success');
      }
    }
    // 突变细胞: the carrier becomes a random operator one tier higher; its equipment (the cell too) returns to the hand
    for (const p of [...player.board, ...player.hand.filter(Boolean)]) {
      if (p.kind !== 'chess' || !(p.items || []).some((it) => itemKeyOf(it.id) === 'chess_item_5_08_e')) continue;
      const tier = Math.min(6, (this.data.chess(p.id)?.tier || 1) + 1);
      player.detach(p.uid);
      player._removeTokensOf?.(p.uid);
      this.match.pool.giveBack(p.id, this.match.pool.copiesOf(p.id));
      for (const it of p.items || []) player.stow({ uid: it.uid, kind: 'item', id: it.id });
      const id = this.match.pool.take(this.match.rng, { minTier: tier, maxTier: tier });
      if (id) player.gainChess(id, { source: 'item' });
    }
    this.emit(player, 'onEnd', { result, perfect });
  }

  /** Consume one charge of a built-in effect ref (升华 / 整备): true when one was used. */
  consumeBuiltin(player, key) {
    const e = player.effects.find((x) => x.key === key && x.counter > 0);
    if (!e) return false;
    e.counter -= 1;
    if (e.counter <= 0) player.effects = player.effects.filter((x) => x !== e);
    player.touch();
    return true;
  }

  // ---- ctx -----------------------------------------------------------------------------------------------------------

  ctx(player, source) {
    const host = this;
    const m = this.match;
    const data = this.data;
    const ctx = {
      round: m.round,
      phase: m.phase,
      playerId: player.playerId,
      seat: player.seat,
      rng: m.rng,
      gd: this.gd,
      data: { choices: data.choiceData, bonds: data.bondMap, effects: data.effectMap, items: data.itemMap, chess: data.chessMap },
      source,
      // pieces
      board: () => player.board.map((p) => viewOf(p, 'board')),
      hand: () => player.hand.map((p) => (p ? viewOf(p, 'hand') : null)),
      temp: () => player.temp.map((p) => (p ? viewOf(p, 'temp') : null)),
      piece: (uid) => { const e = player.find(uid); return e && e.area !== 'equipped' ? viewOf(e.piece, e.area) : null; },
      chessRecord: (id) => data.chess(id),
      pieceBonds: (uid) => { const e = player.find(uid); return e ? metaBonds(ctx, viewOf(e.piece, e.area)) : []; },
      garrisonsOf: (uid) => { const e = player.find(uid); return e ? host.garrisonsOfPiece(e.piece) : []; },
      // bonds
      bonds: () => Object.fromEntries(player.bondEntries().map((b) => [b.bondId, { count: b.count, active: b.active, tier: b.tier, layers: b.layers }])),
      bond: (id) => { const b = player.bondEntries().find((x) => x.bondId === id); return b ? { count: b.count, active: b.active, tier: b.tier, layers: b.layers } : null; },
      bondActive: (id) => player.bondActive(id),
      bondCount: (id) => player.bondCount(id),
      layers: (id) => player.layers[id] || 0,
      addLayers: (id, n, o = {}) => player.addLayers(id, num(n, 0), { requireActive: !!o.requireActive }),
      // funds & shop
      funds: () => player.funds,
      addFunds: (n) => { player.addFunds(int(n, 0)); return player.funds; },
      addPendingFunds: (n) => { player.pendingFunds += Math.max(0, int(n, 0)); player.touch(); return player.pendingFunds; },
      shopLevel: () => player.shop.level,
      shopSlots: () => player.shop.slots.map((s) => (s ? { ...s } : null)),
      setShopSlot: (i, slot) => host._setShopSlot(player, i, slot),
      grantFreeRefresh: (n) => { player.shop.freeRefreshes += Math.max(0, int(n, 0)); player.touch(); return player.shop.freeRefreshes; },
      setPrice: (v) => { const ev = host._pricingEv; if (ev) ev.price = Math.max(0, num(v, ev.price)); },
      modifyPrice: (d) => { const ev = host._pricingEv; if (ev) ev.price = Math.max(0, ev.price + num(d, 0)); },
      // draws & grants
      rollChess: (o = {}) => host.rollChess(player, o),
      rollItem: (o = {}) => host.rollItem(player, o),
      rollPool: (poolId) => host.rollPool(player, poolId),
      grantChess: (id, o = {}) => { const p = player.gainChess(id, { fromPool: o.requirePool !== false, golden: !!o.golden, source: o.source || 'effect' }); return p ? viewOf(p) : null; },
      grantItem: (id, o = {}) => { const p = player.gainItem(id, { source: o.source || 'effect' }); return p ? viewOf(p) : null; },
      offerChess: (ids, o = {}) => player.offerChess(ids, { source: o.source || 'special', label: o.label || labelOf(source, data), tier: o.tier ?? null, fromPool: false }),
      offerItems: (ids, o = {}) => player.offerItems(ids, { source: o.source || 'special', label: o.label || labelOf(source, data) }),
      equipDirect: (itemUid, holderUid) => player.equipDirect(itemUid, holderUid),
      // counters & effects
      counter: (k) => num(player.counters[k], 0),
      setCounter: (k, v) => { player.counters[k] = v; return v; },
      incCounter: (k, n = 1) => { player.counters[k] = num(player.counters[k], 0) + num(n, 1); return player.counters[k]; },
      incPieceCounter: (uid, k, n = 1) => {
        const pc = (player.pieceCounters[uid] = player.pieceCounters[uid] || {});
        pc[k] = num(pc[k], 0) + n;
        return pc[k];
      },
      roundStats: () => player.roundStats,
      addEffect: (entry) => host._addEffect(player, entry),
      addBounty: (card) => host._addBounty(player, card),
      setDeviceActive: (alias, on) => { player.deviceOverrides[alias] = !!on; player.touch(); },
      triggerGarrisons: (uid, event, o = {}) => host.triggerGarrisons(player, uid, event, o),
      // players
      bandId: () => player.bandId,
      teammates: () => [],
      toast: (text, kind = 'info') => m.toast(player.playerId, text, kind),
    };
    return ctx;
  }

  // ---- helpers behind ctx ------------------------------------------------------------------------------------------

  _setShopSlot(player, i, slot) {
    const slots = player.shop.slots;
    if (!Number.isInteger(i) || i < 0 || i >= slots.length) return false;
    const old = slots[i];
    if (old && !old.sold && old.kind === 'chess' && !old.noPool) this.match.pool.giveBack(old.id, 1);
    if (!slot) { slots[i] = null; player.touch(); return true; }
    let s;
    if (slot.kind === 'item') s = player.itemSlot(slot.id);
    else {
      const taken = this.match.pool.takeId(slot.id);
      s = player.chessSlot(slot.id, taken ? {} : { noPool: true });
    }
    if (slot.frozen) s.frozen = true;
    slots[i] = s;
    player.touch();
    return true;
  }

  /** A pool operator id (copy-weighted, not taken): tier ≤ maxTier, of `bond`, passing `filter`. */
  rollChess(player, { maxTier = 6, minTier = 1, bond = null, filter = null, tier = null } = {}) {
    const pool = this.match.pool;
    const cand = [];
    let total = 0;
    for (const [id, n] of pool.counts) {
      if (n <= 0) continue;
      const t = this.data.tierOf(id);
      if (tier != null ? t !== tier : (t > maxTier || t < minTier)) continue;
      const rec = this.data.chess(id);
      if (bond && !(Array.isArray(rec?.bonds) && rec.bonds.includes(bond))) continue;
      if (filter && !filter(id)) continue;
      cand.push([id, n]);
      total += n;
    }
    if (!total) return null;
    let r = this.match.rng() * total;
    for (const [id, n] of cand) { r -= n; if (r < 0) return id; }
    return cand[cand.length - 1][0];
  }

  rollItem(player, { maxTier = null, tier = null, pool = null, minTier = 1 } = {}) {
    if (pool) { const r = this.rollPool(player, pool); if (r && r.kind === 'item') return r.id; }
    return rollShopItem(this.data, this.match.rng, { maxTier: maxTier ?? 6, minTier, tier });
  }

  /** choices.json pools: { kind: 'chess'|'item', id, golden? } or null. */
  rollPool(player, poolId) {
    const pool = this.data.choiceData?.pools?.[poolId];
    const rng = this.match.rng;
    if (!pool) return null;
    const kind = pool.kind === 'chess' ? 'chess' : 'item';
    if (Array.isArray(pool.weighted) && pool.weighted.length) {
      const pick = rng.weighted(pool.weighted.filter((x) => (kind === 'chess' ? this.data.chess(x[0]) : this.data.item(x[0]))), (x) => num(x[1], 0));
      return pick ? { kind, id: pick[0] } : null;
    }
    if (Array.isArray(pool.items) && pool.items.length) {
      const id = rng.pick(pool.items.filter((x) => (kind === 'chess' ? this.data.chess(x) : this.data.item(x))));
      return id ? { kind, id } : null;
    }
    const maxTier = pool.maxTier === 'shopLevel' ? player.shop.level : (Number.isInteger(pool.maxTier) ? pool.maxTier : 6);
    if (kind === 'item') {
      const tiers = Array.isArray(pool.tiers) ? pool.tiers : null;
      if (tiers) {
        const t = rng.pick(tiers);
        return { kind, id: rollShopItem(this.data, rng, { tier: t }) };
      }
      const id = rollShopItem(this.data, rng, { maxTier });
      return id ? { kind, id } : null;
    }
    const id = this.rollChess(player, { maxTier: pool.tier ?? maxTier, minTier: pool.minTier ?? pool.tier ?? 1, bond: pool.bond || null });
    return id ? { kind, id, golden: !!pool.golden } : null;
  }

  _addEffect(player, entry) {
    if (!isObj(entry) || !entry.id) return null;
    const cur = player.effects.find((e) => e.id === entry.id);
    if (cur) Object.assign(cur, entry, { params: { ...(cur.params || {}), ...(entry.params || {}) } });
    else player.effects.push({ battle: false, params: {}, data: {}, ...entry });
    player.touch();
    return entry.id;
  }

  _addBounty(player, card) {
    if (!isObj(card) || !this.data.enemy(card.enemyKey)) return false;
    const rounds = Math.max(1, int(card.rounds, 1));
    const b = {
      id: `bounty:${card.effectId || card.enemyKey}#${++this.match.uidSeq}`, effectId: card.effectId || null, name: card.name || '悬赏',
      enemyKey: card.enemyKey, count: Math.max(1, int(card.count, 1)), coin: Math.max(0, int(card.coin, 0)), payout: card.payout || 'kill',
      roundsLeft: rounds, tier: card.tier ?? 1,
    };
    player.bounties.push(b);
    this._addEffect(player, {
      id: b.id, name: b.name, desc: card.desc || '', iconKind: 'choice', iconId: card.effectId || 'bounty',
      counter: rounds >= 99 ? null : rounds, counterText: rounds >= 99 ? '之后的每场作战' : `还剩 ${rounds} 场作战`,
      battle: false, params: {}, data: { bounty: true, effectId: card.effectId },
    });
    return true;
  }
}

/** The shape content reads for a piece: { uid, kind, id, tier, golden, items, dir, area, row?, col?, ownerUid? }. */
function viewOf(p, area = null) {
  if (!p) return null;
  const v = { ...p, area: area ?? p.area ?? null };
  if (Array.isArray(p.items)) v.items = p.items.map((it) => ({ ...it }));
  return v;
}

function labelOf(source, data) {
  if (!source) return null;
  if (source.kind === 'band') return data.band(source.bandId)?.effectName || null;
  if (source.kind === 'item') return data.item(source.piece?.id)?.name || null;
  if (source.kind === 'garrison') return '特殊招募';
  return null;
}

function makeGd(data, match) {
  const inactiveEnemies = new Set(Array.isArray(match.mode?.inactiveEnemyKeys) ? match.mode.inactiveEnemyKeys : []);
  return {
    chess: (id) => data.chess(id),
    item: (id) => data.item(id),
    bond: (id) => data.bond(id),
    garrison: (id) => data.garrison(id),
    enemy: (id) => data.enemy(id),
    band: (id) => data.band(id),
    tierOf: (id) => data.tierOf(id),
    bondIds: Object.keys(data.bondMap),
    inactiveEnemies,
    rewardOffer: () => data.economy.rewardOffer || { count: 3 },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// built-ins

function buffP(data, itemId, key) {
  const rec = data.item(itemId);
  for (const b of rec && Array.isArray(rec.buffs) ? rec.buffs : []) if (b && b.key === key) return { ...(b.bb || {}), ...(b.bbStr || {}) };
  return {};
}

function registerBuiltins(r, host) {
  const data = host.data;
  // 盟约之币 / 骑士储蓄罐 — equip_destory_gain_random_coin {min, max}
  const coin = {
    onEquip(ctx, ev) {
      const p = buffP(data, ev.item.id, 'equip_destory_gain_random_coin');
      const lo = int(p.min, 1), hi = Math.max(lo, int(p.max, lo));
      const n = lo + ctx.rng.int(hi - lo + 1);
      ctx.addFunds(n);
      ctx.toast(`获得${n}资金`, 'success');
    },
  };
  r.item('chess_item_1_03_e', coin);
  r.item('chess_item_3_12_e', coin);

  // 随身身份牌 — use_equip_reward_char_chess_bond_layer {layer}: the carrier's bonds +layer (无需激活)
  r.item('chess_item_1_04_e', {
    onEquip(ctx, ev) {
      const n = int(buffP(data, ev.item.id, 'use_equip_reward_char_chess_bond_layer').layer, 3);
      for (const b of metaBonds(ctx, ev.target)) ctx.addLayers(b, n, { requireActive: false });
    },
  });

  // 紧急调度券 — use_equip_reward_random_char_chess_in_shop {count} (items/meta.js replaces it)
  r.item('chess_item_2_02_e', {
    onEquip(ctx, ev) {
      const n = Math.max(1, int(buffP(data, ev.item.id, 'use_equip_reward_random_char_chess_in_shop').count, 1));
      for (let k = 0; k < n; k++) {
        const slots = ctx.shopSlots();
        const idx = slots.map((s, i) => (s && s.kind === 'chess' && !s.sold ? i : -1)).filter((i) => i >= 0);
        if (!idx.length) break;
        const i = ctx.rng.pick(idx);
        if (ctx.grantChess(slots[i].id, { requirePool: false })) ctx.setShopSlot(i, null);
      }
    },
  });

  // 精打细算玩偶 — gain_coin_when_round_start {count}: an effect ref paying every round start
  r.item('chess_item_2_05_e', {
    onEquip(ctx, ev) {
      const n = int(buffP(data, ev.item.id, 'gain_coin_when_round_start').count, 1);
      const rec = data.item(ev.item.id);
      ctx.addEffect({ id: `item:${ev.item.uid}`, key: 'effect:builtin_round_coin', name: rec?.name || '精打细算玩偶', desc: rec?.desc || '', iconKind: 'item', iconId: rec?.iconId || null, params: { count: n } });
    },
  });
  r.effect('builtin_round_coin', {
    onRoundStart(ctx) { ctx.addFunds(int(ctx.source.ref?.params?.count, 1)); },
  });

  // 简易通讯机 — use_equip_reward_char_chess_with_same_bond {count}: operators sharing a bond with the carrier (≤ shop level)
  r.item('chess_item_2_06_e', {
    onEquip(ctx, ev) {
      const n = Math.max(1, int(buffP(data, ev.item.id, 'use_equip_reward_char_chess_with_same_bond').count, 1));
      const bonds = new Set(metaBonds(ctx, ev.target));
      const shares = (id) => { const c = data.chess(id); return !!(c && Array.isArray(c.bonds) && c.bonds.some((b) => bonds.has(b))); };
      for (let k = 0; k < n; k++) {
        const id = ctx.rollChess({ maxTier: ctx.shopLevel(), filter: shares });
        if (id) ctx.grantChess(id);
      }
    },
  });

  // 见钱眼开玩偶 — use_equip_gain_coin_when_next_round_start {count}
  r.item('chess_item_2_07_e', {
    onEquip(ctx, ev) {
      const n = int(buffP(data, ev.item.id, 'use_equip_gain_coin_when_next_round_start').count, 2);
      ctx.addPendingFunds(n);
      ctx.toast(`下回合额外获得${n}资金`, 'success');
    },
  });

  // 寻呼模块 — wrapped by items/meta.js (a base is registered so the wrap has something to extend)
  r.item('chess_item_4_01_e', {});

  // 信标 — the carrier and the item are destroyed; a special refresh of 2 operators of the carrier's tier, pick 1
  r.item('chess_item_5_04_e', {
    onEquip(ctx, ev) {
      const p = buffP(data, ev.item.id, 'use_equip_recruit_new_char_and_give_char_to_player_most_bond');
      const tier = data.tierOf(ev.target.id) || 1;
      const player = host.match.player(ctx.playerId);
      const holder = player.find(ev.target.uid);
      if (holder && holder.piece.kind === 'chess') {
        player._removeTokensOf(holder.piece.uid);
        player.detach(holder.piece.uid);
        for (const it of holder.piece.items || []) player.stow({ uid: it.uid, kind: 'item', id: it.id });
        host.match.pool.giveBack(holder.piece.id, host.match.pool.copiesOf(holder.piece.id));
      }
      const ids = [];
      for (let k = 0; k < Math.max(1, int(p.refresh_cnt, 2)) * 4 && ids.length < Math.max(1, int(p.refresh_cnt, 2)); k++) {
        const id = ctx.rollChess({ tier, filter: (x) => !ids.includes(x) });
        if (id) ids.push(id);
      }
      if (ids.length) ctx.offerChess(ids, { source: 'item', label: data.item(ev.item.id)?.name || '信标' });
    },
  });

  // 拟态物质 — use_equip_reward_char_chess: ≥ 2 normal copies of the carrier's operator → one more, else a same-bond operator
  r.item('chess_item_5_05_e', {
    onEquip(ctx, ev) {
      const player = host.match.player(ctx.playerId);
      const base = data.baseOf(ev.target.id);
      const copies = player.copiesOf(base).length;
      if (copies >= 2) { ctx.grantChess(base); return; }
      const bonds = new Set(metaBonds(ctx, ev.target));
      const id = ctx.rollChess({ filter: (x) => { const c = data.chess(x); return !!(c && c.bonds?.some((b) => bonds.has(b))); } });
      if (id) ctx.grantChess(id);
    },
  });

  // 博士投影 — _b: the carrier is promoted at once; _a: at the next round start (an effect ref holds the carrier's uid)
  r.item('chess_item_5_06_e', {
    onEquip(ctx, ev) {
      const rec = data.item(ev.item.id);
      if (rec?.isGolden) { host.promote(host.match.player(ctx.playerId), ev.target.uid); return; }
      ctx.addEffect({ id: `item:${ev.item.uid}`, key: 'effect:builtin_promote_next_round', name: rec?.name || '博士投影', desc: rec?.desc || '', iconKind: 'item', iconId: rec?.iconId || null, params: { uid: ev.target.uid } });
    },
  });
  r.effect('builtin_promote_next_round', {
    onRoundStart(ctx) {
      const player = host.match.player(ctx.playerId);
      const ref = ctx.source.ref;
      host.promote(player, ref?.params?.uid);
      player.effects = player.effects.filter((e) => e !== ref);
      player.touch();
    },
  });

  // 商业包装方案 — sell_char_count_gain_equip_owner_bond {count}: every N sales → a same-bond operator (≤ shop level)
  r.item('chess_item_5_07_e', {
    onSold(ctx) {
      const { piece, holder } = ctx.source;
      if (!piece || !holder) return;
      const n = Math.max(1, int(buffP(data, piece.id, 'sell_char_count_gain_equip_owner_bond').count, 8));
      if (ctx.incPieceCounter(piece.uid, 'builtin:package:sold') % n !== 0) return;
      const bonds = new Set(metaBonds(ctx, ctx.piece(holder.uid) || holder));
      const id = ctx.rollChess({ maxTier: ctx.shopLevel(), filter: (x) => { const c = data.chess(x); return !!(c && c.bonds?.some((b) => bonds.has(b))); } });
      if (id) ctx.grantChess(id);
    },
  });

  // 人事部文档 — equip_destory_deployment_cnt_change {count}: the deploy cap becomes `count`
  r.item('chess_item_6_08_e', {
    onEquip(ctx, ev) {
      const n = int(buffP(data, ev.item.id, 'equip_destory_deployment_cnt_change').count, 9);
      const player = host.match.player(ctx.playerId);
      const base = data.economy.deployCap ?? 8;
      player.extraDeploy = Math.max(player.extraDeploy, n - base);
      player.touch();
    },
  });

  // Arts fallback (教鞭 / “神秘顾客” when no bounty card fits): a low tier kill bounty
  const artBounty = {
    onArt(ctx, ev) {
      const cards = (data.choiceData?.cards?.bounty || []).filter((c) => c && c.payout === 'kill' && (c.tier ?? 1) <= 2 && data.enemy(c.enemyKey));
      const card = ctx.rng.pick(cards);
      if (!card || !ctx.addBounty(card)) { ev.error = 'BAD_TARGET'; ev.detail = 'no bounty available'; }
    },
  };
  r.item('chess_item_6_03_m', artBounty);
  r.item('chess_item_6_01_m', artBounty);
  r.item('chess_item_6_02_m', {});

  // 升华 / 整备 (choices.js BUILTIN_REFS): consumed by purchases (PlayerState.buy → consumeBuiltin)
  r.effect('builtin_next_buy_elite', {});
  r.effect('builtin_next_buy_golden_item', {});
}

/** Promote an owned normal operator to its elite in place (博士投影). */
MetaHost.prototype.promote = function promote(player, uid) {
  if (!player || !Number.isInteger(uid)) return false;
  const e = player.find(uid);
  if (!e || e.piece.kind !== 'chess' || e.piece.golden) return false;
  const gid = this.data.goldenOf(e.piece.id);
  if (!gid) return false;
  const need = this.data.mergeCountOf(e.piece.id);
  for (let i = 1; i < need; i++) this.match.pool.takeId(e.piece.id);
  e.piece.id = gid;
  e.piece.golden = true;
  e.piece.tier = this.data.chess(gid)?.tier ?? e.piece.tier;
  player.stats.merges += 1;
  player.touch();
  this.match.toast(player.playerId, `${this.data.chess(gid)?.name || '干员'} 已晋升为精锐干员`, 'success');
  return true;
};

export { BOND_LAYER_CAP, isShopItem, idList };
