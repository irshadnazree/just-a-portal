// End-to-end: two real portal processes, each with its own fake `tailscale` world, on loopback.
import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test', 'fake-tailscale.mjs');
const IP = '127.0.0.1';
// PORTAL_ENTRY runs the suite against another build of main.js, e.g. the bundled dist/site/portal.js.
const ENTRY = process.env.PORTAL_ENTRY ? path.resolve(process.env.PORTAL_ENTRY) : path.join(ROOT, 'src', 'main.js');

function world({ running = true, selfId, selfName, selfUser = 1, peerId, peerName, peerUser = 1, whoisUser = peerUser, whoisId = peerId }) {
  return {
    status: {
      BackendState: running ? 'Running' : 'Stopped',
      TailscaleIPs: [IP],
      Self: { ID: selfId, HostName: selfName, DNSName: `${selfName}.test.ts.net.`, UserID: selfUser, TailscaleIPs: [IP] },
      CurrentTailnet: { Name: 'test-tailnet' },
      Peer: { k: { ID: peerId, HostName: peerName, DNSName: `${peerName}.test.ts.net.`, OS: 'linux', Online: true, UserID: peerUser, TailscaleIPs: [IP] } },
    },
    whois: { [IP]: { Node: { StableID: whoisId, ComputedName: peerName, Addresses: [`${IP}/32`] }, UserProfile: { ID: whoisUser, LoginName: 'u@test' } } },
  };
}

