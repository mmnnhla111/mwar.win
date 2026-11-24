'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Daily quests now live in the floating quest button; old links land on the feed. */
export default function QuestsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/');
  }, [router]);
  return null;
}
