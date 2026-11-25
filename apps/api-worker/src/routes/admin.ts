import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AdminMemberPatchSchema,
  ListOrphansSchema,
  OrphanListingPatchSchema,
  GameUpsertSchema,
  GamePatchSchema,
  RoomUpsertSchema,
  RoomPatchSchema,
  MEMBER_FILTERS,
  MAX_ENERGY_TICKETS,
  SUPPORT_EC_DAILY_LIMIT,
  StaffRoleUpdateSchema,
  STAFF_PERMISSIONS,
  normalizeStaffRole,
} from '@mwar/shared';
import type { StaffAuditEntry, StaffMember } from '@mwar/shared';
import type { AdminMemberDetail, AdminMemberRow, MemberFilter } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { requireStaff, getStaffRole, isEnvSuperAdmin } from '../middleware/staff';
import { edgeCachePurge } from '../utils/edge-cache';
import { GAMES_CACHE_KEYS, roomsCacheKey, rowToGame, rowToRoom } from './games';

/**
 * /api/admin — member directory + orphan marketplace listings, and the game / room registry.
 * Reads: admin or auditor. Writes: admin only.
 */
type AppEnv = { Bindings: Env; Variables: { user: AuthUserPayload } };
type Ctx = Context<AppEnv>;
export const adminRouter = new Hono<AppEnv>();

adminRouter.use('*', authMiddleware);
// Every route below names the staff permission it needs (STAFF_PERMISSIONS in @mwar/shared).
// Roles are read from D1 per request, so a role change applies at once.

const now = () => Math.floor(Date.now() / 1000);
const PAGE = 20;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
const MEMBER_COLS = `u.id, u.username, u.display_name, u.status, u.role, u.staff_role, u.referrer_id, u.energy_tickets, u.created_at,
  r.username AS referrer_username, COALESCE(w.balance_micro_usd, 0) AS balance, COALESCE(w.total_earned_micro_usd, 0) AS earned,
  (SELECT m.id || '|' || m.price_micro_usd || '|' || m.listing_type FROM marketplace_listings m WHERE m.target_user_id = u.id AND m.status = 'active' LIMIT 1) AS listing`;

function rowToMember(r: any): AdminMemberRow {
  const [lid, price, type] = typeof r.listing === 'string' ? r.listing.split('|') : [];
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || null,
    status: r.status,
    role: r.role,
    staffRole: normalizeStaffRole(r.staff_role),
    referrerId: r.referrer_id || null,
    referrerUsername: r.referrer_username || null,
    energyTickets: Number(r.energy_tickets) || 0,
    balanceMicroUsd: Number(r.balance) || 0,
    totalEarnedMicroUsd: Number(r.earned) || 0,
    createdAt: Number(r.created_at) || 0,
    listing: lid ? { id: lid, priceMicroUsd: Number(price) || 0, type: type === 'orphan' ? 'orphan' : 'player' } : null,
  };
}

/** GET /api/admin/members?filter=all|orphan|listed|active|suspended&q=&cursor=<created_at>:<id> — 20 per page. */
adminRouter.get('/members', requireStaff('membersRead'), async (c) => {
  const filter = ((MEMBER_FILTERS as readonly string[]).includes(c.req.query('filter') || '') ? c.req.query('filter') : 'all') as MemberFilter;
  const q = (c.req.query('q') || '').trim().slice(0, 40);
  const cursor = c.req.query('cursor') || '';
  const where: string[] = [];
  const binds: unknown[] = [];
  const bind = (v: unknown) => {
    binds.push(v);
    return `?${binds.length}`;
  };
  if (filter === 'orphan') where.push("u.referrer_id IS NULL AND u.role = 'player' AND u.staff_role = 'user'");
  if (filter === 'listed') where.push("EXISTS (SELECT 1 FROM marketplace_listings m WHERE m.target_user_id = u.id AND m.status = 'active')");
  if (filter === 'active') where.push("u.status = 'active'");
  if (filter === 'suspended') where.push("u.status IN ('suspended', 'banned')");
  if (q) {
    // Prefix match on the UNIQUE username index, or an exact id
    const p1 = bind(q.toLowerCase());
    const p2 = bind(q.toLowerCase() + '￿');
    const p3 = bind(q);
    where.push(`((LOWER(u.username) >= ${p1} AND LOWER(u.username) < ${p2}) OR u.id = ${p3})`);
  }
  const m = /^(\d+):([\w-]+)$/.exec(cursor);
  if (m) {
    const a = bind(Number(m[1]));
    const b = bind(m[2]);
    where.push(`(u.created_at < ${a} OR (u.created_at = ${a} AND u.id < ${b}))`);
  }
  const sql = `SELECT ${MEMBER_COLS}
    FROM users u LEFT JOIN users r ON r.id = u.referrer_id LEFT JOIN wallets w ON w.user_id = u.id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY u.created_at DESC, u.id DESC LIMIT ${PAGE + 1}`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();
  const rows = (results || []).map(rowToMember);
  const more = rows.length > PAGE;
  const items = rows.slice(0, PAGE);
  const last = items[items.length - 1];
  return c.json({ items, nextCursor: more && last ? `${last.createdAt}:${last.id}` : null });
});

