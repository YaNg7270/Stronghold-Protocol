// Bond counts of a player (the online server's server/match/bondsMeta.js, from data/bonds.json and the client's
// documented rules — js/ui/gameLogic.js, js/ui/bondStrip.js):
//   * members are distinct operators (normal and elite copies count once): board chess for countMode BOARD, board and
//     hand for BOARD_AND_DECK (countsHand — 投资人 远见 奇迹; the 5 temp slots never count), every elite on the board
//     for BOARD_ALL_CHESS + countsGoldenOnly (绝技);
//   * an operator is a member through its record's bonds or a 变形同构体 pairing (gameLogic grantedBonds);
//   * 调和 (maniShip) active → every core bond with members counts one more (`harmony: true`);
//   * tier = thresholds reached (upward); downward bonds (独行) are active while 1 ≤ count ≤ maxCount;
//   * a bond the mode never activates (config modes[].inactiveBondIds) is listed with `off: true` and never active.

import { grantedBonds } from '../../../js/ui/gameLogic.js';

export const HARMONY_BOND = 'maniShip';

/** @returns {Array<{ bondId, name, count, active, tier, layers, thresholds, maxCount, countsHand, harmony, off, isCore }>} */
export function computeBonds(match, player) {
  const data = match.data;
  const mode = match.mode || {};
  const inactive = new Set(Array.isArray(mode.inactiveBondIds) ? mode.inactiveBondIds : []);
  const activeList = Array.isArray(mode.activeBondIds) ? new Set(mode.activeBondIds) : null;
  const getItem = (id) => data.item(id);
  const bondsOf = (p) => {
    const rec = data.chess(p.id);
    const own = Array.isArray(rec?.bonds) ? rec.bonds.slice() : [];
    for (const b of grantedBonds(p.items || [], getItem)) if (!own.includes(b)) own.push(b);
    return own;
  };
  const board = player.board.filter((p) => p.kind === 'chess');
  const hand = player.hand.filter((p) => p && p.kind === 'chess');
  const members = new Map(); // bondId → Set(base ids)
  const add = (bondId, p) => {
    if (!members.has(bondId)) members.set(bondId, new Set());
    members.get(bondId).add(data.baseOf(p.id));
  };
  for (const b of data.bondList()) {
    const id = b.bondId;
    if (b.countMode === 'BOARD_ALL_CHESS' && b.countsGoldenOnly) {
      for (const p of board) if (p.golden) add(id, p);
      continue;
    }
    const pool = b.countMode === 'BOARD_AND_DECK' || b.countsHand ? [...board, ...hand] : board;
    for (const p of pool) if (bondsOf(p).includes(id)) add(id, p);
  }
  const offOf = (id) => inactive.has(id) || (activeList ? !activeList.has(id) : false);
  const tierOf = (b, count) => {
    const th = Array.isArray(b.thresholds) ? b.thresholds : [];
    if (b.thresholdTemplate === 'count_threshold_downward') {
      const max = Number.isFinite(b.maxCount) ? b.maxCount : (th[0] ?? 1);
      return count >= (th[0] ?? 1) && count <= max ? 1 : 0;
    }
    let t = 0;
    for (const x of th) if (count >= x) t++;
    return t;
  };
  const mani = data.bond(HARMONY_BOND);
  const maniCount = members.get(HARMONY_BOND)?.size || 0;
  const maniActive = !!mani && !offOf(HARMONY_BOND) && tierOf(mani, maniCount) > 0;
  const out = [];
  for (const b of data.bondList()) {
    const id = b.bondId;
    let count = members.get(id)?.size || 0;
    const layers = player.layers[id] || 0;
    let harmony = false;
    if (maniActive && b.isCore && count > 0) { count += 1; harmony = true; }
    if (count <= 0 && layers <= 0) continue;
    const off = offOf(id);
    const tier = off ? 0 : tierOf(b, count);
    out.push({
      bondId: id, name: b.name, count, active: !off && tier > 0, tier, layers,
      thresholds: Array.isArray(b.thresholds) ? b.thresholds : [], maxCount: b.maxCount ?? null,
      countsHand: !!(b.countsHand || b.countMode === 'BOARD_AND_DECK'), harmony, off, isCore: !!b.isCore,
    });
  }
  return out;
}
