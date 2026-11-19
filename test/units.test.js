import { test } from 'bun:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeFilename, createPartFile, finalizePartFile } from '../src/files.js';
import { Semaphore } from '../src/util.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-tailscale.mjs');

test('sanitizeFilename', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('..'), 'file');
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('.bashrc'), 'bashrc');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('a:stream.txt'), 'astream.txt');
  assert.equal(sanitizeFilename('trailing. . '), 'trailing');
  assert.equal(sanitizeFilename('evil\u202Etxt.exe'), 'eviltxt.exe');
  assert.ok(Buffer.byteLength(sanitizeFilename('é'.repeat(500) + '.pdf')) <= 200);
  assert.ok(sanitizeFilename('é'.repeat(500) + '.pdf').endsWith('.pdf'));
});

test('finalizePartFile never overwrites and leaves exactly one copy', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-files-'));
  try {
    await fsp.writeFile(path.join(dir, 'a.txt'), 'existing');
    const { partPath, handle } = await createPartFile(dir, 'x'.repeat(22));
    await handle.writeFile('new');
    await handle.close();
    const out = await finalizePartFile(partPath, dir, 'a.txt');
    assert.equal(path.basename(out), 'a (1).txt');
    assert.equal(await fsp.readFile(path.join(dir, 'a.txt'), 'utf8'), 'existing');
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['a (1).txt', 'a.txt']);
    // A pre-existing .part path makes createPartFile fail instead of reusing/following it.
    await fsp.symlink(path.join(dir, 'a.txt'), path.join(dir, `.portal-${'y'.repeat(22)}.part`));
    await assert.rejects(createPartFile(dir, 'y'.repeat(22)), /EEXIST/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('int64 user ids are compared exactly, not as rounded JS numbers', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'portal-ts-'));
  const file = path.join(dir, 'w.json');
  // 9007199254740993 and 9007199254740992 are the same JS Number.
  const statusRaw = `{"BackendState":"Running","Self":{"UserID":9007199254740993,"TailscaleIPs":["100.64.0.1"]},
    "Peer":{"k":{"ID":"nX","HostName":"x","UserID":9007199254740992,"TailscaleIPs":["100.64.0.2"]}}}`;
  await fsp.writeFile(file, JSON.stringify({ statusRaw }));
  process.env.PORTAL_TAILSCALE_BIN = FAKE;
  process.env.FAKE_TS_FILE = file;
  try {
    const ts = await import('../src/tailscale.js');
    const s = await ts.getStatus();
    assert.equal(s.running, true);
    assert.equal(s.selfUserId, '9007199254740993');
    assert.equal(s.peers[0].userId, '9007199254740992');
    assert.notEqual(s.selfUserId, s.peers[0].userId);
    assert.equal(ts.userId('0'), null);
    assert.equal(ts.userId('-5'), null);
  } finally {
    delete process.env.PORTAL_TAILSCALE_BIN;
    delete process.env.FAKE_TS_FILE;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Semaphore rejects when its queue is full', async () => {
  const sem = new Semaphore(1, 1);
  let release;
  const first = sem.run(() => new Promise((r) => { release = r; }));
  const second = sem.run(async () => 'ok');
  await assert.rejects(sem.run(async () => 'nope'), /busy/);
  release();
  await first;
  assert.equal(await second, 'ok');
});
