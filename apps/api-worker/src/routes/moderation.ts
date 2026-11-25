import { Hono } from 'hono';
import { ModerationResultSchema, VIDEO_ARCHIVE_480P_AFTER_DAYS, MEDIA_VIDEO_HARD_BYTES, extractHashtags } from '@mwar/shared';
import type { Env } from '../types';
import { hasInternalSecret } from '../utils/guards';
import { MEDIA_KEY_RE, deleteMediaKeys, purgeFeedHeads, purgeMediaCache, mp4Info } from '../utils/social-media';
import { sortableId } from './social';

/**
 * Batch moderation queue for the self-hosted Ubuntu moderation workers (apps/moderation-worker).
 * Every route needs `X-Internal-Secret: <INTERNAL_API_SECRET>`.
 *
 *  POST /api/moderation/claim    { node_name, batch_size? }  -> up to 15 (max 20) jobs locked for 300 s
 *                                scan jobs first, then transcode_480p jobs (archive old approved videos)
 *  GET  /api/moderation/media?key=social/...                  -> raw media bytes for one claimed job
 *  POST /api/moderation/results  { node_name, results: [...] } -> one D1 batch per call (scan jobs)
 *  POST /api/moderation/transcoded/:jobId (raw MP4 body)      -> replaces the R2 object with the 480p copy
 *       ?skip=1 (no body)                                      -> worker could not transcode: job closed
 *
 * One scan job per media item. A post is rejected as soon as ANY item is prohibited (all its media is
 * deleted from R2 and the author gets ONE post_rejected notification); it becomes visible to others
 * (approved / 18+) when no item is pending any more. Claiming is a single UPDATE ... RETURNING, so
 * 1..N workers can poll the same queue without ever processing a job twice.
 */
export const moderationRouter = new Hono<{ Bindings: Env }>();

const LOCK_SECONDS = 300;
const TRANSCODE_LOCK_SECONDS = 1800;
const MAX_ATTEMPTS = 5;
const DEFAULT_BATCH = 15;
const MAX_BATCH = 20;
const REJECT_REASON = 'Weapons / blood / violence are not allowed';

