// node --test test/  — offline server behaviour (needs the mirror: npm run mirror).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from './harness.mjs';
import { playMatch } from './play.mjs';
import { playPrep, tryReq } from './bot.mjs';
import { memoryStore } from '../offline/server/storage.js';

/** A solo match standing in its first PREP. */
async function inPrep({ seed = 7, difficulty = 'NORMAL', storage = null, band = 'band_bldsk' } = {}) {
  const h = await createHarness({ seed, storage });
  const c = h.client('测试');
  assert.equal(c.hello().t, 'welcome');
  c.ok('room.create', { mode: 'solo', difficulty });
  c.ok('room.start');
  c.ok('g.infoReady');
  c.ok('g.band', { bandId: band });
  h.advance(6000);
  assert.equal(c.state.pub.phase, 'PREP');
  const match = () => [...h.server.rooms.values()][0].match;
  return { h, c, match };
}

test('a full solo match reaches its result', async () => {
  const { result, c } = await playMatch({ difficulty: 'FUNNY', seed: 3, rich: true, verbose: false });
  assert.ok(result, 'm.result arrives');
  assert.equal(c.state.pub.phase, 'RESULT');
  assert.equal(result.players.length, 1);
  assert.ok(result.roundsPassed >= 1);
  assert.equal(c.state.room.inMatch, false);
});

test('coop rooms are refused offline with a readable message', async () => {
  const h = await createHarness({ seed: 1 });
  const c = h.client('x');
  c.hello();
  const r = c.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
  assert.equal(r.t, 'error');
  assert.match(r.msg, /独立模拟/);
});

test('round 1: income, shop slots, buying spends funds and fills the hand', async () => {
  const { c } = await inPrep();
  const priv = c.state.priv;
  assert.equal(priv.funds, 4, 'economy.income[1]');
  assert.equal(priv.shop.slots.filter((s) => s && s.kind === 'chess').length, 3, 'level 1: 3 chess slots');
  assert.equal(priv.shop.slots.filter((s) => s && s.kind === 'item').length, 1);
  const i = priv.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.price <= priv.funds);
  const price = priv.shop.slots[i].price;
  c.ok('g.buy', { slot: i });
  assert.equal(c.state.priv.funds, 4 - price);
  assert.ok(c.state.priv.shop.slots[i].sold);
  assert.equal(c.state.priv.hand.filter(Boolean).length >= 1, true);
  assert.equal(c.request('g.buy', { slot: i }).code, 'SOLD_OUT');
});

test('selling refunds and returns the copy to the pool', async () => {
  const { c, match } = await inPrep();
  const priv = c.state.priv;
  const i = priv.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.price <= priv.funds);
  const id = priv.shop.slots[i].id;
  const before = match().pool.counts.get(id);
  c.ok('g.buy', { slot: i });
  const piece = c.state.priv.hand.find((p) => p && p.id === id);
  const funds = c.state.priv.funds;
  c.ok('g.sell', { uid: piece.uid });
  assert.equal(c.state.priv.funds, funds + 1);
  assert.equal(match().pool.counts.get(id), before + 1);
});

test('three copies merge into the elite and queue a promotion reward', async () => {
  const { c, match } = await inPrep();
  const m = match();
  const p = m.players[0];
  const base = m.pool.take(m.rng, { maxTier: 1 });
  p.gainChess(base);
  p.gainChess(base);
  const elite = p.gainChess(base);
  assert.ok(elite.golden, 'the third copy completes the merge');
  assert.equal(p.copiesOf(base).length, 0);
  assert.ok(p.shop.offers.length >= 1, 'promotion reward offered');
  m.flush();
  assert.ok(c.state.priv.shop.rewardOffer);
  c.ok('g.reward', { idx: 0 });
  assert.equal(c.state.priv.shop.rewardOffer, null);
});

test('refresh, freeze and level-up follow the economy', async () => {
  const { c, match } = await inPrep();
  const p = match().players[0];
  p.funds = 30;
  p.touch();
  match().flush();
  c.ok('g.refresh');
  assert.equal(c.state.priv.funds, 29);
  c.ok('g.freeze');
  assert.equal(c.state.priv.shop.frozen, true);
  const price = c.state.priv.shop.upgradePrice;
  c.ok('g.levelUp');
  assert.equal(c.state.priv.shop.level, 2);
  assert.equal(c.state.priv.funds, 29 - price);
  assert.equal(c.state.priv.shop.slots.filter((s) => s && s.kind === 'chess').length, 4, 'level 2: 4 chess slots');
});

