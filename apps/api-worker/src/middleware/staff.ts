import type { Context, Next } from 'hono';
import { STAFF_PERMISSIONS, normalizeStaffRole } from '@mwar/shared';
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

const CACHE = new WeakMap<Request, StaffRole>();

/**
 * The caller's staff role, read from D1 on every staff request (one primary-key read), so a role
 * change works at once — no new login needed, unlike the JWT `role` claim.
 */
export async function getStaffRole(c: Ctx): Promise<StaffRole> {
  const hit = CACHE.get(c.req.raw);
  if (hit) return hit;
  const me = c.get('user');
  if (!me) return 'user';
  const row = await c.env.DB
    .prepare('SELECT username, status, staff_role FROM users WHERE id = ?1')
    .bind(me.userId)
    .first<{ username: string; status: string; staff_role: string | null }>()
    .catch(() => null);
  let role: StaffRole = 'user';
  if (row && row.status === 'active') {
    role = isEnvSuperAdmin(c.env, row.username) ? 'super_admin' : normalizeStaffRole(row.staff_role);
  }
  CACHE.set(c.req.raw, role);
  return role;
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
    const role = await getStaffRole(c);
    if (!roles.includes(role)) {
      return c.json({ error: 'Forbidden: your staff role does not allow this', code: 'STAFF_ROLE', staffRole: role }, 403);
    }
    return next();
  };
}

/** Inline check for handlers that branch on permissions. */
export async function staffHas(c: Ctx, perm: StaffPermission): Promise<boolean> {
  return (STAFF_PERMISSIONS[perm] as readonly string[]).includes(await getStaffRole(c));
}
