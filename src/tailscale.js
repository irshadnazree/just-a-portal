// Thin wrapper around the `tailscale` CLI. Every call shells out fresh so we never act on stale state.
import { execFile } from 'node:child_process';
import net from 'node:net';

const DEFAULT_BIN = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
// Used only when the CLI isn't on PATH (e.g. launched from a GUI, or a minimal service PATH).
const FALLBACK_BIN = {
  darwin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  win32: `${process.env.ProgramFiles || 'C:\\Program Files'}\\Tailscale\\tailscale.exe`,
}[process.platform] || null;

function bin() {
  return process.env.PORTAL_TAILSCALE_BIN || DEFAULT_BIN;
}

// Tailscale IDs are int64; keep them as exact decimal strings instead of lossy JS numbers.
const ID_KEYS = new Set(['UserID', 'ID', 'User']);
function parseJson(text) {
  return JSON.parse(text, (key, value, ctx) => {
    if (ID_KEYS.has(key) && typeof value === 'number') return ctx?.source ?? String(value);
    return value;
  });
}

/** A positive decimal user id, or null. */
export function userId(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /^[1-9][0-9]{0,19}$/.test(s) ? s : null;
}

function run(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const tryBin = (b, fallback) => {
      // TAILSCALE_BE_CLI stops the macOS app bundle's binary from starting the GUI.
      const env = { ...process.env, TAILSCALE_BE_CLI: '1' };
      execFile(b, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT' && fallback) return tryBin(fallback, null);
        if (err) {
          err.stderr = String(stderr || '');
          err.stdout = String(stdout || '');
          return reject(err);
        }
        resolve(String(stdout));
      });
    };
    const b = bin();
    tryBin(b, process.env.PORTAL_TAILSCALE_BIN ? null : FALLBACK_BIN);
  });
}

/** Strip an IPv6 zone / IPv4-mapped prefix so comparisons are on canonical strings. */
export function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']'));
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  if (s.toLowerCase().startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  return s.toLowerCase();
}

function firstIPv4(ips) {
  return (ips || []).map(normalizeIp).find((ip) => net.isIPv4(ip)) || null;
}

/**
 * @returns {Promise<{running:boolean, state:string, error?:string, selfIPv4?:string, selfUserId?:string|null,
 *   selfName?:string, tailnet?:string, peers: Array<{id:string,name:string,dnsName:string,os:string,online:boolean,ipv4:string|null,userId:string|null}>}>}
 */
export async function getStatus() {
  let raw;
  try {
    raw = await run(['status', '--json']);
  } catch (err) {
    // `tailscale status` exits non-zero when stopped/logged out but may still print JSON.
    raw = err.stdout;
    if (!raw || !raw.trim().startsWith('{')) {
      const msg = err.code === 'ENOENT' ? 'tailscale CLI not found' : (err.stderr || err.message || 'tailscale status failed').trim();
      return { running: false, state: 'Unavailable', error: msg, peers: [] };
    }
  }
  let s;
  try {
    s = parseJson(raw);
  } catch {
    return { running: false, state: 'Unavailable', error: 'could not parse tailscale status', peers: [] };
  }
  const state = String(s.BackendState || 'Unknown');
  const self = s.Self || {};
  const selfIPv4 = firstIPv4(self.TailscaleIPs || s.TailscaleIPs);
  // IPs are listed even while Stopped, so only BackendState + Self.Online-ish signals count.
  const running = state === 'Running' && !!selfIPv4;
  const peers = Object.values(s.Peer || {}).map((p) => ({
    id: String(p.ID || p.PublicKey || ''),
    name: String(p.HostName || p.DNSName || 'unknown'),
    dnsName: String(p.DNSName || '').replace(/\.$/, ''),
    os: String(p.OS || ''),
    online: p.Online === true,
    ipv4: firstIPv4(p.TailscaleIPs),
    userId: userId(p.UserID),
  }));
  return {
    running,
    state,
    selfIPv4: selfIPv4 || undefined,
    selfUserId: userId(self.UserID),
    selfName: String(self.HostName || ''),
    selfDnsName: String(self.DNSName || '').replace(/\.$/, ''),
    tailnet: s.CurrentTailnet?.Name || undefined,
    peers: running ? peers : [],
  };
}

/**
 * Ask tailscaled who owns a remote address. Returns null if it is not a tailnet node.
 * @returns {Promise<null | {nodeId:string, nodeName:string, userId:string|null, loginName:string, addresses:string[]}>}
 */
export async function whois(ip) {
  const addr = normalizeIp(ip);
  if (!net.isIP(addr)) return null;
  let raw;
  try {
    raw = await run(['whois', '--json', addr]);
  } catch {
    return null;
  }
  try {
    const w = parseJson(raw);
    if (!w || !w.Node) return null;
    const addresses = (w.Node.Addresses || []).map((a) => normalizeIp(String(a).split('/')[0]));
    // whois must describe the exact address we asked about.
    if (!addresses.includes(addr)) return null;
    return {
      nodeId: String(w.Node.StableID || w.Node.ID || ''),
      nodeName: String(w.Node.ComputedName || w.Node.Name || w.Node.Hostinfo?.Hostname || ''),
      userId: userId(w.UserProfile?.ID ?? w.Node.User),
      loginName: String(w.UserProfile?.LoginName || ''),
      addresses,
    };
  } catch {
    return null;
  }
}
