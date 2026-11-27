/**
 * MWAR Frontend API Client - Connects directly to local Cloudflare Worker (wrangler dev)
 */

import type { TodayQuestsResponse, DailyMlmSummary, CheerAdFormat, CheerTargetType, CheerStatus, CheerResult, ActiveGameSession, ActiveGameSessionResponse } from '@mwar/shared';
import { activityPayload } from './activity';
import type {
  BootstrapResponse,
  CursorPage,
  SocialPost,
  SocialComment,
  SocialProfile,
  SocialAuthor,
  SocialNotification,
  SocialPostTag,
  ReportReason,
  ContentReportItem,
  ProfileCoverColor,
  GamesResponse,
  FpsRoomsResponse,
  FpsRoomRosterResponse,
  AuthProvidersResponse,
  OAuthLoginResponse,
  OAuthInitInput,
  LineInitResponse,
  TelegramBotInitResponse,
  TelegramBotPollResponse,
  LinkedAccountsResponse,
  PostVisibility,
  StagedUpload,
  StaffMember,
  StaffAuditEntry,
  StaffRole,
} from '@mwar/shared';

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' && (window.location.hostname === 'mwar.win' ||
    window.location.hostname.endsWith('.mwar.win') ||
    // Cloudflare Pages: production + preview deployments of the mwar-web project
    window.location.hostname === 'mwar-web.pages.dev' ||
    window.location.hostname.endsWith('.mwar-web.pages.dev'))
    ? 'https://api.mwar.win'
    : 'http://127.0.0.1:8787');

let inMemoryToken: string | null = null;

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return inMemoryToken || localStorage.getItem('mwar_auth_token') || sessionStorage.getItem('mwar_auth_token');
  } catch {
    return inMemoryToken;
  }
}

/** remember=false keeps the session only until the browser tab is closed ("Remember me" unchecked). */
export function setAuthToken(token: string, remember = true) {
  inMemoryToken = token;
  if (typeof window !== 'undefined') {
    try {
      if (remember) {
        localStorage.setItem('mwar_auth_token', token);
        sessionStorage.removeItem('mwar_auth_token');
      } else {
        sessionStorage.setItem('mwar_auth_token', token);
        localStorage.removeItem('mwar_auth_token');
      }
    } catch {
      /* storage blocked: memory only */
    }
  }
}

export function clearAuthToken() {
  inMemoryToken = null;
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem('mwar_auth_token');
      sessionStorage.removeItem('mwar_auth_token');
    } catch {
      /* ignore */
    }
  }
}

const BANNER_PING_PATHS = new Set(['/api/ads/impression', '/api/ads/simulate-view']);

export async function apiFetch<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // Anti-AFK: every banner impression ping carries the last real input time (the API refuses > 40 s idle)
  let body = options.body;
  if (typeof body === 'string' && BANNER_PING_PATHS.has(endpoint.split('?')[0])) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && (endpoint.startsWith('/api/ads/impression') || parsed.format === 'banner')) {
        body = JSON.stringify({ ...parsed, ...activityPayload() });
      }
    } catch {
      /* not JSON */
    }
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    body,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data.error || data.message || `Request failed with status ${response.status}`) as Error & { status?: number; code?: string };
    err.status = response.status;
    if (typeof data.code === 'string') err.code = data.code;
    throw err;
  }

  return data as T;
}

// User & Profile
export async function getCurrentUser() {
  return apiFetch<{ user: any; wallet: any }>('/api/auth/me');
}