/** GET /api/admin/members/:id — full inspector (links, tree counts, wallet, stats, first 50 of the 5-tier tree). */
adminRouter.get('/members/:id', requireStaff('membersRead'), async (c) => {
  const id = c.req.param('id');
  const [base, links, depthRows, tree, stats] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${MEMBER_COLS} FROM users u LEFT JOIN users r ON r.id = u.referrer_id LEFT JOIN wallets w ON w.user_id = u.id WHERE u.id = ?1`).bind(id),
    c.env.DB.prepare('SELECT provider, provider_username, provider_display_name FROM oauth_accounts WHERE user_id = ?1').bind(id),
    c.env.DB.prepare('SELECT depth, COUNT(*) AS n FROM network_trees WHERE ancestor_id = ?1 GROUP BY depth').bind(id),
    c.env.DB.prepare(
      'SELECT t.descendant_id AS id, u.username, t.depth FROM network_trees t JOIN users u ON u.id = t.descendant_id WHERE t.ancestor_id = ?1 ORDER BY t.depth, u.username LIMIT 50'
    ).bind(id),
    c.env.DB.prepare('SELECT total_kills, total_matches FROM users WHERE id = ?1').bind(id),
  ]);
  const row = base.results?.[0];
  if (!row) return c.json({ error: 'Member not found' }, 404);
  const byDepth = [0, 0, 0, 0, 0];
  for (const d of (depthRows.results || []) as any[]) if (d.depth >= 1 && d.depth <= 5) byDepth[d.depth - 1] = Number(d.n) || 0;
  const l = (links.results || []) as any[];
  const tg = l.find((x) => x.provider === 'telegram');
  const ln = l.find((x) => x.provider === 'line');
  const st = (stats.results?.[0] || {}) as any;
  const body: AdminMemberDetail = {
    ...rowToMember(row),
    telegram: tg ? { username: tg.provider_username || null, displayName: tg.provider_display_name || null } : null,
    line: ln ? { displayName: ln.provider_display_name || null } : null,
    directDownlines: byDepth[0],
    totalDownlines: byDepth.reduce((a, b) => a + b, 0),
    downlinesByDepth: byDepth,
    totalKills: Number(st.total_kills) || 0,
    totalMatches: Number(st.total_matches) || 0,
    tree: ((tree.results || []) as any[]).map((t) => ({ id: t.id, username: t.username, depth: Number(t.depth) })),
  };
  return c.json(body);
});

/** PATCH /api/admin/members/:id { ecDelta?, status? } — EC is clamped to 0…30. */
adminRouter.patch('/members/:id', requireStaff([...STAFF_PERMISSIONS.membersWrite, 'support', 'moderator']), async (c) => {
  const me = c.get('user');
  const myRole = await getStaffRole(c);
  const id = c.req.param('id');
  const parsed = AdminMemberPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid update' }, 400);
  const target = await c.env.DB
    .prepare('SELECT id, username, role, status, staff_role FROM users WHERE id = ?1')
    .bind(id)
    .first<{ id: string; username: string; role: string; status: string; staff_role: string | null }>();
  if (!target) return c.json({ error: 'Member not found' }, 404);
  const { ecDelta, status } = parsed.data;
  const t = now();

  // Permission per field: EC = admin+ (unlimited) or support (daily limit); suspension = admin+ / moderator
  if (ecDelta && !(STAFF_PERMISSIONS.membersWrite as readonly string[]).includes(myRole)) {
    if (myRole !== 'support') return c.json({ error: 'Forbidden: your staff role cannot adjust EC', code: 'STAFF_ROLE' }, 403);
    const dayStart = t - (t % 86_400);
    const used = await c.env.DB
      .prepare("SELECT COALESCE(SUM(ABS(CAST(new_value AS INTEGER))), 0) AS n FROM staff_audit_log WHERE action = 'ec_adjust' AND actor_id = ?1 AND created_at >= ?2")
      .bind(me.userId, dayStart)
      .first<{ n: number }>();
    if (Number(used?.n || 0) + Math.abs(ecDelta) > SUPPORT_EC_DAILY_LIMIT) {
      return c.json({ error: `Support can adjust at most ${SUPPORT_EC_DAILY_LIMIT} EC per day (used ${used?.n || 0})`, code: 'EC_DAILY_LIMIT' }, 403);
    }
  }
  if (status && !(STAFF_PERMISSIONS.suspend as readonly string[]).includes(myRole)) {
    return c.json({ error: 'Forbidden: your staff role cannot suspend accounts', code: 'STAFF_ROLE' }, 403);
  }
  if (status && (target.id === me.userId || normalizeStaffRole(target.staff_role) !== 'user' || target.role !== 'player')) {
    return c.json({ error: 'Staff accounts cannot be suspended here' }, 400);
  }
  if (status && target.status === 'banned') return c.json({ error: 'This account is banned' }, 400);
  const stmts = [];
  if (ecDelta) {
    stmts.push(
      c.env.DB.prepare('UPDATE users SET energy_tickets = MAX(0, MIN(?1, energy_tickets + ?2)) WHERE id = ?3').bind(MAX_ENERGY_TICKETS, ecDelta, id),
      c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, ?3, 'ec_adjust', NULL, ?4, ?5)").bind(
        crypto.randomUUID(),
        me.userId,
        id,
        String(ecDelta),
        t
      )
    );
  }
  if (status) {
    stmts.push(
      c.env.DB.prepare('UPDATE users SET status = ?1 WHERE id = ?2').bind(status, id),
      c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, ?3, 'status', ?4, ?5, ?6)").bind(
        crypto.randomUUID(),
        me.userId,
        id,
        target.status,
        status,
        t
      )
    );
  }
  await c.env.DB.batch(stmts);
  console.log(`[ADMIN] ${me.username} (${myRole}) updated member ${id}: ${JSON.stringify(parsed.data)}`);
  const u = await c.env.DB.prepare('SELECT energy_tickets, status FROM users WHERE id = ?1').bind(id).first<{ energy_tickets: number; status: string }>();
  return c.json({ success: true, energyTickets: u?.energy_tickets ?? 0, status: u?.status });
});

// ---------------------------------------------------------------------------
// Staff & roles (super_admin only)
// ---------------------------------------------------------------------------
const STAFF_COLS = 'id, username, display_name, staff_role, created_at';
const toStaff = (r: any): StaffMember => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name || null,
  staffRole: normalizeStaffRole(r.staff_role),
  createdAt: r.created_at,
});

/** GET /api/admin/staff?q= — current staff (no q) or a username / id prefix search (any user). */
adminRouter.get('/staff', requireStaff('staff'), async (c) => {
  const q = (c.req.query('q') || '').trim().replace(/^@/, '');
  if (q) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(q)) return c.json({ items: [] });
    const { results } = await c.env.DB
      .prepare(
        `SELECT ${STAFF_COLS} FROM users WHERE id = ?1
         UNION SELECT ${STAFF_COLS} FROM users WHERE username >= ?2 AND username < ?3
         ORDER BY username LIMIT 20`
      )
      .bind(q, q.toLowerCase(), `${q.toLowerCase()}\uffff`)
      .all<any>();
    return c.json({ items: (results || []).map(toStaff) });
  }
  const { results } = await c.env.DB
    .prepare(`SELECT ${STAFF_COLS} FROM users WHERE staff_role != 'user' ORDER BY created_at ASC LIMIT 200`)
    .all<any>();
  return c.json({ items: (results || []).map(toStaff) });
});

/** PATCH /api/admin/staff { userId, staffRole } — assign / change / revoke, with an audit row. */
adminRouter.patch('/staff', requireStaff('staff'), async (c) => {
  const me = c.get('user');
  const parsed = StaffRoleUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid role' }, 400);
  const { userId, staffRole } = parsed.data;
  const target = await c.env.DB.prepare(`SELECT ${STAFF_COLS}, status FROM users WHERE id = ?1`).bind(userId).first<any>();
  if (!target) return c.json({ error: 'Member not found' }, 404);
  const old = normalizeStaffRole(target.staff_role);
  if (old === staffRole) return c.json({ success: true, member: toStaff(target) });
  // Never leave the platform without an owner: you cannot demote yourself, and the last super_admin stays
  if (target.id === me.userId && staffRole !== 'super_admin') return c.json({ error: 'You cannot remove your own super_admin role' }, 400);
  if (old === 'super_admin') {
    const others = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE staff_role = 'super_admin' AND id != ?1").bind(target.id).first<{ n: number }>();
    if (!Number(others?.n || 0) && !isEnvSuperAdmin(c.env, target.username)) return c.json({ error: 'At least one super_admin must remain' }, 400);
  }
  // Keep the legacy JWT role roughly in step (old clients / DEV panel): admin-type staff -> 'admin'
  const legacyRole = staffRole === 'super_admin' || staffRole === 'admin' ? 'admin' : staffRole === 'finance_auditor' ? 'auditor' : 'player';
  const t = now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET staff_role = ?1, role = ?2 WHERE id = ?3').bind(staffRole, legacyRole, userId),
    c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, ?3, 'staff_role', ?4, ?5, ?6)").bind(
      crypto.randomUUID(),
      me.userId,
      userId,
      old,
      staffRole,
      t
    ),
  ]);
  console.log(`[ADMIN] ${me.username} set staff_role of ${target.username}: ${old} -> ${staffRole}`);
  return c.json({ success: true, member: { ...toStaff(target), staffRole } });
});

/** GET /api/admin/staff/audit — newest 50 staff actions (role changes, EC adjustments, suspensions). */
adminRouter.get('/staff/audit', requireStaff('staff'), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT l.id, l.action, l.old_value, l.new_value, l.created_at, a.username AS actor, t.username AS target
       FROM staff_audit_log l LEFT JOIN users a ON a.id = l.actor_id LEFT JOIN users t ON t.id = l.target_id
       ORDER BY l.created_at DESC LIMIT 50`
    )
    .all<any>();
  const items: StaffAuditEntry[] = (results || []).map((r: any) => ({
    id: r.id,
    actorUsername: r.actor || null,
    targetUsername: r.target || null,
    action: r.action,
    oldValue: r.old_value ?? null,
    newValue: r.new_value ?? null,
    createdAt: r.created_at,
  }));
  return c.json({ items });
});

