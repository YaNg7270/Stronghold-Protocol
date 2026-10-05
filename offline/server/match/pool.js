// Shared operator pool, bans and shop draws (data/config.json economy; `shopOdds.model` 'copyWeighted').
//
//   * The pool holds `poolCopies[tier]` copies of every visible, non-hidden, non-DIY normal operator that is not banned
//     (economy.poolCopies + poolCopiesOverrides). A shop slot takes one copy out (uniform over the remaining copies of
//     the operators with tier ≤ shop level); an unsold slot gives it back when the shop is rerolled or cleared; a sold
//     operator gives back its copies (an elite: its merge count).
//   * Bans (config.bans, rule "banned iff every bond of a visible non-DIY chess is in (drawn set D ∪
//     mode.inactiveBondIds)"): D = `core` random core bonds + `addon` random other bonds with weight > 0.
//   * Item slots: tier uniform among the tiers ≤ shop level that have shop items, then uniform within the tier
//     (economy.shopOdds note).

import { isShopItem } from '../../../sim/simdata.js';

const isObj = (v) => !!v && typeof v === 'object';

/** Visible normal operators that can ever be in a pool. */
export function poolCandidates(data) {
  return data.chessList().filter((c) => !c.isGolden && c.visible !== false && !c.isHidden && !c.isDiy && Number.isInteger(c.tier));
}

/**
 * Draw the disabled bond set D and derive the banned operators.
 * @returns {{ drawn: string[], disabled: string[], banned: string[] }}
 */
export function drawBans(data, mode, difficulty, rng) {
  const bans = (data.config.bans || {})[difficulty] || { core: 0, addon: 0 };
  const inactive = new Set(Array.isArray(mode?.inactiveBondIds) ? mode.inactiveBondIds : []);
  const active = Array.isArray(mode?.activeBondIds) ? new Set(mode.activeBondIds) : null;
  const eligible = data.bondList().filter((b) => !inactive.has(b.bondId) && (!active || active.has(b.bondId)));
  const core = rng.shuffle(eligible.filter((b) => b.isCore).map((b) => b.bondId)).slice(0, Math.max(0, bans.core | 0));
  const addon = rng.shuffle(eligible.filter((b) => !b.isCore && Number(b.weight) > 0).map((b) => b.bondId)).slice(0, Math.max(0, bans.addon | 0));
  const drawn = [...core, ...addon];
  const off = new Set([...drawn, ...inactive]);
  const banned = [];
  for (const c of poolCandidates(data)) {
    const bonds = Array.isArray(c.bonds) ? c.bonds : [];
    if (bonds.length && bonds.every((b) => off.has(b))) banned.push(c.chessId);
  }
  return { drawn, disabled: [...off], banned };
}

export class Pool {
  /**
   * @param {import('../data.js').GameData} data
   * @param {string[]} banned base chess ids kept out of the pool
   * @param {Record<string, number>} [counts] restored copies (serialize)
   */
  constructor(data, banned = [], counts = null) {
    this.data = data;
    this.banned = new Set(banned);
    this.counts = new Map();
    if (counts) {
      for (const [k, v] of Object.entries(counts)) this.counts.set(k, v);
    } else {
      for (const c of poolCandidates(data)) if (!this.banned.has(c.chessId)) this.counts.set(c.chessId, data.poolCopiesOf(c.chessId));
    }
  }

  serialize() { return Object.fromEntries(this.counts); }

  /** Is this base operator part of the pool (not banned)? */
  has(id) { return this.counts.has(this.data.baseOf(id)); }

  /**
   * Take one copy: uniform over the remaining copies of the operators passing `filter` (default: tier ≤ maxTier).
   * @returns {string|null} base chess id
   */
  take(rng, { maxTier = 6, minTier = 1, filter = null } = {}) {
    let total = 0;
    const cand = [];
    for (const [id, n] of this.counts) {
      if (n <= 0) continue;
      const t = this.data.tierOf(id);
      if (t > maxTier || t < minTier) continue;
      if (filter && !filter(this.data.chess(id))) continue;
      cand.push([id, n]);
      total += n;
    }
    if (total <= 0) return null;
    let r = rng() * total;
    for (const [id, n] of cand) {
      r -= n;
      if (r < 0) { this.counts.set(id, this.counts.get(id) - 1); return id; }
    }
    const [id] = cand[cand.length - 1];
    this.counts.set(id, this.counts.get(id) - 1);
    return id;
  }

  /** Take a specific operator's copy if one is left. */
  takeId(id) {
    const base = this.data.baseOf(id);
    const n = this.counts.get(base);
    if (!(n > 0)) return false;
    this.counts.set(base, n - 1);
    return true;
  }

  /** Give copies back (no-op for operators outside the pool). */
  giveBack(id, n = 1) {
    const base = this.data.baseOf(id);
    if (!this.counts.has(base)) return;
    const cap = this.data.poolCopiesOf(base);
    this.counts.set(base, Math.min(cap, this.counts.get(base) + Math.max(0, n)));
  }

  /** Copies an owned piece stands for (normal 1, elite = its merge count). */
  copiesOf(id) {
    const c = this.data.chess(id);
    return c?.isGolden ? this.data.mergeCountOf(id) : 1;
  }
}

/** Shop items by tier (cached per data object). */
const ITEMS = new WeakMap();
export function shopItemsByTier(data) {
  let m = ITEMS.get(data);
  if (m) return m;
  m = new Map();
  for (const it of data.itemList()) {
    if (!isShopItem(it)) continue;
    if (!m.has(it.tier)) m.set(it.tier, []);
    m.get(it.tier).push(it.id);
  }
  for (const list of m.values()) list.sort();
  ITEMS.set(data, m);
  return m;
}

/** A random shop item of tier ≤ maxTier (tier uniform, then item uniform). */
export function rollShopItem(data, rng, { maxTier = 6, minTier = 1, tier = null } = {}) {
  const m = shopItemsByTier(data);
  const tiers = [...m.keys()].filter((t) => (tier != null ? t === tier : t >= minTier && t <= maxTier)).sort((a, b) => a - b);
  if (!tiers.length) return null;
  const t = rng.pick(tiers);
  return rng.pick(m.get(t)) || null;
}

/** Normalize an id list option (string "a,b" or array). */
export const idList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
export { isObj };
