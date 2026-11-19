// Builds the portal.ruxera.com download site as a Cloudflare Build Output (.cloudflare/output)
// for `cf deploy --prebuilt`. It is assets only: the landing page plus a single bundled portal.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveAndParseConfig } from '@cloudflare/config';
import { cleanBuildOutputDir, writeAssets, writeRootConfig, writeWorkerConfig } from '@cloudflare/build-output-utils';
import cloudflareConfig from '../cloudflare.config.ts';
import pkg from '../package.json';

const ROOT = path.join(import.meta.dir, '..');
const STAGE = path.join(ROOT, 'dist', 'site');
// Production only: there is one site and no preview/staging variant.
const buildContext = { isPreview: false, mode: 'production' };

// @cloudflare/config can't load .ts files itself under Bun, but Bun imports it fine; parse that.
const parsed = await resolveAndParseConfig(cloudflareConfig, buildContext);
if (!parsed.success) {
  console.error('cloudflare.config.ts is invalid:', parsed.error);
  process.exit(1);
}

// Clear the previous output first, so a failed build can't leave an old one for `cf deploy --prebuilt`.
await cleanBuildOutputDir(ROOT);
await fs.rm(STAGE, { recursive: true, force: true });
await fs.mkdir(STAGE, { recursive: true });

// One self-contained file: src/ui.js embeds the UI through text imports.
// Not minified, so anyone can read what they're about to run.
const result = await Bun.build({
  entrypoints: [path.join(ROOT, 'src', 'main.js')],
  target: 'bun',
  outdir: STAGE,
  naming: 'portal.js',
  banner: `// just-a-portal v${pkg.version}. Run with: bun --no-env-file portal.js (from its own folder). Source: https://github.com/irshadnazree/just-a-portal`,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundle = await fs.readFile(path.join(STAGE, 'portal.js'));
const sha256 = new Bun.CryptoHasher('sha256').update(bundle).digest('hex');
const size = `${Math.round(bundle.length / 1024)} KB`;
const fill = (s) => s.replaceAll('{{VERSION}}', pkg.version).replaceAll('{{SHA256}}', sha256).replaceAll('{{SIZE}}', size);

const site = path.join(ROOT, 'site');
for (const name of await fs.readdir(site)) {
  const src = path.join(site, name);
  if (name.endsWith('.html')) await fs.writeFile(path.join(STAGE, name), fill(await fs.readFile(src, 'utf8')));
  else await fs.copyFile(src, path.join(STAGE, name));
}
await fs.copyFile(path.join(ROOT, 'public', 'icon.svg'), path.join(STAGE, 'icon.svg'));
await fs.writeFile(path.join(STAGE, 'portal.js.sha256'), `${sha256}  portal.js\n`);

await writeAssets({ root: ROOT, sourceDirectory: STAGE });
await writeWorkerConfig({ root: ROOT, config: parsed.data.worker });
await writeRootConfig({ root: ROOT, buildContext, producer: { name: pkg.name, version: pkg.version } });

console.log(`Built .cloudflare/output (assets from ${path.relative(ROOT, STAGE)})`);
console.log(`  portal.js  ${size}  sha256 ${sha256}`);
