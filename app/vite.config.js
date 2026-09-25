import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

// The app imports two sibling packages by relative path - ../shared and ../ai -
// exactly as api/ and cli/ do. Both are dependency-free ESM, so they bundle for
// the browser unchanged; `fs.allow` lets the dev server serve them from outside
// this package root. (api/ is deliberately NOT imported: it pulls
// @midnight-ntwrk/compact-runtime, which is Node-only. See src/game/driver.js.)
export default defineConfig({
  // The Midnight SDK chain modules need WASM, top-level await, node polyfills
  // and CommonJS interop in the browser bundle (see src/chain/).
  plugins: [
    react(),
    wasm(),
    viteCommonjs(),
    nodePolyfills({ include: ['buffer', 'process', 'util', 'crypto', 'stream'], globals: { Buffer: true, process: true } }),
  ],
  optimizeDeps: { exclude: ['@midnight-ntwrk'] },
  resolve: {
    // The staged contract module and src/chain must share ONE copy of the
    // compact runtime; two copies break its instanceof checks.
    dedupe: ['@midnight-ntwrk/compact-runtime', '@midnight-ntwrk/onchain-runtime-v3'],
  },
  server: {
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.{js,jsx}'],
    restoreMocks: true,
  },
});
