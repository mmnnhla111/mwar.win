-- ============================================================================
-- MWAR Core Database (core_db) - Cloudflare D1 Migration 0003
-- Server Nodes & 1-Click Provisioning Engine
-- ============================================================================

CREATE TABLE IF NOT EXISTS game_nodes (
    id TEXT PRIMARY KEY,                       -- Node ID (e.g. mwar-game-server-1)
    node_name TEXT NOT NULL,                   -- Friendly Name (e.g. mwar-game-server-1)
    role TEXT NOT NULL DEFAULT 'all',          -- 'all' | 'game' | 'logs'
    status TEXT NOT NULL DEFAULT 'offline',    -- 'online' | 'offline'
    ip_address TEXT,                           -- Public or internal IP
    region TEXT DEFAULT 'local_home',          -- 'local_home' | 'apac' | 'us' | 'eu'
    cpu_usage REAL DEFAULT 0.0,                -- 0.0 - 100.0%
    ram_usage REAL DEFAULT 0.0,                -- 0.0 - 100.0%
    active_rooms INTEGER DEFAULT 0,
    player_count INTEGER DEFAULT 0,
    room_capacity_mini INTEGER DEFAULT 30,     -- Mini mode room size (default 30)
    room_capacity_fast INTEGER DEFAULT 100,    -- Standard/Fast mode room size (default 100)
    provision_token TEXT,                      -- Per-node auth token
    tunnel_hostname TEXT,                      -- e.g. game.mwar.win or logs.mwar.win
    last_heartbeat INTEGER,                    -- Unix timestamp
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_game_nodes_status ON game_nodes(status);
CREATE INDEX IF NOT EXISTS idx_game_nodes_last_heartbeat ON game_nodes(last_heartbeat);

-- Seed initial bare-metal node record for user's Ubuntu server
INSERT OR IGNORE INTO game_nodes (id, node_name, role, status, room_capacity_mini, room_capacity_fast, tunnel_hostname)
VALUES ('mwar-game-server-1', 'mwar-game-server-1 (Ubuntu Bare-Metal i5-8400)', 'all', 'offline', 30, 100, 'game.mwar.win');
