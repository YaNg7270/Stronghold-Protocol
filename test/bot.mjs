// A simple headless player for end-to-end tests: buys what it can afford (preferring copies it owns), fills the board
// with legal placements (the client's own rules) and readies. Not a good player — a thorough one.

import { placementContext, canPlace, deployFieldOf } from '../js/ui/gameLogic.js';
import { GEO } from '../shared/constants.js';

export function playPrep(h, c, { levelUpAt = 12 } = {}) {
  const data = h.data;
  const tries = 40;
  for (let k = 0; k < tries; k++) {
    const priv = c.state.priv;
    if (!priv || priv.ready) return;
    // a pending reward offer: take the first card
    if (priv.shop.rewardOffer) { tryReq(c, 'g.reward', { idx: 0 }); continue; }
    // level up when rich
    if (priv.funds >= levelUpAt && priv.shop.level < priv.shop.maxLevel && priv.shop.upgradePrice <= priv.funds - 4) { tryReq(c, 'g.levelUp'); continue; }
    // buy: owned copies first, then the highest tier affordable
    const owned = new Set([...priv.board, ...priv.hand, ...priv.temp].filter((p) => p && p.kind === 'chess').map((p) => data.baseOf(p.id)));
    const slots = priv.shop.slots.map((s, i) => ({ s, i })).filter(({ s }) => s && !s.sold && s.price <= priv.funds);
    slots.sort((a, b) => (owned.has(b.s.id) ? 1 : 0) - (owned.has(a.s.id) ? 1 : 0) || data.tierOf(b.s.id) - data.tierOf(a.s.id));
    const pick = slots.find(({ s }) => s.kind === 'chess') || slots.find(({ s }) => s.kind === 'item');
    if (pick && tryReq(c, 'g.buy', { slot: pick.i })) continue;
    break;
  }
  deployAll(h, c);
  equipAll(h, c);
  // empty the temp row (sell) so ready is allowed
  for (const p of c.state.priv.temp) if (p && p.kind === 'chess') tryReq(c, 'g.sell', { uid: p.uid });
  for (const p of c.state.priv.temp) if (p && p.kind === 'item') tryReq(c, 'g.destroy', { uid: p.uid });
}

export function deployAll(h, c) {
  const data = h.data;
  for (let k = 0; k < 20; k++) {
    const priv = c.state.priv;
    const ctx = placementContext({
      priv, stage: data.stage(c.state.pub.stageId), editable: true, field: deployFieldOf(c.state.pub, priv.playerId),
      getChess: (id) => data.chess(id), getToken: (id) => data.token(id), getItem: (id) => data.item(id), getEffect: (id) => data.effect(id),
    });
    const cand = priv.hand.filter((p) => p && (p.kind === 'chess' || p.kind === 'token'));
    let moved = false;
    for (const p of cand) {
      for (let r = GEO.FIELD.r0; r <= GEO.FIELD.r1 && !moved; r++) {
        for (let col = GEO.FIELD.c1; col >= GEO.FIELD.c0 && !moved; col--) {
          if (ctx.boardAt.has(`${r},${col}`)) continue;
          const res = canPlace(ctx, p.uid, { area: 'board', row: r, col });
          if (res.ok && res.action === 'move') moved = tryReq(c, 'g.move', { uid: p.uid, to: { area: 'board', row: r, col }, dir: 'RIGHT' });
        }
      }
      if (moved) break;
    }
    if (!moved) return;
  }
}

export function equipAll(h, c) {
  for (let k = 0; k < 10; k++) {
    const priv = c.state.priv;
    const item = priv.hand.find((p) => p && p.kind === 'item' && h.data.item(p.id)?.itemType === 'EQUIP');
    const holder = priv.board.find((p) => p.kind === 'chess' && (p.items || []).length < 2);
    if (!item || !holder) return;
    if (!tryReq(c, 'g.equip', { itemUid: item.uid, targetUid: holder.uid })) return;
  }
}

export function tryReq(c, t, fields = {}) {
  const r = c.request(t, fields);
  if (r.t !== 'ok') { c.lastError = r; return false; }
  return true;
}
