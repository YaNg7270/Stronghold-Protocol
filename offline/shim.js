// Offline shim — loaded by index.html before the client (tools/patchIndex.mjs).
//
// The client opens one game socket, ws(s)://<host>/ws (js/net.js defaultWsUrl), and looks globalThis.WebSocket up when
// it connects. This module replaces that constructor: a socket to /ws becomes an OfflineSocket whose frames go to the
// local game server (offline/worker.js: a module SharedWorker — one server for every tab — or a dedicated Worker);
// any other URL still gets the browser's WebSocket.
// The OfflineSocket speaks the same subset of the WebSocket API net.js uses: readyState, onopen / onmessage / onclose /
// onerror, send(text), close(code, reason) — plus addEventListener for anything else.

const NativeWebSocket = globalThis.WebSocket;
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

let worker = null;
/** The channel to the server: a SharedWorker's port (one server for every tab), or a dedicated Worker. */
let port = null;
let seq = 0;
const sockets = new Map();

function onServerMessage(ev) {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'log') { (console[m.level] || console.log)('[offline-server]', ...(m.args || [])); return; }
  const s = sockets.get(m.id);
  if (!s) return;
  if (m.type === 'open') s._onOpen();
  else if (m.type === 'msg') s._onMessage(m.data);
  else if (m.type === 'close') s._onClose(m.code ?? 1000, m.reason ?? '');
}

function failAll(err) {
  console.error('[offline] game server failed to start', (err && err.message) || err);
  for (const s of [...sockets.values()]) s._onClose(1011, 'server error');
}

function serverPort() {
  if (port) return port;
  const url = new URL('./worker.js', import.meta.url);
  const opts = { type: 'module', name: 'stronghold-offline-server' };
  if (typeof SharedWorker === 'function') {
    try {
      worker = new SharedWorker(url, opts);
      port = worker.port;
      port.onmessage = onServerMessage;
      worker.onerror = failAll;
      port.start();
      // the page is going away: its sockets close on the shared server at once
      addEventListener('pagehide', () => { try { port.postMessage({ type: 'bye' }); } catch { /* closed */ } });
      return port;
    } catch { worker = null; port = null; }
  }
  worker = new Worker(url, opts);
  worker.onmessage = onServerMessage;
  worker.onerror = failAll;
  port = worker;
  return port;
}

class OfflineSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = String(url);
    this.protocol = '';
    this.extensions = '';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.readyState = CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._id = ++seq;
    sockets.set(this._id, this);
    serverPort().postMessage({ id: this._id, type: 'connect' });
  }

  _fire(type, init) {
    const ev = type === 'message' ? new MessageEvent('message', init) : type === 'close' ? new CloseEvent('close', init) : new Event(type);
    const h = this[`on${type}`];
    if (typeof h === 'function') { try { h.call(this, ev); } catch (err) { console.error(err); } }
    this.dispatchEvent(ev);
  }

  _onOpen() {
    if (this.readyState !== CONNECTING) return;
    this.readyState = OPEN;
    this._fire('open');
  }

  _onMessage(data) {
    if (this.readyState !== OPEN) return;
    this._fire('message', { data });
  }

  _onClose(code, reason) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    sockets.delete(this._id);
    this._fire('close', { code, reason, wasClean: code === 1000 });
  }

  send(data) {
    if (this.readyState === CONNECTING) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
    if (this.readyState !== OPEN) return;
    port.postMessage({ id: this._id, type: 'msg', data: String(data) });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    port.postMessage({ id: this._id, type: 'close', code, reason });
    // the close event follows asynchronously, like a real socket
    setTimeout(() => this._onClose(code, reason), 0);
  }
}

for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
  OfflineSocket[k] = v;
  OfflineSocket.prototype[k] = v;
}

const isGameSocket = (url) => {
  try { return new URL(String(url), location.href).pathname === '/ws'; } catch { return false; }
};

function WebSocketShim(url, protocols) {
  if (isGameSocket(url)) return new OfflineSocket(url);
  return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
}
for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) WebSocketShim[k] = v;
WebSocketShim.prototype = NativeWebSocket ? NativeWebSocket.prototype : OfflineSocket.prototype;

globalThis.WebSocket = WebSocketShim;
globalThis.__SP_OFFLINE__ = { version: 1, worker: () => worker };
