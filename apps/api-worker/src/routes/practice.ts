import { Hono } from 'hono';
import type { Env, AuthUserPayload } from '../types';
import { authMiddleware } from '../middleware/auth';

export const practiceRouter = new Hono<{ Bindings: Env; Variables: { user: AuthUserPayload } }>();

// Bot kills no longer recharge EC (0 EC, 0 Micro-USD). EC recharges from ads only:
// POST /api/ads/simulate-view (banner every 20 s, rewarded 15 s / 30 s videos).
practiceRouter.post('/claim-ec', authMiddleware, (c) =>
  c.json({ error: 'Practice kills no longer recharge EC. Watch a rewarded video or keep the banner visible instead.', replacement: '/api/ads/simulate-view' }, 410)
);
