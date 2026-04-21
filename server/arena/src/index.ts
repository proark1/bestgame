import { createServer } from 'node:http';
import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PicnicRoom } from './rooms/PicnicRoom.js';

// Railway (and most PaaS) inject PORT at runtime. Fall back to
// ARENA_PORT for local multi-process dev where both the api (8787)
// and arena (2567) run side-by-side on fixed ports.
const PORT = Number(process.env.PORT ?? process.env.ARENA_PORT ?? 2567);

// We bring our own http.Server so we can answer /health (Railway's
// default readiness probe path) alongside the Colyseus WebSocket
// upgrade. Without this the probe hits the colyseus default matchmaker
// endpoint, gets an unexpected shape, and Railway eventually kills the
// service in a restart loop.
const bootedAtMs = Date.now();
const httpServer = createServer((req, res) => {
  // Only answer the readiness probe. Everything else falls through to
  // the WebSocketTransport upgrade handler.
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'arena',
        uptimeMs: Date.now() - bootedAtMs,
      }),
    );
    return;
  }
  // Anything not claimed by WS upgrade or /health is a client error —
  // a browser hitting the arena URL without ws:// gets a clear hint.
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('hive arena: WebSocket only. Use wss:// or ws://.\n');
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('picnic', PicnicRoom);

gameServer
  .listen(PORT)
  .then(() => {
    console.log(`@hive/arena listening on :${PORT} (ws + /health)`);
    const apiUrl = process.env.HIVE_API_URL;
    if (!apiUrl) {
      console.warn(
        '[arena] HIVE_API_URL not set — /arena/_lookup will default to 127.0.0.1:8787 and rooms will fall back to NEUTRAL_MAP in production.',
      );
    } else {
      console.log(`[arena] HIVE_API_URL = ${apiUrl}`);
    }
    if (!process.env.ARENA_SHARED_SECRET) {
      console.warn(
        '[arena] ARENA_SHARED_SECRET not set — /arena/_lookup will only accept loopback, so cross-host deploys will 401 and rooms will fall back to NEUTRAL_MAP.',
      );
    }
  })
  .catch((err) => {
    console.error('arena listen failed', err);
    process.exit(1);
  });
