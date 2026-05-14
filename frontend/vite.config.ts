import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
// avr8js / rp2040js / @wokwi/elements are resolved from npm via package.json.
// (The third-party/ clones are reference-only — keep them updated for credits.)
//
// The `@pro` alias resolves to a no-op stub by default. Private overlays
// (e.g. velxio-prod) set VITE_PRO_BUILD=true and PRO_OVERLAY_PATH at build
// time to point at their actual pro source tree. See README's "Pro overlay"
// section.
const proOverlayPath =
  process.env.VITE_PRO_BUILD && process.env.PRO_OVERLAY_PATH
    ? path.resolve(process.env.PRO_OVERLAY_PATH)
    : path.resolve(__dirname, 'src/__pro_stub__')

export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@pro': proOverlayPath,
      // Stable alias for OSS modules that the pro overlay needs to import
      // (e.g. lib/proRoutes for route registration). Using an alias instead
      // of a relative path makes the import location-independent: it works
      // whether the overlay is symlinked into src/pro/ (local dev — Rollup
      // resolves the import from the real overlay path) or physically
      // COPYed into src/pro/ (Docker build). Either way `@velxio/<x>`
      // points at the OSS src tree.
      '@velxio': path.resolve(__dirname, 'src'),
    },
    // When the pro overlay is wired in via a junction/symlink
    // (Windows pattern: `frontend/src/pro` → `velxio-prod/pro/frontend/src/pro`),
    // Rollup's default behavior walks the symlink to the real path and
    // resolves imports from THAT location — but the real overlay path
    // has no node_modules nearby AND its `../../<x>` paths land outside
    // the OSS src tree. Preserving symlinks keeps the overlay logically
    // anchored inside src/pro/.
    //
    // In Docker builds the overlay is COPYed in physically (no symlinks
    // to follow), so this flag is effectively a no-op there. We keep it
    // gated on VITE_PRO_BUILD so OSS-only builds without the overlay
    // see the default behavior.
    preserveSymlinks: !!process.env.VITE_PRO_BUILD,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true,
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    include: ['avr8js', 'rp2040js', '@wokwi/elements', 'littlefs'],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/simulation/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
}))
