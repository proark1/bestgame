import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PicnicRoom } from './rooms/PicnicRoom.js';

const PORT = Number(process.env.ARENA_PORT ?? 2567);

const gameServer = new Server({
  transport: new WebSocketTransport({
    // Future: TLS termination at Fly.io; behind proxy here.
  }),
});

gameServer.define('picnic', PicnicRoom);

gameServer
  .listen(PORT)
  .then(() => {
    console.log(`@hive/arena listening on ws://0.0.0.0:${PORT}`);
  })
  .catch((err) => {
    console.error('arena listen failed', err);
    process.exit(1);
  });
