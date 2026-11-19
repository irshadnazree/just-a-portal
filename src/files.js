import fsp from 'node:fs/promises';
import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_NAME_BYTES = 200;

/** Reduce an untrusted filename to a safe single path component. */
export function sanitizeFilename(input) {
  let name = String(input ?? '').normalize('NFC');
  // Keep only the last component under either separator.
  name = name.split(/[\\/]/).pop() || '';
  // Drop control chars, bidi overrides, and characters that are illegal on Windows.
  name = name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>:"|?*]/g, '');
  // No leading dots (hidden files / "..") and no trailing dots/spaces (Windows strips them).
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  // Cap length in bytes while keeping the extension.
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const ext = path.extname(name).slice(0, 20);
    let base = name.slice(0, name.length - ext.length);
    while (Buffer.byteLength(base + ext) > MAX_NAME_BYTES) base = base.slice(0, -1);
    name = base + ext;
  }
  return name || 'file';
}

/**
 * Create an exclusive temp file in dir. Returns its path and an open handle.
 * Exclusive create ('wx') means we never follow a pre-planted symlink or overwrite anything.
 */
export async function createPartFile(dir, transferId) {
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `.portal-${transferId}.part`);
  const handle = await fsp.open(p, 'wx', 0o600);
  return { partPath: p, handle };
}

/**
 * Move a finished .part file to a non-colliding final name without ever overwriting an existing file.
 * Preferred: link() (atomic, fails with EEXIST). Where hard links aren't supported (FAT/exFAT, some
 * network shares) we exclusively create an empty placeholder to claim the name, then rename the
 * finished file over our own placeholder, so the name never shows a half-written file.
 * Publication and cleanup are separate steps: a failed unlink of the temp file can't cause a retry
 * that publishes a second copy.
 */
export async function finalizePartFile(partPath, dir, desiredName) {
  const safe = sanitizeFilename(desiredName);
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length) || 'file';
  let linkSupported = true;
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(dir, i === 0 ? safe : `${base} (${i})${ext}`);
    if (linkSupported) {
      try {
        await fsp.link(partPath, candidate);
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EACCES'].includes(err.code)) throw err;
        linkSupported = false;
      }
      if (linkSupported) {
        await removeQuiet(partPath); // best effort; the startup sweep removes leftovers
        return candidate;
      }
    }
    let placeholder;
    try {
      placeholder = await fsp.open(candidate, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    try {
      await placeholder.close();
      await fsp.rename(partPath, candidate);
    } catch (err) {
      await removeQuiet(candidate);
      throw err;
    }
    return candidate;
  }
  throw new Error('could not find a free filename');
}

export async function removeQuiet(p) {
  try {
    await fsp.unlink(p);
  } catch {}
}
