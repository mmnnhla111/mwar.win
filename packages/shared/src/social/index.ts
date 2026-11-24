import { z } from 'zod';

/**
 * Social platform + multi-game hub contracts shared by apps/api-worker and apps/web.
 * Everything here is plain data (no runtime deps beyond zod) so both sides stay in sync.
 */

// ---------------------------------------------------------------------------
// Limits (keep D1 rows and R2 objects tiny)
// ---------------------------------------------------------------------------
export const SOCIAL_PAGE_SIZE = 10;
export const SOCIAL_POST_MAX_CHARS = 1000;
export const SOCIAL_COMMENT_MAX_CHARS = 300;
export const SOCIAL_BIO_MAX_CHARS = 160;
export const SOCIAL_DISPLAY_NAME_MAX_CHARS = 40;
/** Client-compressed WebP upload ceiling (bytes). */
export const SOCIAL_IMAGE_MAX_BYTES = 120 * 1024;
export const SOCIAL_IMAGE_MAX_WIDTH = 720;
export const SOCIAL_IMAGE_WEBP_QUALITY = 0.72;
export const PASSWORD_RESET_TTL_SECONDS = 15 * 60;

export const SOCIAL_POST_TAGS = ['General', 'Highlight', 'LookingForSquad', 'Market'] as const;
export type SocialPostTag = (typeof SOCIAL_POST_TAGS)[number];

/** Pastel cover gradients a profile can pick (id -> [from, to]). */
export const PROFILE_COVER_COLORS = {
  lemon: ['#FFF6B7', '#FFE135'],
  mint: ['#E7FBF2', '#A7F3D0'],
  peach: ['#FFF1EC', '#FECDD3'],
  sky: ['#EEF8FF', '#BAE6FD'],
  lilac: ['#F5F0FF', '#DDD6FE'],
  sand: ['#FBF7EF', '#E7DCC8'],
} as const;
export type ProfileCoverColor = keyof typeof PROFILE_COVER_COLORS;
export const PROFILE_COVER_IDS = Object.keys(PROFILE_COVER_COLORS) as ProfileCoverColor[];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
export const ForgotPasswordSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(254),
});

