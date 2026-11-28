/**
 * V1.2 Round C game-server helpers (pure, no Colyseus): Worker-signed gift / viewer tokens and the cold-start bot
 * brain. Money is never decided here — a gift is only broadcast after its HMAC token (signed by the Worker AFTER
 * the atomic D1 payment) verifies, and bot bounties are Worker reservations drawn from the Boss Bounty Pool.
 */
import crypto from 'crypto';
import { GIFT_CODES, SKIN_BY_SLUG, type GiftCode } from '@mwar/shared';
import { obstacleIndexForMap } from './ballistics';
import { largeMapTerrainHeight } from '@mwar/shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function verifySigned(token: unknown, secret: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || !token.includes('.') || token.length > 2048) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (typeof json.exp !== 'number' || json.exp < Date.now() / 1000) return null;
    return json;
  } catch {
    return null;
  }
}

export interface GiftClaims {
  gid: string;
  giftCode: GiftCode;
  senderId: string;
  senderName: string;
  receiverId: string | null;
  roomId: string;
  receiverMicroUsd: number;
}

/** A gift token from POST /api/gifts/send | /ammo-box (k: 'gift'); never an entry / rejoin token. */
export function verifyGiftToken(token: unknown, secret: string): GiftClaims | null {
  const j = verifySigned(token, secret);
  if (!j || j.k !== 'gift' || typeof j.gid !== 'string' || !/^gft_[0-9a-f-]{36}$/.test(j.gid)) return null;
  if (!(GIFT_CODES as readonly string[]).includes(String(j.gc)) || typeof j.rid !== 'string' || typeof j.suid !== 'string' || !UUID_RE.test(j.suid)) return null;
  return {
    gid: j.gid,
    giftCode: j.gc as GiftCode,
    senderId: j.suid,
    senderName: String(j.sun ?? '').slice(0, 24),
    receiverId: typeof j.tuid === 'string' && UUID_RE.test(j.tuid) ? j.tuid : null,
    roomId: j.rid,
    receiverMicroUsd: Math.max(0, Math.floor(Number(j.rv) || 0)),
  };
}

/** A viewer token from GET /api/game/viewer-token (k: 'viewer'): a signed-in spectator's identity (chat / gifts). */
export function verifyViewerToken(token: unknown, secret: string): { uid: string; un: string } | null {
  const j = verifySigned(token, secret);
  if (!j || j.k !== 'viewer' || typeof j.uid !== 'string' || !UUID_RE.test(j.uid)) return null;
  return { uid: j.uid, un: String(j.un ?? '').slice(0, 24) };
}

/** Only catalog skins are ever shown (an unknown slug renders the default model). */
export const cleanSkin = (slug: unknown): string => (typeof slug === 'string' && SKIN_BY_SLUG[slug] ? slug : '');

/** Room chat: printable text only, collapsed whitespace, ≤ 140 chars. */
export function cleanChat(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// ---- Cold-start bots ---------------------------------------------------------------------------------------------

export const BOT_NAMES = ['Ranger', 'Viper', 'Falcon', 'Nomad', 'Ghost', 'Raptor', 'Bishop', 'Echo', 'Blaze', 'Kodiak', 'Hawk', 'Atlas', 'Jinx', 'Onyx'];
export const BOT_AVATARS = ['specops', 'mercenary', 'desert_sniper', 'heavy_striker', 'bodysuit_agent', 'urban_scout', 'crimson_operative', 'cyber_valkyrie'];
export const BOT_WEAPON = 'ak47';
/** Chance a validated bot shot actually lands (bots are beatable by design). */
export const BOT_HIT_CHANCE = 0.32;
/** Bot damage per landed shot, as a share of the weapon's damage. */
export const BOT_DAMAGE_SHARE = 0.55;
export const BOT_SPEED_MPS = 3.6;
export const BOT_RESPAWN_MS = 6000;
export const BOT_ENGAGE_M = 40;

export interface BotBrain {
  sid: string;
  waypoint: { x: number; z: number };
  nextShotAt: number;
  respawnAt: number;
  reservationId: string;
  bountyMicroUsd: number;
  reserving: boolean;
}

export const newBotId = () => `bot_${crypto.randomBytes(5).toString('hex')}`;

export function groundY(x: number, z: number, large: boolean): number {
  return large ? largeMapTerrainHeight(x, z) : 0;
}

/** Can a bot walk straight from a to b (no wall / building box at knee and chest height)? */
export function walkable(ax: number, az: number, bx: number, bz: number, large: boolean): boolean {
  const idx = obstacleIndexForMap(large);
  const ay = groundY(ax, az, large);
  const by = groundY(bx, bz, large);
  return !idx.blocksSegment(ax, ay + 0.6, az, bx, by + 0.6, bz, 0.05) && !idx.blocksSegment(ax, ay + 1.4, az, bx, by + 1.4, bz, 0.05);
}

/** Yaw facing from (x, z) towards (tx, tz) in the client camera convention (forward = (−sin yaw, −cos yaw)). */
export const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(-(tx - x), -(tz - z));
