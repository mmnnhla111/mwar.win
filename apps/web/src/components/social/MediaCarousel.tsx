'use client';

import React, { useRef, useState } from 'react';
import type { PostMediaItem } from '@mwar/shared';

/**
 * 1–10 photos / videos: native horizontal scroll-snap (smooth on phones, no JS animation),
 * dots + a "1/10" counter. Marked data-no-swipe so the page-level tab swipe ignores it.
 */
export function MediaCarousel({ items }: { items: (PostMediaItem & { url: string })[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  if (!items.length) return null;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
    if (i !== index) setIndex(i);
  };
  const go = (i: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  const single = items.length === 1;
  return (
    <div className="px-4 pb-3" data-carousel>
      <div className="relative rounded-2xl overflow-hidden border border-stone-100 bg-stone-900/5">
        <div
          ref={ref}
          onScroll={onScroll}
          data-no-swipe
          className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((m, i) => (
            <div
              key={m.id}
              className="relative shrink-0 w-full max-h-[520px] snap-center flex items-center justify-center bg-stone-100"
              // Reserve the box from the known size: no layout jump while the file loads
              style={{ aspectRatio: m.width && m.height ? `${m.width} / ${m.height}` : '4 / 3' }}
            >
              {m.type === 'video' ? (
                <video src={m.url} controls playsInline preload="metadata" className="w-full h-full bg-stone-900" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt="" loading={i === 0 ? 'eager' : 'lazy'} decoding="async" className="w-full h-full object-cover" />
              )}
            </div>
          ))}
        </div>
        {!single && (
          <>
            <span className="absolute top-2 right-2 rounded-full bg-black/55 text-white text-[11px] font-bold px-2 py-0.5 tabular-nums" data-carousel-counter>
              {index + 1}/{items.length}
            </span>
            {index > 0 && (
              <button
                onClick={() => go(index - 1)}
                aria-label="Previous"
                className="hidden sm:flex absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 shadow items-center justify-center text-stone-700 font-black"
              >
                ‹
              </button>
            )}
            {index < items.length - 1 && (
              <button
                onClick={() => go(index + 1)}
                aria-label="Next"
                className="hidden sm:flex absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/90 shadow items-center justify-center text-stone-700 font-black"
              >
                ›
              </button>
            )}
          </>
        )}
      </div>
      {!single && (
        <div className="mt-2 flex justify-center gap-1.5" aria-hidden>
          {items.map((m, i) => (
            <button key={m.id} onClick={() => go(i)} tabIndex={-1} className={`h-1.5 rounded-full transition-all ${i === index ? 'w-4 bg-[#FACC15]' : 'w-1.5 bg-stone-300'}`} />
          ))}
        </div>
      )}
    </div>
  );
}
