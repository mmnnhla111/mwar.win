-- 0018: Anti-AFK banner gate. Server time (unix s) of the user's last ACCEPTED banner impression
-- request, claimed atomically (UPDATE … WHERE gap >= 18 s × count) so parallel or scripted pings
-- cannot be credited faster than one banner per 18 s.
ALTER TABLE users ADD COLUMN last_banner_at INTEGER;
