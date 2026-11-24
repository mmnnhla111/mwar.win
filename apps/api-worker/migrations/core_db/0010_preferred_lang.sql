-- i18n: the account's UI language (en default; th, id, vi, es active; zh, ko, ja, hi, pt reserved).
-- Read by GET /api/bootstrap (no extra request), written by PATCH /api/social/settings.
ALTER TABLE users ADD COLUMN preferred_lang TEXT NOT NULL DEFAULT 'en';
