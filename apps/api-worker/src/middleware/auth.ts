import type { Context, Next } from 'hono';
import { verifyJwt } from '../utils/crypto';
import type { Env, AuthUserPayload } from '../types';

export async function authMiddleware(c: Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    // Check cookie fallback
    const cookieHeader = c.req.header('Cookie');
    if (cookieHeader) {
      const match = cookieHeader.match(/auth_token=([^;]+)/);
      if (match) token = match[1];
    }
  }

  if (!token) {
    return c.json({ error: 'Unauthorized: missing authentication token' }, 401);
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: 'Unauthorized: invalid or expired token' }, 401);
  }

  c.set('user', payload);
  await next();
}

export function requireRole(allowedRoles: Array<'player' | 'admin' | 'auditor'>) {
  return async (c: Context<{ Bindings: Env; Variables: { user: AuthUserPayload } }>, next: Next) => {
    const user = c.get('user');
    if (!user || !allowedRoles.includes(user.role)) {
      return c.json({ error: 'Forbidden: insufficient role privileges' }, 403);
    }
    await next();
  };
}
