import { Hono } from 'hono';
import { AdNetworkConfigUpdateSchema, type AdNetworkConfig, type AdStats, type AdStatsRow } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';
import { requireStaff } from '../middleware/staff';
import { purgeAdConfig, readAdConfig } from '../utils/ad-networks';
import { utcDateKey } from '../utils/ad-value';

/**
 * /api/admin/ads — super_admin only ("ads" permission):
 *   GET  /config   full network config (snippets included) + whether the postback secret is set
 *   PUT  /config   partial update (mode, toggles, snippets, multipliers 10–150 %), audited, cache purged
 *   GET  /stats    today / last 7 days, top countries, by network, by slot
 */
export const adminAdsRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();
adminAdsRouter.use('*', authMiddleware);
adminAdsRouter.use('*', requireStaff('ads'));

adminAdsRouter.get('/config', async (c) => {
  const config = await readAdConfig(c.env);
  return c.json({ config, postbackSecretSet: !!(c.env.AD_POSTBACK_SECRET || c.env.ADS_POSTBACK_SECRET) });
});

adminAdsRouter.put('/config', async (c) => {
  const me = c.get('user');
  const parsed = AdNetworkConfigUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid ad config' }, 400);
  const old = await readAdConfig(c.env);
  const p = parsed.data;
  const next: AdNetworkConfig = {
    ...old,
    ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
    multipliers: { ...old.multipliers, ...(p.multipliers || {}) },
  } as AdNetworkConfig;
  const t = Math.floor(Date.now() / 1000);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO ad_network_configs (id, ad_mode, adsterra_enabled, adsterra_banner_300x250, adsterra_banner_320x50, adsterra_smartlink_url,
         monetag_enabled, monetag_inpage_zone_id, monetag_inpage_script, monetag_direct_link_url,
         mult_adsterra_300x250_pct, mult_adsterra_320x50_pct, mult_monetag_inpage_pct, mult_monetag_direct_pct, mult_adsterra_smartlink_pct,
         updated_at, updated_by)
       VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(id) DO UPDATE SET ad_mode = ?1, adsterra_enabled = ?2, adsterra_banner_300x250 = ?3, adsterra_banner_320x50 = ?4,
         adsterra_smartlink_url = ?5, monetag_enabled = ?6, monetag_inpage_zone_id = ?7, monetag_inpage_script = ?8, monetag_direct_link_url = ?9,
         mult_adsterra_300x250_pct = ?10, mult_adsterra_320x50_pct = ?11, mult_monetag_inpage_pct = ?12, mult_monetag_direct_pct = ?13,
         mult_adsterra_smartlink_pct = ?14, updated_at = ?15, updated_by = ?16`
    ).bind(
      next.adMode,
      next.adsterraEnabled ? 1 : 0,
      next.adsterraBanner300x250 || null,
      next.adsterraBanner320x50 || null,
      next.adsterraSmartlinkUrl || null,
      next.monetagEnabled ? 1 : 0,
      next.monetagInpageZoneId || null,
      next.monetagInpageScript || null,
      next.monetagDirectLinkUrl || null,
      next.multipliers.adsterra_300x250,
      next.multipliers.adsterra_320x50,
      next.multipliers.monetag_inpage,
      next.multipliers.monetag_direct,
      next.multipliers.adsterra_smartlink,
      t,
      me.userId
    ),
    // Audit: mode, toggles and multipliers (not the snippets themselves)
    c.env.DB.prepare("INSERT INTO staff_audit_log (id, actor_id, target_id, action, old_value, new_value, created_at) VALUES (?1, ?2, NULL, 'ad_config', ?3, ?4, ?5)").bind(
      crypto.randomUUID(),
      me.userId,
      auditSummary(old),
      auditSummary(next),
      t
    ),
  ]);
  await purgeAdConfig(c);
  return c.json({ success: true, config: await readAdConfig(c.env) });
});

function auditSummary(cfg: AdNetworkConfig) {
  const m = cfg.multipliers;
  return `${cfg.adMode} A${cfg.adsterraEnabled ? 1 : 0} M${cfg.monetagEnabled ? 1 : 0} ${m.adsterra_300x250}/${m.adsterra_320x50}/${m.monetag_inpage}/${m.monetag_direct}/${m.adsterra_smartlink}`;
}

const row = (r: any): AdStatsRow => ({ impressions: Number(r?.n || 0), estMicroUsd: Number(r?.usd || 0), ecBp: Number(r?.ec || 0) });

adminAdsRouter.get('/stats', async (c) => {
  const today = utcDateKey();
  const from = utcDateKey(new Date(Date.now() - 6 * 86_400_000));
  const agg = 'COUNT(*) AS n, COALESCE(SUM(amount_micro_usd), 0) AS usd, COALESCE(SUM(ec_progress_bp), 0) AS ec';
  const res = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${agg} FROM ad_impressions WHERE date_key = ?1`).bind(today),
    c.env.DB.prepare(`SELECT ${agg} FROM ad_impressions WHERE date_key >= ?1`).bind(from),
    c.env.DB.prepare(`SELECT country_code AS k, ${agg} FROM ad_impressions WHERE date_key >= ?1 GROUP BY country_code ORDER BY usd DESC LIMIT 8`).bind(from),
    c.env.DB.prepare(`SELECT provider AS k, ${agg} FROM ad_impressions WHERE date_key >= ?1 GROUP BY provider ORDER BY usd DESC`).bind(from),
    c.env.DB.prepare(`SELECT ad_slot AS k, ${agg} FROM ad_impressions WHERE date_key >= ?1 AND ad_slot IS NOT NULL GROUP BY ad_slot ORDER BY usd DESC`).bind(from),
  ]);
  const list = (i: number) => (res[i].results || []) as any[];
  const stats: AdStats = {
    today: row(list(0)[0]),
    last7: row(list(1)[0]),
    topCountries: list(2).map((r) => ({ country: r.k, ...row(r) })),
    byNetwork: list(3).map((r) => ({ network: r.k, ...row(r) })),
    bySlot: list(4).map((r) => ({ slot: r.k, ...row(r) })),
  };
  return c.json(stats);
});
