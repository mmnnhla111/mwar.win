import { Hono } from 'hono';
import {
  MarketplaceCreateListingSchema,
  MarketplaceBuySchema,
  formatMicroUsd,
  MARKETPLACE_ESCROW_DAYS,
} from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { edgeCachedJson, edgeCachePurge } from '../utils/edge-cache';
import { logFinancialTransaction, walletBalance } from '../utils/audit-logger';
import { buildNetworkTree } from '../utils/mlm-tree';
import { PLATFORM_ACCOUNT_ID } from '../utils/guards';
import { ledgerAfterUpdate } from '../utils/ledger';

export const marketplaceRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

marketplaceRouter.use('*', authMiddleware);
// Any successful write (list / buy / cancel) drops the cached public listing
marketplaceRouter.use('*', async (c, next) => {
  await next();
  if (c.req.method !== 'GET' && c.res.ok) await edgeCachePurge(c, 'marketplace-listings');
});

// 1. List Active Listings
marketplaceRouter.get('/listings', async (c) => {
  // Same list for every player: served from the edge cache for 20 s (purged on list / buy)
  return edgeCachedJson(c, 'marketplace-listings', 20, async () => {
    const rows = await c.env.DB
      .prepare(
        `SELECT m.id, m.seller_id, m.target_user_id, m.price_micro_usd, m.status, m.created_at, m.listing_type,
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
      // Orphan players listed by the admin are sold by the platform
      sellerUsername: l.listing_type === 'orphan' ? 'mwar.win' : l.seller_username,
      listingType: l.listing_type === 'orphan' ? 'orphan' : 'player',
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

    return { listings };
  });
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
  if (listing.target_user_id === buyer.userId) {
    return c.json({ error: 'You cannot buy yourself' }, 400);
  }
  // The buyer must not sit inside the target's own downline (that would make a loop in the tree)
  const loop = await c.env.DB
    .prepare('SELECT 1 FROM network_trees WHERE ancestor_id = ?1 AND descendant_id = ?2')
    .bind(listing.target_user_id, buyer.userId)
    .first();
  if (loop) {
    return c.json({ error: 'You cannot buy a player from your own upline chain' }, 400);
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
  // The wallet CHECK (balance >= 0) aborts the whole batch if funds were spent concurrently, and the
  // listing update only matches while still 'active' (checked via changes() below) — no double sale.
  let results;
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE marketplace_listings SET status = 'sold', buyer_id = ?1, sold_at = ?2, escrow_release_at = ?3 WHERE id = ?4 AND status = 'active'"
      ).bind(buyer.userId, now, escrowReleaseAt, listing.id),
      // Debit only if the listing row above actually changed (changes() = rows touched by the previous statement)
      c.env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd - ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
      ).bind(listing.price_micro_usd, now, buyer.userId),
      ledgerAfterUpdate(c.env.DB, buyer.userId, -listing.price_micro_usd, 'MARKET_BUY', listing.id, now),
    ]);
  } catch {
    return c.json({ error: 'Insufficient funds to purchase listing', required: listing.price_micro_usd }, 400);
  }
  if ((results[0].meta?.changes ?? 0) !== 1 || (results[1].meta?.changes ?? 0) !== 1) {
    return c.json({ error: 'Listing was just sold to someone else' }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET referrer_id = ?1 WHERE id = ?2').bind(buyer.userId, listing.target_user_id),
    // Remove old upline connections of the target user
    c.env.DB.prepare('DELETE FROM network_trees WHERE descendant_id = ?1').bind(listing.target_user_id),
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

/**
 * Cron: release the 30-day escrow — credit each seller once (escrow_released_at guards re-entry)
 * and write a MARKET_SELL audit row so Layer-1 reconciliation stays exact.
 */
export async function releaseMarketplaceEscrow(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const due = await env.DB
    .prepare(
      "SELECT id, seller_id, target_user_id, price_micro_usd, listing_type FROM marketplace_listings WHERE status = 'sold' AND escrow_released_at IS NULL AND escrow_release_at <= ?1 LIMIT 200"
    )
    .bind(now)
    .all<{ id: string; seller_id: string; target_user_id: string; price_micro_usd: number; listing_type: string }>();
  let released = 0;
  for (const l of due.results || []) {
    // Orphan sale (listed by the admin): the money is platform revenue, never an admin wallet credit
    if (l.listing_type === 'orphan') {
      const r = await env.DB.prepare('UPDATE marketplace_listings SET escrow_released_at = ?1 WHERE id = ?2 AND escrow_released_at IS NULL').bind(now, l.id).run();
      if ((r.meta?.changes ?? 0) !== 1) continue;
      released++;
      await logFinancialTransaction(env, {
        transaction_id: `tx_mktorphan_${l.id.slice(0, 8)}_${now}`,
        user_id: PLATFORM_ACCOUNT_ID,
        action_type: 'MARKET_SELL',
        amount_micro_usd: BigInt(l.price_micro_usd),
        balance_after_micro_usd: 0n,
        related_user_id: l.target_user_id,
      });
      continue;
    }
    const res = await env.DB.batch([
      env.DB.prepare('UPDATE marketplace_listings SET escrow_released_at = ?1 WHERE id = ?2 AND escrow_released_at IS NULL').bind(now, l.id),
      env.DB.prepare(
        'UPDATE wallets SET balance_micro_usd = balance_micro_usd + ?1, total_earned_micro_usd = total_earned_micro_usd + ?1, updated_at = ?2 WHERE user_id = ?3 AND changes() = 1'
      ).bind(l.price_micro_usd, now, l.seller_id),
      ledgerAfterUpdate(env.DB, l.seller_id, l.price_micro_usd, 'MARKET_SELL', l.id, now),
    ]);
    if ((res[1].meta?.changes ?? 0) !== 1) continue;
    released++;
    await logFinancialTransaction(env, {
      transaction_id: `tx_mktsell_${l.id.slice(0, 8)}_${now}`,
      user_id: l.seller_id,
      action_type: 'MARKET_SELL',
      amount_micro_usd: BigInt(l.price_micro_usd),
      balance_after_micro_usd: await walletBalance(env.DB, l.seller_id),
      related_user_id: l.target_user_id,
    });
  }
  return { released };
}
