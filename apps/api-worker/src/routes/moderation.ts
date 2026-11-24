import { Hono } from 'hono';
import { ModerationResultSchema } from '@mwar/shared';
import type { Env } from '../types';
import { hasInternalSecret } from '../utils/guards';
import { MEDIA_KEY_RE, deletePostMedia, purgeFeedHeads, purgeMediaCache } from '../utils/social-media';
import { sortableId } from './social';

/**
 * Batch moderation queue for the self-hosted Ubuntu moderation workers (apps/moderation-worker).
 * Every route needs `X-Internal-Secret: <INTERNAL_API_SECRET>`.
 *
 *  POST /api/moderation/claim    { node_name, batch_size? }  -> up to 15 (max 20) jobs locked for 300 s
 *  GET  /api/moderation/media?key=social/...                  -> raw media bytes for one claimed job
 *  POST /api/moderation/results  { node_name, results: [...] } -> one D1 batch; rejected media deleted from R2
 *
 * Claiming is a single UPDATE ... RETURNING, so 1..N workers can poll the same queue without ever
 * processing a job twice (D1 executes each statement atomically).
 */
export const moderationRouter = new Hono<{ Bindings: Env }>();

const LOCK_SECONDS = 300;
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 15;
const MAX_BATCH = 20;

moderationRouter.use('*', async (c, next) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

moderationRouter.post('/claim', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nodeName = String(body?.node_name || 'moderator').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'moderator';
  const batch = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(body?.batch_size ?? DEFAULT_BATCH)) || DEFAULT_BATCH));
  const now = Math.floor(Date.now() / 1000);

  const [failed, claimed] = await c.env.DB.batch([
    // Jobs that keep crashing a worker are parked as failed (post stays pending, visible to staff only)
    c.env.DB.prepare(
      `UPDATE moderation_jobs SET status = 'failed', updated_at = ?1
       WHERE status = 'processing' AND locked_until < ?1 AND attempts >= ?2`
    ).bind(now, MAX_ATTEMPTS),
    c.env.DB.prepare(
      `UPDATE moderation_jobs
         SET status = 'processing', worker_node_id = ?1, locked_until = ?2, attempts = attempts + 1, updated_at = ?3
       WHERE id IN (
         SELECT id FROM moderation_jobs
         WHERE (status = 'pending') OR (status = 'processing' AND locked_until < ?3 AND attempts < ?4)
         ORDER BY created_at ASC LIMIT ?5
       )
       RETURNING id, post_id, media_key, media_type, attempts`
    ).bind(nodeName, now + LOCK_SECONDS, now, MAX_ATTEMPTS, batch),
  ]);
  void failed;
  const origin = new URL(c.req.url).origin;
  const jobs = ((claimed.results || []) as any[]).map((j) => ({
    job_id: j.id,
    post_id: j.post_id,
    media_key: j.media_key,
    media_type: j.media_type,
    attempts: j.attempts,
    download_url: `${origin}/api/moderation/media?key=${encodeURIComponent(j.media_key)}`,
  }));
  return c.json({ jobs, lock_seconds: LOCK_SECONDS, server_time: now });
});

moderationRouter.get('/media', async (c) => {
  const key = c.req.query('key') || '';
  if (!MEDIA_KEY_RE.test(key)) return c.json({ error: 'Invalid key' }, 400);
  const obj = await c.env.MEDIA_BUCKET.get(key);
  if (!obj) return c.json({ error: 'Not found' }, 404);
  return new Response((obj as any).body as ReadableStream, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, no-store',
    },
  });
});

