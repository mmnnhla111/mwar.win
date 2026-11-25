'use client';

import { OAuthCallback } from '../../../../components/auth/OAuthCallback';

/** LINE Login returns here with ?code=…&state=… (static export: no dynamic route segments). */
export default function LineCallbackPage() {
  return <OAuthCallback provider="line" />;
}
