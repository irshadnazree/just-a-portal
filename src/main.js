#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPortal } from './portal.js';
import { createUiServer } from './ui.js';

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

export function loadConfig() {
  const peerPort = int('PORTAL_PEER_PORT', 7778);
  return {
    uiPort: int('PORTAL_UI_PORT', 7777),
    peerPort,
    remotePeerPort: int('PORTAL_REMOTE_PEER_PORT', peerPort),
    downloadDir: path.resolve(process.env.PORTAL_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'just-a-portal')),
    maxBytes: int('PORTAL_MAX_BYTES', 20 * 1024 ** 3),
    allowAnyTailnetUser: process.env.PORTAL_ALLOW_ANY_TAILNET_USER === '1',
    watchdogMs: int('PORTAL_WATCHDOG_MS', 3000),
    idleTimeoutMs: int('PORTAL_IDLE_TIMEOUT_MS', 30_000),
    offerTimeoutMs: int('PORTAL_OFFER_TIMEOUT_MS', 120_000),
    acceptTimeoutMs: int('PORTAL_ACCEPT_TIMEOUT_MS', 60_000),
    maxPendingOffers: 16,
    maxPendingPerPeer: 4,
    maxActiveReceives: 4,
    maxActiveSends: 8,
    maxPeerConnections: 32,
    maxConcurrentLookups: 8,
    maxQueuedLookups: 32,
    maxHistory: 200,
  };
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {}
}

async function main() {
  const config = loadConfig();
  const portal = createPortal(config);
  const ui = createUiServer(portal, config);
  await ui.listen();
  await portal.start();

  const s = portal.publicStatus();
  console.log('just-a-portal is running.');
  console.log(`  Tailscale: ${s.running ? `connected as ${s.self.name} (${s.self.ip})` : `NOT connected (${s.state}) — transfers are disabled`}`);
  console.log(`  Peer port: ${config.peerPort} (Tailscale address only)`);
  console.log(`  Downloads: ${config.downloadDir}`);
  console.log('\nOpen this link (it contains your private session key — don\'t share it):');
  console.log(`  ${ui.url}\n`);
  if (!process.argv.includes('--no-open')) openBrowser(ui.url);

  portal.events.on('status', (st) => {
    if (st.running !== s.running) {
      s.running = st.running;
      console.log(st.running ? `[tailscale] connected (${st.self?.ip})` : `[tailscale] disconnected (${st.state}) — transfers stopped`);
    }
  });

  const shutdown = async () => {
    await portal.stop();
    await ui.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port already in use: ${err.message}` : err);
  process.exit(1);
});
