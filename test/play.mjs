// Play one full solo match headlessly: node test/play.mjs [difficulty] [seed]
import { createHarness } from './harness.mjs';
import { playPrep, tryReq } from './bot.mjs';

export async function playMatch({ difficulty = 'NORMAL', seed = 1, verbose = true, band = null } = {}) {
  const h = await createHarness({ seed });
  const c = h.client('测试博士');
  const w = c.hello();
  if (w.t !== 'welcome') throw new Error('no welcome');
  c.ok('room.create', { mode: 'solo', difficulty });
  c.ok('room.start');
  c.ok('g.infoReady');
  const bands = h.data.bandList().filter((b) => (b.modeTypeList || []).includes('SINGLE'));
  const bandId = band || bands[seed % bands.length].bandId;
  c.ok('g.band', { bandId });
  const log = [];
  let guard = 0;
  while (!c.state.result && guard++ < 400) {
    const pub = c.state.pub;
    switch (pub.phase) {
      case 'BATTLE_CHECK': case 'ROUND_START': case 'SETTLE': h.advance(1000); break;
      case 'SP_DRAFT': {
        const sp = pub.sp;
        if (verbose) console.log(`  R${pub.round} 机变 ${sp.family}: ${sp.cards.map((x) => x.name).join(' / ')}`);
        if (!tryReq(c, 'g.choice', { idx: 0 })) throw new Error(`choice refused ${JSON.stringify(c.lastError)}`);
        break;
      }
      case 'PREP': {
        playPrep(h, c);
        if (!tryReq(c, 'g.ready', { ready: true })) throw new Error(`ready refused ${JSON.stringify(c.lastError)}`);
        break;
      }
      case 'COMBAT': case 'FINAL_ASSAULT': case 'HIDDEN_CORE': {
        const before = c.state.priv.lp;
        const res = h.runBattles(c);
        for (const r of res) {
          const pr = r.result.perPlayer[c.state.welcome.playerId] || {};
          const line = `R${pub.round} ${r.msg.kind} ${r.result.reason} kills ${pr.killed}/${pr.total} leaks ${(pr.leaked || []).length} t=${r.time.toFixed(1)}s board=${c.state.priv.board.length} lv${c.state.priv.shop.level} bossDmg=${Math.round(pr.bossDamage || 0)}`;
          log.push(line);
          if (verbose) console.log('  ' + line, `LP ${before}`);
        }
        if (!res.length) h.advance(1000);
        break;
      }
      default: h.advance(500);
    }
  }
  return { h, c, log, result: c.state.result };
}

if (process.argv[1] && process.argv[1].endsWith('play.mjs')) {
  const difficulty = process.argv[2] || 'NORMAL';
  const seed = Number(process.argv[3] || 1);
  const t0 = Date.now();
  const { result, c } = await playMatch({ difficulty, seed });
  console.log(`result: victory=${result?.victory} rounds=${result?.roundsPassed}/${result?.lastRound} lp=${c.state.priv.lp} hidden=${result?.hiddenReached}/${result?.hiddenCleared} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
