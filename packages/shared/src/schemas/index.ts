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
  referrer_id: z.string().uuid('Invalid referrer ID').optional().nullable(),
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
  amountMicroUsd: z.number().int().positive(),
  // AFK_FORFEIT is a debit: the round earnings of a player kicked after 30 min AFK
  // BOUNTY_CLAIM: metadata.victimId's accumulated head bounty goes to userId (killer / chest opener)
  actionType: z.enum(['GAME_KILL', 'CHEST_OPEN', 'AD_WATCH', 'AFK_FORFEIT', 'BOUNTY_CLAIM']),
  gameId: z.string(),
  metadata: z.record(z.any()).optional(),
});

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
  media_r2_url: z.string().url().optional(),
}).refine((data) => data.message_text || data.media_r2_url, {
  message: 'Must provide either message text or media URL',
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
