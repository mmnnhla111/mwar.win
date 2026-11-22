import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'colyseus';
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
    roomsAvailable: ['mini_30', 'standard_100'],
    timestamp: new Date().toISOString(),
  });
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

httpServer.listen(port, host, () => {
  console.log(`[Game Server] Colyseus authoritative shooter server listening on ws://${host}:${port}`);
  console.log(`[Game Server] Healthcheck: http://${host}:${port}/health`);
  console.log(`[Game Server] Defined Rooms: 'mini_30' (30-player, 250m) and 'standard_100' (100-player, 600m)`);
});
