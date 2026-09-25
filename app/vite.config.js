import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app imports two sibling packages by relative path - ../shared and ../ai -
// exactly as api/ and cli/ do. Both are dependency-free ESM, so they bundle for
// the browser unchanged; `fs.allow` lets the dev server serve them from outside
// this package root. (api/ is deliberately NOT imported: it pulls
// @midnight-ntwrk/compact-runtime, which is Node-only. See src/game/driver.js.)
export default defineConfig({
  plugins: [react()],
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
