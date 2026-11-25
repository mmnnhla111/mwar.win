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
/** Client-compressed WebP avatar ceiling (bytes). */
export const SOCIAL_IMAGE_MAX_BYTES = 120 * 1024;
/** Post photos: client resizes to 720 px / WebP 0.72; the server hard-caps the upload at 150 KB. */
export const SOCIAL_POST_IMAGE_MAX_BYTES = 150 * 1024;
/** Post videos: MP4 / WebM, at most 30 s and 5 MB. */
export const SOCIAL_VIDEO_MAX_BYTES = 5 * 1024 * 1024;
export const SOCIAL_VIDEO_MAX_SECONDS = 30;
export const SOCIAL_REPORT_DETAILS_MAX_CHARS = 500;
export const SOCIAL_REPORT_CONTACT_MAX_CHARS = 120;
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

/**
 * Post fields. Media is never passed by URL: photos / videos travel in the same multipart request
 * (field `media`) so every upload is tied to a post and queued for moderation (no orphan R2 files).
 */
export const SocialPostCreateSchema = z.object({
  body: z.string().trim().max(SOCIAL_POST_MAX_CHARS).default(''),
  tag: z.enum(SOCIAL_POST_TAGS).default('General'),
  /** Author self-tags the post as 18+ (always hidden from viewers with 18+ off). */
  nsfw: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Content policy: moderation + reports + settings
// ---------------------------------------------------------------------------
export type SocialMediaType = 'none' | 'image' | 'video';
export type SocialContentRating = 'safe' | 'nsfw_18';
export type SocialModerationStatus = 'pending' | 'approved' | 'nsfw_18' | 'rejected';
export type ModerationAction = 'approve_safe' | 'mark_nsfw_18' | 'reject_prohibited';

export const REPORT_REASONS = ['violence', 'privacy', 'copyright', 'unlabeled_18', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  violence: 'อาวุธ / เลือด / ความรุนแรง (Weapons / Blood / Violence)',
  privacy: 'ละเมิดความเป็นส่วนตัว / ภาพส่วนตัวของฉัน (Privacy / Non-Consensual Content)',
  copyright: 'ละเมิดลิขสิทธิ์ (Copyright / DMCA)',
  unlabeled_18: 'เนื้อหา 18+ ที่ไม่ติดป้าย (Unlabeled 18+ Content)',
  other: 'อื่นๆ / ขอให้ลบเนื้อหา (Other Takedown Request)',
};

export const ContentReportSchema = z.object({
  postId: z.string().trim().regex(/^[a-z0-9]{8,40}$/i, 'Invalid post'),
  reasonCategory: z.enum(REPORT_REASONS),
  details: z.string().trim().max(SOCIAL_REPORT_DETAILS_MAX_CHARS).optional().default(''),
  contact: z.string().trim().max(SOCIAL_REPORT_CONTACT_MAX_CHARS).optional().default(''),
});

export const ReportActionSchema = z.object({
  action: z.enum(['delete', 'reclassify_18', 'dismiss']),
});

/** UI language codes the account can store (phase 1 active: en, th, id, vi, es; phase 2 slots: zh, ko, ja, hi, pt). */
export const UI_LANG_CODES = ['en', 'th', 'id', 'vi', 'es', 'zh', 'ko', 'ja', 'hi', 'pt'] as const;
export type UiLang = (typeof UI_LANG_CODES)[number];

// ---------------------------------------------------------------------------
// Total earnings privacy (public / masked / hidden)
// ---------------------------------------------------------------------------
export const EARNINGS_VISIBILITY = ['public', 'masked', 'hidden'] as const;
export type EarningsVisibility = (typeof EARNINGS_VISIBILITY)[number];

export interface EarningsDisplay {
  visibility: EarningsVisibility;
  /** "$17,018.00", "$**,***.**", or null when hidden ("Not specified"). */
  display: string | null;
}

/** Micro-USD -> "$17,018.00" (thousands separators, 2 decimals). */
export function formatUsdGrouped(microUsd: number): string {
  const cents = Math.floor(Math.max(0, Number(microUsd) || 0) / 10_000);
  const whole = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

/** Every digit becomes "*" (symbol and separators stay): "$1,234.50" -> "$*,***.**". */
export function maskDigits(v: string): string {
  return v.replace(/[0-9]/g, '*');
}

/** Apply the owner's privacy mode on the server, so masked/hidden amounts never leave the API. */
export function earningsDisplay(totalEarnedMicroUsd: number, visibility: string | null | undefined): EarningsDisplay {
  const vis: EarningsVisibility = (EARNINGS_VISIBILITY as readonly string[]).includes(visibility || '')
    ? (visibility as EarningsVisibility)
    : 'public';
  if (vis === 'hidden') return { visibility: vis, display: null };
  const s = formatUsdGrouped(totalEarnedMicroUsd);
  return { visibility: vis, display: vis === 'masked' ? maskDigits(s) : s };
}

export const SocialSettingsSchema = z
  .object({
    showNsfw: z.boolean().optional(),
    /** Must be true when turning 18+ on (the viewer confirmed they are 18 or older). */
    confirmAdult: z.boolean().optional(),
    preferredLang: z.enum(UI_LANG_CODES).optional(),
    earningsVisibility: z.enum(EARNINGS_VISIBILITY).optional(),
  })
  .refine((v) => v.showNsfw !== undefined || v.preferredLang !== undefined || v.earningsVisibility !== undefined, {
    message: 'Nothing to update',
  });

export const ModerationResultSchema = z.object({
  node_name: z.string().trim().min(1).max(64),
  results: z
    .array(
      z.object({
        job_id: z.string().min(4).max(64),
        post_id: z.string().min(4).max(64),
        action: z.enum(['approve_safe', 'mark_nsfw_18', 'reject_prohibited']),
        reason: z.string().max(200).optional(),
        score: z.number().min(0).max(1).default(0),
        stage_stopped: z.number().int().min(0).max(2).default(2),
      })
    )
    .min(1)
    .max(20),
});

export interface ContentReportItem {
  id: string;
  postId: string;
  reasonCategory: ReportReason;
  details: string | null;
  reporterUsername: string | null;
  reporterContact: string | null;
  createdAt: number;
  /** Number of pending reports on the same post. */
  reportCount: number;
  post: SocialPost | null;
}

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
  /** Approved photo URL (legacy name kept for photos). */
  imageUrl: string | null;
  mediaType: SocialMediaType;
  /** Public media URL (photo or video); null while the media is pending or after removal. */
  mediaUrl: string | null;
  contentRating: SocialContentRating;
  moderationStatus: SocialModerationStatus;
  /** Only sent to the author for rejected posts. */
  moderationReason?: string | null;
  likeCount: number;
  /** "ให้กำลังใจ" cheers received (ad-backed). */
  cheerCount?: number;
  commentCount: number;
  createdAt: number;
  likedByMe?: boolean;
  /** Client-only: object URL of the just-uploaded file, shown to the author while pending. */
  localPreviewUrl?: string;
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
  /** Lifetime earnings as the owner chose to show them (never the raw amount when masked/hidden). */
  totalEarnings: EarningsDisplay;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  /** Cheers received on posts + profile. */
  cheerCount?: number;
  memberSince: number;
  isFollowing?: boolean;
  isMe?: boolean;
}

export interface SocialNotification {
  id: string;
  type: 'like' | 'comment' | 'follow' | 'moderation';
  actor: SocialAuthor;
  postId: string | null;
  isRead: boolean;
  createdAt: number;
  /** moderation notices: why the media was removed. */
  reason?: string | null;
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
  createdAt: number;
  /** 18+ content preference (default false). */
  showNsfw: boolean;
  /** Saved UI language ('en' is also the default for accounts that never picked one). */
  preferredLang: UiLang;
  /** How total earnings are shown on the profile and sidebar. */
  earningsVisibility: EarningsVisibility;
}

export interface BootstrapWalletSummary {
  balanceMicroUsd: number;
  formattedBalance: string;
  bountyMicroUsd: number;
  totalEarnedMicroUsd: number;
  /** Total earnings with the owner's privacy mode applied (what the sidebar shows). */
  totalEarnings: EarningsDisplay;
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
  /** From the admin room registry (absent on the built-in fallback list). */
  maxSpectators?: number;
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
    name: 'Skirmish 30 — Small Map',
    mode: 'mini_30',
    modeLabel: '30P Skirmish',
    map: 'Metro Block (240m)',
    mapSize: 'small',
    capacity: 30,
    costEc: 1,
    multiplayer: true,
    rules: ['30-player free-for-all on the 240 m map', 'Respawn 3 s after each death', 'Kill bounty paid on every elimination'],
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

/** Build the /game launch URL for a room (spectate=1 keeps the room's mode so the right map loads). */
export function fpsLaunchUrl(room: Pick<FpsRoomDef, 'id' | 'mode'> & { mapSize?: 'large' | 'small' }, spectate = false): string {
  const p = new URLSearchParams({ mode: room.mode, room: room.id });
  if (room.mapSize) p.set('map', room.mapSize);
  if (spectate) p.set('spectate', '1');
  return `/game?${p.toString()}`;
}
