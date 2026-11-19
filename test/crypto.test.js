import { test } from 'bun:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { generateEphemeral, deriveSession, offerContext, EncryptStream, DecryptStream, newTransferId, CHUNK_SIZE } from '../src/crypto.js';

function sessions() {
  const transferId = newTransferId();
  const s = generateEphemeral();
  const r = generateEphemeral();
  const common = { transferId, senderPub: s.pub, receiverPub: r.pub, context: offerContext({ transferId, name: 'a.txt', size: 1 }) };
  return {
    tx: deriveSession({ ...common, privateKey: s.privateKey, peerPub: r.pub }),
    rx: deriveSession({ ...common, privateKey: r.privateKey, peerPub: s.pub }),
  };
}

async function collect(stream) {
  const out = [];
  for await (const c of stream) out.push(c);
  return Buffer.concat(out);
}

async function encrypt(tx, data, piece = 65536) {
  const parts = [];
  for (let i = 0; i < data.length; i += piece) parts.push(data.subarray(i, i + piece));
  return collect(Readable.from(parts).pipe(new EncryptStream(tx)));
}

async function decrypt(rx, framed) {
  const out = [];
  const d = new DecryptStream(rx);
  d.on('data', (c) => out.push(c));
  await pipeline(Readable.from([framed]), d);
  return Buffer.concat(out);
}

test('both sides derive the same key', () => {
  const { tx, rx } = sessions();
  assert.deepEqual(tx.key, rx.key);
  assert.deepEqual(tx.noncePrefix, rx.noncePrefix);
});

for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 12345]) {
  test(`round trip ${size} bytes`, async () => {
    const { tx, rx } = sessions();
    const data = crypto.randomBytes(size);
    const framed = await encrypt(tx, data);
    if (size >= 16) assert.ok(!framed.includes(data.subarray(0, Math.min(64, size))), 'plaintext visible in ciphertext');
    assert.deepEqual(await decrypt(rx, framed), data);
  });
}

test('tampered byte is rejected', async () => {
  const { tx, rx } = sessions();
  const framed = await encrypt(tx, crypto.randomBytes(5000));
  framed[20] ^= 1;
  await assert.rejects(decrypt(rx, framed), /decrypt failed/);
});

test('truncation (dropping the final frame) is rejected', async () => {
  const { tx, rx } = sessions();
  const framed = await encrypt(tx, crypto.randomBytes(CHUNK_SIZE + 10));
  const firstFrameLen = 5 + CHUNK_SIZE + 16;
  await assert.rejects(decrypt(rx, framed.subarray(0, firstFrameLen)), /truncated/);
});

test('setting FINAL on an earlier frame is rejected', async () => {
  const { tx, rx } = sessions();
  const framed = await encrypt(tx, crypto.randomBytes(CHUNK_SIZE + 10));
  framed[0] = 1;
  await assert.rejects(decrypt(rx, framed), /decrypt failed/);
});

test('frames from another transfer are rejected', async () => {
  const a = sessions();
  const b = sessions();
  const framed = await encrypt(a.tx, crypto.randomBytes(100));
  await assert.rejects(decrypt(b.rx, framed), /decrypt failed/);
});

test('different offer metadata yields a different key', () => {
  const transferId = newTransferId();
  const s = generateEphemeral();
  const r = generateEphemeral();
  const base = { transferId, senderPub: s.pub, receiverPub: r.pub };
  const tx = deriveSession({ ...base, privateKey: s.privateKey, peerPub: r.pub, context: offerContext({ transferId, name: 'a', size: 1 }) });
  const rx = deriveSession({ ...base, privateKey: r.privateKey, peerPub: s.pub, context: offerContext({ transferId, name: 'b', size: 1 }) });
  assert.notDeepEqual(tx.key, rx.key);
});
