import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Target a lean first load on mobile. Aggressive code-split so arena,
// clan, and replay viewer lazy-load; the landing page ships zero JS
// besides the tiny inline localStorage sniff.
export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      // Multi-page build. index.html is the marketing landing (no
      // Phaser — ~2 KB of inline CSS + a single CTA link). play.html
      // is the game shell and loads src/main.ts. admin.html is the
      // separate admin panel. Each entrypoint produces its own
      // dedicated main bundle but shares chunks via the manualChunks
      // split below.
      input: {
        main: resolve(__dirname, 'index.html'),
        play: resolve(__dirname, 'play.html'),
        admin: resolve(__dirname, 'admin.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        terms: resolve(__dirname, 'terms.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/phaser')) return 'phaser';
          if (id.includes('node_modules/colyseus.js')) return 'colyseus';
          if (id.includes('/scenes/ArenaScene')) return 'arena';
          if (id.includes('/scenes/ClanScene')) return 'clan';
          if (id.includes('/scenes/RaidScene')) return 'raid';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@hive/shared': resolve(__dirname, '../shared/src'),
      '@hive/protocol': resolve(__dirname, '../protocol/src'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
