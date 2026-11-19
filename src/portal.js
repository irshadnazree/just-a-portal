// Core: Tailscale watchdog, the tailnet-only peer server (receive side) and the peer client (send side).
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';
import * as ts from './tailscale.js';
import {
  generateEphemeral, deriveSession, offerContext, EncryptStream, DecryptStream,
  isValidPub, isValidTransferId, newTransferId,
} from './crypto.js';
import { sanitizeFilename, createPartFile, finalizePartFile, removeQuiet } from './files.js';
import { sendJson, readJsonBody, HttpError, MeterStream, Semaphore } from './util.js';

const TERMINAL = new Set(['done', 'declined', 'failed', 'cancelled', 'expired']);

export function createPortal(config) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const lookups = new Semaphore(config.maxConcurrentLookups, config.maxQueuedLookups);
  let rev = 0;

  /** @type {Map<string, any>} */
  const transfers = new Map(); // both directions, keyed by transferId
  const peerSockets = new Set(); // every socket on the peer server
  const outgoingReqs = new Set(); // every request we made to a peer

  let status = { running: false, state: 'Starting', peers: [] };
  let statusAt = 0;
  let statusRev = 0;
  let receivedBytes = 0; // running total written by all receives (for disk reservations)
  let peerServer = null;
  let boundIp = null;
  let listenError = null;
  let watchdogTimer = null;
  let checking = null;

  // ---------- status / watchdog ----------

  function publicStatus() {
    return {
      rev: statusRev,
      running: status.running,
      state: status.state,
      error: status.error,
      self: status.running ? { name: status.selfName, dnsName: status.selfDnsName, ip: status.selfIPv4 } : null,
      tailnet: status.tailnet,
      listening: !!peerServer && boundIp === status.selfIPv4,
      listenError: listenError || undefined,
      peers: (status.peers || []).map((p) => ({
        id: p.id, name: p.name, dnsName: p.dnsName, os: p.os, online: p.online, ip: p.ipv4,
        sameUser: !!p.userId && p.userId === status.selfUserId,
      })),
      downloadDir: config.downloadDir,
    };
  }

  async function refreshStatus() {
    if (checking) return checking;
    checking = (async () => {
      const next = await ts.getStatus();
      const wasUp = status.running ? status.selfIPv4 : null;
      const nowUp = next.running ? next.selfIPv4 : null;
      status = next;
      statusAt = Date.now();
      statusRev++;
      if (wasUp && wasUp !== nowUp) teardown(nowUp ? 'Tailscale address changed' : 'Tailscale disconnected');
      if (nowUp && boundIp !== nowUp) await bindPeerServer(nowUp);
      if (!nowUp && peerServer) await closePeerServer();
      events.emit('status', publicStatus());
      return status;
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  /** Fresh check (<= 1 s old) used right before any security-relevant action. */
  async function requireRunning() {
    const s = Date.now() - statusAt < 1000 ? status : await refreshStatus();
    if (!s.running || !s.selfIPv4) throw new HttpError(503, 'Tailscale is not connected');
    if (!peerServer || boundIp !== s.selfIPv4) throw new HttpError(503, 'Peer listener is not bound to the Tailscale address');
    return s;
  }

  /** Abort everything in flight. Called when Tailscale goes away or changes identity. */
  function teardown(reason) {
    for (const req of outgoingReqs) req.destroy(new Error(reason));
    outgoingReqs.clear();
    for (const sock of peerSockets) sock.destroy();
    peerSockets.clear();
    for (const t of transfers.values()) {
      if (!TERMINAL.has(t.state)) fail(t, reason);
    }
  }

  // ---------- transfer bookkeeping ----------

  function snapshot(t) {
    return {
      id: t.id, direction: t.direction, state: t.state, name: t.name, size: t.size,
      bytes: t.bytes || 0, peerName: t.peerName, error: t.error, sha256: t.sha256,
      savedAs: t.savedAs ? path.basename(t.savedAs) : undefined, createdAt: t.createdAt, updatedAt: t.updatedAt,
      rev: t.rev,
    };
  }

  /** Apply a change. Terminal states are final: once reached, every later update is ignored. */
  function update(t, patch) {
    if (TERMINAL.has(t.state)) return false;
    Object.assign(t, patch, { updatedAt: Date.now(), rev: ++rev });
    if (TERMINAL.has(t.state)) {
      // Drop secrets and HTTP objects as soon as a transfer is finished.
      t.eph = undefined;
      t.session = undefined;
      t.respond = undefined;
      t.offerReq = undefined;
      clearTimeout(t.timer);
      t.abort?.abort();
    }
    events.emit('transfer', snapshot(t));
    return true;
  }

  function fail(t, error, state = 'failed') {
    if (TERMINAL.has(t.state)) return;
    const onTerminal = t.onTerminal;
    t.onTerminal = undefined;
    update(t, { state, error: String(error?.message || error) });
    onTerminal?.(state, t.error);
  }

  /** Revision of the newest transfer change; a snapshot taken now covers everything up to it. */
  function transfersRev() {
    return rev;
  }

  function listTransfers() {
    return [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
  }

  function prune() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const finished = [...transfers.values()].filter((t) => TERMINAL.has(t.state)).sort((a, b) => b.updatedAt - a.updatedAt);
    finished.forEach((t, i) => {
      if (t.updatedAt < cutoff || i >= config.maxHistory) transfers.delete(t.id);
    });
  }

  // ---------- peer server (receive side) ----------

  async function bindPeerServer(ip) {
    await closePeerServer();
    const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 0, headersTimeout: 10_000 }, (req, res) => {
      handlePeer(req, res).catch((err) => {
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
        else res.destroy();
      });
    });
    server.maxConnections = config.maxPeerConnections;
    // Node resets a kept-alive socket's timeout to server.timeout on its next request, so set it here
    // too (not only per socket below); without a callback, timed-out sockets are destroyed.
    server.setTimeout(config.idleTimeoutMs);
    server.on('connection', (sock) => {
      peerSockets.add(sock);
      sock.setTimeout(config.idleTimeoutMs, () => sock.destroy());
      sock.on('close', () => peerSockets.delete(sock));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      // Binding to the Tailscale IP (not 0.0.0.0) means the listener only exists while the address does.
      server.listen({ host: ip, port: config.peerPort, exclusive: true }, resolve);
    }).then(() => {
      peerServer = server;
      boundIp = ip;
      listenError = null;
      statusRev++;
    }, (err) => {
      listenError = `Cannot listen on ${ip}:${config.peerPort} (${err.code || err.message})`;
      statusRev++;
    });
  }

  async function closePeerServer() {
    const s = peerServer;
    peerServer = null;
    boundIp = null;
    if (!s) return;
    statusRev++;
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }

  /** Authenticate the remote end of a peer request. */
  async function authPeer(req) {
    const s = await requireRunning();
    const local = ts.normalizeIp(req.socket.localAddress);
    if (local !== s.selfIPv4) throw new HttpError(403, 'not received on the Tailscale address');
    const remote = ts.normalizeIp(req.socket.remoteAddress);
    const peer = s.peers.find((p) => p.ipv4 === remote);
    if (!peer) throw new HttpError(403, 'not a tailnet peer');
    const who = await lookups.run(() => ts.whois(remote));
    if (!who || !who.nodeId || who.nodeId !== peer.id) throw new HttpError(403, 'tailscale identity check failed');
    if (!config.allowAnyTailnetUser) {
      if (!who.userId || !s.selfUserId || who.userId !== s.selfUserId) {
        throw new HttpError(403, 'peer belongs to a different Tailscale user');
      }
    }
    return { nodeId: who.nodeId, name: peer.name || who.nodeName, ip: remote };
  }

  async function handlePeer(req, res) {
    const url = new URL(req.url, 'http://peer');
    if (req.method === 'POST' && url.pathname === '/v1/offer') return peerOffer(req, res);
    const m = url.pathname.match(/^\/v1\/data\/([A-Za-z0-9_-]{22})$/);
    if (req.method === 'POST' && m) return peerData(req, res, m[1]);
    throw new HttpError(404, 'not found');
  }

  async function peerOffer(req, res) {
    const who = await authPeer(req);
    const body = await readJsonBody(req, 4096);
    const { transferId, name, size, senderPub } = body;
    if (!isValidTransferId(transferId) || !isValidPub(senderPub)) throw new HttpError(400, 'bad offer');
    if (typeof name !== 'string' || name.length > 1024) throw new HttpError(400, 'bad name');
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'bad size');
    if (size > config.maxBytes) throw new HttpError(413, 'file exceeds receiver limit');
    if (transfers.has(transferId)) throw new HttpError(409, 'duplicate transfer id');
    const pending = [...transfers.values()].filter((t) => t.direction === 'in' && t.state === 'pending');
    if (pending.length >= config.maxPendingOffers) throw new HttpError(429, 'too many pending offers');
    if (pending.filter((t) => t.fromNodeId === who.nodeId).length >= config.maxPendingPerPeer) {
      throw new HttpError(429, 'too many pending offers from this peer');
    }

    const t = {
      id: transferId, direction: 'in', state: 'pending', name: sanitizeFilename(name), rawName: name, size,
      senderPub, fromNodeId: who.nodeId, peerName: who.name, createdAt: Date.now(),
    };
    transfers.set(t.id, t);

    // Hold the request open until the user decides; trickle whitespace so idle timers stay happy and
    // a dead path is noticed. JSON.parse ignores the leading whitespace.
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const keepalive = setInterval(() => res.write(' '), Math.min(10_000, config.idleTimeoutMs / 3));
    let answered = false;
    const respond = (obj) => {
      if (answered) return;
      answered = true;
      clearInterval(keepalive);
      res.end(JSON.stringify(obj));
    };
    t.respond = respond;
    t.onTerminal = (state, error) => respond({ decision: state === 'declined' ? 'declined' : 'expired', error });
    res.on('close', () => {
      clearInterval(keepalive);
      if (!answered) {
        answered = true;
        fail(t, 'sender cancelled', 'cancelled');
      }
    });
    t.timer = setTimeout(() => fail(t, 'offer timed out', 'expired'), config.offerTimeoutMs);
    update(t, {});
  }

  /** Called from the local UI. */
  async function acceptIncoming(id) {
    const t = transfers.get(id);
    if (!t || t.direction !== 'in') throw new HttpError(404, 'no such offer');
    if (t.state !== 'pending') throw new HttpError(409, `offer is ${t.state}`);
    await requireRunning();
    await fsp.mkdir(config.downloadDir, { recursive: true });
    const st = await fsp.lstat(config.downloadDir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new HttpError(500, 'download dir is not a real directory');
    const activeIn = () => [...transfers.values()].filter((x) => x.direction === 'in' && (x.state === 'accepted' || x.state === 'receiving'));
    // Bytes written to disk by receives between the free-space sample and the commit below are not
    // reflected in the sample, so they are subtracted explicitly.
    const writtenBefore = receivedBytes;
    let free = Infinity;
    try {
      const fsStat = await fsp.statfs(config.downloadDir);
      free = Number(fsStat.bavail) * Number(fsStat.bsize);
    } catch {}
    // Everything below is synchronous up to the state change, so concurrent accepts can't both pass.
    if (t.state !== 'pending') throw new HttpError(409, `offer is ${t.state}`);
    const active = activeIn();
    if (active.length >= config.maxActiveReceives) throw new HttpError(429, 'too many active downloads');
    const stillComing = active.reduce((a, x) => a + x.size - (x.bytes || 0), 0);
    const writtenSince = receivedBytes - writtenBefore;
    if (free - writtenSince < stillComing + t.size + 64 * 1024 * 1024) throw new HttpError(507, 'not enough disk space');
    const eph = generateEphemeral();
    t.session = deriveSession({
      privateKey: eph.privateKey, peerPub: t.senderPub, transferId: t.id, senderPub: t.senderPub,
      receiverPub: eph.pub, context: offerContext({ transferId: t.id, name: t.rawName, size: t.size }),
    });
    clearTimeout(t.timer);
    t.timer = setTimeout(() => fail(t, 'sender never started the upload', 'expired'), config.acceptTimeoutMs);
    const respond = t.respond;
    t.onTerminal = undefined;
    t.respond = undefined;
    update(t, { state: 'accepted' });
    respond({ decision: 'accepted', receiverPub: eph.pub });
    return snapshot(t);
  }

  function declineIncoming(id) {
    const t = transfers.get(id);
    if (!t || t.direction !== 'in') throw new HttpError(404, 'no such offer');
    if (t.state !== 'pending') throw new HttpError(409, `offer is ${t.state}`);
    fail(t, 'declined by you', 'declined');
    return snapshot(t);
  }

  async function peerData(req, res, id) {
    const who = await authPeer(req);
    const t = transfers.get(id);
    if (!t || t.direction !== 'in' || t.fromNodeId !== who.nodeId) throw new HttpError(404, 'no such transfer');
    if (t.state !== 'accepted') throw new HttpError(409, `transfer is ${t.state}`);
    // Single-threaded: this check-and-set is atomic, so only one upload per acceptance.
    clearTimeout(t.timer);
    t.abort = new AbortController();
    update(t, { state: 'receiving', bytes: 0 });
    const session = t.session;
    t.session = undefined;

    let part;
    try {
      part = await createPartFile(config.downloadDir, t.id);
      const meter = new MeterStream(t.size, (bytes) => {
        receivedBytes += bytes - (t.bytes || 0);
        update(t, { bytes });
      });
      // If the sender goes away before we reply (cancel, disconnect), don't keep the file: the sender
      // will report failure, so a saved copy here would be a silent disagreement.
      res.on('close', () => {
        if (!res.writableFinished) fail(t, 'sender disconnected before completion');
      });
      await pipeline(req, new DecryptStream(session), meter, part.handle.createWriteStream(), { signal: t.abort.signal });
      if (t.state !== 'receiving') throw new Error(t.error || 'aborted');
      // Re-check right before publishing the file.
      await requireRunning();
      if (t.state !== 'receiving') throw new Error(t.error || 'aborted');
      const savedAs = await finalizePartFile(part.partPath, config.downloadDir, t.name);
      part = null;
      if (!update(t, { state: 'done', bytes: t.size, sha256: meter.digest, savedAs })) {
        // Cancelled or disconnected while the file was being published: take it back out.
        await removeQuiet(savedAs);
        throw new Error(t.error || 'aborted');
      }
      sendJson(res, 200, { ok: true, sha256: meter.digest });
    } catch (err) {
      if (part) {
        await part.handle.close().catch(() => {});
        await removeQuiet(part.partPath);
      }
      fail(t, err.name === 'AbortError' ? (t.error || 'aborted') : err);
      if (!res.headersSent && !res.destroyed) sendJson(res, 400, { error: t.error });
    }
  }

  // ---------- peer client (send side) ----------

  function peerRequest(s, peerIp, { method, pathName, headers = {} }) {
    const req = http.request({
      host: peerIp,
      port: config.remotePeerPort,
      // Bind our end to our own Tailscale address. If Tailscale went down after the status check the
      // address no longer exists, so the connect fails instead of leaking onto another interface.
      localAddress: s.selfIPv4,
      method,
      path: pathName,
      headers,
      agent: false,
      timeout: config.idleTimeoutMs,
    });
    outgoingReqs.add(req);
    req.on('timeout', () => req.destroy(new Error('peer stopped responding')));
    req.on('close', () => outgoingReqs.delete(req));
    return req;
  }

  function readResponse(req) {
    return new Promise((resolve, reject) => {
      req.on('error', reject);
      req.on('response', (res) => {
        const parts = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > 1024 * 1024) req.destroy(new Error('peer response too large'));
          else parts.push(c);
        });
        res.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
          } catch {}
          resolve({ status: res.statusCode, body });
        });
        res.on('error', reject);
      });
    });
  }

  async function resolvePeer(peerId) {
    const s = await requireRunning();
    const peer = s.peers.find((p) => p.id === peerId);
    if (!peer || !peer.ipv4) throw new HttpError(404, 'peer not found on the tailnet');
    const who = await lookups.run(() => ts.whois(peer.ipv4));
    if (!who || who.nodeId !== peer.id) throw new HttpError(502, 'peer identity check failed');
    return { s, peer };
  }

  /** Called from the local UI: start an offer. The file body is uploaded only after acceptance. */
  async function startSend({ peerId, name, size }) {
    if (typeof name !== 'string' || !name || name.length > 1024) throw new HttpError(400, 'bad name');
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'bad size');
    const { s, peer } = await resolvePeer(peerId);
    const outgoing = [...transfers.values()].filter((t) => t.direction === 'out' && !TERMINAL.has(t.state));
    if (outgoing.length >= config.maxActiveSends) throw new HttpError(429, 'too many active sends');

    const t = {
      id: newTransferId(), direction: 'out', state: 'offering', name, size, peerId,
      peerIp: peer.ipv4, peerName: peer.name, createdAt: Date.now(), eph: generateEphemeral(),
    };
    transfers.set(t.id, t);
    update(t, {});

    (async () => {
      const body = Buffer.from(JSON.stringify({ transferId: t.id, name, size, senderPub: t.eph.pub }));
      const req = peerRequest(s, t.peerIp, {
        method: 'POST', pathName: '/v1/offer',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
      });
      t.offerReq = req;
      const done = readResponse(req);
      req.end(body);
      const { status: code, body: r } = await done;
      t.offerReq = undefined;
      if (TERMINAL.has(t.state)) return;
      if (code !== 200) throw new Error(r.error || `peer rejected the offer (HTTP ${code})`);
      if (r.decision === 'declined') return fail(t, 'declined by receiver', 'declined');
      if (r.decision !== 'accepted') return fail(t, r.error || 'receiver did not accept in time', 'expired');
      if (!isValidPub(r.receiverPub)) throw new Error('receiver sent an invalid key');
      t.session = deriveSession({
        privateKey: t.eph.privateKey, peerPub: r.receiverPub, transferId: t.id, senderPub: t.eph.pub,
        receiverPub: r.receiverPub, context: offerContext({ transferId: t.id, name, size }),
      });
      t.eph = undefined;
      t.timer = setTimeout(() => fail(t, 'upload was not started in time', 'expired'), config.acceptTimeoutMs);
      update(t, { state: 'accepted' });
    })().catch((err) => fail(t, err));

    return snapshot(t);
  }

  /** Called from the local UI with the browser's request stream carrying the file bytes. */
  async function sendBody(id, source) {
    const t = transfers.get(id);
    if (!t || t.direction !== 'out') throw new HttpError(404, 'no such transfer');
    if (t.state !== 'accepted') throw new HttpError(409, `transfer is ${t.state}`);
    clearTimeout(t.timer);
    t.abort = new AbortController();
    update(t, { state: 'sending', bytes: 0 });
    const session = t.session;
    t.session = undefined;
    try {
      const s = await requireRunning();
      const peer = s.peers.find((p) => p.id === t.peerId);
      if (!peer || peer.ipv4 !== t.peerIp) throw new Error('peer address changed');
      const req = peerRequest(s, t.peerIp, {
        method: 'POST', pathName: `/v1/data/${t.id}`, headers: { 'content-type': 'application/octet-stream' },
      });
      t.abort.signal.addEventListener('abort', () => req.destroy(new Error(t.error || 'aborted')), { once: true });
      const response = readResponse(req);
      response.catch(() => {});
      const meter = new MeterStream(t.size, (bytes) => update(t, { bytes }));
      await pipeline(source, meter, new EncryptStream(session), req, { signal: t.abort.signal });
      const { status: code, body: r } = await response;
      if (code !== 200 || !r.ok) throw new Error(r.error || `receiver failed (HTTP ${code})`);
      if (r.sha256 !== meter.digest) throw new Error('checksum mismatch reported by receiver');
      if (!update(t, { state: 'done', bytes: t.size, sha256: meter.digest })) throw new Error(t.error || 'aborted');
    } catch (err) {
      // If the receiver may have finished but its reply was lost we cannot know; say so.
      const msg = err.name === 'AbortError' ? (t.error || 'aborted') : err.message;
      fail(t, t.bytes === t.size && t.size > 0 ? `${msg} (all bytes were sent; check the receiver)` : msg);
      source.resume?.();
    }
    return snapshot(t);
  }

  function cancel(id) {
    const t = transfers.get(id);
    if (!t) throw new HttpError(404, 'no such transfer');
    if (TERMINAL.has(t.state)) return snapshot(t);
    t.offerReq?.destroy();
    fail(t, 'cancelled', 'cancelled');
    return snapshot(t);
  }

  // ---------- lifecycle ----------

  async function start() {
    // Clean up partial files left by a previous crash.
    try {
      for (const f of await fsp.readdir(config.downloadDir)) {
        if (/^\.portal-[A-Za-z0-9_-]{22}\.part$/.test(f)) await removeQuiet(path.join(config.downloadDir, f));
      }
    } catch {}
    await refreshStatus().catch(() => {});
    const tick = async () => {
      await refreshStatus().catch(() => {});
      prune();
      watchdogTimer = setTimeout(tick, config.watchdogMs);
      watchdogTimer.unref?.();
    };
    watchdogTimer = setTimeout(tick, config.watchdogMs);
  }

  async function stop() {
    clearTimeout(watchdogTimer);
    teardown('shutting down');
    await closePeerServer();
  }

  return {
    events, start, stop, refreshStatus, publicStatus, listTransfers, transfersRev,
    startSend, sendBody, cancel, acceptIncoming, declineIncoming,
  };
}
