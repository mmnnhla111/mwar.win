-- 0012: total-earnings privacy, EC cap 30, orphan marketplace listings, game + room registry

-- 1. Total earnings privacy on profile / sidebar: 'public' | 'masked' | 'hidden'
ALTER TABLE users ADD COLUMN earnings_visibility TEXT NOT NULL DEFAULT 'public';

-- 2. EC cap 6 -> 30 for every account (new accounts start with 1 EC, set by the sign-up code)
UPDATE users SET max_energy_tickets = 30 WHERE max_energy_tickets < 30;

-- 3. Admin can list orphan players (no upline) on the marketplace; the sale goes to the platform
ALTER TABLE marketplace_listings ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'player';
CREATE INDEX IF NOT EXISTS idx_market_target_status ON marketplace_listings(target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_users_status_created ON users(status, created_at);

-- 4. Game registry (adding a game = a row, no code change)
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT,
  description TEXT,
  genre_tags TEXT NOT NULL DEFAULT '[]',          -- JSON array
  logo_url TEXT,
  cover_url TEXT,
  route_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'coming_soon' CHECK (status IN ('active', 'coming_soon', 'maintenance')),
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO games (id, slug, title, subtitle, description, genre_tags, route_path, status, sort_order)
VALUES ('fps', 'fps', 'MWAR Tactical FPS', 'Play-to-earn 3D shooter',
        'Battle on the 960 m Grand Valley or the 240 m Metro Block. Earn on every elimination.',
        '["3D FPS","Play-to-Earn","Mobile & PC"]', '/games/fps', 'active', 0);

-- 5. Rooms per game per game-server node
CREATE TABLE IF NOT EXISTS game_server_rooms (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  node_id TEXT,                                    -- game_nodes.id (NULL = any node)
  room_code TEXT NOT NULL,                         -- e.g. TH-01
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('warzone', 'skirmish', 'fast_mini', 'solo_bot')),
  map_size TEXT NOT NULL CHECK (map_size IN ('small', 'large')),
  max_players INTEGER NOT NULL CHECK (max_players BETWEEN 2 AND 200),
  max_spectators INTEGER NOT NULL DEFAULT 50 CHECK (max_spectators BETWEEN 0 AND 500),
  entry_cost_ec INTEGER NOT NULL DEFAULT 1 CHECK (entry_cost_ec BETWEEN 0 AND 30),
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  rules TEXT NOT NULL DEFAULT '[]',                -- JSON array of short rule lines
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (game_id, room_code)
);
CREATE INDEX IF NOT EXISTS idx_game_rooms_game ON game_server_rooms(game_id, sort_order);

INSERT OR IGNORE INTO game_server_rooms (id, game_id, node_id, room_code, name, mode, map_size, max_players, max_spectators, entry_cost_ec, sort_order, rules) VALUES
  ('fps-TH-01', 'fps', 'mwar-game-server-1', 'TH-01', 'Warzone 100 — Open World', 'warzone', 'large', 100, 100, 1, 10,
   '["100-player free-for-all on the 960 m map","Kill bounty paid on every elimination","Suicide / fall deaths drop a bounty chest"]'),
  ('fps-TH-02', 'fps', 'mwar-game-server-1', 'TH-02', 'Skirmish 30 — Small Map', 'skirmish', 'small', 30, 50, 1, 20,
   '["30-player free-for-all on the 240 m map","Respawn 3 s after each death","Kill bounty paid on every elimination"]'),
  ('fps-TH-03', 'fps', 'mwar-game-server-1', 'TH-03', 'Fast & Mini — CQB Arena', 'fast_mini', 'small', 16, 30, 1, 30,
   '["Close-quarters fights on the 240 m block","Respawn 3 s after each death","Kill bounty paid on every elimination"]'),
  ('fps-SOLO', 'fps', NULL, 'SOLO', 'Bot Practice & EC Charge', 'solo_bot', 'small', 20, 0, 0, 40,
   '["20 offline bots, free to play","No cash or EC from bot kills (EC comes from ads)","Great for warming up your aim"]');