async function startNode(name, opts) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `portal-${name}-`));
  const tsFile = path.join(dir, 'world.json');
  const downloads = path.join(dir, 'downloads');
  await fsp.writeFile(tsFile, JSON.stringify(world(opts.world)));
  const child = spawn(process.execPath, [ENTRY, '--no-open'], {
    env: {
      ...process.env,
      PORTAL_TAILSCALE_BIN: FAKE,
      FAKE_TS_FILE: tsFile,
      PORTAL_UI_PORT: '0',
      PORTAL_PEER_PORT: String(opts.peerPort),
      PORTAL_REMOTE_PEER_PORT: String(opts.remotePeerPort),
      PORTAL_DOWNLOAD_DIR: downloads,
      PORTAL_WATCHDOG_MS: '150',
      PORTAL_IDLE_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`));
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name} did not start: ${out}`)), 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/#k=([A-Za-z0-9_-]+)/);
      if (m) {
        clearTimeout(t);
        resolve({ port: Number(m[1]), token: m[2] });
      }
    });
    child.on('exit', (code) => reject(new Error(`${name} exited ${code}: ${out}`)));
  });
  const node = {
    name, child, dir, downloads, tsFile, ...url, opts,
    setWorld: (patch) => fsp.writeFile(tsFile, JSON.stringify(world({ ...opts.world, ...patch }))),
    api: (p, { method = 'GET', json, body, headers = {} } = {}) => request({
      port: url.port, path: p, method,
      headers: { 'x-portal-token': url.token, origin: `http://127.0.0.1:${url.port}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
    }),
  };
  return node;
}

function request({ port, path: p, method, headers, body, host }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: host || `127.0.0.1:${port}`, ...headers } }, (res) => {
      const parts = [];
      res.on('error', reject);
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body);
  });
}

async function waitFor(fn, what, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const transfer = async (node, id) => (await node.api('/api/status')).json.transfers.find((t) => t.id === id);
const inState = (node, id, ...states) => waitFor(async () => {
  const t = await transfer(node, id);
  return t && states.includes(t.state) ? t : null;
}, `${node.name} ${id} -> ${states}`);
const listening = (node, up = true) => waitFor(async () => {
  const r = await node.api('/api/status');
  return r.json.status.listening === up ? r.json.status : null;
}, `${node.name} listening=${up}`);

let A, B;
const base = 20000 + Math.floor(Math.random() * 20000);

beforeAll(async () => {
  A = await startNode('A', { peerPort: base, remotePeerPort: base + 1, world: { selfId: 'nA', selfName: 'alpha', peerId: 'nB', peerName: 'bravo' } });
  B = await startNode('B', { peerPort: base + 1, remotePeerPort: base, world: { selfId: 'nB', selfName: 'bravo', peerId: 'nA', peerName: 'alpha' } });
  await listening(A);
  await listening(B);
});

afterAll(async () => {
  for (const n of [A, B]) {
    n?.child.kill('SIGTERM');
    await fsp.rm(n.dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function offer(name, size) {
  const r = await A.api('/api/send', { method: 'POST', json: { peerId: 'nB', name, size } });
  assert.equal(r.status, 200, r.text);
  await inState(B, r.json.id, 'pending');
  return r.json.id;
}

test('happy path: offer, accept, encrypted transfer, file saved and hash matches', async () => {
  const data = crypto.randomBytes(3 * 1024 * 1024 + 777);
  const id = await offer('report.bin', data.length);
  const acc = await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  assert.equal(acc.status, 200, acc.text);
  await inState(A, id, 'accepted');
  const sent = await A.api(`/api/send/${id}/body`, { method: 'POST', body: data, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.state, 'done');
  const expected = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(sent.json.sha256, expected);
  const rx = await inState(B, id, 'done');
  assert.equal(rx.sha256, expected);
  const saved = await fsp.readFile(path.join(B.downloads, rx.savedAs));
  assert.ok(saved.equals(data));
});

test('empty file works', async () => {
  const id = await offer('empty.txt', 0);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  const sent = await A.api(`/api/send/${id}/body`, { method: 'POST', body: Buffer.alloc(0) });
  assert.equal(sent.json.state, 'done', sent.text);
  const rx = await inState(B, id, 'done');
  assert.equal((await fsp.stat(path.join(B.downloads, rx.savedAs))).size, 0);
});

test('hostile filename is reduced to a safe basename and never overwrites', async () => {
  const names = [];
  for (let i = 0; i < 2; i++) {
    const id = await offer('../../etc/evil.txt', 3);
    await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
    await inState(A, id, 'accepted');
    await A.api(`/api/send/${id}/body`, { method: 'POST', body: Buffer.from(`v${i}!`) });
    names.push((await inState(B, id, 'done')).savedAs);
  }
  assert.deepEqual(names, ['evil.txt', 'evil (1).txt']);
  assert.equal(await fsp.readFile(path.join(B.downloads, 'evil.txt'), 'utf8'), 'v0!');
});

test('declined offer ends as declined on the sender', async () => {
  const id = await offer('nope.txt', 10);
  await B.api(`/api/transfers/${id}/decline`, { method: 'POST' });
  const t = await inState(A, id, 'declined');
  assert.match(t.error, /declined/);
});

test('sending fewer bytes than declared fails and leaves no file', async () => {
  const id = await offer('short.bin', 100);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  const sent = await A.api(`/api/send/${id}/body`, { method: 'POST', body: Buffer.alloc(50) });
  assert.equal(sent.json.state, 'failed');
  assert.match(sent.json.error, /size mismatch/);
  // The sender aborts before any frame leaves, so the receiver just waits for its accept window to expire.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(['accepted', 'failed', 'expired'].includes((await transfer(B, id)).state));
  const files = await fsp.readdir(B.downloads);
  assert.ok(!files.includes('short.bin'));
  assert.ok(!files.some((f) => f.endsWith('.part')));
});

test('body cannot be uploaded before the receiver accepts', async () => {
  const id = await offer('early.bin', 5);
  const r = await A.api(`/api/send/${id}/body`, { method: 'POST', body: Buffer.alloc(5) });
  assert.equal(r.status, 409);
  await A.api(`/api/transfers/${id}/cancel`, { method: 'POST' });
  await inState(B, id, 'cancelled', 'failed', 'expired');
});

test('local UI rejects bad host, missing token, and foreign origin', async () => {
  const badHost = await request({ port: A.port, path: '/api/status', method: 'GET', headers: { 'x-portal-token': A.token }, host: 'evil.example:80' });
  assert.equal(badHost.status, 421);
  const noToken = await request({ port: A.port, path: '/api/status', method: 'GET', headers: {} });
  assert.equal(noToken.status, 401);
  const badOrigin = await request({
    port: A.port, path: '/api/send', method: 'POST',
    headers: { 'x-portal-token': A.token, origin: 'http://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ peerId: 'nB', name: 'x', size: 1 }),
  });
  assert.equal(badOrigin.status, 403);
  const page = await request({ port: A.port, path: '/', method: 'GET', headers: {} });
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes(A.token), 'page must not embed the session token');
  assert.match(page.text, /just-a-portal/);
});

test('peer from a different Tailscale user is rejected', async () => {
  await B.setWorld({ whoisUser: 999 });
  try {
    const r = await A.api('/api/send', { method: 'POST', json: { peerId: 'nB', name: 'x.txt', size: 1 } });
    const t = await inState(A, r.json.id, 'failed');
    assert.match(t.error, /different Tailscale user/);
  } finally {
    await B.setWorld({});
  }
});

test('whois identity mismatch is rejected', async () => {
  await B.setWorld({ whoisId: 'nSomeoneElse' });
  try {
    const r = await A.api('/api/send', { method: 'POST', json: { peerId: 'nB', name: 'x.txt', size: 1 } });
    const t = await inState(A, r.json.id, 'failed');
    assert.match(t.error, /identity/);
  } finally {
    await B.setWorld({});
  }
});

test('sender with Tailscale stopped cannot send at all', async () => {
  await A.setWorld({ running: false });
  try {
    await listening(A, false);
    const r = await A.api('/api/send', { method: 'POST', json: { peerId: 'nB', name: 'x.txt', size: 1 } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /Tailscale is not connected/);
  } finally {
    await A.setWorld({});
    await listening(A, true);
  }
});

test('receiver with Tailscale stopped is unreachable and the offer fails', async () => {
  await B.setWorld({ running: false });
  try {
    await listening(B, false);
    const r = await A.api('/api/send', { method: 'POST', json: { peerId: 'nB', name: 'x.txt', size: 1 } });
    assert.equal(r.status, 200);
    await inState(A, r.json.id, 'failed');
  } finally {
    await B.setWorld({});
    await listening(B, true);
  }
});

test('receiver losing Tailscale mid-transfer aborts on both ends and leaves no file', async () => {
  const size = 8 * 1024 * 1024;
  const id = await offer('mid.bin', size);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  // Trickle the body so the transfer is still running when Tailscale drops.
  const { PassThrough } = await import('node:stream');
  const body = new PassThrough();
  const sending = A.api(`/api/send/${id}/body`, { method: 'POST', body });
  const chunk = Buffer.alloc(256 * 1024);
  let written = 0;
  const pump = setInterval(() => {
    if (written < size - chunk.length) {
      body.write(chunk);
      written += chunk.length;
    }
  }, 50);
  try {
    await inState(B, id, 'receiving');
    await waitFor(async () => ((await transfer(B, id))?.bytes || 0) > 0, 'some bytes received');
    await B.setWorld({ running: false });
    const rx = await inState(B, id, 'failed');
    assert.match(rx.error, /Tailscale disconnected|aborted/);
    const tx = await inState(A, id, 'failed');
    assert.ok(tx.error);
  } finally {
    clearInterval(pump);
    body.destroy();
    await sending.catch(() => {});
    await B.setWorld({});
    await listening(B, true);
  }
  const files = await fsp.readdir(B.downloads);
  assert.ok(!files.includes('mid.bin'));
  assert.ok(!files.some((f) => f.endsWith('.part')), `leftover: ${files}`);
});

test('receiver rejects tampered/unencrypted data on the peer port and keeps no file', async () => {
  const id = await offer('tamper.bin', 1000);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  // Bypass A's encryptor and send plaintext straight to B's peer port as if we were A.
  const r = await request({
    port: B.opts.peerPort, path: `/v1/data/${id}`, method: 'POST',
    headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(1000, 0x41),
  }).catch((err) => ({ status: 0, err }));
  assert.notEqual(r.status, 200);
  const rx = await inState(B, id, 'failed');
  assert.match(rx.error, /decrypt failed|frame/);
  // The acceptance was consumed: a second attempt is refused.
  const again = await request({ port: B.opts.peerPort, path: `/v1/data/${id}`, method: 'POST', headers: {}, body: Buffer.alloc(1) });
  assert.equal(again.status, 409);
  await A.api(`/api/transfers/${id}/cancel`, { method: 'POST' });
  const files = await fsp.readdir(B.downloads);
  assert.ok(!files.includes('tamper.bin') && !files.some((f) => f.endsWith('.part')));
});

test('cancel is final: a cancelled receive never turns into done', async () => {
  const size = 4 * 1024 * 1024;
  const id = await offer('cancel-me.bin', size);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  const { PassThrough } = await import('node:stream');
  const body = new PassThrough();
  const sending = A.api(`/api/send/${id}/body`, { method: 'POST', body });
  body.write(Buffer.alloc(1536 * 1024)); // > 1 frame, so the first frame is flushed
  await waitFor(async () => ((await transfer(B, id))?.bytes || 0) > 0, 'some bytes received');
  const c = await B.api(`/api/transfers/${id}/cancel`, { method: 'POST' });
  assert.equal(c.json.state, 'cancelled');
  body.end(Buffer.alloc(size - 1536 * 1024)); // sender finishes anyway
  await sending.catch(() => {});
  await inState(A, id, 'failed', 'cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await transfer(B, id)).state, 'cancelled');
  assert.ok(!(await fsp.readdir(B.downloads)).includes('cancel-me.bin'));
});

test('sender cancel while sending stays cancelled', async () => {
  const id = await offer('sender-cancel.bin', 4 * 1024 * 1024);
  await B.api(`/api/transfers/${id}/accept`, { method: 'POST' });
  await inState(A, id, 'accepted');
  const { PassThrough } = await import('node:stream');
  const body = new PassThrough();
  const sending = A.api(`/api/send/${id}/body`, { method: 'POST', body });
  body.write(Buffer.alloc(1536 * 1024));
  await inState(A, id, 'sending');
  await waitFor(async () => ((await transfer(B, id))?.bytes || 0) > 0, 'some bytes received');
  await A.api(`/api/transfers/${id}/cancel`, { method: 'POST' });
  body.destroy();
  await sending.catch(() => {});
  await inState(B, id, 'failed');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await transfer(A, id)).state, 'cancelled');
});
