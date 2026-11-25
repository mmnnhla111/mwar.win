'use client';

import { OAuthCallback } from '../../../../components/auth/OAuthCallback';

/** oauth.telegram.org returns here with #tgAuthResult=… (static export: no dynamic route segments). */
export default function TelegramCallbackPage() {
  return <OAuthCallback provider="telegram" />;
}
