import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { ShootingRoom } from './rooms/ShootingRoom';
import { startRegistryRefresh, registryRooms } from './roomRegistry';

// Attempt to load .env from multiple candidate locations
const envCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  '/opt/mwar-node/.env',
];

for (const candidate of envCandidates) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    console.log(`[Game Server] Loaded environment from: ${candidate}`);
    break;
  }
}

const port = Number(process.env.GAME_PORT || process.env.PORT) || 2567;
const host = '0.0.0.0';
const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'MWAR Authoritative Game Server (Colyseus v0.15+)',
    tickRateHz: 20,
    roomsAvailable: ['arena', 'mini_30', 'standard_100', 'fast_mini'],
    registryRooms: registryRooms().map((r) => r.roomCode),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Read-only live room snapshot for the web Room Lobby (proxied + edge-cached 15 s by the API worker).
 * RAM only: player / spectator counts and a capped roster per mode, summed across room instances.
 */
const ROSTER_CAP = 120;
app.get('/rooms', async (_req, res) => {
  type Bucket = { players: number; spectators: number; roster: Array<{ username: string; userId: string; kills: number; deaths: number; status: string }> };
  const modes: Record<string, Bucket> = {};
  for (const mode of ['standard_100', 'mini_30', 'fast_mini']) modes[mode] = { players: 0, spectators: 0, roster: [] };
  // Per registry room code (what the web lobby shows); legacy per-mode rooms are still reported in `modes`
  const rooms: Record<string, Bucket> = {};
  for (const r of registryRooms()) rooms[r.roomCode] = { players: 0, spectators: 0, roster: [] };
  try {
    const listings = await matchMaker.query({});
    for (const listing of listings) {
      const code = (listing.metadata as any)?.roomCode;
      const bucket = listing.name === 'arena' ? (code ? rooms[code] : undefined) : modes[listing.name];
      if (!bucket) continue;
      const room = matchMaker.getRoomById(listing.roomId) as any;
      const players: any[] = room?.state?.players ? Array.from(room.state.players.values()) : [];
      if (players.length === 0) {
        bucket.players += listing.clients || 0;
        continue;
      }
      for (const p of players) {
        if (p.isSpectator) bucket.spectators += 1;
        else bucket.players += 1;
        if (bucket.roster.length < ROSTER_CAP) {
          bucket.roster.push({
            username: String(p.username || 'Player'),
            userId: String(p.id || ''),
            kills: Number(p.kills) || 0,
            deaths: Number(p.deaths) || 0,
            status: p.isSpectator ? 'spectating' : p.isGhost ? 'dead' : 'alive',
          });
        }
      }
    }
  } catch (err) {
    console.warn('[Game Server] /rooms snapshot failed', err);
  }
  res.set('Cache-Control', 'public, max-age=10');
  res.json({ rooms, modes, timestamp: Date.now() });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
  }),
});

// Define Game Rooms
gameServer
  .define('mini_30', ShootingRoom, { mode: 'mini_30' })
  .enableRealtimeListing();

gameServer
  .define('standard_100', ShootingRoom, { mode: 'standard_100' })
  .enableRealtimeListing();

// Fast & Mini Mode: compact 240 m map (30P Skirmish also uses the 240 m map; 100P Warzone the 960 m map)
gameServer
  .define('fast_mini', ShootingRoom, { mode: 'fast_mini' })
  .enableRealtimeListing();

// Admin room registry (GET /api/games/rooms-config): one 'arena' room per configured room code.
// The client sends only { roomCode }; mode, map and seat caps come from the registry.
gameServer.define('arena', ShootingRoom).filterBy(['roomCode']).enableRealtimeListing();
startRegistryRefresh();

httpServer.listen(port, host, () => {
  console.log(`[Game Server] Colyseus authoritative shooter server listening on ws://${host}:${port}`);
  console.log(`[Game Server] Healthcheck: http://${host}:${port}/health`);
  console.log(`[Game Server] Defined Rooms: 'arena' (admin registry by roomCode), legacy 'mini_30' (240m), 'standard_100' (960m), 'fast_mini' (240m)`);
});
