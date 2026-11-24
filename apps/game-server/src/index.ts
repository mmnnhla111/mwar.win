import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server, matchMaker } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { ShootingRoom } from './rooms/ShootingRoom';

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
    roomsAvailable: ['mini_30', 'standard_100', 'fast_mini'],
    timestamp: new Date().toISOString(),
  });
});

/**
 * Read-only live room snapshot for the web Room Lobby (proxied + edge-cached 15 s by the API worker).
 * RAM only: player / spectator counts and a capped roster per mode, summed across room instances.
 */
const ROSTER_CAP = 120;
app.get('/rooms', async (_req, res) => {
  const modes: Record<string, { players: number; spectators: number; roster: Array<{ username: string; userId: string; kills: number; deaths: number; status: string }> }> = {};
  for (const mode of ['standard_100', 'mini_30', 'fast_mini']) modes[mode] = { players: 0, spectators: 0, roster: [] };
  try {
    const listings = await matchMaker.query({});
    for (const listing of listings) {
      const bucket = modes[listing.name];
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
  res.json({ modes, timestamp: Date.now() });
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

// Fast & Mini Mode keeps the compact 240 m map (30P Skirmish + 100P Warzone use the 960 m map)
gameServer
  .define('fast_mini', ShootingRoom, { mode: 'fast_mini' })
  .enableRealtimeListing();

httpServer.listen(port, host, () => {
  console.log(`[Game Server] Colyseus authoritative shooter server listening on ws://${host}:${port}`);
  console.log(`[Game Server] Healthcheck: http://${host}:${port}/health`);
  console.log(`[Game Server] Defined Rooms: 'mini_30' (30P, 960m map), 'standard_100' (100P, 960m map), 'fast_mini' (240m map)`);
});