moderationRouter.post('/results', async (c) => {
  const parsed = ModerationResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || 'Invalid results' }, 400);
  const { node_name, results } = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const db = c.env.DB;

  // Only jobs that are still being processed count (a late duplicate result is ignored)
  const ids = results.map((r) => r.job_id);
  const ph = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results: jobRows } = await db
    .prepare(
      `SELECT j.id, j.post_id, j.media_key, p.author_id, p.tag, p.author_marked_nsfw
       FROM moderation_jobs j LEFT JOIN social_posts p ON p.id = j.post_id
       WHERE j.id IN (${ph}) AND j.status = 'processing'`
    )
    .bind(...ids)
    .all<any>();
  const jobs = new Map((jobRows || []).map((j: any) => [j.id, j]));

  const stmts: D1PreparedStatement[] = [];
  const purge: { mediaKey: string; authorId: string | null; tag: string | null; rejected: boolean }[] = [];
  let applied = 0;
  for (const r of results) {
    const job = jobs.get(r.job_id);
    if (!job || job.post_id !== r.post_id) continue;
    applied++;
    const reason = (r.reason || '').slice(0, 200) || null;
    stmts.push(
      db.prepare(
        `UPDATE moderation_jobs SET status = 'done', result_action = ?1, result_reason = ?2, result_score = ?3, worker_node_id = ?4, updated_at = ?5
         WHERE id = ?6`
      ).bind(r.action, reason ? `${reason} [stage ${r.stage_stopped}]` : `stage ${r.stage_stopped}`, r.score, node_name, now, r.job_id)
    );
    if (!job.author_id) continue; // post was deleted meanwhile
    if (r.action === 'reject_prohibited') {
      const why = reason || 'Weapons / blood / violence are not allowed';
      stmts.push(
        db.prepare(
          `UPDATE social_posts SET moderation_status = 'rejected', moderation_reason = ?1, nsfw_score = ?2, media_key = NULL
           WHERE id = ?3 AND moderation_status = 'pending'`
        ).bind(why, r.score, r.post_id),
        db.prepare(
          `INSERT INTO social_notifications (id, user_id, actor_id, type, post_id, created_at)
           VALUES (?1, ?2, ?2, 'moderation', ?3, ?4)`
        ).bind(sortableId('n'), job.author_id, r.post_id, now)
      );
    } else if (r.action === 'mark_nsfw_18') {
      stmts.push(
        db.prepare(
          `UPDATE social_posts SET moderation_status = 'nsfw_18', content_rating = 'nsfw_18', nsfw_score = ?1
           WHERE id = ?2 AND moderation_status = 'pending'`
        ).bind(r.score, r.post_id)
      );
    } else {
      // approve_safe — a post the author self-tagged 18+ stays 18+
      stmts.push(
        db.prepare(
          `UPDATE social_posts SET
             moderation_status = CASE WHEN author_marked_nsfw = 1 THEN 'nsfw_18' ELSE 'approved' END,
             content_rating = CASE WHEN author_marked_nsfw = 1 THEN 'nsfw_18' ELSE 'safe' END,
             nsfw_score = ?1
           WHERE id = ?2 AND moderation_status = 'pending'`
        ).bind(r.score, r.post_id)
      );
    }
    purge.push({ mediaKey: job.media_key, authorId: job.author_id, tag: job.tag, rejected: r.action === 'reject_prohibited' });
  }
  if (stmts.length) await db.batch(stmts);

  // Rejected media: delete from R2 right away (0 bytes kept); refresh feed caches for new posts
  const origin = new URL(c.req.url).origin;
  await Promise.all(
    purge.map(async (p) => {
      if (p.rejected) {
        await deletePostMedia(c.env, p.mediaKey);
        await purgeMediaCache(c, origin, p.mediaKey);
      }
      if (p.authorId) await purgeFeedHeads(c, p.authorId, p.tag || undefined);
    })
  );
  return c.json({ success: true, applied, ignored: results.length - applied });
});

/** Nightly cron: prune finished jobs, expired reset tokens and rejected posts (D1 stays small). */
export async function pruneModerationData(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const week = now - 7 * 86_400;
  const { results: oldRejected } = await env.DB
    .prepare(`SELECT id, author_id, media_key FROM social_posts WHERE moderation_status = 'rejected' AND created_at < ?1 LIMIT 200`)
    .bind(week)
    .all<{ id: string; author_id: string; media_key: string | null }>();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM moderation_jobs WHERE status IN ('done', 'failed') AND updated_at < ?1").bind(week),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(now - 86_400),
    // Resolved reports whose post no longer exists (orphans), after 30 days
    env.DB.prepare(
      "DELETE FROM content_reports WHERE status != 'pending' AND resolved_at < ?1 AND NOT EXISTS (SELECT 1 FROM social_posts p WHERE p.id = content_reports.post_id)"
    ).bind(now - 30 * 86_400),
  ];
  for (const p of oldRejected || []) {
    stmts.push(
      env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_post_comments WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_notifications WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM moderation_jobs WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_posts WHERE id = ?1').bind(p.id),
      env.DB.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id = ?1').bind(p.author_id)
    );
  }
  await env.DB.batch(stmts);
  await Promise.all((oldRejected || []).map((p) => deletePostMedia(env, p.media_key)));
  return { prunedRejectedPosts: oldRejected?.length || 0 };
}

type D1PreparedStatement = ReturnType<Env['DB']['prepare']>;