/**
 * POST /api/admin/members/list-orphans { items: [{ userId, priceMicroUsd }] } — publish orphan players
 * (no upline) on the marketplace. The buyer becomes their direct upline; the money goes to the platform.
 */
adminRouter.post('/members/list-orphans', requireStaff('membersWrite'), async (c) => {
  const me = c.get('user');
  const parsed = ListOrphansSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid list' }, 400);
  const t = now();
  const results: Array<{ userId: string; ok: boolean; listingId?: string; error?: string }> = [];
  for (const item of parsed.data.items) {
    const u = await c.env.DB
      .prepare(
        `SELECT u.id, u.referrer_id, u.role, u.status,
                (SELECT 1 FROM marketplace_listings m WHERE m.target_user_id = u.id AND m.status = 'active' LIMIT 1) AS listed
         FROM users u WHERE u.id = ?1`
      )
      .bind(item.userId)
      .first<any>();
    if (!u) results.push({ userId: item.userId, ok: false, error: 'not_found' });
    else if (u.referrer_id) results.push({ userId: item.userId, ok: false, error: 'has_upline' });
    else if (u.role !== 'player' || u.status !== 'active') results.push({ userId: item.userId, ok: false, error: 'not_eligible' });
    else if (u.listed) results.push({ userId: item.userId, ok: false, error: 'already_listed' });
    else {
      const listingId = crypto.randomUUID();
      await c.env.DB
        .prepare(
          "INSERT INTO marketplace_listings (id, seller_id, target_user_id, price_micro_usd, status, created_at, listing_type) VALUES (?1, ?2, ?3, ?4, 'active', ?5, 'orphan')"
        )
        .bind(listingId, me.userId, item.userId, item.priceMicroUsd, t)
        .run();
      results.push({ userId: item.userId, ok: true, listingId });
    }
  }
  await edgeCachePurge(c, 'marketplace-listings');
  return c.json({ success: true, listed: results.filter((r) => r.ok).length, results });
});

