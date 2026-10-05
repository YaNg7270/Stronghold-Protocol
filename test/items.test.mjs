// Consume-on-equip items and Arts (engine built-ins + the served items/meta.js wrappers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { deployAll } from './bot.mjs';

async function setup(seed = 31) {
  const h = await createHarness({ seed });
  const c = h.client('道具');
  c.hello();
  c.ok('room.create', { mode: 'solo', difficulty: 'NORMAL' });
  c.ok('room.start');
  c.ok('g.infoReady');
  c.ok('g.band', { bandId: 'band_bldsk' });
  h.advance(6000);
  const m = [...h.server.rooms.values()][0].match;
  const p = m.players[0];
  p.funds = 50;
  // two operators on the board
  for (let i = 0; i < 2; i++) p.gainChess(m.pool.take(m.rng, { maxTier: 2 }));
  m.flush();
  deployAll(h, c);
  return { h, c, m, p };
}

const equipNew = (c, p, itemId) => {
  const it = p.gainItem(itemId);
  assert.ok(it, `gained ${itemId}`);
  p.match.flush();
  const holder = c.state.priv.board.find((x) => x.kind === 'chess');
  assert.ok(holder, 'an operator on the board');
  const r = c.request('g.equip', { itemUid: it.uid, targetUid: holder.uid });
  return { r, holder };
};

test('盟约之币 gives funds and is consumed', async () => {
  const { c, p } = await setup();
  const before = p.funds;
  const { r } = equipNew(c, p, 'chess_item_1_03_e_a');
  assert.equal(r.t, 'ok');
  assert.equal(p.funds, before + 1);
  assert.ok(!p.allPieces().some((e) => e.piece.kind === 'item' && e.piece.id === 'chess_item_1_03_e_a'));
});

test('随身身份牌 adds 3 layers to the carrier bonds', async () => {
  const { c, p, h } = await setup();
  const { holder } = equipNew(c, p, 'chess_item_1_04_e_a');
  const bonds = h.data.chess(holder.id).bonds;
  for (const b of bonds) assert.ok((p.layers[b] || 0) >= 3, `${b} layers`);
});

test('见钱眼开玩偶 pays next round; 人事部文档 raises the deploy cap to 9', async () => {
  const { c, p } = await setup();
  equipNew(c, p, 'chess_item_2_07_e_a');
  assert.equal(p.pendingFunds, 2);
  equipNew(c, p, 'chess_item_6_08_e_a');
  assert.equal(p.deployCap(), 9);
});

test('精打细算玩偶 pays every round start', async () => {
  const { c, p, m } = await setup();
  equipNew(c, p, 'chess_item_2_05_e_a');
  assert.ok(p.effects.some((e) => e.key === 'effect:builtin_round_coin'));
  const before = p.funds;
  m.meta.roundStart(p);
  assert.equal(p.funds, before + 1);
});

test('博士投影 (golden) promotes the carrier at once', async () => {
  const { c, p } = await setup();
  const { holder } = equipNew(c, p, 'chess_item_5_06_e_b');
  const now = p.find(holder.uid).piece;
  assert.equal(now.golden, true);
});

test('拟态物质 / 简易通讯机 grant operators', async () => {
  const { c, p } = await setup();
  const n0 = p.allPieces().filter((e) => e.piece.kind === 'chess').length;
  equipNew(c, p, 'chess_item_5_05_e_a');
  equipNew(c, p, 'chess_item_2_06_e_a');
  const n1 = p.allPieces().filter((e) => e.piece.kind === 'chess').length;
  assert.ok(n1 >= n0 + 1, `${n0} → ${n1}`);
});

test('紧急调度券 takes an operator out of the shop; 寻呼模块 opens a special offer', async () => {
  const { c, p } = await setup();
  const shopChess = () => p.shop.slots.filter((s) => s && s.kind === 'chess' && !s.sold).length;
  const s0 = shopChess();
  equipNew(c, p, 'chess_item_2_02_e_a');
  assert.equal(shopChess(), s0 - 1);
  equipNew(c, p, 'chess_item_4_01_e_a');
  assert.ok(p.shop.offers.length >= 1);
});

test('画卷 copies the operator in range', async () => {
  const { c, p } = await setup();
  const art = p.gainItem('chess_item_6_02_m');
  p.match.flush();
  const target = c.state.priv.board.find((x) => x.kind === 'chess');
  const n0 = p.allPieces().filter((e) => e.piece.kind === 'chess' && p.data.baseOf(e.piece.id) === p.data.baseOf(target.id)).length;
  const r = c.request('g.art', { itemUid: art.uid, row: target.row, col: target.col, dir: 'RIGHT' });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const n1 = p.allPieces().filter((e) => e.piece.kind === 'chess' && (p.data.baseOf(e.piece.id) === p.data.baseOf(target.id))).length;
  assert.ok(n1 === n0 + 1 || p.stats.merges > 0, `copied (or merged): ${n0} → ${n1}`);
  assert.ok(!p.allPieces().some((e) => e.piece.uid === art.uid), 'the Art is used up');
});

test('教鞭 adds a bounty to the next battles', async () => {
  const { c, p } = await setup();
  const art = p.gainItem('chess_item_6_03_m');
  p.match.flush();
  const target = c.state.priv.board.find((x) => x.kind === 'chess');
  const r = c.request('g.art', { itemUid: art.uid, row: target.row, col: target.col, dir: 'RIGHT' });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  assert.equal(p.bounties.length, 1);
  assert.ok(p.effects.some((e) => e.id === p.bounties[0].id));
});
