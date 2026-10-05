// Browser end-to-end check of the offline build: the real client in Chromium against the in-page server, with every
// non-localhost request blocked (proves nothing is fetched from the internet).
//
//   node test/e2e.mjs [--shots dir] [--rounds n] [--difficulty NORMAL] [--headed]
//
// Flow: title → lobby (独立模拟) → room → briefing → strategy → rounds (buy / deploy via the client's own net API,
// ready, watch the local battle) → … Screenshots of every phase go to --shots. Exits non-zero on page errors.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createHandler } from '../tools/serve.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : acc), []));
const shots = path.resolve(args.shots || path.join(repo, 'test-output', 'e2e'));
const maxRounds = Number(args.rounds || 2);
const difficulty = args.difficulty || 'NORMAL';
fs.mkdirSync(shots, { recursive: true });

const server = http.createServer(createHandler({ root: path.join(repo, 'mirror'), offline: path.join(repo, 'offline') }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const exe = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, headless: !args.headed, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const blocked = [];
await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
  blocked.push(u.href);
  return route.abort();
});
const page = await context.newPage();
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const t = `[${m.type()}] ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(t);
});
page.on('worker', (w) => w.on('console', (m) => logs.push(`[worker ${m.type()}] ${m.text()}`)));

let n = 0;
const shot = async (name) => { await page.screenshot({ path: path.join(shots, `${String(++n).padStart(2, '0')}-${name}.png`) }); };
const sp = (fn, arg) => page.evaluate(fn, arg);
const state = () => sp(() => { const s = globalThis.__SP__?.store.get(); return s ? { route: null, phase: s.match.public?.phase, round: s.match.public?.round, priv: s.match.private, room: s.room, result: s.match.result } : null; });
const req = (t, fields = {}) => sp(async ([t, f]) => { try { await globalThis.__SP__.net.request(t, f); return 'ok'; } catch (e) { return `${e.code}: ${e.message}`; } }, [t, fields]);
const waitPhase = async (phases, ms = 30000) => {
  const list = Array.isArray(phases) ? phases : [phases];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await state();
    if (s && list.includes(s.phase)) return s;
    if (s?.result) return s;
    await page.waitForTimeout(250);
  }
  throw new Error(`timeout waiting for ${list.join('/')}`);
};

try {
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForSelector('.title-login input', { timeout: 20000 });
  await shot('title');
  await page.fill('.title-login input', '离线博士');
  await page.click('.title-login button.btn--primary, .title-login button:has-text("开始")');
  await page.waitForSelector('.mode-cards', { timeout: 15000 });
  await page.waitForTimeout(800);
  await shot('lobby');
  // 独立模拟 + difficulty, then create
  await page.click('.mode-card:has-text("独立")');
  await page.click(`.diff-card:has-text("${{ FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' }[difficulty]}")`);
  await page.getByRole('button', { name: /开始.*模拟/ }).click();
  await page.waitForSelector('.room-screen', { timeout: 10000 });
  await page.waitForTimeout(500);
  await shot('room');
  await page.click('button:has-text("开始模拟")');
  await waitPhase('INFO_CHECK');
  await page.waitForTimeout(2500);
  await shot('briefing');
  await page.click('button:has-text("准备就绪")');
  await waitPhase('BAND_DRAFT');
  await page.waitForTimeout(1500);
  await shot('band-draft');
  await page.click('button:has-text("确认选择")');
  await waitPhase(['BATTLE_CHECK', 'ROUND_START', 'PREP']);
  for (let r = 1; r <= maxRounds; r++) {
    let s = await waitPhase(['PREP', 'SP_DRAFT'], 20000);
    if (s.phase === 'SP_DRAFT') {
      await page.waitForTimeout(1200);
      await shot(`r${s.round}-sp`);
      console.log('choice', await req('g.choice', { idx: 0 }));
      s = await waitPhase('PREP');
    }
    await page.waitForTimeout(2500);
    await shot(`r${s.round}-prep`);
    // buy what fits and deploy through the client's own placement rules
    const bought = await sp(async () => {
      const { store, net } = globalThis.__SP__;
      const out = [];
      for (let k = 0; k < 6; k++) {
        const priv = store.get().match.private;
        const slot = priv.shop.slots.findIndex((x) => x && !x.sold && x.kind === 'chess' && x.price <= priv.funds);
        if (slot < 0) break;
        try { await net.request('g.buy', { slot }); out.push(slot); } catch (e) { out.push(e.code); break; }
      }
      return out;
    });
    const deployed = await sp(async () => {
      const { store, net } = globalThis.__SP__;
      const gl = await import('/js/ui/gameLogic.js');
      const data = (await import('/js/data.js')).data;
      await data.loadAll(['chess', 'tokens', 'items', 'stages', 'effects']);
      const out = [];
      for (let k = 0; k < 10; k++) {
        const s = store.get();
        const priv = s.match.private;
        const ctx = gl.placementContext({ priv, stage: data.lookup('stages', s.match.public.stageId), editable: true, field: gl.deployFieldOf(s.match.public, s.me.playerId),
          getChess: (id) => data.lookup('chess', id), getToken: (id) => data.lookup('tokens', id), getItem: (id) => data.lookup('items', id), getEffect: (id) => data.lookup('effects', id) });
        const p = priv.hand.find((x) => x && x.kind === 'chess');
        if (!p) break;
        let done = false;
        for (let r = 9; r <= 12 && !done; r++) for (let c = 10; c >= 2 && !done; c--) {
          if (ctx.boardAt.has(`${r},${c}`)) continue;
          const res = gl.canPlace(ctx, p.uid, { area: 'board', row: r, col: c });
          if (res.ok && res.action === 'move') { try { await net.request('g.move', { uid: p.uid, to: { area: 'board', row: r, col: c }, dir: 'RIGHT' }); out.push([r, c]); done = true; } catch (e) { out.push(e.code); done = true; } }
        }
        if (!done) break;
      }
      return out;
    });
    console.log(`R${s.round} bought`, bought, 'deployed', deployed);
    await page.waitForTimeout(1500);
    await shot(`r${s.round}-deployed`);
    if (args.reload && r === 1) {
      // P6: a reload in the middle of the prep keeps the match (the Worker restores it from IndexedDB)
      const before = (await state()).priv.board.map((p) => p.uid).sort();
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'load' });
      const back = await waitPhase('PREP', 30000);
      const after = back.priv.board.map((p) => p.uid).sort();
      console.log('reload in prep: board', JSON.stringify(before) === JSON.stringify(after) ? 'kept' : `CHANGED ${before} → ${after}`);
      if (JSON.stringify(before) !== JSON.stringify(after)) errors.push('reload lost the board');
      await page.waitForTimeout(2000);
      await shot('r1-after-reload');
    }
    console.log('ready', await req('g.ready', { ready: true }));
    s = await waitPhase(['COMBAT', 'FINAL_ASSAULT', 'HIDDEN_CORE']);
    if (args.timing) {
      // when the local battle ends compared to the countdown the HUD shows (user report: "the last 3 seconds freeze")
      const t = await sp(async () => {
        const { store } = globalThis.__SP__;
        const t0 = Date.now();
        const dl = store.get().match.public.deadline;
        const off = store.get().clock?.offset || 0;
        let done = null, settle = null;
        while (Date.now() - t0 < 90000) {
          const s = store.get();
          if (done == null && s.match.battle && s.match.battle.done) done = Date.now() + off;
          if (s.match.public.phase !== 'COMBAT') { settle = Date.now() + off; break; }
          await new Promise((r) => setTimeout(r, 50));
        }
        return { battleDoneVsDeadline: done && dl ? done - dl : null, settleVsDeadline: settle && dl ? settle - dl : null };
      });
      console.log('timing (ms, negative = before the countdown hits 0):', JSON.stringify(t));
    }
    await page.waitForTimeout(6000);
    await shot(`r${s.round}-combat`);
    if (args.reload && r === 1) {
      // a reload in the middle of the battle: the battle is resent (b.start, elapsed) and still settles
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'load' });
      await waitPhase(['COMBAT', 'SETTLE', 'ROUND_START', 'PREP'], 30000);
      await page.waitForTimeout(3000);
      await shot('r1-combat-after-reload');
      console.log('reload in combat: phase', (await state()).phase);
    }
    s = await waitPhase(['SETTLE', 'ROUND_START', 'PREP', 'RESULT'], 120000);
    await page.waitForTimeout(800);
    await shot(`r${s.round}-after`);
    const st = await state();
    console.log(`R${s.round}: lp=${st.priv?.lp} funds=${st.priv?.funds} phase=${st.phase}`);
    if (st.result) {
      await page.waitForTimeout(3000);
      await shot('result');
      break;
    }
  }
} catch (err) {
  errors.push(`flow: ${err.message}`);
  await shot('failure').catch(() => {});
} finally {
  fs.writeFileSync(path.join(shots, 'console.log'), logs.join('\n'));
  await browser.close();
  server.close();
}
console.log(`blocked external requests: ${blocked.length}${blocked.length ? ' e.g. ' + blocked.slice(0, 3).join(', ') : ''}`);
if (errors.length) {
  console.log('ERRORS:\n' + errors.slice(0, 30).join('\n'));
  process.exitCode = 1;
} else console.log('e2e ok — screenshots in', shots);