/** PATCH /api/admin/listings/:id { priceMicroUsd? , delist? } — orphan listings that are still unsold. */
adminRouter.patch('/listings/:id', requireStaff('membersWrite'), async (c) => {
  const parsed = OrphanListingPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid update' }, 400);
  const id = c.req.param('id');
  const res = parsed.data.delist
    ? await c.env.DB.prepare("UPDATE marketplace_listings SET status = 'cancelled' WHERE id = ?1 AND status = 'active' AND listing_type = 'orphan'").bind(id).run()
    : await c.env.DB
        .prepare("UPDATE marketplace_listings SET price_micro_usd = ?1 WHERE id = ?2 AND status = 'active' AND listing_type = 'orphan'")
        .bind(parsed.data.priceMicroUsd, id)
        .run();
  if ((res.meta?.changes ?? 0) !== 1) return c.json({ error: 'Listing not found, already sold, or not an orphan listing' }, 404);
  await edgeCachePurge(c, 'marketplace-listings');
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Games + rooms
// ---------------------------------------------------------------------------
async function purgeGames(c: Ctx, gameId?: string) {
  await Promise.all([...GAMES_CACHE_KEYS, ...(gameId ? [roomsCacheKey(gameId)] : [])].map((k) => edgeCachePurge(c, k)));
}

adminRouter.get('/games', requireStaff('games'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM games ORDER BY sort_order, title').all<any>();
  return c.json({ games: (results || []).map(rowToGame) });
});

adminRouter.post('/games', requireStaff('games'), async (c) => {
  const parsed = GameUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid game' }, 400);
  const d = parsed.data;
  const t = now();
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO games (id, slug, title, subtitle, description, genre_tags, logo_url, cover_url, route_path, status, sort_order, created_at, updated_at)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
      )
      .bind(d.slug, d.title, d.subtitle || null, d.description || null, JSON.stringify(d.genreTags), d.logoUrl || null, d.coverUrl || null, d.routePath, d.status, d.sortOrder, t)
      .run();
  } catch {
    return c.json({ error: 'A game with this slug already exists' }, 409);
  }
  await purgeGames(c);
  return c.json({ success: true, id: d.slug }, 201);
});

