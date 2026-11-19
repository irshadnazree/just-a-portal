'use strict';

// ---- session key: arrives in the URL fragment, kept only in this tab ----
const token = (() => {
  const m = location.hash.match(/[#&]k=([A-Za-z0-9_-]{43})/);
  try {
    if (m) sessionStorage.setItem('portal-key', m[1]);
    if (m) history.replaceState(null, '', location.pathname);
    return m ? m[1] : sessionStorage.getItem('portal-key');
  } catch {
    return m ? m[1] : null;
  }
})();

const $ = (id) => document.getElementById(id);
// revs remembers the newest revision seen per transfer even after its row is removed, so a late,
// older snapshot can never resurrect a row or roll its state back.
const state = { status: null, transfers: new Map(), revs: new Map(), files: new Map(), uploading: new Set(), selectedPeer: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-portal-token': token, ...(opts.json ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.state) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- event stream (fetch-based so the token rides in a header, not the URL) ----
async function listen() {
  for (;;) {
    try {
      const res = await fetch('/api/events', { headers: { 'x-portal-token': token } });
      if (res.status === 401) return showLocked();
      if (!res.ok || !res.body) throw new Error('stream failed');
      resync(); // anything that happened while we were disconnected
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const obj = JSON.parse(data);
          if (ev === 'status') onStatus(obj);
          else if (ev === 'transfer') onTransfer(obj);
        }
      }
    } catch {}
    onStatus({ running: false, state: 'portal unreachable', peers: [], error: 'Lost connection to the local portal server.' });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function resync() {
  api('/api/status').then((r) => {
    onStatus(r.status);
    // The server list is authoritative: drop finished rows it no longer has (pruned history).
    // Only rows this snapshot already covers (rev <= transfersRev) can be judged missing.
    const ids = new Set(r.transfers.map((t) => t.id));
    for (const [id, t] of state.transfers) {
      if (!ids.has(id) && (t.rev || 0) <= r.transfersRev) {
        // The server pruned it (pruned transfers are finished for good), so block any late snapshot.
        state.revs.set(id, Infinity);
        state.transfers.delete(id);
        state.files.delete(id);
      }
    }
    for (const t of r.transfers) onTransfer(t);
    renderTransfers();
  }).catch((err) => {
    if (/token/.test(err.message)) showLocked();
  });
}

function showLocked() {
  $('locked').hidden = false;
  $('ts-text').textContent = 'Locked';
}

// ---- rendering ----
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function onStatus(s) {
  // Ignore an older snapshot (e.g. a slow /api/status reply arriving after a newer event).
  if (s.rev !== undefined && state.status?.rev !== undefined && s.rev < state.status.rev) return;
  state.status = s;
  const pill = $('ts-pill');
  pill.classList.toggle('on', !!s.running);
  pill.classList.toggle('off', !s.running);
  $('ts-text').textContent = s.running ? `Tailscale connected${s.tailnet ? ` · ${s.tailnet}` : ''}` : `Tailscale ${String(s.state || 'offline').toLowerCase()}`;
  $('offline').hidden = !!s.running;
  $('offline-detail').textContent = s.error ? `${s.error}. Sending and receiving are disabled.` : 'Sending and receiving are disabled until it is.';
  $('self').textContent = s.self ? `This PC: ${s.self.name} · ${s.self.ip}` : '';
  $('dl-dir').textContent = s.downloadDir ? `Saving to ${s.downloadDir}` : '';
  $('dl-dir').title = s.downloadDir || '';
  renderPeers();
}

function renderPeers() {
  const s = state.status;
  const sel = $('peer');
  sel.replaceChildren();
  const peers = (s?.peers || []).filter((p) => p.ip).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  const ready = !!s?.running && !!s?.listening;
  // Placeholders have an empty value, so they can never be mistaken for a device.
  const placeholder = el('option', '', !s?.running ? 'Tailscale not connected' : !s.listening ? 'Not ready' : peers.length ? 'Choose a device…' : 'No other devices on your tailnet');
  placeholder.value = '';
  placeholder.disabled = true;
  sel.append(placeholder);
  for (const p of peers) {
    const o = el('option', '', `${p.name}${p.online ? '' : ' (offline)'}${p.os ? ` — ${p.os}` : ''}`);
    o.value = p.id;
    sel.append(o);
  }
  // Only the user picks the target. If their device vanished, fall back to "choose" rather than
  // silently retargeting; the remembered id survives disconnects and is restored when it returns.
  sel.value = peers.some((p) => p.id === state.selectedPeer) ? state.selectedPeer : '';
  sel.disabled = !ready || peers.length === 0;
  const canDrop = ready && !!sel.value;
  $('file').disabled = !canDrop;
  $('drop').classList.toggle('disabled', !canDrop);
  const cur = peers.find((p) => p.id === sel.value);
  $('peer-hint').textContent = s?.running && s.listenError ? s.listenError : !cur ? '' : !cur.online
    ? 'This device looks offline. It needs Tailscale and just-a-portal running to receive.'
    : cur.sameUser ? 'Needs just-a-portal running on that device.' : 'Owned by another Tailscale user; they must allow other users to receive.';
}

const LABEL = {
  offering: 'Waiting for receiver', pending: 'Wants to send you', accepted: 'Starting', sending: 'Sending',
  receiving: 'Receiving', done: 'Done', declined: 'Declined', failed: 'Failed', cancelled: 'Cancelled', expired: 'Expired',
};
const ACTIVE = new Set(['offering', 'pending', 'accepted', 'sending', 'receiving']);

function renderTransfers() {
  const list = $('transfers');
  const items = [...state.transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  $('empty').hidden = items.length > 0;
  list.replaceChildren(...items.map(renderTransfer));
}

function renderTransfer(t) {
  const li = el('li', `t ${t.state}${t.direction === 'in' && t.state === 'pending' ? ' incoming-pending' : ''}`);
  const name = el('div', 't-name', t.savedAs || t.name);
  name.title = t.savedAs || t.name;
  const arrow = t.direction === 'out' ? `to ${t.peerName}` : `from ${t.peerName}`;
  const pct = t.size ? Math.min(100, Math.round(((t.bytes || 0) / t.size) * 100)) : (t.state === 'done' ? 100 : 0);
  const progress = ['sending', 'receiving'].includes(t.state) ? ` · ${fmtBytes(t.bytes)} of ${fmtBytes(t.size)} (${pct}%)` : ` · ${fmtBytes(t.size)}`;
  const meta = el('div', 't-meta', `${arrow}${progress}`);
  const actions = el('div', 't-actions');
  actions.append(el('span', `badge ${t.state}`, LABEL[t.state] || t.state));
  if (t.direction === 'in' && t.state === 'pending') {
    const ok = el('button', 'btn primary', 'Accept');
    ok.type = 'button';
    ok.onclick = () => act(t.id, 'accept', ok);
    const no = el('button', 'btn', 'Decline');
    no.type = 'button';
    no.onclick = () => act(t.id, 'decline', no);
    actions.append(ok, no);
  } else if (ACTIVE.has(t.state)) {
    const c = el('button', 'btn', 'Cancel');
    c.type = 'button';
    c.onclick = () => act(t.id, 'cancel', c);
    actions.append(c);
  }
  li.append(name, actions, meta);
  if (t.state !== 'pending' && t.state !== 'offering') {
    const bar = el('div', 't-bar');
    const fill = el('i');
    fill.style.width = `${t.state === 'done' ? 100 : pct}%`;
    bar.append(fill);
    li.append(bar);
  }
  if (t.error && t.state !== 'done') li.append(el('div', 't-err', t.error));
  if (t.sha256) {
    const h = el('div', 't-hash mono', `SHA-256 ${t.sha256}`);
    h.title = 'Verified on both ends';
    li.append(h);
  }
  return li;
}

async function act(id, action, btn) {
  btn.disabled = true;
  try {
    onTransfer(await api(`/api/transfers/${id}/${action}`, { method: 'POST' }));
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}

function onTransfer(t) {
  // Responses and events can arrive out of order; never let an older snapshot win.
  if ((state.revs.get(t.id) || 0) > (t.rev || 0)) return;
  state.revs.set(t.id, t.rev || 0);
  if (state.revs.size > 2000) state.revs.delete(state.revs.keys().next().value);
  state.transfers.set(t.id, t);
  // The receiver accepted: now (and only now) upload the bytes to our local server.
  if (t.direction === 'out' && t.state === 'accepted' && state.files.has(t.id) && !state.uploading.has(t.id)) {
    upload(t.id);
  }
  if (!ACTIVE.has(t.state)) state.files.delete(t.id);
  // Keep a long-open tab bounded like the server's history.
  if (state.transfers.size > 200) {
    const old = [...state.transfers.values()].filter((x) => !ACTIVE.has(x.state)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const x of old.slice(0, state.transfers.size - 200)) state.transfers.delete(x.id);
  }
  scheduleRender();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderTransfers();
  });
}

async function upload(id) {
  const file = state.files.get(id);
  state.uploading.add(id);
  try {
    onTransfer(await api(`/api/send/${id}/body`, { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } }));
  } catch (err) {
    const t = state.transfers.get(id);
    // +0.5 so this local verdict beats a same-revision server snapshot but not a later real one.
    if (t && ACTIVE.has(t.state)) onTransfer({ ...t, state: 'failed', error: err.message, rev: (t.rev || 0) + 0.5 });
  } finally {
    state.uploading.delete(id);
    state.files.delete(id);
  }
}

async function sendFiles(files) {
  const peerId = $('peer').value;
  if (!peerId || !state.status?.running) return;
  for (const file of files) {
    try {
      const t = await api('/api/send', { method: 'POST', json: { peerId, name: file.name, size: file.size } });
      state.files.set(t.id, file);
      onTransfer(t);
      // The receiver may already have accepted (event arrived before this response).
      const latest = state.transfers.get(t.id);
      if (latest?.state === 'accepted' && !state.uploading.has(t.id)) upload(t.id);
      else if (!latest || !ACTIVE.has(latest.state)) state.files.delete(t.id);
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
}

// ---- wiring ----
function init() {
  if (!token) return showLocked();
  $('peer').addEventListener('change', () => {
    state.selectedPeer = $('peer').value;
    renderPeers();
  });
  $('file').addEventListener('change', (e) => {
    sendFiles([...e.target.files]);
    e.target.value = '';
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (!$('file').disabled) drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if ($('file').disabled) return;
    const items = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
    const dirs = items.filter((i) => i.webkitGetAsEntry?.()?.isDirectory).length;
    const files = items.length
      ? items.filter((i) => !i.webkitGetAsEntry?.()?.isDirectory).map((i) => i.getAsFile()).filter(Boolean)
      : [...e.dataTransfer.files];
    if (dirs) alert('Folders can\'t be sent yet. Zip the folder first, or drop the files inside it.');
    sendFiles(files);
  });
  $('ts-pill').addEventListener('click', () => api('/api/refresh', { method: 'POST' }).then((r) => onStatus(r.status)).catch(() => {}));
  window.addEventListener('beforeunload', (e) => {
    if (state.files.size) e.preventDefault();
  });
  listen();
}

init();
