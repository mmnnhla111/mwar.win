/**
 * Sticky referral attribution. The last VALID ?ref= code is kept in four places so that clearing one
 * (or opening the app from the home screen) still credits the right sponsor at Telegram / LINE sign-up:
 *   1. localStorage  mwar_ref_code
 *   2. cookie        mwar_ref (1 year, SameSite=Lax, Secure)
 *   3. IndexedDB     mwar_ref_db / attribution
 *   4. the server    POST /api/referral/touch { device_fp: mwar_device_fp, ref_code }
 * Restore order: URL → cookie → IndexedDB → localStorage → GET /api/referral/resolve.
 * A stored code is only replaced by a DIFFERENT code that the server confirms is valid (not yourself);
 * invalid codes are ignored.
 */
import { checkReferralCode, referralResolve, referralTouch } from './api';

const LS_KEY = 'mwar_ref_code';
const COOKIE = 'mwar_ref';
const FP_KEY = 'mwar_device_fp';
const DB_NAME = 'mwar_ref_db';
const STORE = 'attribution';
const CODE_RE = /^[a-zA-Z0-9_-]{3,64}$/;

const clean = (v: string | null | undefined) => {
  const s = (v || '').trim().slice(0, 64);
  return CODE_RE.test(s) ? s : '';
};

// --- cookie -----------------------------------------------------------------
function readCookie(): string {
  const m = document.cookie.match(/(?:^|;\s*)mwar_ref=([^;]*)/);
  return m ? clean(decodeURIComponent(m[1])) : '';
}
function writeCookie(code: string) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(code)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

// --- IndexedDB --------------------------------------------------------------
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function readIdb(): Promise<string> {
  const db = await idb();
  if (!db) return '';
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get('ref');
      r.onsuccess = () => resolve(clean((r.result as { code?: string } | undefined)?.code));
      r.onerror = () => resolve('');
    } catch {
      resolve('');
    }
  });
}
async function writeIdb(code: string) {
  const db = await idb();
  if (!db) return;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put({ code, at: Date.now() }, 'ref');
  } catch {
    /* ignore */
  }
}

// --- localStorage -------------------------------------------------------------
function readLs(): string {
  try {
    return clean(localStorage.getItem(LS_KEY));
  } catch {
    return '';
  }
}

// --- device fingerprint ---------------------------------------------------
let fpPromise: Promise<string> | null = null;
/** A stable, anonymous hash of this browser (SHA-256 hex): no personal data leaves the device. */
export function getDeviceFp(): Promise<string> {
  if (fpPromise) return fpPromise;
  fpPromise = (async () => {
    try {
      const kept = localStorage.getItem(FP_KEY);
      if (kept && /^[a-f0-9]{64}$/.test(kept)) return kept;
    } catch {
      /* ignore */
    }
    const n = navigator as any;
    let canvasSig = '';
    try {
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = 30;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 60, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('mwar.win ✓', 2, 4);
        canvasSig = c.toDataURL().slice(-64);
      }
    } catch {
      /* ignore */
    }
    const parts = [
      navigator.userAgent,
      navigator.language,
      (navigator.languages || []).join(','),
      n.platform || '',
      n.hardwareConcurrency || '',
      n.deviceMemory || '',
      n.maxTouchPoints || 0,
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      window.devicePixelRatio || 1,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      canvasSig,
    ].join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(FP_KEY, hex);
    } catch {
      /* ignore */
    }
    return hex;
  })();
  return fpPromise;
}

function storeEverywhere(code: string) {
  try {
    localStorage.setItem(LS_KEY, code);
  } catch {
    /* ignore */
  }
  writeCookie(code);
  void writeIdb(code);
}

/** The code currently kept on this device (cookie → IndexedDB → localStorage), no network. */
export async function storedReferral(): Promise<string> {
  return readCookie() || (await readIdb()) || readLs();
}

/**
 * A ?ref= code arrived. Valid + different from the stored one → store it in all four places.
 * Invalid / self-referral → ignored (the stored code stays). Returns the code now in effect.
 */
export async function captureReferral(raw: string | null | undefined): Promise<string> {
  const code = clean(raw);
  const current = await storedReferral();
  if (!code) return current;
  if (current && current.toLowerCase() === code.toLowerCase()) {
    // Same code: refresh the copies that were cleared, nothing else
    storeEverywhere(current);
    return current;
  }
  let canonical = '';
  try {
    const fp = await getDeviceFp();
    const r = await referralTouch(fp, code);
    if (r && (r as any).valid && !(r as any).self) canonical = clean((r as any).username) || code;
  } catch {
    /* fall through to the plain check */
  }
  if (!canonical) {
    try {
      const r = await checkReferralCode(code);
      if (r.valid) canonical = code;
    } catch {
      /* offline: keep the stored code */
    }
  }
  if (!canonical) return current;
  storeEverywhere(canonical);
  return canonical;
}

/** Restore order: URL → cookie → IndexedDB → localStorage → server (by device fingerprint). */
export async function restoreReferral(): Promise<string> {
  const fromUrl = clean(new URLSearchParams(window.location.search).get('ref'));
  if (fromUrl) return captureReferral(fromUrl);
  const local = await storedReferral();
  if (local) {
    storeEverywhere(local);
    return local;
  }
  try {
    const fp = await getDeviceFp();
    const r = await referralResolve(fp);
    const code = clean(r?.refCode);
    if (code) {
      storeEverywhere(code);
      return code;
    }
  } catch {
    /* ignore */
  }
  return '';
}
