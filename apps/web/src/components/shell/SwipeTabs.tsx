'use client';

import React, { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { MAIN_TABS, isTabActive } from './nav';

const SWIPE_MIN_DX = 56;
const SWIPE_RATIO = 1.6;
const IGNORE = 'input, textarea, select, [contenteditable="true"], video, audio, [data-no-swipe], [data-carousel], [role="dialog"], [aria-modal="true"]';

/** Does the touch start inside something that scrolls sideways (its own swipe wins)? */
function inHorizontalScroller(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

let pendingDir: 'left' | 'right' | null = null;

/**
 * Mobile (< 768 px): swipe left / right on the page to move between the bottom tabs
 * Home ↔ Games ↔ Market ↔ Wallet ↔ Profile. A swipe counts when |dx| > 56 px and |dx| > 1.6 × |dy|;
 * carousels, inputs, sideways scrollers and open dialogs are ignored. The new tab slides in.
 */
export function SwipeTabs({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/';
  const router = useRouter();
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const [anim, setAnim] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    if (pendingDir) {
      setAnim(pendingDir);
      pendingDir = null;
      const id = setTimeout(() => setAnim(null), 260);
      return () => clearTimeout(id);
    }
  }, [pathname]);

  const index = MAIN_TABS.findIndex((t) => isTabActive(t, pathname));

  const onStart = (e: React.TouchEvent) => {
    start.current = null;
    if (index < 0 || e.touches.length !== 1 || window.innerWidth >= 768) return;
    const target = e.target as Element;
    if (target.closest(IGNORE) || document.querySelector('[aria-modal="true"]') || inHorizontalScroller(target)) return;
    const tch = e.touches[0];
    start.current = { x: tch.clientX, y: tch.clientY, t: Date.now() };
  };

  const onEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || index < 0) return;
    const tch = e.changedTouches[0];
    const dx = tch.clientX - s.x;
    const dy = tch.clientY - s.y;
    if (Math.abs(dx) <= SWIPE_MIN_DX || Math.abs(dx) <= Math.abs(dy) * SWIPE_RATIO || Date.now() - s.t > 800) return;
    // Text being selected is not a swipe
    if (window.getSelection()?.toString()) return;
    const next = dx < 0 ? index + 1 : index - 1;
    if (next < 0 || next >= MAIN_TABS.length) return;
    pendingDir = dx < 0 ? 'left' : 'right';
    router.push(MAIN_TABS[next].href);
  };

  return (
    <div
      onTouchStart={onStart}
      onTouchEnd={onEnd}
      data-swipe-root
      data-swipe-anim={anim || undefined}
      className={anim === 'left' ? 'animate-[slideFromRight_240ms_ease-out]' : anim === 'right' ? 'animate-[slideFromLeft_240ms_ease-out]' : ''}
    >
      {children}
    </div>
  );
}
