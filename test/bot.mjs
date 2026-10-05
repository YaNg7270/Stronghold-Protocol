// A simple headless player for end-to-end tests: levels the shop on a schedule, buys merges first and then the best
// operators it can afford, keeps the strongest operators on the board (the client's own placement rules), equips
// items and readies. Not a good player — a thorough one that reaches the late rounds.

import { placementContext, canPlace, deployFieldOf } from '../js/ui/gameLogic.js';
import { GEO } from '../shared/constants.js';

const strength = (data, p) => (p ? data.tierOf(p.id) * 10 + (p.golden ? 25 : 0) + (p.items || []).length * 3 : 0);

export function playPrep(h, c) {
  const data = h.data;
  for (let k = 0; k < 60; k++) {
    const priv = c.state.priv;
    const pub = c.state.pub;
    if (!priv || priv.ready) return;
    if (priv.shop.rewardOffer) { if (!tryReq(c, 'g.reward', { idx: 0 })) break; continue; }
    // shop level: about one level every two rounds
    const want = Math.min(priv.shop.maxLevel, 1 + Math.floor((pub.round + 1) / 2));
    if (priv.shop.level < want && priv.shop.upgradePrice <= priv.funds) { if (tryReq(c, 'g.levelUp')) continue; }
    const owned = new Map();
    for (const p of [...priv.board, ...priv.hand, ...priv.temp]) if (p && p.kind === 'chess' && !p.golden) owned.set(data.baseOf(p.id), (owned.get(data.baseOf(p.id)) || 0) + 1);
    const free = priv.hand.filter((x) => !x).length;
    const slots = priv.shop.slots.map((s, i) => ({ s, i })).filter(({ s }) => s && !s.sold && s.price <= priv.funds);
    slots.sort((a, b) => (owned.get(b.s.id) || 0) - (owned.get(a.s.id) || 0) || data.tierOf(b.s.id) - data.tierOf(a.s.id));
    const pick = slots.find(({ s }) => s.kind === 'chess' && (free > 1 || owned.get(s.id) >= 2)) || (free > 2 ? slots.find(({ s }) => s.kind === 'item') : null);
    if (pick && tryReq(c, 'g.buy', { slot: pick.i })) continue;
    // nothing to buy: refresh while rich
    if (priv.funds >= 4 && priv.shop.refreshPrice <= priv.funds - 2 && tryReq(c, 'g.refresh')) continue;
    break;
  }
  deployAll(h, c);
  equipAll(h, c);
  useArts(h, c);
  // keep the hand tidy: sell the weakest unmergeable leftovers when it is nearly full, empty the temp row
  const priv = c.state.priv;
  if (priv.hand.filter(Boolean).length >= 8) {
    const weak = priv.hand.filter((p) => p && p.kind === 'chess').sort((a, b) => strength(data, a) - strength(data, b)).slice(0, 2);
    for (const p of weak) tryReq(c, 'g.sell', { uid: p.uid });
  }
  for (const p of c.state.priv.temp) if (p && p.kind === 'chess') tryReq(c, 'g.sell', { uid: p.uid });
  for (const p of c.state.priv.temp) if (p && p.kind === 'item') tryReq(c, 'g.destroy', { uid: p.uid });
}

function ctxOf(h, c) {
  const data = h.data;
  return placementContext({
    priv: c.state.priv, stage: data.stage(c.state.pub.stageId), editable: true, field: deployFieldOf(c.state.pub, c.state.priv.playerId),
    getChess: (id) => data.chess(id), getToken: (id) => data.token(id), getItem: (id) => data.item(id), getEffect: (id) => data.effect(id),
  });
}

export function deployAll(h, c) {
  const data = h.data;
  for (let k = 0; k < 24; k++) {
    const priv = c.state.priv;
    const ctx = ctxOf(h, c);
    const cand = priv.hand.filter((p) => p && (p.kind === 'chess' || p.kind === 'token')).sort((a, b) => strength(data, b) - strength(data, a));
    let moved = false;
    for (const p of cand) {
      // an empty legal tile, front (right) first
      for (let r = GEO.FIELD.r0; r <= GEO.FIELD.r1 && !moved; r++) {
        for (let col = GEO.FIELD.c1; col >= GEO.FIELD.c0 && !moved; col--) {
          if (ctx.boardAt.has(`${r},${col}`)) continue;
          const res = canPlace(ctx, p.uid, { area: 'board', row: r, col });
          if (res.ok && res.action === 'move') moved = tryReq(c, 'g.move', { uid: p.uid, to: { area: 'board', row: r, col }, dir: 'RIGHT' });
        }
      }
      if (moved) break;
      // the board is full: swap with a weaker operator
      if (p.kind !== 'chess') continue;
      const weakest = priv.board.filter((b) => b.kind === 'chess').sort((a, b) => strength(data, a) - strength(data, b))[0];
      if (weakest && strength(data, weakest) + 5 < strength(data, p)) {
        const res = canPlace(ctx, p.uid, { area: 'board', row: weakest.row, col: weakest.col });
        if (res.ok) { moved = tryReq(c, 'g.move', { uid: p.uid, to: { area: 'board', row: weakest.row, col: weakest.col }, dir: 'RIGHT' }); if (moved) break; }
      }
    }
    if (!moved) return;
  }
}

export function equipAll(h, c) {
  for (let k = 0; k < 12; k++) {
    const priv = c.state.priv;
    const item = priv.hand.find((p) => p && p.kind === 'item' && h.data.item(p.id)?.itemType === 'EQUIP');
    const holder = priv.board.filter((p) => p.kind === 'chess' && (p.items || []).length < 2).sort((a, b) => strength(h.data, b) - strength(h.data, a))[0];
    if (!item || !holder) return;
    if (!tryReq(c, 'g.equip', { itemUid: item.uid, targetUid: holder.uid })) return;
  }
}

export function useArts(h, c) {
  for (let k = 0; k < 2; k++) {
    const priv = c.state.priv;
    const art = priv.hand.find((p) => p && p.kind === 'item' && h.data.item(p.id)?.itemType === 'MAGIC');
    const target = priv.board.find((p) => p.kind === 'chess');
    if (!art || !target) return;
    if (!tryReq(c, 'g.art', { itemUid: art.uid, row: target.row, col: target.col, dir: 'RIGHT' })) {
      tryReq(c, 'g.destroy', { uid: art.uid });
      return;
    }
  }
}

export function tryReq(c, t, fields = {}) {
  const r = c.request(t, fields);
  if (r.t !== 'ok') { c.lastError = r; return false; }
  return true;
}
