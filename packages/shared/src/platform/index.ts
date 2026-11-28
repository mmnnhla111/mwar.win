import { z } from 'zod';

// ---------------------------------------------------------------------------
// Staff roles (RBAC) — users.staff_role (migration 0013)
// ---------------------------------------------------------------------------
/** Highest first. `user` = regular player. */
export const STAFF_ROLES = ['super_admin', 'admin', 'ops_manager', 'moderator', 'support', 'finance_auditor', 'user'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * V1.1 multi-role staff (table user_staff_roles): one account can hold several of these at once; its powers are the
 * union. `super_admin` is never grantable / editable via the API (owner var SUPER_ADMIN_USERNAMES, or set in D1).
 * `admin` is the pre-V1.1 all-round role: kept for accounts that already have it (migration 0022 copies it into
 * user_staff_roles) but can no longer be newly granted; saving a staff row without it removes it.
 */
export const ASSIGNABLE_STAFF_ROLES = ['moderator', 'support', 'finance_auditor', 'ops_manager'] as const;
export type AssignableStaffRole = (typeof ASSIGNABLE_STAFF_ROLES)[number];
export const LEGACY_STAFF_ROLES = ['admin'] as const;

/** What each staff area allows (checked on the API; the /admin tabs only mirror it). */
export const STAFF_PERMISSIONS = {
  /** Assign / revoke staff roles. */
  staff: ['super_admin'],
  /** Withdrawal approval (money out). */
  financeWrite: ['super_admin'],
  /** Read-only payouts / ledger audit. */
  financeRead: ['super_admin', 'finance_auditor'],
  /** Member list + inspector (read). */
  membersRead: ['super_admin', 'admin', 'moderator', 'support', 'finance_auditor'],
  /** Unlimited EC adjust, orphan marketplace listings. */
  membersWrite: ['super_admin', 'admin'],
  /** EC adjust within SUPPORT_EC_DAILY_LIMIT. */
  ecLimited: ['support'],
  /** Suspend / lift suspension. */
  suspend: ['super_admin', 'admin', 'moderator'],
  /** Games, rooms, nodes. */
  games: ['super_admin', 'admin', 'ops_manager'],
  nodes: ['super_admin', 'admin', 'ops_manager'],
  /** Takedown reports + 18+ review. */
  takedown: ['super_admin', 'admin', 'moderator'],
  /** Ad networks (Adsterra / Monetag) config, live/test mode, eCPM multipliers. */
  ads: ['super_admin'],
  /** V1.2 C cold-start tools (bot fill, Happy Hour, promo codes, streamer share, skin fee) in Game & Rooms. */
  coldStart: ['super_admin', 'ops_manager'],
  /** V1.2 C marketing-pool deposits (company money in). */
  marketingDeposit: ['super_admin'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type StaffPermission = keyof typeof STAFF_PERMISSIONS;

/** EC one support agent may add or remove in total per UTC day. */
export const SUPPORT_EC_DAILY_LIMIT = 30;

export function staffCan(role: StaffRole | null | undefined, perm: StaffPermission): boolean {
  return !!role && (STAFF_PERMISSIONS[perm] as readonly string[]).includes(role);
}

/** Union check for a multi-role account. */
export function staffCanAny(roles: readonly (StaffRole | string)[] | null | undefined, perm: StaffPermission): boolean {
  const allowed = STAFF_PERMISSIONS[perm] as readonly string[];
  return !!roles && roles.some((r) => allowed.includes(r));
}

/** Keep only valid staff roles (no 'user'), highest first, de-duplicated. */
export function normalizeStaffRoles(v: unknown): StaffRole[] {
  const list = Array.isArray(v) ? v : [];
  return STAFF_ROLES.filter((r) => r !== 'user' && list.includes(r));
}

/** The single most senior role of a set ('user' when empty): the legacy `staffRole` field. */
export function primaryStaffRole(roles: readonly string[]): StaffRole {
  return STAFF_ROLES.find((r) => roles.includes(r)) || 'user';
}

export function normalizeStaffRole(v: unknown): StaffRole {
  return (STAFF_ROLES as readonly string[]).includes(String(v)) ? (v as StaffRole) : 'user';
}

export const StaffRoleUpdateSchema = z.object({
  userId: z.string().trim().min(8).max(64),
  staffRole: z.enum(STAFF_ROLES),
});

export const StaffRolesUpdateSchema = z.object({
  roles: z.array(z.string().trim().min(1).max(32)).max(10),
});

export interface StaffMember {
  id: string;
  username: string;
  displayName: string | null;
  staffRole: StaffRole;
  /** All roles held (union). */
  staffRoles: StaffRole[];
  createdAt: number;
}

export interface StaffAuditEntry {
  id: string;
  actorUsername: string | null;
  targetUsername: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Media: 2-layer limits (Layer 1 = the user's device, Layer 2 = the API gate)
// ---------------------------------------------------------------------------
/** Layer 1 target: every photo compressed on the device to <= 200 KB, longest edge <= 1080 px. */
export const MEDIA_IMAGE_TARGET_BYTES = 200 * 1024;
export const MEDIA_IMAGE_MAX_EDGE = 1080;
/** Layer 2 hard limit (tolerance): anything above 300 KB is rejected and the attempt is purged. */
export const MEDIA_IMAGE_HARD_BYTES = 307_200;
/** Videos: <= 3 minutes, < 720p after Layer 1 (target 960x540 / 854x480). */
export const MEDIA_VIDEO_MAX_SECONDS = 180;
export const MEDIA_VIDEO_TARGET_HEIGHT = 540;
export const MEDIA_VIDEO_TARGET_BITRATE = 1_100_000;
/** Layer 2: reject height > 720 or width > 1280 (either orientation). */
export const MEDIA_VIDEO_MAX_LONG_EDGE = 1280;
export const MEDIA_VIDEO_MAX_SHORT_EDGE = 720;
/** Layer 2 byte ceiling for one video (3 min at the target bitrate is ~25 MB). */
export const MEDIA_VIDEO_HARD_BYTES = 45 * 1024 * 1024;
/** Items per post. */
export const POST_MEDIA_MAX_ITEMS = 10;
/** Approved videos older than this are re-encoded to 480p by the moderation worker. */
export const VIDEO_ARCHIVE_480P_AFTER_DAYS = 30;
/** Profile cover: client WebP <= 250 KB, max 1200x400. */
export const COVER_MAX_BYTES = 250 * 1024;
export const COVER_MAX_WIDTH = 1200;
export const COVER_MAX_HEIGHT = 400;
/** Chat photos / videos are deleted from R2 after 7 days (text history stays). */
export const CHAT_MEDIA_TTL_SECONDS = 7 * 86_400;

/** The exact message for any Layer-2 rejection (the client then reloads the compression library). */
export const MEDIA_GATE_ERROR_CODE = 'MEDIA_GATE';
export const MEDIA_GATE_ERROR_EN = 'Post failed. Please refresh the screen and post again.';

export type PostMediaType = 'image' | 'video';
export type VideoTier = 'hd_sub720' | 'sd_480';

/** Staged upload (POST /api/social/uploads) — attached to a post by POST /api/social/posts. */
export interface StagedUpload {
  uploadId: string;
  mediaType: PostMediaType;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  bytes: number;
}

export interface PostMediaItem {
  id: string;
  type: PostMediaType;
  /** null while another viewer is not allowed to see it yet. */
  url: string | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

// ---------------------------------------------------------------------------
// Post audience
// ---------------------------------------------------------------------------
export const POST_VISIBILITY = ['public', 'followers', 'private'] as const;
export type PostVisibility = (typeof POST_VISIBILITY)[number];

/** #hashtags: letters (incl. Thai marks), digits and _ ; 1–40 chars. */
export const HASHTAG_RE = /#([\p{L}\p{M}\p{N}_]{1,40})/gu;
export function extractHashtags(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(HASHTAG_RE)) {
    out.add(m[1].toLowerCase());
    if (out.size >= 10) break;
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Notifications (table `notifications`, migration 0013)
// ---------------------------------------------------------------------------
export const NOTIFICATION_TYPES = ['like', 'comment', 'follow', 'referral_join', 'post_rejected', 'system'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ---------------------------------------------------------------------------
// Sticky referral attribution
// ---------------------------------------------------------------------------
export const DEVICE_FP_RE = /^[a-f0-9]{32,64}$/;
export const ReferralTouchSchema = z.object({
  device_fp: z.string().trim().regex(DEVICE_FP_RE),
  ref_code: z.string().trim().min(3).max(64),
});