export const ResetPasswordSchema = z.object({
  token: z.string().trim().min(16).max(128),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

/** Avatar / post images must be our own R2 media URLs or bundled presets (never data: URLs). */
const mediaUrl = z
  .string()
  .max(300)
  .refine((v) => /^\/images\/[a-z0-9_./-]+$/i.test(v) || /^https?:\/\/[^\s/]+\/api\/media\/[a-z0-9-]{8,64}\/[a-z0-9-]{8,64}\.webp$/i.test(v), 'Invalid image URL');

export const SocialPostCreateSchema = z.object({
  body: z.string().trim().max(SOCIAL_POST_MAX_CHARS).default(''),
  tag: z.enum(SOCIAL_POST_TAGS).default('General'),
  imageUrl: mediaUrl.optional().nullable(),
}).refine((v) => v.body.length > 0 || !!v.imageUrl, { message: 'Write something or attach a photo' });

export const SocialCommentCreateSchema = z.object({
  body: z.string().trim().min(1, 'Comment is empty').max(SOCIAL_COMMENT_MAX_CHARS),
});

export const SocialProfileUpdateSchema = z.object({
  displayName: z.string().trim().max(SOCIAL_DISPLAY_NAME_MAX_CHARS).optional(),
  bio: z.string().trim().max(SOCIAL_BIO_MAX_CHARS).optional(),
  avatarUrl: mediaUrl.optional(),
  coverColor: z.enum(PROFILE_COVER_IDS as [ProfileCoverColor, ...ProfileCoverColor[]]).optional(),
});

export type SocialPostCreateInput = z.infer<typeof SocialPostCreateSchema>;
export type SocialProfileUpdateInput = z.infer<typeof SocialProfileUpdateSchema>;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------
export interface SocialAuthor {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface SocialPost {
  id: string;
  author: SocialAuthor;
  body: string;
  tag: SocialPostTag;
  imageUrl: string | null;
  likeCount: number;
  commentCount: number;
  createdAt: number;
  likedByMe?: boolean;
}

export interface SocialComment {
  id: string;
  postId: string;
  author: SocialAuthor;
  body: string;
  createdAt: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SocialProfile {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverColor: ProfileCoverColor;
  totalKills: number;
  totalMatches: number;
  headBountyMicroUsd: number;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  memberSince: number;
  isFollowing?: boolean;
  isMe?: boolean;
}

export interface SocialNotification {
  id: string;
  type: 'like' | 'comment' | 'follow';
  actor: SocialAuthor;
  postId: string | null;
  isRead: boolean;
  createdAt: number;
}

export interface BootstrapUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  coverColor: ProfileCoverColor;
  role: 'player' | 'admin' | 'auditor';
  rankBadge: string | null;
  energyTickets: number;
  maxEnergyTickets: number;
  energyProgressPct: number;
  secondsToNextRecharge: number;
  createdAt: number;
}

export interface BootstrapWalletSummary {
  balanceMicroUsd: number;
  formattedBalance: string;
  bountyMicroUsd: number;
  totalEarnedMicroUsd: number;
}

/** GET /api/bootstrap — everything the shell needs, in one request. */
export interface BootstrapResponse {
  user: BootstrapUser;
  walletSummary: BootstrapWalletSummary;
  remainingDailyQuestsCount: number;
  unreadNotifCount: number;
  unreadChatCount: number;
  dateKey: string;
  serverTime: number;
}

// ---------------------------------------------------------------------------
// Multi-game hub + XSHOT-style room catalogue
// ---------------------------------------------------------------------------
export type FpsRoomMode = 'standard_100' | 'mini_30' | 'fast_mini' | 'practice';
export type FpsRoomFilter = 'all' | 'large' | 'small' | 'practice';

export interface FpsRoomDef {
  id: string;
  name: string;
  mode: FpsRoomMode;
  modeLabel: string;
  map: string;
  mapSize: 'large' | 'small';
  capacity: number | null; // null = unlimited (local solo)
  costEc: number;
  multiplayer: boolean;
  rules: string[];
}

/** Default seeded rooms: one per core mode, synced with apps/game-server room names. */
export const FPS_ROOMS: readonly FpsRoomDef[] = [
  {
    id: 'TH-01',
    name: 'Warzone 100 — Open World',
    mode: 'standard_100',
    modeLabel: '100P Warzone',
    map: 'Grand Valley (960m)',
    mapSize: 'large',
    capacity: 100,
    costEc: 1,
    multiplayer: true,
    rules: ['100-player free-for-all on the 960 m map', 'Kill bounty paid on every elimination', 'Suicide / fall deaths drop a bounty chest'],
  },
  {
    id: 'TH-02',
    name: 'Skirmish 30 — Tactical',
    mode: 'mini_30',
    modeLabel: '30P Skirmish',
    map: 'Grand Valley (960m)',
    mapSize: 'large',
    capacity: 30,
    costEc: 1,
    multiplayer: true,
    rules: ['30-player free-for-all on the 960 m map', 'Respawn 3 s after each death', 'Kill bounty paid on every elimination'],
  },
  {
    id: 'TH-03',
    name: 'Fast & Mini — CQB Arena',
    mode: 'fast_mini',
    modeLabel: 'Fast & Mini',
    map: 'Metro Block (240m)',
    mapSize: 'small',
    capacity: 16,
    costEc: 1,
    multiplayer: true,
    rules: ['Close-quarters fights on the 240 m block', 'Respawn 3 s after each death', 'Kill bounty paid on every elimination'],
  },
  {
    id: 'SOLO',
    name: 'Bot Practice & EC Charge',
    mode: 'practice',
    modeLabel: 'Solo Bot (20 Bots)',
    map: 'Metro Block (240m)',
    mapSize: 'small',
    capacity: null,
    costEc: 0,
    multiplayer: false,
    rules: ['20 offline bots, free to play', 'No cash or EC from bot kills (EC comes from ads)', 'Great for warming up your aim'],
  },
] as const;

export interface FpsRosterEntry {
  username: string;
  userId: string | null;
  kills: number;
  deaths: number;
  status: 'alive' | 'dead' | 'spectating';
}

export interface FpsRoomLive extends FpsRoomDef {
  players: number;
  spectators: number;
  isFull: boolean;
}

export interface FpsRoomsResponse {
  rooms: FpsRoomLive[];
  serverOnline: boolean;
  updatedAt: number;
}

export interface FpsRoomRosterResponse {
  roomId: string;
  items: FpsRosterEntry[];
  nextCursor: string | null;
  total: number;
}

export interface GameDirectoryEntry {
  id: string;
  name: string;
  href: string;
  tags: string[];
  totalPlayers: number;
  onlineNow: number;
  live: boolean;
}

export interface GamesResponse {
  games: GameDirectoryEntry[];
  updatedAt: number;
}

/** Build the /game launch URL for a room (spectate=1 keeps the room's mode so the right map loads). */
export function fpsLaunchUrl(room: Pick<FpsRoomDef, 'id' | 'mode'>, spectate = false): string {
  const p = new URLSearchParams({ mode: room.mode, room: room.id });
  if (spectate) p.set('spectate', '1');
  return `/game?${p.toString()}`;
}
