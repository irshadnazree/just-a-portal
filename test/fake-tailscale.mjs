#!/usr/bin/env node
// Stand-in for the `tailscale` CLI in tests. Reads its world from the JSON file in $FAKE_TS_FILE:
//   { "status": <status --json output>, "whois": { "<ip>": <whois --json output> } }
import fs from 'node:fs';
const world = JSON.parse(fs.readFileSync(process.env.FAKE_TS_FILE, 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'status') {
  // statusRaw lets a test hand over exact JSON text (e.g. int64 ids that JS numbers can't hold).
  process.stdout.write(world.statusRaw ?? JSON.stringify(world.status));
  process.exit(world.statusRaw || world.status.BackendState === 'Running' ? 0 : 1);
}
if (cmd === 'whois') {
  const ip = rest.filter((a) => !a.startsWith('-'))[0];
  const w = world.whois?.[ip];
  if (!w) { process.stderr.write('no match for IP\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(w));
  process.exit(0);
}
process.exit(2);
