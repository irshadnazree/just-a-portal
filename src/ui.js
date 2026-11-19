// Local-only UI server: static files + JSON API + event stream. Binds 127.0.0.1.
import http from 'node:http';
import crypto from 'node:crypto';
import { sendJson, readJsonBody, HttpError } from './util.js';
// Embedded at import time, so `bun build` bundles the UI into one file and nothing is read from disk.
import indexHtml from '../public/index.html' with { type: 'text' };
import appJs from '../public/app.js' with { type: 'text' };
import styleCss from '../public/style.css' with { type: 'text' };
import iconSvg from '../public/icon.svg' with { type: 'text' };

const STATIC = {
  '/': [Buffer.from(indexHtml), 'text/html; charset=utf-8'],
  '/app.js': [Buffer.from(appJs), 'text/javascript; charset=utf-8'],
  '/style.css': [Buffer.from(styleCss), 'text/css; charset=utf-8'],
  '/icon.svg': [Buffer.from(iconSvg), 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

export function createUiServer(portal, config) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenBuf = Buffer.from(token);
  // Computed per request so an ephemeral port (0) is reflected after listen().
  const allowedHosts = () => new Set([`127.0.0.1:${config.uiPort}`, `localhost:${config.uiPort}`]);

  function checkToken(req) {
    const got = Buffer.from(String(req.headers['x-portal-token'] || ''));
    if (got.length !== tokenBuf.length || !crypto.timingSafeEqual(got, tokenBuf)) throw new HttpError(401, 'bad or missing token');
  }

  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 0, headersTimeout: 10_000 }, (req, res) => {
    handle(req, res).catch((err) => {
      if (!(err instanceof HttpError)) console.error('[ui]', err);
      sendJson(res, err.status || 500, { error: err.status ? err.message : 'internal error' }, SECURITY_HEADERS);
      if (req.readable) req.resume();
    });
  });

  async function handle(req, res) {
    // DNS-rebinding guard: only our exact loopback host names, on every route.
    const hosts = allowedHosts();
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(421, 'bad host');
    const origin = req.headers.origin;
    if (origin !== undefined && ![...hosts].some((h) => origin === `http://${h}`)) throw new HttpError(403, 'bad origin');
    const site = req.headers['sec-fetch-site'];
    if (site && !['same-origin', 'none'].includes(site)) throw new HttpError(403, 'cross-site request');

    const url = new URL(req.url, 'http://local');
    const p = url.pathname;

    if (req.method === 'GET' && STATIC[p]) {
      const [data, type] = STATIC[p];
      res.writeHead(200, { 'content-type': type, 'content-length': data.length, ...SECURITY_HEADERS });
      return res.end(data);
    }

    if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');
    // Everything under /api needs the token, which only reaches the page via the URL fragment
    // printed in the terminal (fragments are never sent to servers or logged).
    checkToken(req);

    if (req.method === 'GET' && p === '/api/status') {
      return sendJson(res, 200, { status: portal.publicStatus(), transfers: portal.listTransfers(), transfersRev: portal.transfersRev() }, SECURITY_HEADERS);
    }
    if (req.method === 'GET' && p === '/api/events') return eventStream(req, res);
    if (req.method === 'POST' && p === '/api/refresh') {
      await portal.refreshStatus();
      return sendJson(res, 200, { status: portal.publicStatus() }, SECURITY_HEADERS);
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    // Mutations: require a same-origin Origin header (browsers always send it on fetch POST).
    if (!origin) throw new HttpError(403, 'missing origin');

    if (p === '/api/send') {
      const body = await readJsonBody(req, 4096);
      const t = await portal.startSend({ peerId: String(body.peerId || ''), name: body.name, size: body.size });
      return sendJson(res, 200, t, SECURITY_HEADERS);
    }
    let m = p.match(/^\/api\/send\/([A-Za-z0-9_-]{22})\/body$/);
    if (m) {
      const t = await portal.sendBody(m[1], req);
      return sendJson(res, t.state === 'done' ? 200 : 502, t, SECURITY_HEADERS);
    }
    m = p.match(/^\/api\/transfers\/([A-Za-z0-9_-]{22})\/(accept|decline|cancel)$/);
    if (m) {
      req.resume();
      const [, id, action] = m;
      const t = action === 'accept' ? await portal.acceptIncoming(id) : action === 'decline' ? portal.declineIncoming(id) : portal.cancel(id);
      return sendJson(res, 200, t, SECURITY_HEADERS);
    }
    throw new HttpError(404, 'not found');
  }

  function eventStream(req, res) {
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', portal.publicStatus());
    const onStatus = (s) => send('status', s);
    const onTransfer = (t) => send('transfer', t);
    portal.events.on('status', onStatus);
    portal.events.on('transfer', onTransfer);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      portal.events.off('status', onStatus);
      portal.events.off('transfer', onTransfer);
    });
  }

  return {
    token,
    get url() {
      return `http://127.0.0.1:${config.uiPort}/#k=${token}`;
    },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: config.uiPort, exclusive: true }, () => {
        config.uiPort = server.address().port;
        resolve();
      });
    }),
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
    address: () => server.address(),
  };
}
