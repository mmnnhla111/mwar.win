/**
 * Layer-1 media compression loader. The library lives at /vendor/media-compress/media-compress.js and is
 * loaded only where people attach media (home feed composer, profile, chat).
 *
 * Self-heal: when the API gate (Layer 2) rejects an upload, `markMediaLibStale()` sets
 * localStorage mwar_reload_media_lib=1; the next load fetches the file again with ?v=<timestamp>
 * (bypassing any stale cached copy) and clears the flag.
 */
export type CompressedMedia = { blob: Blob; width: number; height: number; type: string; durationSec?: number; transcoded?: boolean };

type Lib = {
  version: number;
  compressImage: (f: File | Blob, opts?: { maxEdge?: number; maxBytes?: number; maxWidth?: number; maxHeight?: number; crop?: 'cover'; forceWebp?: boolean }) => Promise<CompressedMedia>;
  compressVideo: (f: File, opts?: { onProgress?: (p: number) => void }) => Promise<CompressedMedia>;
};

const LIB_VERSION = '1';
const RELOAD_KEY = 'mwar_reload_media_lib';
let loading: Promise<Lib> | null = null;

export function markMediaLibStale() {
  try {
    localStorage.setItem(RELOAD_KEY, '1');
  } catch {
    /* private mode */
  }
  loading = null;
  delete (window as any).MwarMediaCompress;
}

export function loadMediaCompress(): Promise<Lib> {
  if (typeof window === 'undefined') return Promise.reject(new Error('client only'));
  const existing = (window as any).MwarMediaCompress as Lib | undefined;
  let stale = false;
  try {
    stale = localStorage.getItem(RELOAD_KEY) === '1';
  } catch {
    /* ignore */
  }
  if (existing && !stale) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise<Lib>((resolve, reject) => {
    document.querySelectorAll('script[data-mwar-media-compress]').forEach((el) => el.remove());
    const s = document.createElement('script');
    s.src = `/vendor/media-compress/media-compress.js?v=${stale ? Date.now() : LIB_VERSION}`;
    s.async = true;
    s.dataset.mwarMediaCompress = '1';
    s.onload = () => {
      const lib = (window as any).MwarMediaCompress as Lib | undefined;
      if (!lib) {
        loading = null;
        reject(new Error('media library unavailable'));
        return;
      }
      try {
        localStorage.removeItem(RELOAD_KEY);
      } catch {
        /* ignore */
      }
      resolve(lib);
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('media library unavailable'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Warm the library in the background (call on mount of pages with a composer). */
export function preloadMediaCompress() {
  if (typeof window === 'undefined') return;
  const go = () => loadMediaCompress().catch(() => {});
  if ('requestIdleCallback' in window) (window as any).requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 1500);
}
