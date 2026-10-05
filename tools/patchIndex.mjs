// Patch the mirrored index.html for offline play (used by the dev server and the packaged build):
//   * the offline shim (/offline/shim.js) is loaded as the first module, before /js/main.js, so the client's socket
//     (js/net.js reads globalThis.WebSocket at connect time) talks to the in-page game server;
//   * the Google Fonts <link> (and its preconnects) point at the local copy made by tools/mirror (fonts/google/fonts.css).

export const SHIM_TAG = '<script type="module" src="/offline/shim.js"></script>';

/** @param {string} html the original index.html @returns {string} */
export function patchIndex(html) {
  let out = html;
  out = out.replace(/\s*<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>/g, '');
  out = out.replace(/href="https:\/\/fonts\.googleapis\.com\/css2[^"]*"/, 'href="/fonts/google/fonts.css"');
  if (!out.includes(SHIM_TAG)) {
    const anchor = '<link rel="modulepreload" href="/js/main.js" />';
    if (out.includes(anchor)) out = out.replace(anchor, `${SHIM_TAG}\n  ${anchor}`);
    else out = out.replace('<script type="module" src="/js/main.js"', `${SHIM_TAG}\n  <script type="module" src="/js/main.js"`);
  }
  return out;
}
