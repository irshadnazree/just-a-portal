import crypto from 'node:crypto';
import { Transform } from 'node:stream';

export function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Read a small JSON body with a hard byte cap (checked before buffering more). */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return reject(new HttpError(413, 'body too large'));
    const parts = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > maxBytes) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      try {
        resolve(len ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Counts and hashes bytes; fails if more than `limit` pass, or (on end) if not exactly `limit`. */
export class MeterStream extends Transform {
  constructor(limit, onProgress) {
    super();
    this.limit = limit;
    this.bytes = 0;
    this.hash = crypto.createHash('sha256');
    this.onProgress = onProgress;
    this.lastEmit = 0;
  }
  _transform(chunk, _enc, cb) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return cb(new Error('more data than declared size'));
    this.hash.update(chunk);
    const now = Date.now();
    if (this.onProgress && now - this.lastEmit > 200) {
      this.lastEmit = now;
      this.onProgress(this.bytes);
    }
    cb(null, chunk);
  }
  _flush(cb) {
    if (this.bytes !== this.limit) return cb(new Error(`size mismatch: got ${this.bytes} of ${this.limit} bytes`));
    this.onProgress?.(this.bytes);
    this.digest = this.hash.digest('hex');
    cb();
  }
}

/** Tiny counting semaphore to bound concurrent CLI lookups. */
export class Semaphore {
  constructor(n, maxQueue = Infinity) {
    this.n = n;
    this.maxQueue = maxQueue;
    this.queue = [];
  }
  async run(fn) {
    if (this.n <= 0) {
      if (this.queue.length >= this.maxQueue) throw new HttpError(503, 'busy, try again');
      await new Promise((r) => this.queue.push(r));
    }
    else this.n--;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.n++;
    }
  }
}