export async function updateProfile(data: { username?: string; avatarUrl?: string }) {
  return apiFetch<{ success: boolean; user: any; remainingRenames: number }>('/api/auth/profile', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Daily Quests & MLM Engine
export async function getTodayQuests(dateKey?: string): Promise<TodayQuestsResponse> {
  const query = dateKey ? `?dateKey=${dateKey}` : '';
  return apiFetch<TodayQuestsResponse>(`/api/quests/today${query}`);
}

export async function progressQuest(questId: string, increment = 1, dateKey?: string) {
  return apiFetch<{
    success: boolean;
    questId: string;
    current: number;
    isCompleted: boolean;
    isMlmUnlocked: boolean;
    justUnlockedMlm: boolean;
  }>('/api/quests/progress', {
    method: 'POST',
    body: JSON.stringify({ questId, increment, dateKey }),
  });
}

export async function claimQuest(questId: string, dateKey?: string) {
  return apiFetch<{
    success: boolean;
    questId: string;
    rewardCoins: number;
    /** ฿ game coins after the claim (missions never pay cash). */
    coinsBalance?: number;
    rewardMicroUsd: number;
    formattedReward: string;
  }>('/api/quests/claim', {
    method: 'POST',
    body: JSON.stringify({ questId, dateKey }),
  });
}

export async function getDailyMlmSummary(dateKey?: string): Promise<DailyMlmSummary> {
  const query = dateKey ? `?dateKey=${dateKey}` : '';
  return apiFetch<DailyMlmSummary>(`/api/wallet/daily-mlm-summary${query}`);
}

export async function settleDailyMlm(dateKey?: string, targetUserId?: string) {
  return apiFetch<{
    success: boolean;
    dateKey: string;
    settledUsersCount: number;
    forfeitedUsersCount: number;
    totalSettledMicroUsd: number;
    formattedSettled: string;
    totalForfeitedMicroUsd: number;
    formattedForfeited: string;
  }>('/api/cron/settle-daily-mlm', {
    method: 'POST',
    body: JSON.stringify({ dateKey, targetUserId }),
  });
}

// Server Nodes & 1-Click Provisioning API
export interface GameNode {
  id: string;
  node_name: string;
  /** 'logs' = log-only node (the installer's spelling); 'log' accepted too. */
  role: 'all' | 'game' | 'moderator' | 'log' | 'logs';
  status: 'online' | 'offline';
  ip_address?: string;
  region?: string;
  cpu_usage: number;
  ram_usage: number;
  active_rooms: number;
  player_count: number;
  room_capacity_mini: number;
  room_capacity_fast: number;
  provision_token?: string;
  tunnel_hostname?: string;
  last_heartbeat?: number;
  created_at: number;
  /** Optional telemetry from moderator / log nodes. */
  mod_pending?: number | null;
  mod_processed?: number | null;
  pg_status?: 'ok' | 'down' | null;
}

export async function getServerNodes() {
  return apiFetch<{ nodes: GameNode[]; provisionKey?: string }>('/api/nodes');
}

export async function getProvisionCommand(data: { role: string; nodeName: string; tunnelToken?: string }) {
  return apiFetch<{ command: string; provisionKey: string }>('/api/nodes/provision-command', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateNodeCapacity(nodeId: string, data: { room_capacity_mini?: number; room_capacity_fast?: number }) {
  return apiFetch<{ success: boolean; node: GameNode }>(`/api/nodes/${nodeId}/capacity`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ---------------------------------------------------------------------------
// App bootstrap: ONE request for the whole shell, kept 60 s in memory + sessionStorage
// ---------------------------------------------------------------------------

export const BOOTSTRAP_FRESH_MS = 60_000;
const BOOT_STORAGE_KEY = 'mwar_bootstrap_v3'; // v3: downline rank object + staffRoles
type BootEntry = { at: number; data: BootstrapResponse };
let bootMem: BootEntry | null = null;
let bootInflight: Promise<BootstrapResponse> | null = null;

export function readBootstrapCache(): BootEntry | null {
  if (bootMem) return bootMem;
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(BOOT_STORAGE_KEY);
    if (raw) bootMem = JSON.parse(raw) as BootEntry;
  } catch {
    /* storage blocked */
  }
  return bootMem;
}

function writeBootstrapCache(entry: BootEntry | null) {
  bootMem = entry;
  if (typeof window === 'undefined') return;
  try {
    if (entry) sessionStorage.setItem(BOOT_STORAGE_KEY, JSON.stringify(entry));
    else sessionStorage.removeItem(BOOT_STORAGE_KEY);
  } catch {
    /* storage blocked */
  }
}

export function isBootstrapFresh(): boolean {
  const e = readBootstrapCache();
  return !!e && Date.now() - e.at < BOOTSTRAP_FRESH_MS;
}

/** Returns the cached bootstrap while fresh (0 requests), otherwise fetches once (deduped). */
export async function getBootstrap(force = false): Promise<BootstrapResponse> {
  const cached = readBootstrapCache();
  if (!force && cached && Date.now() - cached.at < BOOTSTRAP_FRESH_MS) return cached.data;
  if (bootInflight) return bootInflight;
  bootInflight = apiFetch<BootstrapResponse>('/api/bootstrap')
    .then((data) => {
      writeBootstrapCache({ at: Date.now(), data });
      return data;
    })
    .finally(() => {
      bootInflight = null;
    });
  return bootInflight;
}

/** Local optimistic update (e.g. a quest claimed) without another request; keeps the original timestamp. */
export function patchBootstrapCache(fn: (b: BootstrapResponse) => BootstrapResponse): BootstrapResponse | null {
  const cached = readBootstrapCache();
  if (!cached) return null;
  const next = { at: cached.at, data: fn(cached.data) };
  writeBootstrapCache(next);
  return next.data;
}

export function clearBootstrapCache() {
  writeBootstrapCache(null);
}

export function logout() {
  clearAuthToken();
  clearBootstrapCache();
}

// ---------------------------------------------------------------------------
// Auth: Telegram / LINE sign-in, connected accounts, username (once), backup password
// ---------------------------------------------------------------------------
let providersCache: Promise<AuthProvidersResponse> | null = null;
export function getAuthProviders(): Promise<AuthProvidersResponse> {
  if (!providersCache) {
    providersCache = apiFetch<AuthProvidersResponse>('/api/auth/providers').catch((e) => {
      providersCache = null;
      throw e;
    });
  }
  return providersCache;
}

export function checkReferralCode(code: string) {
  return apiFetch<{ valid: boolean; username: string | null }>(`/api/auth/referral?code=${encodeURIComponent(code)}`);
}

export function oauthTelegram(payload: Record<string, unknown> & { device_fp?: string | null }) {
  return apiFetch<OAuthLoginResponse>('/api/auth/oauth/telegram', { method: 'POST', body: JSON.stringify(payload) });
}

export function oauthLine(payload: { code: string; state: string; device_fp?: string | null }) {
  return apiFetch<OAuthLoginResponse>('/api/auth/oauth/line', { method: 'POST', body: JSON.stringify(payload) });
}

export function oauthLineInit(payload: OAuthInitInput) {
  return apiFetch<LineInitResponse>('/api/auth/oauth/line/init', { method: 'POST', body: JSON.stringify(payload) });
}

export function telegramBotInit(payload: OAuthInitInput) {
  return apiFetch<TelegramBotInitResponse>('/api/auth/oauth/telegram/bot-init', { method: 'POST', body: JSON.stringify(payload) });
}

export function telegramBotPoll(state: string) {
  return apiFetch<TelegramBotPollResponse>(`/api/auth/oauth/telegram/bot-poll?state=${encodeURIComponent(state)}`, { cache: 'no-store' });
}

export function telegramBotExchange(token: string) {
  return apiFetch<OAuthLoginResponse>('/api/auth/oauth/telegram/bot-exchange', { method: 'POST', body: JSON.stringify({ token }) });
}

export function getLinkedAccounts() {
  return apiFetch<LinkedAccountsResponse>('/api/auth/linked-accounts');
}

export function unlinkAccount(provider: 'telegram' | 'line') {
  return apiFetch<{ success: boolean }>(`/api/auth/linked-accounts/${provider}`, { method: 'DELETE' });
}

export function setUsernameOnce(username: string) {
  return apiFetch<{ success: boolean; username: string; token: string }>('/api/auth/username', { method: 'POST', body: JSON.stringify({ username }) });
}

export function setBackupPassword(password: string, username?: string) {
  return apiFetch<{ success: boolean; username: string; token?: string; passwordChangeAvailableAt: number }>('/api/auth/backup-password', {
    method: 'POST',
    body: JSON.stringify({ password, ...(username ? { username } : {}) }),
  });
}

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------
const qs = (o: Record<string, string | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Feed page; the first home page also carries `mine` = my posts still under review or removed. */
export function getFeed(opts: { cursor?: string | null; tag?: string | null; author?: string | null } = {}) {
  return apiFetch<CursorPage<SocialPost> & { mine?: SocialPost[] }>(`/api/social/feed${qs({ cursor: opts.cursor, tag: opts.tag, author: opts.author })}`);
}

/** Layer-2 rejection: the compression library is reloaded and the user is asked to refresh and post again. */
export class MediaGateError extends Error {
  code = 'MEDIA_GATE';
}

/**
 * Stage ONE compressed photo / video for a post (Layer-2 gate on the API). Any rejection purges the
 * whole attempt on the server and throws MediaGateError.
 */
export async function uploadPostMedia(file: Blob, attemptId: string, meta: { width?: number | null; height?: number | null; name?: string } = {}): Promise<StagedUpload> {
  const fd = new FormData();
  fd.set('attemptId', attemptId);
  if (meta.width) fd.set('width', String(meta.width));
  if (meta.height) fd.set('height', String(meta.height));
  fd.set('file', file, meta.name || (file.type === 'video/mp4' ? 'media.mp4' : 'media.webp'));
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}/api/social/uploads?attemptId=${encodeURIComponent(attemptId)}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 422 || data?.code === 'MEDIA_GATE') throw new MediaGateError(data?.error || 'MEDIA_GATE');
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
  return data as StagedUpload;
}

/** Drop every staged upload of a cancelled posting attempt. */
export function cancelUploads(attemptId: string) {
  return apiFetch<{ success: boolean }>(`/api/social/uploads/${encodeURIComponent(attemptId)}`, { method: 'DELETE' }).catch(() => null);
}

/** Create a post (JSON) from text + staged uploads in display order. */
export async function createPost(data: { body: string; tag: SocialPostTag; nsfw?: boolean; visibility?: PostVisibility; uploads?: string[]; attemptId?: string }) {
  try {
    return await apiFetch<{ success: boolean; post: SocialPost }>('/api/social/posts', {
      method: 'POST',
      body: JSON.stringify({ body: data.body, tag: data.tag, nsfw: !!data.nsfw, visibility: data.visibility || 'public', uploads: data.uploads || [], attemptId: data.attemptId }),
    });
  } catch (e: any) {
    if (/refresh the screen/i.test(e?.message || '')) throw new MediaGateError(e.message);
    throw e;
  }
}

export function updatePost(id: string, data: { body?: string; visibility?: PostVisibility }) {
  return apiFetch<{ success: boolean; post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
}

export function getPost(id: string) {
  return apiFetch<{ post: SocialPost }>(`/api/social/posts/${encodeURIComponent(id)}`);
}

export function getHashtagFeed(hashtag: string, cursor?: string | null) {
  return apiFetch<CursorPage<SocialPost>>(`/api/social/feed${qs({ hashtag, cursor })}`);
}

export function updateComment(id: string, body: string) {
  return apiFetch<{ success: boolean; body: string; editedAt: number }>(`/api/social/comments/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ body }) });
}

export function deleteComment(id: string) {
  return apiFetch<{ success: boolean; commentCount: number }>(`/api/social/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setBlock(userId: string, block: boolean) {
  return apiFetch<{ success: boolean; blocked: boolean }>('/api/social/block', { method: 'POST', body: JSON.stringify({ userId, block }) });
}

/** Upload a compressed WebP cover (<= 250 KB, max 1200x400); returns its URL (save it with updateSocialProfile). */
export async function uploadCover(blob: Blob): Promise<string> {
  const res = await apiFetch<{ success: boolean; url: string }>('/api/social/cover', { method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: blob });
  return res.url;
}

// Content policy: 18+ setting, reports, admin takedown queue
export function updateSocialSettings(data: { showNsfw?: boolean; confirmAdult?: boolean; preferredLang?: string; earningsVisibility?: 'public' | 'masked' | 'hidden' }) {
  return apiFetch<{ success: boolean; showNsfw?: boolean; preferredLang?: string }>('/api/social/settings', { method: 'PATCH', body: JSON.stringify(data) });
}

export function reportPost(data: { postId: string; reasonCategory: ReportReason; details?: string; contact?: string }) {
  return apiFetch<{ success: boolean; message: string; duplicate?: boolean }>('/api/social/reports', { method: 'POST', body: JSON.stringify(data) });
}

export function getTakedownReports(cursor?: string | null) {
  return apiFetch<CursorPage<ContentReportItem>>(`/api/social/admin/reports${qs({ cursor })}`);
}

export function actOnReport(id: string, action: 'delete' | 'reclassify_18' | 'dismiss') {
  return apiFetch<{ success: boolean; action: string }>(`/api/social/admin/reports/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export function deletePost(id: string) {
  return apiFetch<{ success: boolean }>(`/api/social/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function setPostLike(id: string, like: boolean) {
  return apiFetch<{ success: boolean; liked: boolean; likeCount: number }>(`/api/social/posts/${encodeURIComponent(id)}/like`, {
    method: 'POST',
    body: JSON.stringify({ like }),
  });
}

export function getComments(postId: string, cursor?: string | null) {
  return apiFetch<CursorPage<SocialComment>>(`/api/social/posts/${encodeURIComponent(postId)}/comments${qs({ cursor })}`);
}

export function addComment(postId: string, body: string) {
  return apiFetch<{ success: boolean; comment: SocialComment; commentCount: number }>(`/api/social/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export function getProfile(username?: string | null) {
  return apiFetch<{ profile: SocialProfile; posts: CursorPage<SocialPost> & { mine?: SocialPost[] } }>(`/api/social/profile${qs({ u: username })}`);
}

export function updateSocialProfile(data: { displayName?: string; bio?: string; avatarUrl?: string; coverColor?: ProfileCoverColor; coverUrl?: string | null }) {
  return apiFetch<{ success: boolean }>('/api/social/profile', { method: 'POST', body: JSON.stringify(data) });
}

export function setFollow(userId: string, follow: boolean) {
  return apiFetch<{ success: boolean; following: boolean; followersCount: number }>('/api/social/follow', {
    method: 'POST',
    body: JSON.stringify({ userId, follow }),
  });
}

export function getFollows(username: string, type: 'followers' | 'following', cursor?: string | null) {
  return apiFetch<CursorPage<SocialAuthor>>(`/api/social/follows${qs({ u: username, type, cursor })}`);
}

export type SearchResult = { users: SocialAuthor[]; posts: SocialPost[]; hashtags: { tag: string; count: number }[] };
export function searchAll(q: string) {
  return apiFetch<SearchResult>(`/api/social/search${qs({ q })}`);
}
export const searchUsers = searchAll;

export function getSuggestions() {
  return apiFetch<{ online: { username: string; userId: string | null; roomId: string }[]; newest: SocialAuthor[] }>('/api/social/suggestions');
}

export function getNotifications(cursor?: string | null) {
  return apiFetch<CursorPage<SocialNotification>>(`/api/social/notifications${qs({ cursor })}`);
}

/** Mark one notification (id) or all of them read; returns the unread count left. */
export function markNotificationsRead(id?: string) {
  return apiFetch<{ success: boolean; unread: number }>('/api/social/notifications/read', { method: 'POST', body: JSON.stringify(id ? { id } : {}) });
}

/** Upload an already-compressed WebP avatar (<= 120 KB) to R2; returns its immutable URL. */
export async function uploadMedia(blob: Blob): Promise<string> {
  const res = await apiFetch<{ success: boolean; url: string }>('/api/social/media', {
    method: 'POST',
    headers: { 'Content-Type': 'image/webp' },
    body: blob,
  });
  return res.url;
}

// ---------------------------------------------------------------------------
// Game hub
// ---------------------------------------------------------------------------
export function getGames() {
  return apiFetch<GamesResponse>('/api/games');
}

export function getFpsRooms() {
  return apiFetch<FpsRoomsResponse>('/api/games/fps/rooms');
}

/**
 * V1.1 R3: the alive character this account still has in a live room (a disconnected body or another tab).
 * `rejoin` also asks for the 120 s signed token the game server needs to re-attach to that body.
 */
export function getActiveSession(rejoin = false) {
  return apiFetch<ActiveGameSessionResponse>(`/api/game/active-session${rejoin ? '?rejoin=1' : ''}`);
}

/** /game link that resumes control of that body (the extra params let the page build the right map first). */
export function rejoinHref(s: ActiveGameSession) {
  const q = new URLSearchParams({ rejoin: s.roomId, mode: s.mode, map: s.mapName === 'large' ? 'large' : 'small' });
  if (s.roomCode) q.set('room', s.roomCode);
  return `/game?${q.toString()}`;
}

export function getFpsRoster(roomId: string, cursor?: string | null) {
  return apiFetch<FpsRoomRosterResponse>(`/api/games/fps/rooms${qs({ room: roomId, cursor })}`);
}

// ---- "ให้กำลังใจ" Cheer (ad-backed support + EC recharge) ----------------------------------------
export function getCheerStatus(targetType: CheerTargetType, targetId?: string | null) {
  const q = new URLSearchParams({ targetType });
  if (targetId) q.set('targetId', targetId);
  return apiFetch<CheerStatus>(`/api/ads/cheer/status?${q}`);
}

export function startCheer(data: { format: CheerAdFormat; targetType: CheerTargetType; targetId?: string | null }) {
  return apiFetch<{ success: true; viewId: string; format: CheerAdFormat; durationSeconds: number; startedAt: number; ecBp: number }>('/api/ads/cheer/start', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function completeCheer(viewId: string) {
  return apiFetch<CheerResult>('/api/ads/cheer', { method: 'POST', body: JSON.stringify({ viewId }) });
}

// ---------------------------------------------------------------------------
// Staff & roles (super_admin)
// ---------------------------------------------------------------------------
export function getStaff() {
  return apiFetch<{ items: StaffMember[] }>('/api/admin/staff');
}
export function searchStaffCandidates(q: string) {
  return apiFetch<{ items: StaffMember[] }>(`/api/admin/staff/search-users${qs({ q })}`);
}
/** roles = [] demotes the account back to a regular member. */
export function setStaffRoles(userId: string, roles: StaffRole[]) {
  return apiFetch<{ success: boolean; member: StaffMember }>(`/api/admin/staff/${encodeURIComponent(userId)}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) });
}
export function getStaffAudit() {
  return apiFetch<{ items: StaffAuditEntry[] }>('/api/admin/staff/audit');
}

// ---------------------------------------------------------------------------
// Chat media (deleted after 7 days)
// ---------------------------------------------------------------------------
export async function uploadChatMedia(blob: Blob): Promise<{ mediaKey: string; mediaType: 'image' | 'video'; url: string }> {
  const token = getAuthToken();
  const res = await fetch(`${API_BASE_URL}/api/chat/media`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 422) throw new MediaGateError(data?.error || 'MEDIA_GATE');
  if (!res.ok) throw new Error(data?.error || `Upload failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------------------
// Sticky referral
// ---------------------------------------------------------------------------
export function referralTouch(deviceFp: string, refCode: string) {
  return apiFetch<{ ok: boolean; valid?: boolean; self?: boolean; username?: string }>('/api/referral/touch', { method: 'POST', body: JSON.stringify({ device_fp: deviceFp, ref_code: refCode }) }).catch(() => null);
}
export function referralResolve(deviceFp: string) {
  return apiFetch<{ refCode: string | null }>(`/api/referral/resolve${qs({ device_fp: deviceFp })}`).catch(() => ({ refCode: null }));
}
