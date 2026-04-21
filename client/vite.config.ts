import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Facebook Instant Games caps first load at 5 MB. Target: ≤ 2.5 MB.
// Aggressive code-split so arena, clan, and replay viewer lazy-load.
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
      // Multi-page build: the game entrypoint (index.html → src/main.ts)
      // and the admin panel (admin.html → src/admin/main.ts) share
      // the same dist but load independently. The admin bundle stays
      // small (no Phaser) so it opens fast even over a slow connection.
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
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
