// Round enemies: wave templates (data/waves.json) → BattleSpec spawns / routes, with the match's 特训敌人 factions
// (data/factions.json `generation`, the official RandomEnemyGenerater as decoded by the online remake), the mode's
// enemy scaling (config modes[].enemyScale) and the player's bounties (机变 悬赏).
//
//   generateFactions(match)          once per match: roundTypes[1..15] + per-round slot keys (N, E, S, NF, EF, SF, T, TF)
//   roundSpawns(match, player, r)    { template, routes, spawns, maxPlayTime, overrides } for the player's battle of round r
//   previewOf(spawns, routes)        m.private.nextEnemies entries (render/pen.js)

import { spawnsFromTemplate } from '../../../sim/simdata.js';

const isObj = (v) => !!v && typeof v === 'object';
const f32 = Math.fround;

/** Round half to even (the client's Mathf.RoundToInt). */
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * The match's faction draw (generation notes 1–2): the involveRandom types are shuffled, `specialEnemyNum` kept; each
 * owns `count` of the maxLevelCnt round slots, fillType the rest; the slots are shuffled. Per round, an entry of that
 * type and half (r ≤ firstHalfMaxRound) is picked by weight among the entries not inactive in the mode.
 * @returns {{ types: string[], rounds: Record<string, { type: string, key: string, slots: Record<string, string> }> }}
 */
export function generateFactions(match) {
  const fd = match.data.factionData || {};
  const gen = fd.generation || {};
  const types = isObj(fd.types) ? fd.types : {};
  const entries = isObj(fd.entries) ? fd.entries : {};
  const rng = match.rng;
  const inactive = new Set(Array.isArray(match.mode?.inactiveEnemyKeys) ? match.mode.inactiveEnemyKeys : []);
  const maxLevel = gen.maxLevelCnt || 15;
  const random = rng.shuffle(Object.values(types).filter((t) => t.involveRandom).map((t) => t.type)).slice(0, gen.specialEnemyNum ?? 3);
  const slots = [];
  for (const t of random) for (let i = 0; i < (types[t]?.count ?? 3); i++) slots.push(t);
  const fill = gen.fillType || 'SPECIAL';
  while (slots.length < maxLevel) slots.push(fill);
  rng.shuffle(slots);
  const rounds = {};
  for (let r = 1; r <= maxLevel; r++) {
    const type = slots[r - 1];
    const half = r <= (gen.firstHalfMaxRound ?? 7);
    let cands = Object.values(entries).filter((e) => e && e.type === type && !!e.firstHalf === half && !inactive.has(e.key));
    if (!cands.length) cands = Object.values(entries).filter((e) => e && e.type === type && !inactive.has(e.key));
    if (!cands.length) cands = Object.values(entries).filter((e) => e && e.type === fill && !inactive.has(e.key));
    const e = rng.weighted(cands, (x) => Number(x.weight) || 1);
    if (!e) continue;
    const pickKey = (list) => (Array.isArray(list) && list.length ? rng.pick(list).key : null);
    const out = { S: e.key, N: pickKey(e.N), E: pickKey(e.E) };
    rounds[String(r)] = { type, key: e.key, fly: !!e.fly, slots: out };
  }
  const involved = [...new Set([gen.alwaysIncludedType || 'SPECIAL', ...random])];
  return { types: involved, rounds };
}

/** Attribute power of an enemy (generation powerFormula, beFactors). */
function powerOf(match, key) {
  const e = match.data.enemy(key);
  if (!e) return 1;
  if (Number.isFinite(e.attrPower)) return e.attrPower;
  const f = match.data.factionData?.generation?.beFactors || { hp: 1, atk: 5, def: 3, res: 3 };
  const s = e.stats || e;
  return f32(f32(f32(f32((s.atk || 0) * f.atk) + f32((s.maxHp || s.hp || 0) * f.hp)) + f32((s.def || 0) * f.def)) + f32(f.res * (s.res ?? s.magicResistance ?? 0)));
}

const isFly = (match, key) => {
  const e = match.data.enemy(key);
  return !!(e && (e.isFlyEnemy || e.stats?.motion === 'FLY' || e.motion === 'FLY'));
};

/** Replace the placeholder spawns of a template with the round's faction enemies (generation note 3). */
function substitute(match, spawns, round) {
  const gen = match.data.factionData?.generation || {};
  const ph = gen.placeholders || {};
  const fr = match.factions?.rounds?.[String(round)];
  if (!fr) return spawns;
  const out = [];
  for (const s of spawns) {
    const p = ph[s.enemyKey];
    if (!p) { out.push(s); continue; }
    const cls = p.cls === 'elite' ? 'E' : p.cls === 'special' ? 'S' : 'N';
    const key = fr.slots[cls];
    if (!key || !match.data.enemy(key)) continue;
    if (isFly(match, key) !== !!p.fly) continue;
    const n = Math.max(1, s.count || 1);
    const pt = powerOf(match, s.enemyKey);
    const pn = powerOf(match, key);
    const n2 = Math.max(gen.minReplacedEnemyCount ?? 1, Math.min(gen.maxReplacedEnemyCount ?? 5, roundHalfEven(f32(f32(n * pt) / f32(pn || 1)))));
    const span = n * (s.interval || 0);
    const iv = Math.max(span / n2, (gen.minActionIntervalRatio ?? 0.05) * span);
    out.push({ ...s, enemyKey: key, count: n2, interval: iv });
  }
  return out;
}