test('placement follows the client rules: deploy, refuse bad tiles, withdraw', async () => {
  const { h, c } = await inPrep();
  playPrep(h, c);
  const priv = c.state.priv;
  assert.ok(priv.board.length > 0, 'deployed');
  const p = priv.board[0];
  assert.equal(c.request('g.move', { uid: p.uid, to: { area: 'board', row: 0, col: 0 } }).code, 'BAD_TILE');
  const slot = c.state.priv.hand.findIndex((x) => !x);
  c.ok('g.move', { uid: p.uid, to: { area: 'hand', idx: slot } });
  assert.ok(c.state.priv.hand.some((x) => x && x.uid === p.uid));
});

test('a battle the client never reports is taken over by the server', async () => {
  const { h, c } = await inPrep();
  playPrep(h, c);
  c.ok('g.ready', { ready: true });
  assert.equal(c.state.pub.phase, 'COMBAT');
  assert.equal(c.starts.length, 1);
  c.starts.length = 0;
  h.advance(60_000);
  h.advance(30_000);
  assert.notEqual(c.state.pub.phase, 'COMBAT');
  assert.ok(c.inbox.some((m) => m.t === 'b.end' && m.reason === 'takeover'));
});

test('the server state survives a restart (persisted match resumes)', async () => {
  const storage = memoryStore();
  const { h, c } = await inPrep({ storage, seed: 11 });
  playPrep(h, c);
  const token = c.state.welcome.token;
  const priv = c.state.priv;
  h.server.tick();
  h.server._persist(true);
  // a new server on the same storage (a page reload in the browser)
  const h2 = await createHarness({ seed: 99, storage, start: h.now + 5000 });
  const c2 = h2.client('测试');
  const w = c2.hello(token);
  assert.equal(w.playerId, c.state.welcome.playerId, 'same session');
  assert.equal(c2.state.pub.phase, 'PREP');
  assert.equal(c2.state.priv.funds, priv.funds);
  assert.deepEqual(c2.state.priv.board.map((p) => p.uid), priv.board.map((p) => p.uid));
  // and it plays on
  c2.ok('g.ready', { ready: true });
  assert.equal(c2.state.pub.phase, 'COMBAT');
  const res = h2.runBattles(c2);
  assert.equal(res.length, 1);
  h2.advance(4000);
  assert.ok(['ROUND_START', 'PREP', 'SP_DRAFT', 'SETTLE'].includes(c2.state.pub.phase));
});

test('a reconnect with the token resumes the session and resends the battle', async () => {
  const { h, c } = await inPrep();
  playPrep(h, c);
  c.ok('g.ready', { ready: true });
  const token = c.state.welcome.token;
  c.conn.closed();
  const c2 = h.client('测试');
  const w = c2.hello(token);
  assert.equal(w.playerId, c.state.welcome.playerId);
  assert.equal(c2.state.pub.phase, 'COMBAT');
  assert.equal(c2.starts.length, 1, 'b.start resent');
  assert.equal(h.runBattles(c2).length, 1);
});

test('机变 draft: a solo round offers 3 cards and a pick moves on to PREP', async () => {
  const { h, c } = await inPrep({ difficulty: 'NORMAL', seed: 21 });
  const sp = h.data.mode('mode_single_normal').spRounds;
  let guard = 0;
  while (c.state.pub.round < sp[0] && guard++ < 50) {
    if (c.state.pub.phase === 'PREP') {
      const m = [...h.server.rooms.values()][0].match;
      m.players[0].funds += 30; m.players[0].touch(); m.flush();
      playPrep(h, c);
      c.ok('g.ready', { ready: true });
    } else if (['COMBAT'].includes(c.state.pub.phase)) h.runBattles(c);
    else h.advance(1000);
  }
  while (c.state.pub.phase !== 'SP_DRAFT' && guard++ < 80) h.advance(500);
  assert.equal(c.state.pub.phase, 'SP_DRAFT');
  assert.equal(c.state.pub.sp.cards.length, 3);
  assert.ok(tryReq(c, 'g.choice', { idx: 0 }));
  assert.equal(c.state.pub.phase, 'PREP');
});

test('after the result the room can start another match', async () => {
  const { h, c } = await playMatch({ difficulty: 'FUNNY', seed: 4, rich: false, verbose: false });
  assert.ok(c.state.result);
  assert.equal(c.state.room.inMatch, false);
  c.ok('room.start');
  assert.equal(c.state.room.inMatch, true);
  assert.equal(c.state.pub.phase, 'INFO_CHECK');
  assert.equal(c.state.pub.round, 0);
  h.advance(30_000);
  assert.equal(c.state.pub.phase, 'BAND_DRAFT');
});
