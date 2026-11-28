import { z } from 'zod';

// Authentication Schemas
export const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, 'Username must be at least 3 characters')
    .max(20, 'Username must not exceed 20 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain alphanumeric characters and underscores'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Upline code: the sponsor's user id (UUID) or username
  referrer_id: z.string().trim().min(3).max(64).optional().nullable(),
});

export const LoginSchema = z.object({
  usernameOrEmail: z.string().min(3),
  password: z.string().min(1),
});

// WhatsApp OTP Schemas
export const WhatsAppOtpRequestSchema = z.object({
  phoneNumber: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid international E.164 phone number format'),
});

export const WhatsAppOtpVerifySchema = z.object({
  phoneNumber: z
    .string()
    .regex(/^\+?[1-9]\d{1,14}$/, 'Invalid international E.164 phone number format'),
  code: z.string().length(6, 'OTP must be 6 digits'),
  referrer_id: z.string().uuid().optional().nullable(),
});

// Telegram Login Widget Schema
export const TelegramLoginSchema = z.object({
  id: z.string().or(z.number()),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().url().optional(),
  auth_date: z.number(),
  hash: z.string(),
  phone_number: z.string().optional(),
  referrer_id: z.string().uuid().optional().nullable(),
});

// Financial & Withdrawal Schemas
export const WithdrawalCreateSchema = z.object({
  amount_micro_usd: z
    .number()
    .int('Amount must be an integer Micro-USD')
    .min(10_000_000, 'Minimum cashout amount is $10.00 USD (10,000,000 Micro-USD)'),
  crypto_currency: z.enum(['USDT', 'LTC', 'BTC', 'TRX']).default('USDT'),
  payout_address: z.string().min(10, 'Invalid payout destination address'),
});

export const WithdrawalReviewSchema = z.object({
  withdrawal_id: z.string().uuid(),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(255).optional(),
});

// Marketplace Schemas
export const MarketplaceCreateListingSchema = z.object({
  target_user_id: z.string().uuid('Invalid target referral user ID'),
  price_micro_usd: z
    .number()
    .int()
    .positive('Listing price must be greater than zero Micro-USD'),
});

export const MarketplaceBuySchema = z.object({
  listing_id: z.string().uuid('Invalid listing ID'),
});

// Ad Network Postback Schemas (AdswedMedia & OnClickA)
export const AdPostbackSchema = z.object({
  provider: z.enum(['adswedmedia', 'onclicka']),
  click_id: z.string().min(1),
  user_id: z.string().uuid(),
  payout: z.number().or(z.string()).optional(),
  country: z.string().default('OTHER'),
  signature: z.string().optional(),
});