/** The wave template of round r for this match (normal template, or the leader's template in boss rounds). */
export function templateFor(match, round) {
  const mode = match.mode || {};
  const row = mode.rounds?.[String(round)] || {};
  if (row.isHidden) {
    const boss = match.data.boss(match.hiddenBossId);
    return boss?.templates?.[match.modeId]?.template || row.bossTemplates?.[match.hiddenBossId] || null;
  }
  if (row.isBoss) {
    const boss = match.data.boss(match.bossId);
    return boss?.templates?.[match.modeId]?.template || row.bossTemplates?.[match.bossId] || null;
  }
  return row.template || null;
}

/** The enemy scaling of a round as spawn mods. */
export function roundMods(match, round) {
  const sc = match.mode?.enemyScale?.[String(round)];
  if (!sc) return null;
  const mods = {};
  if (Number.isFinite(sc.atk) && sc.atk !== 1) mods.atkMul = sc.atk;
  if (Number.isFinite(sc.hp) && sc.hp !== 1) mods.hpMul = sc.hp;
  if (Number.isFinite(sc.speed) && sc.speed !== 1) mods.speedMul = sc.speed;
  return Object.keys(mods).length ? mods : null;
}

/**
 * Spawns and routes of a player's battle of round r.
 * @returns {{ waveId: string|null, routes: any[], spawns: any[], maxPlayTime: number|null, overrides: any, dp: any }}
 */
export function roundSpawns(match, player, round) {
  const waveId = templateFor(match, round);
  const tpl = waveId ? match.data.wave(waveId) : null;
  if (!tpl) return { waveId, routes: [], spawns: [], maxPlayTime: null, overrides: {}, dp: null };
  const conv = spawnsFromTemplate({ ...tpl, spawns: (tpl.spawns || []).map((s) => ({ ...s, enemyKey: s.enemyKey ?? s.key })) });
  let spawns = substitute(match, conv.spawns, round);
  // 炎佑 (enemy_9012_acloon) is never an enemy (generation note)
  spawns = spawns.filter((s) => s.enemyKey !== 'enemy_9012_acloon');
  // the round's enemy scaling; the leader itself is unaffected (config.bossHpScale.unaffectedByEnemyScale: its HP is
  // the shared pool), its escorts are scaled like any enemy of the round
  const scale = roundMods(match, round);
  const leaderExempt = match.data.config.bossHpScale?.unaffectedByEnemyScale !== false;
  if (scale) spawns = spawns.map((s) => (s.tag === 'boss' && leaderExempt ? s : { ...s, mods: { ...scale, ...(s.mods || {}) } }));
  // the player's bounties (机变 悬赏): extra enemies on the next battles
  for (const b of player.bounties) {
    if (!(b.roundsLeft > 0)) continue;
    const route = Math.min(Math.max(0, conv.routes.length - 1), b.routeIndex ?? 0);
    spawns.push({
      time: Number.isFinite(b.time) ? b.time : 5, enemyKey: b.enemyKey, routeIndex: route, count: b.count, interval: 2,
      mods: { ...(scale || {}), ...(match.roomMode === 'solo' && b.payout === 'perfect' ? { hpMul: (scale?.hpMul ?? 1) * 0.7, atkMul: (scale?.atkMul ?? 1) * 0.7 } : {}) },
      tag: 'bounty', bounty: b.payout === 'kill' ? { coins: b.coin, ownerPlayerId: player.playerId, effectId: b.effectId } : null,
    });
  }
  return { waveId, routes: conv.routes, spawns, maxPlayTime: conv.maxPlayTime, overrides: conv.overrides || {}, dp: tpl.dp || null, extraRoutes: conv.extraRoutes };
}

/** m.private.nextEnemies entries: one per spawn action (render/pen.js). */
export function previewOf(match, spawns, routes) {
  const out = [];
  for (const s of spawns) {
    const e = match.data.enemy(s.enemyKey);
    if (!e) continue;
    const route = routes[s.routeIndex ?? 0] || routes[0];
    const startRow = Array.isArray(route?.start) ? route.start[0] : 9;
    out.push({
      enemyKey: s.enemyKey, count: Math.max(1, s.count || 1), t: Number(s.time) || 0,
      gate: startRow >= 11 ? 'upper' : 'lower', fly: isFly(match, s.enemyKey),
      elite: e.rank === 'ELITE', boss: e.rank === 'BOSS' || s.tag === 'boss', tag: s.tag || null,
    });
  }
  return out;
}