moderationRouter.use('*', async (c, next) => {
  if (!hasInternalSecret(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

moderationRouter.post('/claim', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const nodeName = String(body?.node_name || 'moderator').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'moderator';
  const batch = Math.max(1, Math.min(MAX_BATCH, Math.floor(Number(body?.batch_size ?? DEFAULT_BATCH)) || DEFAULT_BATCH));
  const allowTranscode = body?.transcode !== false;
  const now = Math.floor(Date.now() / 1000);

  const [, claimed] = await c.env.DB.batch([
    // Jobs that keep crashing a worker are parked as failed (the item stays pending: visible to its author only)
    c.env.DB.prepare(
      `UPDATE moderation_jobs SET status = 'failed', updated_at = ?1
       WHERE status = 'processing' AND locked_until < ?1 AND attempts >= ?2`
    ).bind(now, MAX_ATTEMPTS),
    c.env.DB.prepare(
      `UPDATE moderation_jobs
         SET status = 'processing', worker_node_id = ?1,
             locked_until = ?3 + CASE WHEN job_type = 'transcode_480p' THEN ?6 ELSE ?2 END,
             attempts = attempts + 1, updated_at = ?3
       WHERE id IN (
         SELECT id FROM moderation_jobs
         WHERE ((status = 'pending') OR (status = 'processing' AND locked_until < ?3 AND attempts < ?4))
           AND (?7 = 1 OR job_type = 'scan')
         ORDER BY CASE job_type WHEN 'scan' THEN 0 ELSE 1 END, created_at ASC LIMIT ?5
       )
       RETURNING id, post_id, media_id, media_key, media_type, job_type, attempts`
    ).bind(nodeName, LOCK_SECONDS, now, MAX_ATTEMPTS, batch, TRANSCODE_LOCK_SECONDS, allowTranscode ? 1 : 0),
  ]);
  const origin = new URL(c.req.url).origin;
  const jobs = ((claimed.results || []) as any[]).map((j) => ({
    job_id: j.id,
    job_type: j.job_type || 'scan',
    post_id: j.post_id,
    media_id: j.media_id,
    media_key: j.media_key,
    media_type: j.media_type,
    attempts: j.attempts,
    download_url: `${origin}/api/moderation/media?key=${encodeURIComponent(j.media_key)}`,
    ...(j.job_type === 'transcode_480p' ? { upload_url: `${origin}/api/moderation/transcoded/${j.id}`, target_height: 480, crf: 28 } : {}),
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

  // Only scan jobs that are still being processed count (a late duplicate result is ignored)
  const ids = results.map((r) => r.job_id);
  const ph = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results: jobRows } = await db
    .prepare(
      `SELECT j.id, j.post_id, j.media_id, j.media_key, p.author_id, p.tag, p.body, p.visibility
       FROM moderation_jobs j LEFT JOIN social_posts p ON p.id = j.post_id
       WHERE j.id IN (${ph}) AND j.status = 'processing' AND j.job_type = 'scan'`
    )
    .bind(...ids)
    .all<any>();
  const jobs = new Map((jobRows || []).map((j: any) => [j.id, j]));

  const stmts: D1PreparedStatement[] = [];
  const posts = new Map<string, { authorId: string; tag: string; body: string; reason: string | null; score: number; rejected: boolean }>();
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
    const status = r.action === 'reject_prohibited' ? 'rejected' : r.action === 'mark_nsfw_18' ? 'nsfw_18' : 'approved';
    stmts.push(
      db.prepare(
        `UPDATE social_post_media SET moderation_status = ?1, nsfw_score = ?2,
           content_rating = CASE WHEN ?1 = 'nsfw_18' THEN 'nsfw_18' ELSE content_rating END
         WHERE id = ?3 AND moderation_status = 'pending'`
      ).bind(status, r.score, job.media_id || `m${job.post_id}`)
    );
    const p = posts.get(job.post_id) || { authorId: job.author_id, tag: job.tag, body: job.body || '', reason: null, score: 0, rejected: false };
    p.score = Math.max(p.score, r.score);
    if (status === 'rejected') {
      p.rejected = true;
      p.reason = p.reason || reason || REJECT_REASON;
    }
    posts.set(job.post_id, p);
  }

  // Post aggregate (runs after the item updates in the same batch)
  for (const [postId, p] of posts) {
    if (p.rejected) {
      stmts.push(
        db.prepare(
          `UPDATE social_posts SET moderation_status = 'rejected', moderation_reason = ?1, nsfw_score = ?2, media_key = NULL
           WHERE id = ?3 AND moderation_status = 'pending'`
        ).bind(p.reason, p.score, postId),
        // Exactly one notice per rejected post (guarded by the UPDATE above)
        db.prepare(
          `INSERT INTO notifications (id, user_id, actor_id, type, target_id, message_key, payload_json, created_at)
           SELECT ?1, ?2, NULL, 'post_rejected', ?3, 'notif.postRejected', ?4, ?5 WHERE changes() = 1`
        ).bind(sortableId('n'), p.authorId, postId, JSON.stringify({ reason: p.reason }), now),
        db.prepare("UPDATE social_post_media SET moderation_status = 'rejected' WHERE post_id = ?1").bind(postId),
        // Remaining scans of a rejected post are pointless
        db.prepare("UPDATE moderation_jobs SET status = 'done', result_action = 'post_rejected', updated_at = ?2 WHERE post_id = ?1 AND status IN ('pending', 'processing')").bind(
          postId,
          now
        )
      );
    } else {
      stmts.push(
        db.prepare(
          `UPDATE social_posts SET
             moderation_status = CASE WHEN author_marked_nsfw = 1 OR EXISTS (SELECT 1 FROM social_post_media m WHERE m.post_id = ?1 AND m.moderation_status = 'nsfw_18') THEN 'nsfw_18' ELSE 'approved' END,
             content_rating = CASE WHEN author_marked_nsfw = 1 OR EXISTS (SELECT 1 FROM social_post_media m WHERE m.post_id = ?1 AND m.moderation_status = 'nsfw_18') THEN 'nsfw_18' ELSE 'safe' END,
             nsfw_score = MAX(nsfw_score, ?2)
           WHERE id = ?1 AND moderation_status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM social_post_media m WHERE m.post_id = ?1 AND m.moderation_status IN ('pending', 'rejected'))`
        ).bind(postId, p.score)
      );
    }
  }
  if (stmts.length) await db.batch(stmts);

  // Rejected posts: every file of the post is deleted from R2 right away (0 bytes kept)
  const origin = new URL(c.req.url).origin;
  await Promise.all(
    [...posts].map(async ([postId, p]) => {
      if (p.rejected) {
        const { results: media } = await db.prepare('SELECT media_key FROM social_post_media WHERE post_id = ?1').bind(postId).all<{ media_key: string }>();
        const keys = (media || []).map((m) => m.media_key);
        await deleteMediaKeys(c.env, keys);
        await Promise.all(keys.map((k) => purgeMediaCache(c, origin, k)));
      }
      await purgeFeedHeads(c, p.authorId, p.tag || undefined, extractHashtags(p.body));
    })
  );
  return c.json({ success: true, applied, ignored: results.length - applied });
});

/**
 * POST /api/moderation/transcoded/:jobId — body: the 480p MP4 (ffmpeg scale=-2:480 -crf 28).
 * The object is replaced under the same R2 key (URLs stay valid) and the item becomes 'sd_480'.
 */
moderationRouter.post('/transcoded/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const now = Math.floor(Date.now() / 1000);
  const job = await c.env.DB
    .prepare("SELECT id, media_id, media_key FROM moderation_jobs WHERE id = ?1 AND job_type = 'transcode_480p' AND status = 'processing'")
    .bind(jobId)
    .first<{ id: string; media_id: string; media_key: string }>();
  if (!job) return c.json({ error: 'Unknown or finished job' }, 404);
  const close = (action: string) =>
    c.env.DB.prepare("UPDATE moderation_jobs SET status = 'done', result_action = ?1, updated_at = ?2 WHERE id = ?3").bind(action, now, job.id).run();
  if (c.req.query('skip') === '1') {
    // Mark the item so the nightly sweep does not queue it again
    await c.env.DB.prepare("UPDATE social_post_media SET video_tier = 'sd_480' WHERE id = ?1").bind(job.media_id).run();
    await close('transcode_skipped');
    return c.json({ success: true, skipped: true });
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  const info = mp4Info(buf);
  if (!buf.byteLength || buf.byteLength > MEDIA_VIDEO_HARD_BYTES || !info.height || Math.min(info.width || 0, info.height) > 480) {
    return c.json({ error: 'Not a valid 480p MP4' }, 422);
  }
  const exists = await c.env.DB.prepare('SELECT id FROM social_post_media WHERE id = ?1').bind(job.media_id).first();
  if (!exists) {
    await close('media_gone');
    return c.json({ success: true, gone: true });
  }
  await c.env.MEDIA_BUCKET.put(job.media_key, buf, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' } });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE social_post_media SET video_tier = 'sd_480', width = ?1, height = ?2 WHERE id = ?3").bind(info.width, info.height, job.media_id),
    c.env.DB.prepare("UPDATE moderation_jobs SET status = 'done', result_action = 'transcoded_480p', updated_at = ?1 WHERE id = ?2").bind(now, job.id),
  ]);
  return c.json({ success: true, bytes: buf.byteLength, width: info.width, height: info.height });
});

/**
 * Nightly cron: prune finished jobs, expired reset tokens, rejected posts and abandoned staged
 * uploads (D1 + R2 stay small), then queue 480p archive jobs for approved videos older than 30 days.
 */
export async function pruneModerationData(env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const week = now - 7 * 86_400;
  const [rejectedRes, stagedRes] = await env.DB.batch([
    env.DB.prepare(`SELECT id, author_id FROM social_posts WHERE moderation_status = 'rejected' AND created_at < ?1 LIMIT 200`).bind(week),
    env.DB.prepare('SELECT id, media_key FROM social_media_uploads WHERE created_at < ?1 LIMIT 500').bind(now - 6 * 3600),
  ]);
  const oldRejected = (rejectedRes.results || []) as { id: string; author_id: string }[];
  const staged = (stagedRes.results || []) as { id: string; media_key: string }[];
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM moderation_jobs WHERE status IN ('done', 'failed') AND updated_at < ?1").bind(week),
    env.DB.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(now - 86_400),
    env.DB.prepare(
      "DELETE FROM content_reports WHERE status != 'pending' AND resolved_at < ?1 AND NOT EXISTS (SELECT 1 FROM social_posts p WHERE p.id = content_reports.post_id)"
    ).bind(now - 30 * 86_400),
    // Read notifications older than 90 days
    env.DB.prepare('DELETE FROM notifications WHERE is_read = 1 AND created_at < ?1').bind(now - 90 * 86_400),
  ];
  const rejectedKeys: string[] = [];
  for (const p of oldRejected) {
    const { results: m } = await env.DB.prepare('SELECT media_key FROM social_post_media WHERE post_id = ?1').bind(p.id).all<{ media_key: string }>();
    rejectedKeys.push(...(m || []).map((x) => x.media_key));
    stmts.push(
      env.DB.prepare('DELETE FROM social_post_likes WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_post_comments WHERE post_id = ?1').bind(p.id),
      env.DB.prepare("DELETE FROM notifications WHERE target_id = ?1 AND type <> 'post_rejected'").bind(p.id),
      env.DB.prepare('DELETE FROM moderation_jobs WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_post_media WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_post_hashtags WHERE post_id = ?1').bind(p.id),
      env.DB.prepare('DELETE FROM social_posts WHERE id = ?1').bind(p.id),
      env.DB.prepare('UPDATE users SET posts_count = MAX(0, posts_count - 1) WHERE id = ?1').bind(p.author_id)
    );
  }
  if (staged.length) stmts.push(env.DB.prepare(`DELETE FROM social_media_uploads WHERE id IN (${staged.map((_, i) => `?${i + 1}`).join(',')})`).bind(...staged.map((s) => s.id)));
  // 480p archive: approved / 18+ HD videos older than 30 days with no open transcode job (50 per night)
  stmts.push(
    env.DB.prepare(
      `INSERT INTO moderation_jobs (id, post_id, media_id, media_key, media_type, job_type, status, created_at, updated_at)
       SELECT 'jt' || m.id || ?1, m.post_id, m.id, m.media_key, 'video', 'transcode_480p', 'pending', ?1, ?1
       FROM social_post_media m
       WHERE m.media_type = 'video' AND m.video_tier = 'hd_sub720' AND m.moderation_status IN ('approved', 'nsfw_18') AND m.created_at < ?2
         AND NOT EXISTS (SELECT 1 FROM moderation_jobs j WHERE j.media_id = m.id AND j.job_type = 'transcode_480p' AND j.status IN ('pending', 'processing'))
       LIMIT 50`
    ).bind(now, now - VIDEO_ARCHIVE_480P_AFTER_DAYS * 86_400)
  );
  await env.DB.batch(stmts);
  await deleteMediaKeys(env, [...rejectedKeys, ...staged.map((s) => s.media_key)]);
  return { prunedRejectedPosts: oldRejected.length, prunedStagedUploads: staged.length };
}

type D1PreparedStatement = ReturnType<Env['DB']['prepare']>;
