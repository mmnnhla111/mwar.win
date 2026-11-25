import { z } from 'zod';
import type { FpsRoomMode } from '../social';

// ---------------------------------------------------------------------------
// Game + room registry (D1 tables `games` and `game_server_rooms`, admin-managed)
// ---------------------------------------------------------------------------

export const GAME_STATUSES = ['active', 'coming_soon', 'maintenance'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

/** Room modes as the admin picks them. */
export const ROOM_MODES = ['warzone', 'skirmish', 'fast_mini', 'solo_bot'] as const;
export type RoomMode = (typeof ROOM_MODES)[number];

/** Admin room mode -> the game engine mode (game server rule set, entry API, /game?mode=). */
export const ROOM_MODE_ENGINE: Record<RoomMode, FpsRoomMode> = {
  warzone: 'standard_100',
  skirmish: 'mini_30',
  fast_mini: 'fast_mini',
  solo_bot: 'practice',
};

export const MAP_SIZES = ['small', 'large'] as const;
export type MapSize = (typeof MAP_SIZES)[number];
export const MAP_LABELS: Record<MapSize, string> = {
  small: 'Metro Block (240m)',
  large: 'Grand Valley (960m)',
};

export const ROOM_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,15}$/;
export const GAME_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export interface GameRecord {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  genreTags: string[];
  logoUrl: string | null;
  coverUrl: string | null;
  routePath: string;
  status: GameStatus;
  sortOrder: number;
  updatedAt: number;
}

/** Public game directory entry (GET /api/games). */
export interface GameDirectoryItem extends GameRecord {
  totalPlayers: number;
  onlineNow: number;
}

export interface GamesResponse {
  games: GameDirectoryItem[];
  updatedAt: number;
}

export interface GameRoomConfig {
  id: string;
  gameId: string;
  nodeId: string | null;
  roomCode: string;
  name: string;
  mode: RoomMode;
  mapSize: MapSize;
  maxPlayers: number;
  maxSpectators: number;
  entryCostEc: number;
  isActive: boolean;
  sortOrder: number;
  rules: string[];
  updatedAt: number;
}

/** GET /api/games/rooms-config — what the game server needs (public, edge-cached 20 s). */
export interface RoomsConfigResponse {
  rooms: Array<Pick<GameRoomConfig, 'roomCode' | 'nodeId' | 'mode' | 'mapSize' | 'maxPlayers' | 'maxSpectators' | 'entryCostEc' | 'isActive'> & { engineMode: FpsRoomMode; gameSlug: string; nodeName?: string | null }>;
  updatedAt: number;
}

const optUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || v.startsWith('/') || /^https:\/\//.test(v), 'Use an https:// URL or an uploaded image')
  .optional()
  .nullable();

export const GameUpsertSchema = z.object({
  slug: z.string().trim().regex(GAME_SLUG_RE, 'Slug: 2–32 lowercase letters, digits or -'),
  title: z.string().trim().min(2).max(80),
  subtitle: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(1000).optional().nullable(),
  genreTags: z.array(z.string().trim().min(1).max(24)).max(8).default([]),
  logoUrl: optUrl,
  coverUrl: optUrl,
  routePath: z.string().trim().regex(/^\/[a-z0-9/_-]{1,63}$/, 'Route must start with /'),
  status: z.enum(GAME_STATUSES).default('coming_soon'),
  sortOrder: z.number().int().min(0).max(9999).default(100),
});
export const GamePatchSchema = GameUpsertSchema.partial();

export const RoomUpsertSchema = z.object({
  roomCode: z.string().trim().toUpperCase().regex(ROOM_CODE_RE, 'Room code: 2–16 of A-Z, 0-9, - or _'),
  name: z.string().trim().min(2).max(60),
  nodeId: z.string().trim().max(64).optional().nullable(),
  mode: z.enum(ROOM_MODES),
  mapSize: z.enum(MAP_SIZES),
  maxPlayers: z.number().int().min(2).max(200),
  maxSpectators: z.number().int().min(0).max(500).default(50),
  entryCostEc: z.number().int().min(0).max(30).default(1),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(100),
  rules: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
});
export const RoomPatchSchema = RoomUpsertSchema.partial();

// ---------------------------------------------------------------------------
// Admin: members + orphan marketplace listings
// ---------------------------------------------------------------------------
export const MEMBER_FILTERS = ['all', 'orphan', 'listed', 'active', 'suspended'] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

export interface AdminMemberRow {
  id: string;
  username: string;
  displayName: string | null;
  status: 'active' | 'suspended' | 'banned';
  role: 'player' | 'admin' | 'auditor';
  staffRole: import('../platform').StaffRole;
  referrerId: string | null;
  referrerUsername: string | null;
  energyTickets: number;
  balanceMicroUsd: number;
  totalEarnedMicroUsd: number;
  createdAt: number;
  /** Active marketplace listing on this member, if any. */
  listing: { id: string; priceMicroUsd: number; type: 'player' | 'orphan' } | null;
}

export interface AdminMemberDetail extends AdminMemberRow {
  telegram: { username: string | null; displayName: string | null } | null;
  line: { displayName: string | null } | null;
  directDownlines: number;
  totalDownlines: number;
  downlinesByDepth: number[];
  totalKills: number;
  totalMatches: number;
  /** Up to 50 members of the 5-tier tree under this player. */
  tree: Array<{ id: string; username: string; depth: number }>;
}

export const AdminMemberPatchSchema = z
  .object({
    ecDelta: z.number().int().min(-1000).max(1000).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((v) => v.ecDelta !== undefined || v.status !== undefined, { message: 'Nothing to update' });

export const ListOrphansSchema = z.object({
  items: z
    .array(z.object({ userId: z.string().min(1).max(64), priceMicroUsd: z.number().int().min(10_000).max(100_000_000_000) }))
    .min(1)
    .max(50),
});

export const OrphanListingPatchSchema = z
  .object({
    priceMicroUsd: z.number().int().min(10_000).max(100_000_000_000).optional(),
    delist: z.boolean().optional(),
  })
  .refine((v) => v.priceMicroUsd !== undefined || v.delist === true, { message: 'Nothing to update' });
