'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Sign-up happens through Telegram / LINE on /login. Old invite links (/register?ref=…) keep working. */
export default function RegisterRedirect() {
  const router = useRouter();
  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    router.replace(ref ? `/login?ref=${encodeURIComponent(ref)}` : '/login');
  }, [router]);
  return null;
}
