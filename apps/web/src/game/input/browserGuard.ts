/**
 * Prevents browser shortcuts from hijacking gameplay keys (e.g. Ctrl = crouch + W = forward
 * closing the tab via Ctrl+W).
 *
 * Browsers never let a normal page cancel Ctrl+W / Ctrl+T / Ctrl+N. The only standards-based way
 * is the Keyboard Lock API (Chrome / Edge / Opera), which works while the page is fullscreen.
 * So while playing on desktop we:
 *   1. enter fullscreen on the game container + request navigator.keyboard.lock() for game keys
 *   2. preventDefault every other Ctrl/Alt/Meta combo the browser allows us to cancel
 *   3. arm a beforeunload confirmation as a safety net (Firefox / Safari, or if fullscreen is exited)
 */

type KeyboardLockApi = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };

const LOCKED_CODES = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyR',
  'KeyF',
  'KeyC',
  'KeyZ',
  'KeyT',
  'KeyN',
  'KeyP',
  'Tab',
  'Space',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'MetaLeft',
  'MetaRight',
];

export function keyboardLockSupported(): boolean {
  return typeof navigator !== 'undefined' && !!(navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard?.lock;
}

export class BrowserGuard {
  private armed = false;
  private keyboardLocked = false;

  constructor(private container: HTMLElement) {}

  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!this.armed) return;
    e.preventDefault();
    // Legacy browsers need returnValue set to show the "Leave site?" prompt.
    e.returnValue = '';
    return '';
  };

  /** Capture-phase keydown filter: blocks cancellable browser shortcuts while in-game. */
  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.armed) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Let copy/paste style shortcuts through only when not in active play.
      e.preventDefault();
    }
    if (k === 'tab' || k === ' ' || k === 'f1' || k === 'f3' || k === 'f5' || k === 'f7' || k === 'backspace') e.preventDefault();
  };

  private onFullscreenChange = () => {
    if (!document.fullscreenElement && this.keyboardLocked) {
      (navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard?.unlock?.();
      this.keyboardLocked = false;
    } else if (document.fullscreenElement && this.armed && !this.keyboardLocked) {
      void this.lockKeys();
    }
  };

  private async lockKeys() {
    const kb = (navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard;
    if (!kb?.lock) return;
    try {
      await kb.lock(LOCKED_CODES);
      this.keyboardLocked = true;
    } catch {
      this.keyboardLocked = false;
    }
  }

  /**
   * Manual fullscreen toggle (the ⛶ button). Fullscreens the whole document so overlays stay
   * visible; on phones it also tries to lock landscape orientation. Never called automatically.
   */
  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return false;
      }
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions);
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation?.lock?.('landscape').catch(() => {});
      if (this.armed) await this.lockKeys();
      return true;
    } catch (err) {
      console.warn('[BrowserGuard] fullscreen toggle failed:', err);
      return !!document.fullscreenElement;
    }
  }

  private onContextMenu = (e: Event) => {
    if (this.armed) e.preventDefault();
  };

  attach() {
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.container.addEventListener('contextmenu', this.onContextMenu);
  }

  detach() {
    this.disarm();
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('keydown', this.onKeyDown, { capture: true } as EventListenerOptions);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.container.removeEventListener('contextmenu', this.onContextMenu);
  }

  /** Call from a user gesture (click) when gameplay starts. */
  async arm(opts: { fullscreen: boolean }) {
    this.armed = true;
    if (!opts.fullscreen) return;
    try {
      if (!document.fullscreenElement && this.container.requestFullscreen) {
        await this.container.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions);
      }
      const kb = (navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard;
      if (kb?.lock) {
        await kb.lock(LOCKED_CODES);
        this.keyboardLocked = true;
      }
    } catch (err) {
      console.warn('[BrowserGuard] fullscreen / keyboard lock unavailable:', err);
    }
  }

  disarm() {
    this.armed = false;
    if (this.keyboardLocked) {
      (navigator as unknown as { keyboard?: KeyboardLockApi }).keyboard?.unlock?.();
      this.keyboardLocked = false;
    }
  }

  get isKeyboardLocked() {
    return this.keyboardLocked;
  }

  get isArmed() {
    return this.armed;
  }

  exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
}