adminRouter.patch('/games/:id', requireStaff('games'), async (c) => {
  const id = c.req.param('id');
  const parsed = GamePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid game' }, 400);
  const d = parsed.data;
  const cols: Record<string, unknown> = {
    title: d.title,
    subtitle: d.subtitle,
    description: d.description,
    genre_tags: d.genreTags ? JSON.stringify(d.genreTags) : undefined,
    logo_url: d.logoUrl,
    cover_url: d.coverUrl,
    route_path: d.routePath,
    status: d.status,
    sort_order: d.sortOrder,
  };
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    binds.push(v === '' ? null : v);
    sets.push(`${k} = ?${binds.length}`);
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  binds.push(now(), id);
  const res = await c.env.DB.prepare(`UPDATE games SET ${sets.join(', ')}, updated_at = ?${binds.length - 1} WHERE id = ?${binds.length}`).bind(...binds).run();
  if ((res.meta?.changes ?? 0) !== 1) return c.json({ error: 'Game not found' }, 404);
  await purgeGames(c, id);
  return c.json({ success: true });
});

/** POST /api/admin/games/:id/media?kind=logo|cover — body: a WebP image (compressed in the browser, ≤ 400 KB). */
adminRouter.post('/games/:id/media', requireStaff('games'), async (c) => {
  const id = c.req.param('id') || '';
  const kind = c.req.query('kind') === 'cover' ? 'covers' : 'logos';
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.byteLength < 32 || buf.byteLength > 400 * 1024) return c.json({ error: 'Image must be a WebP of at most 400 KB' }, 400);
  const tag = String.fromCharCode(...buf.slice(0, 4)) + String.fromCharCode(...buf.slice(8, 12));
  if (tag !== 'RIFFWEBP') return c.json({ error: 'Only WebP images are accepted' }, 400);
  const game = await c.env.DB.prepare('SELECT id FROM games WHERE id = ?1').bind(id).first();
  if (!game) return c.json({ error: 'Game not found' }, 404);
  const file = `${id.replace(/[^a-z0-9-]/g, '').slice(0, 24)}-${crypto.randomUUID().slice(0, 8)}.webp`;
  await c.env.MEDIA_BUCKET.put(`games/${kind}/${file}`, buf, { httpMetadata: { contentType: 'image/webp' } });
  // Absolute https URL (game cards are shown on the web origin); plain http only for local dev
  const reqUrl = new URL(c.req.url);
  const local = reqUrl.hostname === 'localhost' || reqUrl.hostname === '127.0.0.1';
  const url = `${local ? reqUrl.origin : `https://${reqUrl.host}`}/api/games/media/${kind}/${file}`;
  return c.json({ success: true, url });
});

