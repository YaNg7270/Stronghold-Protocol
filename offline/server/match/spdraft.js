// 机变阶段 (SP_DRAFT) — card generation and picks (data/choices.json: schedule, families, cards, bountyDrafts,
// shopDraft, tacticDraft; the online server's server/match/choices.js). Solo: 3 cards, untimed, one pick.
//
//   bounty  悬赏决策  cards of the round's bountyDraft list (one official group, cards drawn without repeats)
//   supply  道具补给  random normal EQUIP shop items within schedule.supplyTiers [min, max] (duplicates allowed)
//   shop    机密商店  at shopDraft.rounds: the slot scheme (tier VI, VI, V, 盟约之币, mixed); else items of tiers I–VI
//   tactic  战术决策  cards.tactic (terrain cards only for the match's stage); at tacticDraft.rounds the ally cards by
//                    weight, other rounds uniform; drawn with replacement
// What a picked card does is the card's meta handler (sim/content/choices.js registerMeta, via the meta host).

import { rollShopItem, shopItemsByTier } from './pool.js';
import { ServerError } from './errors.js';

const isObj = (v) => !!v && typeof v === 'object';

export class SpDraft {
  constructor(match, round, st = null) {
    this.match = match;
    this.round = round;
    if (st) { Object.assign(this, st); this.match = match; return; }
    const sched = match.data.choiceData?.schedule?.[match.modeId]?.rounds?.[String(round)] || null;
    this.family = null;
    this.cards = [];
    this.picks = {};
    this.order = match.alivePlayers().map((p) => p.playerId);
    if (!sched) return;
    const fam = match.rng.weighted(sched.families || [], (f) => Number(f.weight) || 0);
    this.family = fam ? fam.family : null;
    const n = match.roomMode === 'solo' ? Math.min(3, sched.cards || 3) : (sched.cards || 6);
    this.cards = this._generate(this.family, sched, n);
  }

  ready() { return !!this.family && this.cards.length > 0; }

  done() { return this.order.every((id) => this.picks[id] != null); }

  _generate(family, sched, n) {
    const m = this.match;
    const rng = m.rng;
    const data = m.data;
    const cd = data.choiceData || {};
    const out = [];
    const itemCard = (id) => {
      const it = data.item(id);
      return it ? { kind: 'item', id, itemId: id, name: it.name, tier: it.tier } : null;
    };
    if (family === 'supply') {
      const [lo, hi] = Array.isArray(sched.supplyTiers) ? sched.supplyTiers : [1, 6];
      for (let i = 0; i < n; i++) {
        const id = rollShopItem(data, rng, { minTier: lo, maxTier: hi });
        const c = id && itemCard(id);
        if (c) out.push(c);
      }
    } else if (family === 'shop') {
      const sd = cd.shopDraft || {};
      if (Array.isArray(sd.rounds) && sd.rounds.includes(this.round) && Array.isArray(sd.slots)) {
        const slots = rng.shuffle(sd.slots.slice()).slice(0, n);
        const byTier = shopItemsByTier(data);
        for (const s of slots) {
          const key = rng.weighted(Object.keys(s), (k) => Number(s[k]) || 0);
          let id = null;
          if (key === 'coin') id = sd.coin;
          else {
            const list = byTier.get(Number(key)) || [];
            const w = sd.itemWeights || {};
            id = rng.weighted(list, (x) => 1 + (Number(w[x]) || 0));
          }
          const c = id && itemCard(id);
          if (c) out.push(c);
        }
      } else {
        for (let i = 0; i < n; i++) {
          const id = rollShopItem(data, rng, { minTier: 1, maxTier: 6 });
          const c = id && itemCard(id);
          if (c) out.push(c);
        }
      }
    } else if (family === 'tactic') {
      const td = cd.tacticDraft || {};
      const all = (cd.cards?.tactic || []).filter((c) => isObj(c) && (!c.stageId || c.stageId === m.stageId));
      const special = Array.isArray(td.rounds) && td.rounds.includes(this.round);
      const pool = special ? all.filter((c) => (td.kinds || ['ally']).includes(c.kind)) : all;
      for (let i = 0; i < n; i++) {
        const c = special ? rng.weighted(pool, (x) => 1 + (Number(td.weights?.[x.effectId]) || 0)) : rng.pick(pool);
        if (c) out.push({ kind: 'tactic', id: c.effectId, effectId: c.effectId, name: c.name, desc: c.desc, team: !!c.team, tacticKind: c.kind || null });
      }
    } else if (family === 'bounty') {
      const bd = cd.bountyDrafts?.[sched.bountyDraft] || null;
      const inactive = new Set(Array.isArray(m.mode?.inactiveEnemyKeys) ? m.mode.inactiveEnemyKeys : []);
      const cards = (cd.cards?.bounty || []).filter((c) => isObj(c) && data.enemy(c.enemyKey) && !inactive.has(c.enemyKey));
      const byId = new Map(cards.map((c) => [c.effectId, c]));
      let ids = [];
      if (bd && Array.isArray(bd.groups) && bd.groups.length) {
        const g = rng.weighted(bd.groups, (x) => (Array.isArray(x.seen) ? x.seen.length : 1));
        ids = (g?.cards || []).filter((id) => byId.has(id));
      }
      if (!ids.length) ids = cards.filter((c) => c.draft).map((c) => c.effectId);
      if (!ids.length) ids = cards.map((c) => c.effectId);
      for (const id of rng.shuffle(ids.slice()).slice(0, n)) {
        const c = byId.get(id);
        out.push({ kind: 'bounty', id, effectId: id, name: c.name, desc: c.desc, tier: c.tier, coin: c.coin, enemyKey: c.enemyKey });
      }
    }
    return out;
  }

  publicView() {
    const fam = this.match.data.choiceData?.families?.[this.family] || {};
    const turn = this.order.find((id) => this.picks[id] == null) || null;
    return {
      family: this.family, name: fam.name || null, desc: fam.desc || null, untimed: true,
      cards: this.cards.map((c, idx) => ({ ...c, idx })), order: this.order, turn,
      picks: { ...this.picks },
    };
  }

  pick(player, idx) {
    if (this.picks[player.playerId] != null) throw new ServerError('ALREADY', '已完成该操作');
    const card = this.cards[idx];
    if (!card) throw new ServerError('BAD_TARGET', '无效的目标');
    if (Object.values(this.picks).includes(idx)) throw new ServerError('BAD_TARGET', '该机变已被选择');
    this.picks[player.playerId] = idx;
    this.match.meta.choicePick(player, card);
    this.match.publicDirty = true;
    player.touch();
  }

  serialize() {
    return { round: this.round, family: this.family, cards: this.cards, picks: this.picks, order: this.order };
  }

  static restore(match, st) { return new SpDraft(match, st.round, st); }
}
