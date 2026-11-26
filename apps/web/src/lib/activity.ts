/**
 * Global, throttled record of the player's last REAL input (mouse, touch, pointer, key, scroll).
 * Banner impression pings send it as `lastActiveAt` so the API can refuse AFK charging (> 40 s idle).
 * Listeners are passive + capture on window, so game handlers that stop propagation still count.
 */
const EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'pointermove', 'pointerdown', 'scroll', 'wheel'] as const;
const THROTTLE_MS = 500;

let lastActiveAt = typeof Date !== 'undefined' ? Date.now() : 0;
let installed = false;
const listeners = new Set<(t: number) => void>();

function onInput(e: Event) {
  // Synthetic events (element.dispatchEvent from scripts) are not user input
  if (!e.isTrusted) return;
  const now = Date.now();
  if (now - lastActiveAt < THROTTLE_MS) return;
  lastActiveAt = now;
  listeners.forEach((f) => f(now));
}

export function ensureActivityTracking() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  lastActiveAt = Date.now();
  for (const ev of EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
}

export function getLastActiveAt(): number {
  ensureActivityTracking();
  return lastActiveAt;
}

/** A deliberate "I'm here" (e.g. the Resume Charging button). */
export function markActive() {
  lastActiveAt = Date.now();
  listeners.forEach((f) => f(lastActiveAt));
}

export function onActivity(fn: (t: number) => void): () => void {
  ensureActivityTracking();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fields every banner impression request carries (same clock for both, so skew doesn't matter). */
export function activityPayload() {
  return { lastActiveAt: getLastActiveAt(), clientNow: Date.now() };
}
