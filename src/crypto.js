// Application-layer encryption on top of Tailscale's WireGuard tunnel.
//
// Per transfer: ephemeral X25519 on both sides -> HKDF-SHA256 -> AES-256-GCM key + nonce prefix.
// Stream format: a sequence of frames
//   [1 byte flags][4 bytes BE ciphertext length][ciphertext][16 byte GCM tag]
// flags bit0 = FINAL. Nonce = 4-byte prefix || u64 BE frame index. AAD binds protocol version,
// transfer id, frame index and flags, so reordering, replay across transfers, dropping frames and
// truncation (missing FINAL) are all detected.
import crypto from 'node:crypto';
import { Transform } from 'node:stream';

export const CHUNK_SIZE = 1024 * 1024;
const TAG_LEN = 16;
const HEADER_LEN = 5;
const FLAG_FINAL = 0x01;
const PROTO = Buffer.from('just-a-portal/v1');

export function generateEphemeral() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }).x; // base64url, 32 bytes
  return { privateKey, pub };
}

export function isValidPub(pub) {
  return typeof pub === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pub) && Buffer.from(pub, 'base64url').length === 32;
}

export function isValidTransferId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);
}

export function newTransferId() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Both sides call this with their own private key and the other's public key. The transcript
 * (transfer id + both public keys in sender/receiver order + a hash of the offer metadata) is bound
 * into the HKDF, so the key is unique to this exchange and any tampering with the offer (name, size)
 * makes the first frame fail to decrypt.
 */
export function offerContext({ transferId, name, size }) {
  return crypto.createHash('sha256').update(JSON.stringify(['offer', transferId, String(name), Number(size)])).digest();
}

export function deriveSession({ privateKey, peerPub, transferId, senderPub, receiverPub, context }) {
  if (!Buffer.isBuffer(context) || context.length !== 32) throw new Error('missing offer context');
  if (!isValidPub(peerPub) || !isValidPub(senderPub) || !isValidPub(receiverPub)) throw new Error('bad public key');
  const peerKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: peerPub }, format: 'jwk' });
  // OpenSSL refuses low-order points (all-zero shared secret), which throws here.
  const shared = crypto.diffieHellman({ privateKey, publicKey: peerKey });
  if (shared.every((b) => b === 0)) throw new Error('invalid shared secret');
  const info = Buffer.concat([PROTO, Buffer.from(senderPub, 'base64url'), Buffer.from(receiverPub, 'base64url'), context]);
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(transferId), info, 36));
  shared.fill(0);
  return { key: okm.subarray(0, 32), noncePrefix: okm.subarray(32, 36), transferId };
}

function nonceFor(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
}

function aadFor(transferId, index, flags) {
  const idx = Buffer.alloc(9);
  idx.writeBigUInt64BE(BigInt(index), 0);
  idx[8] = flags;
  return Buffer.concat([PROTO, Buffer.from(transferId), idx]);
}

function seal(session, index, flags, plaintext) {
  const c = crypto.createCipheriv('aes-256-gcm', session.key, nonceFor(session.noncePrefix, index), { authTagLength: TAG_LEN });
  c.setAAD(aadFor(session.transferId, index, flags));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = flags;
  header.writeUInt32BE(ct.length, 1);
  return Buffer.concat([header, ct, c.getAuthTag()]);
}

/** Plaintext in -> framed ciphertext out. Always ends with a FINAL frame (possibly empty). */
export class EncryptStream extends Transform {
  constructor(session) {
    super();
    this.session = session;
    this.index = 0;
    this.pending = [];
    this.pendingLen = 0;
  }
  _transform(chunk, _enc, cb) {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    // Hold back at least one full chunk so the last data frame can carry the FINAL flag.
    while (this.pendingLen > CHUNK_SIZE) {
      const all = Buffer.concat(this.pending);
      this.push(seal(this.session, this.index++, 0, all.subarray(0, CHUNK_SIZE)));
      const rest = all.subarray(CHUNK_SIZE);
      this.pending = [rest];
      this.pendingLen = rest.length;
    }
    cb();
  }
  _flush(cb) {
    this.push(seal(this.session, this.index++, FLAG_FINAL, Buffer.concat(this.pending)));
    this.pending = [];
    cb();
  }
}

/** Framed ciphertext in -> verified plaintext out. Errors on any tamper, reorder or truncation. */
export class DecryptStream extends Transform {
  constructor(session) {
    super();
    this.session = session;
    this.index = 0;
    this.buf = Buffer.alloc(0);
    this.done = false;
  }
  _transform(chunk, _enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this.buf.length >= HEADER_LEN) {
        if (this.done) throw new Error('data after final frame');
        const flags = this.buf[0];
        if (flags & ~FLAG_FINAL) throw new Error('unknown frame flags');
        const len = this.buf.readUInt32BE(1);
        if (len > CHUNK_SIZE) throw new Error('frame too large');
        const total = HEADER_LEN + len + TAG_LEN;
        if (this.buf.length < total) break;
        const ct = this.buf.subarray(HEADER_LEN, HEADER_LEN + len);
        const tag = this.buf.subarray(HEADER_LEN + len, total);
        const d = crypto.createDecipheriv('aes-256-gcm', this.session.key, nonceFor(this.session.noncePrefix, this.index), { authTagLength: TAG_LEN });
        d.setAAD(aadFor(this.session.transferId, this.index, flags));
        d.setAuthTag(tag);
        const pt = Buffer.concat([d.update(ct), d.final()]); // throws on auth failure
        this.index++;
        if (flags & FLAG_FINAL) this.done = true;
        this.buf = this.buf.subarray(total);
        if (pt.length) this.push(pt);
      }
      cb();
    } catch (err) {
      cb(new Error(`decrypt failed: ${err.message}`));
    }
  }
  _flush(cb) {
    if (!this.done || this.buf.length) return cb(new Error('decrypt failed: stream truncated'));
    cb();
  }
}
