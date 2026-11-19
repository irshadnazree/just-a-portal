import { defineConfig } from 'cf/config'

// portal.ruxera.com is a static download page only. The portal itself must run on each PC
// (it needs the local Tailscale CLI and disk), so there is no Worker entrypoint.
// `bun run build` writes the Build Output (.cloudflare/output) that `cf deploy --prebuilt` uploads.
export default defineConfig({
  worker: {
    name: 'just-a-portal',
    compatibilityDate: '2026-11-01',
    assets: { htmlHandling: 'auto-trailing-slash', notFoundHandling: '404-page' },
    // Production only: no workers.dev or per-version preview URLs.
    workersDev: false,
    previewUrls: false,
    domains: ['portal.ruxera.com'],
  },
})