// Game Server Batch Sync Schema
export const BatchPayoutItemSchema = z.object({
  userId: z.string().uuid(),
  // V1.1: 0 is allowed only for TICKET_FORFEIT (the Worker always uses the ticket row's value)
  amountMicroUsd: z.number().int().nonnegative(),
  // AFK_FORFEIT is a debit: the round earnings of a player kicked after 30 min AFK
  // BOUNTY_CLAIM: metadata.victimId's accumulated head bounty goes to userId (killer / chest opener)
  // GAME_KILL / CHEST_OPEN: metadata.ticketId + metadata.victimId — V = the victim's ticket value (capped
  //   at user_energy_tickets.backed_micro_usd, settled exactly once)
  // TICKET_FORFEIT: userId's in_match ticket (metadata.ticketId) ended without a payout (left / AFK /
  //   collusion kill / unopened chest) → its backing goes to the platform
  // V1.1 R2 TICKET_RETURN: a "Play again" ticket the room could not use (player already alive / gone) →
  //   back to available (metadata.ticketId, metadata.entryId)
  // V1.1 R2 FAST_MINI_KILL: userId killed metadata.victimId in Fast & Mini → the Worker pays 90/10 of the
  //   victim's OWN verified-banner pot (metadata.potId, credits up to metadata.diedAt) — amount is ignored
  // V1.1 R2 FAST_MINI_CLOSE: userId's Fast & Mini pot (metadata.potId) closed (left / AFK / room closed)
  // V1.2 BOSS_BOUNTY_CLAIM: userId eliminated the Golden Boss metadata.victimId → the Worker pays the
  //   reservation metadata.reservationId (amount from D1, never item.amountMicroUsd) through 55/15/5/5/20, once
  // V1.2 BOSS_BOUNTY_RELEASE: the Golden Boss reservation metadata.reservationId ended unclaimed → back to the pool, once
  actionType: z.enum(['GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'AFK_FORFEIT', 'BOUNTY_CLAIM', 'TICKET_FORFEIT', 'TICKET_RETURN', 'FAST_MINI_KILL', 'FAST_MINI_CLOSE', 'BOSS_BOUNTY_CLAIM', 'BOSS_BOUNTY_RELEASE']),
  gameId: z.string(),
  metadata: z.record(z.any()).optional(),
});

/**
 * V1.1 R3: live-session report that rides along with every batch-payout POST (processed AFTER the payout
 * items of the same request, so a death's settlement and the end of its session arrive together).
 *  · upsert: an alive Paid-EC / Fast & Mini seat (connected or a disconnected body) — snapshot at flush time
 *  · end: the life is over (died / left dead / AFK kick / room shutdown) — retried until delivered
 *  · roomId heart-beats every session of the room (stale rooms drop out of GET /api/game/active-session)
 */
export const GameSessionUpsertSchema = z.object({
  userId: z.string().uuid(),
  entryId: z.string().min(8).max(64),
  roomCode: z.string().max(16).nullable().optional(),
  mode: z.enum(['mini_30', 'standard_100', 'fast_mini']),
  mapName: z.string().max(16),
  hp: z.number().int().min(0).max(1000),
  isPropHidden: z.boolean(),
  propType: z.string().max(32).nullable().optional(),
  isDisconnected: z.boolean(),
  /** ms timestamp the life started (a late snapshot of an older life never revives an ended session). */
  lifeStartedAt: z.number().int().nonnegative(),
  ticketId: z.string().max(90).nullable().optional(),
  potId: z.string().max(64).nullable().optional(),
});
export const GameSessionEndSchema = z.object({
  userId: z.string().uuid(),
  entryId: z.string().min(8).max(64),
  reason: z.string().max(24),
  /** ms timestamp of the end (death time). */
  endedAt: z.number().int().nonnegative(),
});
export const GameSessionReportSchema = z.object({
  roomId: z.string().min(1).max(64),
  serverUrl: z.string().max(200).optional(),
  upsert: z.array(GameSessionUpsertSchema).max(400).default([]),
  end: z.array(GameSessionEndSchema).max(2000).default([]),
});
export type GameSessionUpsert = z.infer<typeof GameSessionUpsertSchema>;
export type GameSessionEnd = z.infer<typeof GameSessionEndSchema>;
export type GameSessionReport = z.infer<typeof GameSessionReportSchema>;

export const GameBatchPayoutSchema = z.object({
  gameId: z.string(),
  timestamp: z.number(),
  secret: z.string(),
  payouts: z.array(BatchPayoutItemSchema),
});

// Direct Messaging Schema
export const DirectMessageSendSchema = z.object({
  receiver_id: z.string().uuid(),
  message_text: z.string().max(1000).optional(),
  /** Chat photo / video uploaded with POST /api/chat/media (deleted from R2 after 7 days). */
  media_key: z.string().regex(/^chat-media\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.(webp|jpg|mp4)$/).optional(),
}).refine((data) => data.message_text || data.media_key, {
  message: 'Must provide either message text or media',
});

// Daily Quest Schemas
export const QuestProgressSchema = z.object({
  questId: z.string().min(1),
  // Self-reported progress is capped per call (spectate heartbeat = 15 s)
  increment: z.number().int().positive().max(15).default(1),
});

export const QuestClaimSchema = z.object({
  questId: z.string().min(1),
});

// User Profile Update Schema
export const UpdateProfileSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/)
    .optional(),
  avatarUrl: z.string().max(800000).optional(),
});

// Types inferred from Zod schemas
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type WhatsAppOtpRequestInput = z.infer<typeof WhatsAppOtpRequestSchema>;
export type WhatsAppOtpVerifyInput = z.infer<typeof WhatsAppOtpVerifySchema>;
export type TelegramLoginInput = z.infer<typeof TelegramLoginSchema>;
export type WithdrawalCreateInput = z.infer<typeof WithdrawalCreateSchema>;
export type MarketplaceCreateListingInput = z.infer<typeof MarketplaceCreateListingSchema>;
export type AdPostbackInput = z.infer<typeof AdPostbackSchema>;
export type GameBatchPayoutInput = z.infer<typeof GameBatchPayoutSchema>;
export type DirectMessageSendInput = z.infer<typeof DirectMessageSendSchema>;
export type QuestProgressInput = z.infer<typeof QuestProgressSchema>;
export type QuestClaimInput = z.infer<typeof QuestClaimSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;
