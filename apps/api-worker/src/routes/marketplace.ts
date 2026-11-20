import { Hono } from 'hono';
import {
  MarketplaceCreateListingSchema,
  MarketplaceBuySchema,
  formatMicroUsd,
  MARKETPLACE_ESCROW_DAYS,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { logFinancialTransaction } from '../utils/audit-logger';
import { buildNetworkTree } from '../utils/mlm-tree';

export const marketplaceRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

marketplaceRouter.use('*', authMiddleware);

// 1. List Active Listings
marketplaceRouter.get('/listings', async (c) => {
  const rows = await c.env.DB
    .prepare(
      `SELECT m.id, m.seller_id, m.target_user_id, m.price_micro_usd, m.status, m.created_at,
              u_target.username as target_username, u_target.created_at as target_joined_at,
              w_target.total_earned_micro_usd as target_total_earned,
              u_seller.username as seller_username
       FROM marketplace_listings m
       JOIN users u_target ON u_target.id = m.target_user_id
       LEFT JOIN wallets w_target ON w_target.user_id = m.target_user_id
       JOIN users u_seller ON u_seller.id = m.seller_id
       WHERE m.status = 'active'
       ORDER BY m.created_at DESC`
    )
    .all<any>();

  const listings = (rows.results || []).map((l: any) => ({
    id: l.id,
    sellerId: l.seller_id,
    sellerUsername: l.seller_username,
    targetUserId: l.target_user_id,
    targetUsername: l.target_username,
    targetJoinedAt: l.target_joined_at,
    targetTotalEarnedMicroUsd: l.target_total_earned || 0,
    formattedTargetEarned: formatMicroUsd(l.target_total_earned || 0),
    priceMicroUsd: l.price_micro_usd,
    formattedPrice: formatMicroUsd(l.price_micro_usd),
    escrowWarrantyDays: MARKETPLACE_ESCROW_DAYS,
    createdAt: l.created_at,
  }));

  return c.json({ listings });
});

// 2. Create Listing
marketplaceRouter.post('/listings', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = MarketplaceCreateListingSchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { target_user_id, price_micro_usd } = parseResult.data;

  // Verify target is seller's direct downline (depth = 1)
  const isDirectDownline = await c.env.DB
    .prepare('SELECT ancestor_id FROM network_trees WHERE ancestor_id = ?1 AND descendant_id = ?2 AND depth = 1')
    .bind(user.userId, target_user_id)
    .first();

  if (!isDirectDownline) {
    return c.json({ error: 'You can only list your direct Level 1 downline members' }, 403);
  }

  // Check not already listed
  const existing = await c.env.DB
    .prepare("SELECT id FROM marketplace_listings WHERE target_user_id = ?1 AND status = 'active'")
    .bind(target_user_id)
    .first();

  if (existing) {
    return c.json({ error: 'This downline member is already active on the marketplace' }, 409);
  }

  const listingId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await c.env.DB
    .prepare('INSERT INTO marketplace_listings (id, seller_id, target_user_id, price_micro_usd, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(listingId, user.userId, target_user_id, price_micro_usd, 'active', now)
    .run();

  return c.json({
    success: true,
    listingId,
    priceMicroUsd: price_micro_usd,
    formattedPrice: formatMicroUsd(price_micro_usd),
  }, 201);
});

// 3. Purchase Listing (with 30-day Escrow Warranty)
marketplaceRouter.post('/buy', async (c) => {
  const buyer = c.get('user');
  const body = await c.req.json().catch(() => null);

  const parseResult = MarketplaceBuySchema.safeParse(body);
  if (!parseResult.success) {
    return c.json({ error: 'Validation failed', details: parseResult.error.format() }, 400);
  }

  const { listing_id } = parseResult.data;

  const listing = await c.env.DB
    .prepare("SELECT * FROM marketplace_listings WHERE id = ?1 AND status = 'active'")
    .bind(listing_id)
    .first<any>();

  if (!listing) {
    return c.json({ error: 'Listing not found or no longer active' }, 404);
  }

  if (listing.seller_id === buyer.userId) {
    return c.json({ error: 'You cannot buy your own listing' }, 400);
  }

  // Check buyer balance
  const buyerWallet = await c.env.DB
    .prepare('SELECT balance_micro_usd FROM wallets WHERE user_id = ?1')
    .bind(buyer.userId)
    .first<{ balance_micro_usd: number }>();

  if (!buyerWallet || buyerWallet.balance_micro_usd < listing.price_micro_usd) {
    return c.json({
      error: 'Insufficient funds to purchase listing',
      required: listing.price_micro_usd,
      balance: buyerWallet?.balance_micro_usd || 0,
    }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const escrowReleaseAt = now + MARKETPLACE_ESCROW_DAYS * 86400; // 30 days warranty escrow

  // Execute atomic transfer:
  // 1. Deduct price from buyer
  // 2. Mark listing as sold with buyer_id and escrow_release_at
  // 3. Update target user's referrer_id to buyer.userId
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3 AND balance_micro_usd >= ?1'
    ).bind(listing.price_micro_usd, now, buyer.userId),
    c.env.DB.prepare(
      "UPDATE marketplace_listings SET status = 'sold', buyer_id = ?1, sold_at = ?2, escrow_release_at = ?3 WHERE id = ?4"
    ).bind(buyer.userId, now, escrowReleaseAt, listing.id),
    c.env.DB.prepare(
      'UPDATE users SET referrer_id = ?1 WHERE id = ?2'
    ).bind(buyer.userId, listing.target_user_id),
    // Remove old upline connections of the target user
    c.env.DB.prepare(
      'DELETE FROM network_trees WHERE descendant_id = ?1'
    ).bind(listing.target_user_id),
  ]);

  // Rebuild network tree under the buyer
  await buildNetworkTree(c.env.DB, listing.target_user_id, buyer.userId);

  // Financial audit log
  await logFinancialTransaction(c.env, {
    transaction_id: `tx_mkt_${listing.id.slice(0, 8)}_${now}`,
    user_id: buyer.userId,
    action_type: 'MARKET_BUY',
    amount_micro_usd: BigInt(listing.price_micro_usd),
    balance_after_micro_usd: BigInt(buyerWallet.balance_micro_usd - listing.price_micro_usd),
    related_user_id: listing.target_user_id,
  });

  return c.json({
    success: true,
    message: 'Referral purchased successfully with 30-day warranty escrow',
    listingId: listing.id,
    buyerId: buyer.userId,
    targetUserId: listing.target_user_id,
    priceMicroUsd: listing.price_micro_usd,
    escrowReleaseAt,
  });
});
