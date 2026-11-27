import type { Context, Next } from 'hono';
import { STAFF_PERMISSIONS, normalizeStaffRoles, primaryStaffRole } from '@mwar/shared';
import type { StaffPermission, StaffRole } from '@mwar/shared';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from './auth';
import { isLocalDev } from '../utils/guards';

type Ctx = Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>;

/** Usernames in SUPER_ADMIN_USERNAMES (comma separated) are always super_admin: the owner is never locked out. */
export function isEnvSuperAdmin(env: Env, username: string | null | undefined): boolean {
  if (!username) return false;
  const list = (env.SUPER_ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(username.toLowerCase());
}

const CACHE = new WeakMap<Request, StaffRole[]>();

/**
 * The caller's staff roles (V1.1 multi-role), read from D1 on every staff request, so a role change works at
 * once — no new login needed, unlike the JWT `role` claim. Union of: super_admin (SUPER_ADMIN_USERNAMES or
 * users.staff_role), every user_staff_roles row, and the legacy users.staff_role value. Empty = regular player.
 */
export async function getStaffRoles(c: Ctx): Promise<StaffRole[]> {
  const hit = CACHE.get(c.req.raw);
  if (hit) return hit;
  const me = c.get('user');
  if (!me) return [];
  const [u, rows] = await c.env.DB
    .batch([
      c.env.DB.prepare('SELECT username, status, staff_role FROM users WHERE id = ?1').bind(me.userId),
      c.env.DB.prepare('SELECT role_key FROM user_staff_roles WHERE user_id = ?1').bind(me.userId),
    ])
    .catch(() => [null, null] as any);
  const row = u?.results?.[0] as { username: string; status: string; staff_role: string | null } | undefined;
  let roles: StaffRole[] = [];
  if (row && row.status === 'active') {
    const keys: string[] = (rows?.results || []).map((r: any) => String(r.role_key));
    if (row.staff_role) keys.push(row.staff_role);
    if (isEnvSuperAdmin(c.env, row.username)) keys.push('super_admin');
    roles = normalizeStaffRoles(keys);
  }
  CACHE.set(c.req.raw, roles);
  return roles;
}

/** The most senior role ('user' for a regular player); kept for call sites that only need a label. */
export async function getStaffRole(c: Ctx): Promise<StaffRole> {
  return primaryStaffRole(await getStaffRoles(c));
}

/**
 * Route guard: `requireStaff('games')` (a permission from STAFF_PERMISSIONS) or an explicit role list.
 * Runs authMiddleware itself when the router did not. Local `wrangler dev` with no token stays open for
 * the Dev Mock Panel, exactly like the old admin/auditor checks.
 */
export function requireStaff(allowed: StaffPermission | readonly StaffRole[]) {
  const roles: readonly StaffRole[] = typeof allowed === 'string' ? STAFF_PERMISSIONS[allowed] : allowed;
  return async (c: Ctx, next: Next) => {
    if (!c.get('user')) {
      if (isLocalDev(c) && !c.req.header('Authorization')) return next();
      const denied = await authMiddleware(c, async () => {});
      if (denied) return denied;
    }
    const mine = await getStaffRoles(c);
    if (!mine.some((r) => roles.includes(r))) {
      return c.json({ error: 'Forbidden: your staff role does not allow this', code: 'STAFF_ROLE', staffRole: primaryStaffRole(mine) }, 403);
    }
    return next();
  };
}

/** Inline check for handlers that branch on permissions. */
export async function staffHas(c: Ctx, perm: StaffPermission): Promise<boolean> {
  const allowed = STAFF_PERMISSIONS[perm] as readonly string[];
  return (await getStaffRoles(c)).some((r) => allowed.includes(r));
}
