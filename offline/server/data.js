// Game data for the offline server: the same /data/*.json files the client and the sim read.
//
// loadGameData(fetchJson) fetches every file once and returns a GameData with id lookups and the derived tables the
// match needs (pool chess, tiers, bond members …). In the browser `fetchJson` is fetch(); Node tests pass a file reader.
// The sim's own data (simdata.setSimData) is installed from the same objects (sim.js), so prep and battle agree.

export const DATA_FILES = Object.freeze([
  'config', 'chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects',
  'choices', 'bosses', 'factions',
]);

/** The files the sim's DataSource takes (js/battle/runner.js SIM_DATA_FILES). */
export const SIM_DATA_FILES = Object.freeze(['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function deepFreeze(root) {
  const stack = [root];
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || Object.isFrozen(o)) continue;
    Object.freeze(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
  return root;
}

export class GameData {
  /** @param {Record<string, any>} raw file name → parsed JSON */
  constructor(raw) {
    this.raw = raw;
    this.config = raw.config || {};
    this.economy = this.config.economy || {};
    this.chessMap = raw.chess || {};
    this.itemMap = raw.items || {};
    this.bondMap = raw.bonds || {};
    this.bandMap = raw.bands || {};
    this.enemyMap = raw.enemies || {};
    this.tokenMap = raw.tokens || {};
    this.stageMap = raw.stages || {};
    this.waveMap = raw.waves || {};
    this.effectMap = raw.effects || {};
    this.garrisonMap = raw.garrisons || {};
    this.bossMap = raw.bosses || {};
    this.choiceData = raw.choices || {};
    this.factionData = raw.factions || {};
  }

  chess(id) { return (typeof id === 'string' && this.chessMap[id]) || null; }
  item(id) { return (typeof id === 'string' && this.itemMap[id]) || null; }
  bond(id) { return (typeof id === 'string' && this.bondMap[id]) || null; }
  band(id) { return (typeof id === 'string' && this.bandMap[id]) || null; }
  enemy(id) { return (typeof id === 'string' && this.enemyMap[id]) || null; }
  token(id) { return (typeof id === 'string' && this.tokenMap[id]) || null; }
  stage(id) { return (typeof id === 'string' && this.stageMap[id]) || null; }
  wave(id) { return (typeof id === 'string' && this.waveMap[id]) || null; }
  effect(id) { return (typeof id === 'string' && this.effectMap[id]) || null; }
  garrison(id) { return (typeof id === 'string' && this.garrisonMap[id]) || null; }
  boss(id) { return (typeof id === 'string' && this.bossMap[id]) || null; }
  mode(id) { return (isObj(this.config.modes) && this.config.modes[id]) || null; }

  /** Tier of a chess or item id (0 when unknown). */
  tierOf(id) {
    const r = this.chess(id) || this.item(id);
    return Number.isInteger(r?.tier) ? r.tier : 0;
  }

  /** Base (normal) chess id of a chess id (elite `_b` → its normal copy). */
  baseOf(id) {
    const c = this.chess(id);
    if (c && typeof c.baseId === 'string' && c.baseId) return c.baseId;
    return typeof id === 'string' ? id.replace(/_b$/, '_a') : id;
  }

  /** Elite (golden) chess id of a chess id, or null. */
  goldenOf(id) {
    const base = this.chess(this.baseOf(id));
    const g = base && (base.goldenId || String(base.chessId || id).replace(/_a$/, '_b'));
    return g && this.chess(g) ? g : null;
  }

  /** Copies of a normal chess needed for its elite (economy.mergeCount + overrides, or the record's upgradeNum). */
  mergeCountOf(id) {
    const base = this.baseOf(id);
    const ov = this.economy.mergeCountOverrides || {};
    if (Number.isInteger(ov[base])) return ov[base];
    const c = this.chess(base);
    if (Number.isInteger(c?.upgradeNum) && c.upgradeNum > 0) return c.upgradeNum;
    return Number.isInteger(this.economy.mergeCount) ? this.economy.mergeCount : 3;
  }

  /** Pool copies of a normal chess (economy.poolCopies by tier + overrides). */
  poolCopiesOf(id) {
    const ov = this.economy.poolCopiesOverrides || {};
    if (Number.isInteger(ov[id])) return ov[id];
    const t = this.tierOf(id);
    const n = (this.economy.poolCopies || {})[String(t)];
    return Number.isInteger(n) ? n : 0;
  }

  /** Every chess record (normal and elite). */
  chessList() { return Object.values(this.chessMap).filter(isObj); }
  itemList() { return Object.values(this.itemMap).filter(isObj); }
  bondList() { return Object.values(this.bondMap).filter(isObj); }
  bandList() { return Object.values(this.bandMap).filter(isObj); }

  /** Buy price of a chess record (economy.chessPrice by tier). */
  chessPrice(id) {
    const c = this.chess(id);
    const row = (this.economy.chessPrice || {})[String(c?.tier ?? 1)] || {};
    const p = c?.isGolden ? row.golden : row.normal;
    if (Number.isFinite(c?.price)) return c.price;
    return Number.isFinite(p) ? p : 1;
  }

  /** Sell price of a chess id (record sellPrice, else economy.chessSell). */
  chessSellPrice(id) {
    const c = this.chess(id);
    if (Number.isFinite(c?.sellPrice)) return c.sellPrice;
    const row = (this.economy.chessSell || {})[String(c?.tier ?? 1)] || {};
    const p = c?.isGolden ? row.golden : row.normal;
    return Number.isFinite(p) ? p : 1;
  }

  /** The raw objects for simdata.setSimData. */
  simRaw() {
    const out = {};
    for (const n of SIM_DATA_FILES) out[n] = this.raw[n];
    return out;
  }
}

/**
 * Load every data file.
 * @param {(name: string) => Promise<any>} fetchJson resolves the parsed JSON of /data/<name>.json (null when missing)
 * @returns {Promise<GameData>}
 */
export async function loadGameData(fetchJson) {
  const entries = await Promise.all(DATA_FILES.map(async (n) => [n, await fetchJson(n)]));
  const raw = {};
  const missing = [];
  for (const [n, j] of entries) {
    if (j && typeof j === 'object') raw[n] = deepFreeze(j);
    else missing.push(n);
  }
  const required = [...SIM_DATA_FILES, 'config'];
  const bad = missing.filter((n) => required.includes(n));
  if (bad.length) throw new Error(`game data unavailable: ${bad.join(', ')}`);
  return new GameData(raw);
}
