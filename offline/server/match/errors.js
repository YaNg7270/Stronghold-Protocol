// A refused intent: `code` is an ERR code (shared/constants.js) — the client shows ERR_TEXT[code] — or an unknown code
// whose message is shown as is (js/net.js errorText).
export class ServerError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'ServerError';
    this.code = code;
    this.detail = detail;
  }
}
