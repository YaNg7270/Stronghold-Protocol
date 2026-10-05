// The served sim, wired to the match data: simdata.setSimData installs the frozen data/*.json the battles and the
// content modules read (exactly what js/battle/runner.js loadBrowserSim does in the page), and the content modules'
// prep-side registry (registerAllMeta) is loaded for the meta host.

import { setSimData, DataSource } from '../../sim/simdata.js';
import * as support from '../../sim/content/support/index.js';
import * as spec from '../../sim/spec.js';

/** @param {import('./data.js').GameData} data */
export async function installSim(data) {
  const raw = data.simRaw();
  setSimData(raw);
  if (typeof support.setGameData === 'function') support.setGameData(null);
  const content = await import('../../sim/content/index.js');
  return { spec, content, support, ds: new DataSource(raw, null) };
}