adminRouter.get('/games/:gameId/rooms', requireStaff('games'), async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM game_server_rooms WHERE game_id = ?1 ORDER BY sort_order, room_code')
    .bind(c.req.param('gameId'))
    .all<any>();
  return c.json({ rooms: (results || []).map(rowToRoom) });
});

async function checkNode(c: Ctx, nodeId: string | null | undefined) {
  if (!nodeId) return true;
  return !!(await c.env.DB.prepare('SELECT 1 FROM game_nodes WHERE id = ?1').bind(nodeId).first());
}

adminRouter.post('/games/:gameId/rooms', requireStaff('games'), async (c) => {
  const gameId = c.req.param('gameId');
  const parsed = RoomUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid room' }, 400);
  const d = parsed.data;
  if (!(await c.env.DB.prepare('SELECT 1 FROM games WHERE id = ?1').bind(gameId).first())) return c.json({ error: 'Game not found' }, 404);
  if (!(await checkNode(c, d.nodeId))) return c.json({ error: 'Unknown game server node' }, 400);
  const t = now();
  try {
    await c.env.DB
      .prepare(
        `INSERT INTO game_server_rooms (id, game_id, node_id, room_code, name, mode, map_size, max_players, max_spectators, entry_cost_ec, is_active, sort_order, rules, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`
      )
      .bind(`${gameId}-${d.roomCode}`, gameId, d.nodeId || null, d.roomCode, d.name, d.mode, d.mapSize, d.maxPlayers, d.maxSpectators, d.entryCostEc, d.isActive ? 1 : 0, d.sortOrder, JSON.stringify(d.rules), t)
      .run();
  } catch {
    return c.json({ error: 'This room code already exists for the game' }, 409);
  }
  await purgeGames(c, gameId);
  return c.json({ success: true, id: `${gameId}-${d.roomCode}` }, 201);
});

adminRouter.patch('/games/:gameId/rooms/:roomId', requireStaff('games'), async (c) => {
  const { gameId, roomId } = c.req.param();
  const parsed = RoomPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid room' }, 400);
  const d = parsed.data;
  if (d.nodeId !== undefined && !(await checkNode(c, d.nodeId))) return c.json({ error: 'Unknown game server node' }, 400);
  const cols: Record<string, unknown> = {
    name: d.name,
    node_id: d.nodeId === undefined ? undefined : d.nodeId || null,
    mode: d.mode,
    map_size: d.mapSize,
    max_players: d.maxPlayers,
    max_spectators: d.maxSpectators,
    entry_cost_ec: d.entryCostEc,
    is_active: d.isActive === undefined ? undefined : d.isActive ? 1 : 0,
    sort_order: d.sortOrder,
    rules: d.rules ? JSON.stringify(d.rules) : undefined,
  };
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v === undefined) continue;
    binds.push(v);
    sets.push(`${k} = ?${binds.length}`);
  }
  if (!sets.length) return c.json({ error: 'Nothing to update' }, 400);
  binds.push(now(), roomId, gameId);
  const n = binds.length;
  const res = await c.env.DB
    .prepare(`UPDATE game_server_rooms SET ${sets.join(', ')}, updated_at = ?${n - 2} WHERE id = ?${n - 1} AND game_id = ?${n}`)
    .bind(...binds)
    .run();
  if ((res.meta?.changes ?? 0) !== 1) return c.json({ error: 'Room not found' }, 404);
  await purgeGames(c, gameId);
  return c.json({ success: true });
});

adminRouter.delete('/games/:gameId/rooms/:roomId', requireStaff('games'), async (c) => {
  const { gameId, roomId } = c.req.param();
  const res = await c.env.DB.prepare('DELETE FROM game_server_rooms WHERE id = ?1 AND game_id = ?2').bind(roomId, gameId).run();
  if ((res.meta?.changes ?? 0) !== 1) return c.json({ error: 'Room not found' }, 404);
  await purgeGames(c, gameId);
  return c.json({ success: true });
});

