import type { D1Database } from '@cloudflare/workers-types';
import type { MlmUpline } from '@mwar/shared';

/**
 * Inserts the 5-level MLM hierarchy closure relations into network_trees.
 */
export async function buildNetworkTree(
  db: D1Database,
  newUserId: string,
  referrerId: string | null
): Promise<void> {
  if (!referrerId) return;

  // 1. Verify referrer exists
  const referrer = await db
    .prepare('SELECT id FROM users WHERE id = ?1')
    .bind(referrerId)
    .first<{ id: string }>();

  if (!referrer) return;

  // 2. Insert Direct Upline (Level 1)
  const statements: ReturnType<typeof db.prepare>[] = [
    db
      .prepare('INSERT OR IGNORE INTO network_trees (ancestor_id, descendant_id, depth) VALUES (?1, ?2, 1)')
      .bind(referrerId, newUserId),
  ];

  // 3. Find uplines of referrer up to depth 4, who become depth 2..5 of new user
  const ancestors = await db
    .prepare('SELECT ancestor_id, depth FROM network_trees WHERE descendant_id = ?1 AND depth < 5 ORDER BY depth ASC')
    .bind(referrerId)
    .all<{ ancestor_id: string; depth: number }>();

  if (ancestors.results && ancestors.results.length > 0) {
    for (const row of ancestors.results) {
      statements.push(
        db
          .prepare('INSERT OR IGNORE INTO network_trees (ancestor_id, descendant_id, depth) VALUES (?1, ?2, ?3)')
          .bind(row.ancestor_id, newUserId, row.depth + 1)
      );
    }
  }

  // Atomic batch execute in D1
  await db.batch(statements);
}

/**
 * Retrieves the 5-level ancestors for a given user, ordered from Level 1 (Direct) to Level 5.
 */
export async function getUplines(db: D1Database, userId: string): Promise<MlmUpline[]> {
  const result = await db
    .prepare('SELECT ancestor_id, depth FROM network_trees WHERE descendant_id = ?1 AND depth <= 5 ORDER BY depth ASC')
    .bind(userId)
    .all<{ ancestor_id: string; depth: number }>();

  if (!result.results) return [];

  return result.results.map((r) => ({
    userId: r.ancestor_id,
    depth: r.depth as 1 | 2 | 3 | 4 | 5,
  }));
}
