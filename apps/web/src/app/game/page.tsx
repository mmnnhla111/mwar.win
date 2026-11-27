'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Client as ColyseusClient, Room } from 'colyseus.js';
import { apiFetch, progressQuest } from '../../lib/api';
import { formatCoins2, formatCoinsAndUsd, formatUsdPrecise } from '@mwar/shared';
import { useTranslation } from '../../i18n/I18nProvider';
import { QuestSpectateIcon } from '../../components/icons';
import { soundFX } from '../../game/audio';
import { CollisionWorld, MoveBody } from '../../game/physics/collision';
import { MAP2D, type WindowSpot } from '../../game/assets/map2d';
import { MaterialLibrary } from '../../game/assets/materials';
import { buildArena } from '../../game/assets/mapLayout';
import { PLAY_HALF } from '../../game/assets/skyAndTerrain';
import { buildLargeArena } from '../../game/maps/largeMap';
import { LARGE_PLAY_HALF, LARGE_TERRAIN_BOUNDS, largeMapTerrainHeight, mapKindForMode, MAX_ENERGY_TICKETS, INITIAL_ENERGY_TICKETS } from '@mwar/shared';
import { animateBountyChest, createBountyChest } from '../../game/assets/props';
import { Viewmodel } from '../../game/viewmodel';
import { CombatEffects } from '../../game/effects';
import { BotManager } from '../../game/ai/bots';
import { animateMedkit, createMedkitModel, MEDKIT_CAST_SECONDS, MEDKIT_DROP_CHANCE, MEDKIT_TTL_MS, rollMedkitHeal } from '../../game/assets/medkit';
import {
  animateCharacter,
  CharacterId,
  CharacterRig,
  characterArmColors,
  CHARACTER_IDS,
  createCharacter,
  randomCharacterId,
  renderCharacterPortraits,
} from '../../game/assets/characters';
import { createPropModel, propDef, PropId, PROPS } from '../../game/assets/disguiseProps';
import {
  animateWorldWeapon,
  buildGrenadeModel,
  createWorldWeapon,
  disposeObject,
  falloff,
  GRENADE,
  PRIMARY_IDS,
  PrimaryId,
  WeaponId,
  WEAPONS,
  WorldWeapon,
} from '../../game/weapons';
import { BrowserGuard, keyboardLockSupported } from '../../game/input/browserGuard';
import RadialPropMenu, { propIndexAt, RADIAL } from '../../game/ui/RadialPropMenu';
import LoadoutScreen from '../../game/ui/LoadoutScreen';
import { useAdConfig } from '../../lib/ads';
import { AdsterraBanner } from '../../components/ad-networks/AdsterraBanner';
import { ChargePausedModal } from '../../components/ad-networks/ChargePausedModal';
import { useIdleChargeGuard } from '../../hooks/useIdleChargeGuard';
import { DirectLinkAdModal } from '../../components/ad-networks/DirectLinkVisit';
import { flushBannerImpressions, RechargeVideoButtons, RewardedVideoModal, SimulatedAdBanner, usePendingBanners, type AdEcResult } from '../../game/ui/AdEngine';
import { BLIP_LIFETIME_MS, drawMinimap, RadarBlip } from '../../game/ui/minimap';
import {
  BulletIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CrateIcon,
  CrouchIcon,
  DropIcon,
  EnterFullscreenIcon,
  ExitFullscreenIcon,
  GrenadeIcon,
  JumpIcon,
  VaultIcon,
  ProneIcon,
  ReloadIcon,
  ScopeIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
} from '../../game/ui/HudIcons';

// ----------------------------------------------------------------------------
// Tuning constants
// ----------------------------------------------------------------------------
const STAND_EYE = 1.7;
const CROUCH_EYE = 1.05;
const PRONE_EYE = 0.4;
/** Collision capsule height per stance (prone can crawl under ~0.65 m cover). */
const STANCE_HEIGHT = { stand: 1.78, crouch: 1.2, prone: 0.6 } as const;
const STANCE_SPEED = { stand: 6.2, crouch: 2.8, prone: 1.15 } as const;
type Stance = keyof typeof STANCE_HEIGHT;
/** World-axis footprint (w along x, d along z) of a w×d box rotated by yaw. */
const rotatedExtent = (w: number, d: number, yaw: number): [number, number] => {
  const c = Math.abs(Math.cos(yaw));
  const sn = Math.abs(Math.sin(yaw));
  return [w * c + d * sn, w * sn + d * c];
};
const TOAST_MS = 10_000;
const LEAN_DISTANCE = 0.65; // metres sideways along the camera's horizontal right vector
const LEAN_ROLL = THREE.MathUtils.degToRad(12);
const LEAN_WALL_MARGIN = 0.28;
const HIP_FOV = 75;
// Narrow aim-assist: only when genuinely aiming at a visible enemy — acquire inside ~2.2°,
// break away beyond ~4.5°, max 65 m hip-fire / 130 m aiming down sights, strict line of sight
// (walls, terrain and foliage block it). The same lock drives the green ● / red ( ● ) reticle.
const AIM_ASSIST_ACQUIRE = THREE.MathUtils.degToRad(1.8);
const AIM_ASSIST_BREAK = THREE.MathUtils.degToRad(3.5);
/** The crosshair must rest on the target this long before it locks (a mouse / thumb sweep never locks). */
const AIM_ASSIST_DWELL = 0.15;
const AIM_ASSIST_HIP_RANGE = 65;
const AIM_ASSIST_ADS_RANGE = 130;
// PC (mouse): slightly tighter than touch — the crosshair must be on the target (≈1.5°), lock drops past ≈3°
const AIM_ASSIST_ACQUIRE_PC = THREE.MathUtils.degToRad(1.5);
const AIM_ASSIST_BREAK_PC = THREE.MathUtils.degToRad(3);
// v2: aim-assist is now on by default on PC too (very narrow, soft, never a hard lock)
const RESPAWN_SECONDS = 3;
const LOADOUT_STORAGE_KEY = 'mwar_fps_loadout_v2';
const FALL_SAFE_SPEED = 13; // m/s landing speed before fall damage (~3.8 m drop)
const BOT_COUNT = 20; // free-for-all solo bots
const BOT_ACCURACY = 0.7; // 70 % skill

type ArenaMode = 'mini_30' | 'standard_100' | 'fast_mini' | 'practice' | 'spectator';

function readMode(): ArenaMode {
  if (typeof window === 'undefined') return 'mini_30';
  const q = new URLSearchParams(window.location.search);
  // Room Lobby links: /game?mode=<room mode>&room=<id>&spectate=1 opens that room as a Ghost Spectator
  if (q.get('spectate') === '1') return 'spectator';
  const m = q.get('mode');
  if (m === 'standard_100' || m === 'fast_mini' || m === 'practice' || m === 'spectator') return m;
  return 'mini_30';
}

/** Which multiplayer room a spectator watches (from ?mode=… with spectate=1; legacy ?mode=spectator → mini_30). */
function readSpectateRoom(): 'standard_100' | 'mini_30' | 'fast_mini' {
  if (typeof window === 'undefined') return 'mini_30';
  const m = new URLSearchParams(window.location.search).get('mode');
  return m === 'standard_100' || m === 'fast_mini' ? m : 'mini_30';
}

/** Admin room registry code from the lobby link (/game?room=TH-02&map=small): the server applies that room's settings. */
function readRoomCode(): string | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const code = (q.get('room') || '').toUpperCase();
  if (q.get('mode') === 'practice' || code === 'SOLO' || !/^[A-Z0-9][A-Z0-9_-]{1,15}$/.test(code)) return null;
  return code;
}

/** Map chosen for the room by the admin (lobby link ?map=small|large); falls back to the mode default. */
function readMapOverride(): 'small' | 'large' | null {
  if (typeof window === 'undefined') return null;
  const m = new URLSearchParams(window.location.search).get('map');
  return m === 'small' || m === 'large' ? m : null;
}

const MODE_LABEL: Record<ArenaMode, string> = {
  mini_30: '30-PLAYER SKIRMISH',
  standard_100: '100-PLAYER WARZONE',
  fast_mini: 'FAST & MINI MODE',
  practice: 'PRACTICE RANGE / SOLO BOTS',
  spectator: 'GHOST SPECTATOR',
};
/** Short labels for the single-row status strip. */
const MODE_SHORT: Record<ArenaMode, string> = {
  mini_30: '30P SKIRMISH',
  standard_100: '100P WARZONE',
  fast_mini: 'FAST MINI',
  practice: 'SOLO BOT',
  spectator: 'SPECTATOR',
};

interface HudState {
  health: number;
  kills: number;
  deaths: number;
  chests: number;
  earningsMicroUsd: number;
  /** Own head bounty (5 % of every reward) — whoever eliminates you claims it. */
  bountyMicroUsd: number;
  /** V1.1: real backed value of your live Energy Ticket — what your killer is paid (0 once settled). */
  ticketMicroUsd: number;
  isProp: boolean;
  isGhost: boolean;
  ammo: number;
  reserve: number;
  weaponName: string;
  slot: Slot;
  primaryLabel: string | null;
  primaryAmmo: string;
  pistolLabel: string | null;
  pistolAmmo: string;
  grenades: number;
  pickupPrompt: string | null;
  propName: string | null;
  reloading: boolean;
  botsAlive: number;
  roundKills: number;
  ecProgress: number;
  energyTickets: number;
  maxEnergyTickets: number;
  roundsCompleted: number;
  alive: boolean;
  respawnIn: number;
  leanDir: -1 | 0 | 1;
  crouching: boolean;
  stance: Stance;
  keyboardLocked: boolean;
  weaponId: WeaponId | null;
  medkits: number;
  /** Medkit cast progress 0..1, or -1 when not casting. */
  medkitCast: number;
  leaderboard: { name: string; kills: number }[];
}

type Slot = 'primary' | 'pistol' | 'grenade';

interface Gun {
  id: WeaponId;
  mag: number;
  reserve: number;
}

interface DamageIndicator {
  id: number;
  angle: number;
  at: number;
}

export default function GamePage() {
  // V1.1: HUD money strings (C with 2 decimals + $) — read through a ref inside the room callbacks
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const rootRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [mode, setMode] = useState<ArenaMode>('mini_30');
  const [hudStats, setHudStats] = useState<HudState>({
    health: 100,
    kills: 0,
    deaths: 0,
    chests: 0,
    earningsMicroUsd: 0,
    bountyMicroUsd: 0,
    ticketMicroUsd: 0,
    isProp: false,
    isGhost: false,
    ammo: 0,
    reserve: 0,
    weaponName: '',
    slot: 'primary',
    primaryLabel: null,
    primaryAmmo: '',
    pistolLabel: null,
    pistolAmmo: '',
    grenades: GRENADE.start,
    pickupPrompt: null,
    propName: null,
    reloading: false,
    botsAlive: 0,
    roundKills: 0,
    ecProgress: 0,
    energyTickets: INITIAL_ENERGY_TICKETS,
    maxEnergyTickets: MAX_ENERGY_TICKETS,
    roundsCompleted: 0,
    alive: true,
    respawnIn: 0,
    leanDir: 0,
    weaponId: null,
    medkits: 0,
    medkitCast: -1,
    leaderboard: [],
    crouching: false,
    stance: 'stand',
    keyboardLocked: false,
  });
  const [toast, setToast] = useState<{ text: string; at: number; id: number } | null>(null);
  const [toastFading, setToastFading] = useState(false);
  const [afkPrompt, setAfkPrompt] = useState<string | null>(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [compactLandscape, setCompactLandscape] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'offline_practice' | 'solo_bots'>('connecting');
  const [loadingWorld, setLoadingWorld] = useState(true);
  const [damageFlash, setDamageFlash] = useState(0);
  const [ecToast, setEcToast] = useState<string | null>(null);
  const pendingBanners = usePendingBanners();
  const ecToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [damageIndicators, setDamageIndicators] = useState<DamageIndicator[]>([]);
  const [hitMarker, setHitMarker] = useState<{ at: number; kill: boolean; head: boolean } | null>(null);
  const [roundBanner, setRoundBanner] = useState<string | null>(null);
  const [videoAd, setVideoAd] = useState<null | 'video_15s' | 'video_30s'>(null);
  const adCfg = useAdConfig();
  const [kbLockSupported, setKbLockSupported] = useState(false);

  // Loadout / deploy, prop wheel, fullscreen, scope, command bar
  const [deployed, setDeployed] = useState(false);
  const [loadoutPrimary, setLoadoutPrimary] = useState<PrimaryId>('m16');
  const [loadoutCharacter, setLoadoutCharacter] = useState<CharacterId>('specops');
  const [portraits, setPortraits] = useState<Partial<Record<CharacterId, string>>>({});
  const [propMenu, setPropMenu] = useState<{ open: boolean; hover: number | null; cursor: { x: number; y: number } | null }>({ open: false, hover: null, cursor: null });
  const [currentProp, setCurrentProp] = useState<PropId | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scoped, setScoped] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandText, setCommandText] = useState('');

  // Interactive UI Overlay & Controls Mode States
  const [isOverlayDismissed, setIsOverlayDismissed] = useState(false);
  const [isDragLookMode, setIsDragLookMode] = useState(false);
  const [isAdsActive, setIsAdsActive] = useState(false);
  const [stanceUi, setStanceUi] = useState<Stance>('stand');
  const [leanState, setLeanState] = useState<'none' | 'left' | 'right'>('none');
  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });

  // Refs for real-time loops and cross-event communication
  const isPointerLockedRef = useRef(false);
  const isDragLookRef = useRef(false);
  const isMouseDownRef = useRef(false);
  const isMobileRef = useRef(false);
  const isOverlayDismissedRef = useRef(false);
  const isAdsActiveRef = useRef(false);
  const stanceRef = useRef<Stance>('stand');
  const setStanceRef = useRef<(s: Stance) => void>(() => {});
  const propRotateRef = useRef(0);
  const leanStateRef = useRef<'none' | 'left' | 'right'>('none');
  const firingRef = useRef(false);
  // Drag-to-aim FIRE button: the firing finger also turns the camera
  const fireTouchIdRef = useRef<number | null>(null);
  const lastFireTouchRef = useRef<{ x: number; y: number } | null>(null);
  const aimAssistRef = useRef(false);
  const [targetLocked, setTargetLocked] = useState(false);
  const minimapRef = useRef<HTMLCanvasElement>(null);
  const lookRef = useRef({ yaw: 0, pitch: 0, dx: 0, dy: 0 });
  const togglePropRef = useRef<() => void>(() => {});
  const triggerJumpRef = useRef<() => void>(() => {});
  /** Vault through the window in front of you (T on PC, contextual button on mobile). */
  const vaultWindowRef = useRef<() => void>(() => {});
  const [canVault, setCanVault] = useState(false);
  const reloadRef = useRef<() => void>(() => {});
  const deployRef = useRef<(primary: PrimaryId, character: CharacterId) => void>(() => {});
  /** Solo Bot death: after the 3 s elimination screen, reopen the loadout to pick weapon / operator. */
  const reopenLoadoutRef = useRef<() => void>(() => {});
  const [respawnLoadout, setRespawnLoadout] = useState(false);
  const deployedRef = useRef(false);
  const propMenuOpenRef = useRef(false);
  const menuCursorRef = useRef({ x: 0, y: 0 });
  const menuHoverRef = useRef<number | null>(null);
  const selectPropRef = useRef<(id: PropId | null) => void>(() => {});
  const equipRef = useRef<(slot: Slot) => void>(() => {});
  const throwWeaponRef = useRef<() => void>(() => {});
  const pickupRef = useRef<() => void>(() => {});
  const medkitRef = useRef<() => void>(() => {});
  const quickGrenadeRef = useRef<() => void>(() => {});
  const commandRef = useRef<(cmd: string) => void>(() => {});
  const commandOpenRef = useRef(false);
  const guardRef = useRef<BrowserGuard | null>(null);
  const joystickCenterRef = useRef<{ x: number; y: number } | null>(null);
  const lastTouchLookRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    isPointerLockedRef.current = isPointerLocked;
  }, [isPointerLocked]);
  useEffect(() => {
    isDragLookRef.current = isDragLookMode;
  }, [isDragLookMode]);
  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);
  useEffect(() => {
    isOverlayDismissedRef.current = isOverlayDismissed;
  }, [isOverlayDismissed]);
  useEffect(() => {
    isAdsActiveRef.current = isAdsActive;
  }, [isAdsActive]);
  useEffect(() => {
    leanStateRef.current = leanState;
  }, [leanState]);

  // Spectator Mode Quest Tracking (90 seconds for Q_SPECTATE)
  const [spectatorSeconds, setSpectatorSeconds] = useState(0);
  const [spectatorQuestCompleted, setSpectatorQuestCompleted] = useState(false);

  const mobileInputRef = useRef({ moveX: 0, moveZ: 0 });

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    soundFX.isMuted = next;
  };

  useEffect(() => {
    commandOpenRef.current = commandOpen;
  }, [commandOpen]);

  // Saved loadout + avatar portraits
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LOADOUT_STORAGE_KEY) || 'null');
      if (saved && PRIMARY_IDS.includes(saved.primary)) setLoadoutPrimary(saved.primary);
      if (saved && CHARACTER_IDS.includes(saved.character)) setLoadoutCharacter(saved.character);
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => setPortraits(renderCharacterPortraits()), 60);
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearTimeout(t);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  // Radial prop wheel open / close helpers
  const openPropMenu = () => {
    propMenuOpenRef.current = true;
    menuCursorRef.current = { x: 0, y: 0 };
    menuHoverRef.current = null;
    firingRef.current = false;
    setPropMenu({ open: true, hover: null, cursor: isPointerLockedRef.current ? { x: 0, y: 0 } : null });
  };
  const closePropMenu = () => {
    propMenuOpenRef.current = false;
    menuHoverRef.current = null;
    setPropMenu({ open: false, hover: null, cursor: null });
  };

  const toggleFullscreen = () => {
    const guard = guardRef.current;
    // iPhone Safari has no element fullscreen: fall back to a CSS "fixed inset-0" pseudo-fullscreen
    if (!document.fullscreenEnabled) {
      setIsFullscreen((v) => !v);
      return;
    }
    const lockLandscape = () => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      o?.lock?.('landscape').catch(() => {});
    };
    if (guard) guard.toggleFullscreen().then((on) => setIsFullscreen(on));
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else
      document.documentElement
        .requestFullscreen()
        .then(lockLandscape)
        .catch(() => {});
  };

  useEffect(() => {
    setMode(readMode());
    setKbLockSupported(keyboardLockSupported());
    const isTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
    setIsMobile(isTouch);
    // Aim-assist is always on (touch and PC) — narrow, soft, never a hard lock; no toggle
    aimAssistRef.current = true;
    isMobileRef.current = isTouch;
    // Phones held sideways get a compact, thumb-reach control layout
    const onOrient = () => setCompactLandscape(isTouch && window.innerWidth > window.innerHeight && window.innerHeight < 560);
    onOrient();
    window.addEventListener('resize', onOrient);
    window.addEventListener('orientationchange', onOrient);
    return () => {
      window.removeEventListener('resize', onOrient);
      window.removeEventListener('orientationchange', onOrient);
    };
  }, []);

  // Engage controls: pointer lock + in-game shortcut guard. NEVER enters fullscreen automatically —
  // fullscreen is only toggled by the dedicated ⛶ button (bottom-right).
  const engageControls = () => {
    setIsOverlayDismissed(true);
    isOverlayDismissedRef.current = true;
    if (isMobileRef.current) {
      guardRef.current?.arm({ fullscreen: false });
      return;
    }
    const el = mountRef.current;
    const lockPointer = () => {
      if (!el) return;
      try {
        const promise = el.requestPointerLock?.() as unknown as Promise<void> | undefined;
        if (promise && typeof promise.catch === 'function') {
          promise.catch((err: unknown) => {
            console.warn('Pointer lock request rejected, enabling drag-look fallback:', err);
            setIsDragLookMode(true);
            isDragLookRef.current = true;
          });
        }
      } catch (err) {
        console.warn('Pointer lock error, enabling drag-look fallback:', err);
        setIsDragLookMode(true);
        isDragLookRef.current = true;
      }
    };
    const guard = guardRef.current;
    if (guard) {
      guard.arm({ fullscreen: false }).then(() => setHudStats((p) => ({ ...p, keyboardLocked: guard.isKeyboardLocked })));
      lockPointer();
    } else lockPointer();
  };

  const deploy = (dragLook: boolean) => {
    try {
      localStorage.setItem(LOADOUT_STORAGE_KEY, JSON.stringify({ primary: loadoutPrimary, character: loadoutCharacter }));
    } catch {
      /* ignore */
    }
    deployedRef.current = true;
    setDeployed(true);
    setRespawnLoadout(false);
    flushBannerImpressions();
    deployRef.current(loadoutPrimary, loadoutCharacter);
    if (isMobileRef.current) {
      setIsOverlayDismissed(true);
      isOverlayDismissedRef.current = true;
      guardRef.current?.arm({ fullscreen: false });
      const orientation = (screen as Screen).orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation?.lock?.('landscape').catch(() => {});
    } else if (dragLook) {
      setIsOverlayDismissed(true);
      isOverlayDismissedRef.current = true;
      setIsDragLookMode(true);
      isDragLookRef.current = true;
      guardRef.current?.arm({ fullscreen: false });
    } else {
      engageControls();
    }
  };

  // ---- True multi-touch: each control tracks its own Touch.identifier -------------------------
  const joystickTouchIdRef = useRef<number | null>(null);
  const lookTouchIdRef = useRef<number | null>(null);
  const findTouch = (list: React.TouchList, id: number | null) => {
    if (id === null) return null;
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };
  const updateJoystick = (clientX: number, clientY: number) => {
    if (!joystickCenterRef.current) return;
    const dx = clientX - joystickCenterRef.current.x;
    const dy = clientY - joystickCenterRef.current.y;
    const maxRadius = 45;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const clampedDist = Math.min(dist, maxRadius);
    const nx = Math.cos(angle) * clampedDist;
    const ny = Math.sin(angle) * clampedDist;
    setJoystickPos({ x: nx, y: ny });
    mobileInputRef.current.moveX = nx / maxRadius;
    mobileInputRef.current.moveZ = ny / maxRadius;
  };
  const handleJoystickTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (joystickTouchIdRef.current !== null) return;
    const touch = e.changedTouches[0];
    joystickTouchIdRef.current = touch.identifier;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joystickCenterRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateJoystick(touch.clientX, touch.clientY);
  };
  const handleJoystickTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = findTouch(e.changedTouches, joystickTouchIdRef.current);
    if (touch) updateJoystick(touch.clientX, touch.clientY);
  };
  const handleJoystickTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    if (!findTouch(e.changedTouches, joystickTouchIdRef.current)) return;
    joystickTouchIdRef.current = null;
    setJoystickPos({ x: 0, y: 0 });
    mobileInputRef.current.moveX = 0;
    mobileInputRef.current.moveZ = 0;
    joystickCenterRef.current = null;
  };

  // Touch look (right side of the screen) — its own finger, independent of the joystick
  const handleTouchLookStart = (e: React.TouchEvent) => {
    if (lookTouchIdRef.current !== null) return;
    const touch = e.changedTouches[0];
    lookTouchIdRef.current = touch.identifier;
    lastTouchLookRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const handleTouchLookMove = (e: React.TouchEvent) => {
    const touch = findTouch(e.changedTouches, lookTouchIdRef.current);
    if (!touch || !lastTouchLookRef.current) return;
    const deltaX = touch.clientX - lastTouchLookRef.current.x;
    const deltaY = touch.clientY - lastTouchLookRef.current.y;
    lastTouchLookRef.current = { x: touch.clientX, y: touch.clientY };
    const sens = isAdsActiveRef.current ? 0.0032 : 0.005;
    const look = lookRef.current;
    look.yaw -= deltaX * sens;
    look.pitch = THREE.MathUtils.clamp(look.pitch - deltaY * sens, -1.45, 1.45);
    look.dx += deltaX;
    look.dy += deltaY;
  };
  const handleTouchLookEnd = (e: React.TouchEvent) => {
    if (!findTouch(e.changedTouches, lookTouchIdRef.current)) return;
    lookTouchIdRef.current = null;
    lastTouchLookRef.current = null;
  };

  // Spectator timer heartbeat
  useEffect(() => {
    const isSpectatorMode = mode === 'spectator';
    if (!isSpectatorMode) return;
    const timer = setInterval(() => {
      if (document.hidden) return; // hidden tab: the spectate clock (and its quest pings) pause
      setSpectatorSeconds((prev) => {
        const next = prev + 1;
        if (next % 15 === 0 && next <= 90) progressQuest('Q_SPECTATE', 15).catch(() => {});
        if (next >= 90 && !spectatorQuestCompleted) {
          setSpectatorQuestCompleted(true);
          soundFX.playQuestComplete();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [mode, hudStats.isGhost, spectatorQuestCompleted]);

  // Fade damage indicators
  useEffect(() => {
    if (!damageIndicators.length && damageFlash <= 0) return;
    const t = setTimeout(() => {
      const now = performance.now();
      setDamageIndicators((list) => list.filter((d) => now - d.at < 1400));
      setDamageFlash((v) => Math.max(0, v - 0.15));
    }, 80);
    return () => clearTimeout(t);
  }, [damageIndicators, damageFlash]);

  useEffect(() => {
    if (!toast) return;
    setToastFading(false);
    const fade = setTimeout(() => setToastFading(true), TOAST_MS - 800);
    const kill = setTimeout(() => setToast((t) => (t && t.id === toast.id ? null : t)), TOAST_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(kill);
    };
  }, [toast]);

  useEffect(() => {
    if (!hitMarker) return;
    const t = setTimeout(() => setHitMarker(null), 180);
    return () => clearTimeout(t);
  }, [hitMarker]);

  // =============================================================================================
  // 3D engine
  // =============================================================================================
  useEffect(() => {
    if (!mountRef.current || !rootRef.current) return;
    const arenaMode = readMode();
    let destroyed = false;
    const container = mountRef.current;
    const guard = new BrowserGuard(rootRef.current);
    guard.attach();
    guardRef.current = guard;

    let width = container.clientWidth || window.innerWidth;
    let height = container.clientHeight || window.innerHeight;

    // ---- Renderer / scene / cameras ---------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // Pixel ratio is set ONCE (capped at 2) — resizes only touch the drawing-buffer size.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobileRef.current ? 1.5 : 2));
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = false;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(HIP_FOV, width / height, 0.05, 2200);
    scene.add(camera);

    // Map: the room's configured map (lobby link), else per mode: 100P Warzone → 960 m; Skirmish / Fast & Mini / Solo → 240 m
    const largeMap = (readMapOverride() ?? mapKindForMode(arenaMode === 'spectator' ? readSpectateRoom() : arenaMode)) === 'large';
    const playHalf = largeMap ? LARGE_PLAY_HALF : PLAY_HALF;
    const world = new CollisionWorld(
      largeMap
        ? { halfSize: LARGE_PLAY_HALF, stepHeight: 0.45, gravity: -22, terrain: { height: largeMapTerrainHeight, bounds: LARGE_TERRAIN_BOUNDS } }
        : { halfSize: PLAY_HALF, stepHeight: 0.45, gravity: -22 }
    );
    const lib = new MaterialLibrary();
    const layout = largeMap ? buildLargeArena(scene, world, lib) : buildArena(scene, world, lib);
    // Per-chunk distance culling for the large map (beyond the fog nothing is drawn)
    const chunkedMeshes = layout.staticMeshes.filter((m) => m.userData.chunked);
    const CHUNK_CULL_DIST = 700;
    let cullTimer = 0;
    const effects = new CombatEffects(scene);
    const viewmodel = new Viewmodel(width / height);
    setLoadingWorld(false);

    // Muzzle light in the world (lights nearby walls when firing)
    const worldMuzzleLight = new THREE.PointLight(0xffb347, 0, 9, 2);
    scene.add(worldMuzzleLight);

    // ---- Player ------------------------------------------------------------------------------
    const isGhostSpectator = arenaMode === 'spectator';
    const pickSpawn = (avoid: THREE.Vector3 | null) => {
      // Random valid spawn far from the death location and out of every living bot's direct LOS.
      const pool = layout.spawnPoints.length ? layout.spawnPoints : layout.playerSpawns;
      const shuffled = pool.slice().sort(() => Math.random() - 0.5);
      const alive = bots ? bots.bots.filter((b) => b.state !== 'dead') : [];
      const score = (c: THREE.Vector3, strict: boolean) => {
        if (avoid && c.distanceTo(avoid) < (strict ? 40 : 20)) return false;
        for (const b of alive) {
          const d = Math.hypot(b.body.x - c.x, b.body.z - c.z);
          if (d < (strict ? 22 : 12)) return false;
          if (strict && d < 80 && world.lineOfSight(b.body.x, b.body.y + 1.6, b.body.z, c.x, c.y + 1.6, c.z)) return false;
        }
        return true;
      };
      return shuffled.find((c) => score(c, true)) ?? shuffled.find((c) => score(c, false)) ?? shuffled[0];
    };
    const spawn = layout.playerSpawns[Math.floor(Math.random() * layout.playerSpawns.length)];
    const body: MoveBody = { x: spawn.x, y: spawn.y, z: spawn.z, velY: 0, onGround: true, radius: 0.36, height: 1.78, owner: 'local' };
    const look = lookRef.current;
    look.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
    look.pitch = 0;
    if (isGhostSpectator) camera.position.set(largeMap ? -230 : 0, 18, largeMap ? -230 : 40);

    const player = {
      hp: 100,
      alive: true,
      respawnTimer: 0,
      reloadTimer: -1,
      reloadTime: 2,
      fireCooldown: 0,
      fireQueued: false,
      recoilPitch: 0,
      recoilYaw: 0,
      recoilRecover: 7,
      eyeHeight: STAND_EYE,
      renderY: 0,
      leanT: 0,
      lastDamageAt: -10,
      kills: 0,
      deaths: 0,
      chests: 0,
      isProp: false,
      roundKills: 0,
      roundsCompleted: 0,
      medkits: 0,
      speed: 0,
      orbitPitch: 0.35,
      propYaw: 0,
      deathPos: new THREE.Vector3(),
      character: 'specops' as CharacterId,
      loadoutPrimary: 'm16' as PrimaryId,
    };

    // ---- Inventory: 1 Primary · 2 Pistol · 3 Frag grenades -------------------------------
    const fullGun = (id: WeaponId): Gun => ({ id, mag: WEAPONS[id].magSize, reserve: WEAPONS[id].reserve });
    const inv = {
      primary: fullGun('m16') as Gun | null,
      pistol: fullGun('pistol') as Gun | null,
      grenades: GRENADE.start,
      slot: 'primary' as Slot,
      lastGunSlot: 'primary' as 'primary' | 'pistol',
    };
    const currentGun = (): Gun | null => (inv.slot === 'primary' ? inv.primary : inv.slot === 'pistol' ? inv.pistol : null);
    const gunOf = (slot: 'primary' | 'pistol') => (slot === 'primary' ? inv.primary : inv.pistol);
    const hasAmmo = (g: Gun | null) => !!g && g.mag + g.reserve > 0;
    const syncViewmodelWeapon = (instant = false) => {
      const g = currentGun();
      viewmodel.setWeapon(inv.slot === 'grenade' ? 'grenade' : g ? g.id : 'pistol', instant);
    };
    const equip = (slot: Slot) => {
      if (!player.alive || player.isProp) return;
      if (slot === 'primary' && !inv.primary) return;
      if (slot === 'pistol' && !inv.pistol) return;
      if (slot === 'grenade' && inv.grenades <= 0) return;
      if (slot === inv.slot) return;
      player.reloadTimer = -1;
      player.fireQueued = false;
      inv.slot = slot;
      if (slot !== 'grenade') inv.lastGunSlot = slot;
      syncViewmodelWeapon();
    };
    equipRef.current = equip;
    const cycleSlot = (dir: number) => {
      const order: Slot[] = ['primary', 'pistol', 'grenade'];
      let i = order.indexOf(inv.slot);
      for (let k = 0; k < 3; k++) {
        i = (i + dir + 3) % 3;
        const s = order[i];
        if ((s === 'primary' && inv.primary) || (s === 'pistol' && inv.pistol) || (s === 'grenade' && inv.grenades > 0)) {
          equip(s);
          return;
        }
      }
    };
    const switchToAnyGun = () => {
      const other: 'primary' | 'pistol' = inv.slot === 'primary' ? 'pistol' : 'primary';
      if (hasAmmo(gunOf(other))) equip(other);
      else if (inv.grenades > 0) equip('grenade');
    };


    const keys: Record<string, boolean> = {};

    // ---- Bot mode (practice or offline) & economy ----------------------------------------------
    let bots: BotManager | null = null;
    let botMode = false;
    // Single latest status line (replaces the previous one; fades out after 10 s)
    const feed = (msg: string) => setToast({ text: msg, at: Date.now(), id: Math.random() });

    const playerInfo = {
      position: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      speed: 0,
      crouching: false,
      alive: true,
      disguised: false,
      prone: false,
    };

    // Bot kills / practice chests give 0 EC and 0 Micro-USD. EC recharges from ads only.
    const awardPracticeProgress = (_points: number, reason: string) => {
      if (reason) feed(reason);
    };

    // ---- World weapon drops (5-minute despawn, glow + name tag) ----------------------------
    const worldWeapons: WorldWeapon[] = [];
    const removeWorldWeapon = (w: WorldWeapon) => {
      const i = worldWeapons.indexOf(w);
      if (i >= 0) worldWeapons.splice(i, 1);
      scene.remove(w.group);
      disposeObject(w.group);
    };
    const dropWeapon = (gun: Gun, pos: THREE.Vector3, vel?: THREE.Vector3) => {
      // EMPTY WEAPON RULE: a weapon with 0 in the magazine AND 0 reserve vanishes when dropped.
      if (gun.mag <= 0 && gun.reserve <= 0) return null;
      const w = createWorldWeapon(gun.id as WorldWeapon['id'], gun.mag, gun.reserve);
      w.group.position.copy(pos);
      if (vel) {
        w.vel.copy(vel);
        w.resting = false;
      } else {
        w.group.position.y = world.groundHeightAt(pos.x, pos.z, 0.3, pos.y + 0.5);
      }
      scene.add(w.group);
      worldWeapons.push(w);
      // Keep the world tidy
      if (worldWeapons.length > 24) removeWorldWeapon(worldWeapons[0]);
      return w;
    };
    const updateWorldWeapons = (dt: number, t: number) => {
      for (let i = worldWeapons.length - 1; i >= 0; i--) {
        const w = worldWeapons[i];
        w.ttl -= dt;
        if (w.ttl <= 0) {
          removeWorldWeapon(w);
          continue;
        }
        if (!w.resting) {
          w.vel.y -= 18 * dt;
          const p = w.group.position;
          const len = w.vel.length() * dt;
          if (len > 1e-4) {
            const d = w.vel.clone().normalize();
            const hit = world.raycast(p.x, p.y + 0.1, p.z, d.x, d.y, d.z, len + 0.1);
            if (hit) {
              if (hit.normal.y > 0.5) {
                p.set(hit.point.x, hit.point.y, hit.point.z);
                w.resting = true;
                soundFX.playClink(0.08);
              } else {
                p.set(hit.point.x + hit.normal.x * 0.15, hit.point.y - 0.1, hit.point.z + hit.normal.z * 0.15);
                w.vel.set(hit.normal.x * 1.2, Math.min(0, w.vel.y), hit.normal.z * 1.2);
              }
            } else p.addScaledVector(w.vel, dt);
          }
          const model = w.group.getObjectByName('model');
          if (model && !w.resting) model.rotation.z += dt * 9;
          const g = world.groundHeightAt(p.x, p.z, 0.2, p.y + 0.05);
          if (p.y <= g) {
            p.y = g;
            w.resting = true;
          }
          if (p.y < -5) removeWorldWeapon(w);
        }
        animateWorldWeapon(w, t);
      }
    };
    const nearestWeapon = (maxDist: number) => {
      let best: WorldWeapon | null = null;
      let bd = maxDist;
      for (const w of worldWeapons) {
        if (!w.resting) continue;
        const d = Math.hypot(w.group.position.x - body.x, w.group.position.z - body.z);
        if (d < bd && Math.abs(w.group.position.y - body.y) < 1.4) {
          bd = d;
          best = w;
        }
      }
      return best;
    };
    const takeWorldWeapon = (w: WorldWeapon) => {
      const slot: 'primary' | 'pistol' = w.id === 'pistol' ? 'pistol' : 'primary';
      const held = gunOf(slot);
      if (held && held.id === w.id) {
        // Same weapon: pull its ammo into reserve
        held.reserve += w.mag + w.reserve;
      } else {
        if (held) {
          const fwd = new THREE.Vector3(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
          dropWeapon(held, new THREE.Vector3(body.x, body.y, body.z).addScaledVector(fwd, 0.6));
        }
        const g: Gun = { id: w.id, mag: w.mag, reserve: w.reserve };
        if (slot === 'primary') inv.primary = g;
        else inv.pistol = g;
        player.reloadTimer = -1;
        inv.slot = slot;
        inv.lastGunSlot = slot;
        syncViewmodelWeapon();
      }
      soundFX.playClink(0.14);
      soundFX.playReload();
      feed(`🔫 Picked up ${WEAPONS[w.id].name} (${w.mag}/${w.reserve})`);
      if (currentRoom) {
        currentRoom.send('player_pickup_weapon', {
          dropId: String(w.uid),
          weaponId: w.id,
        });
      }
      removeWorldWeapon(w);
    };
    pickupRef.current = () => {
      if (!player.alive || player.isProp) return;
      const w = nearestWeapon(2.0);
      if (w) takeWorldWeapon(w);
    };
    throwWeaponRef.current = () => {
      // G: throw / discard the weapon in hand forward
      if (!player.alive || player.isProp || inv.slot === 'grenade') return;
      const slot = inv.slot as 'primary' | 'pistol';
      const gun = gunOf(slot);
      if (!gun) return;
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const from = camera.position.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0, -0.25, 0));
      const vel = dir.multiplyScalar(6.5).add(new THREE.Vector3(0, 2.6, 0));
      const w = dropWeapon(gun, from, vel);
      if (currentRoom && w) {
        currentRoom.send('player_drop_weapon', {
          weaponId: gun.id,
          magAmmo: gun.mag,
          reserveAmmo: gun.reserve,
          x: from.x,
          y: from.y,
          z: from.z,
        });
      }
      feed(w ? `🫳 Threw ${WEAPONS[gun.id].name} (${gun.mag}/${gun.reserve})` : `🗑️ Empty ${WEAPONS[gun.id].name} discarded — it vanished`);
      viewmodel.throwSwing();
      if (slot === 'primary') inv.primary = null;
      else inv.pistol = null;
      player.reloadTimer = -1;
      const other: 'primary' | 'pistol' = slot === 'primary' ? 'pistol' : 'primary';
      if (gunOf(other)) {
        inv.slot = other;
        inv.lastGunSlot = other;
      } else if (inv.grenades > 0) inv.slot = 'grenade';
      syncViewmodelWeapon();
    };

    // ---- Medkits: 20 % drop on any death, 10-minute despawn, walk-over / F pickup ------------
    const worldMedkits = new Map<string, { group: THREE.Group; expiresAt: number }>();
    let medkitSeq = 0;
    const pendingMedkitPickups = new Set<string>();
    const addMedkit = (id: string, x: number, y: number, z: number, expiresAt: number) => {
      if (worldMedkits.has(id)) return;
      const g = createMedkitModel();
      g.position.set(x, world.groundHeightAt(x, z, 0.3, y + 0.5), z);
      scene.add(g);
      worldMedkits.set(id, { group: g, expiresAt });
    };
    const removeMedkit = (id: string) => {
      const m = worldMedkits.get(id);
      if (!m) return;
      scene.remove(m.group);
      disposeObject(m.group);
      worldMedkits.delete(id);
      pendingMedkitPickups.delete(id);
    };
    /** Solo / practice drop (multiplayer drops are server-authoritative in ShootingRoom). */
    const maybeDropMedkit = (pos: THREE.Vector3) => {
      if (!botMode || Math.random() >= MEDKIT_DROP_CHANCE) return;
      addMedkit(`local_medkit_${medkitSeq++}`, pos.x + 0.5, pos.y, pos.z - 0.3, Date.now() + MEDKIT_TTL_MS);
    };
    const nearestMedkit = (maxDist: number) => {
      let best: string | null = null;
      let bd = maxDist;
      worldMedkits.forEach((m, id) => {
        const d = Math.hypot(m.group.position.x - body.x, m.group.position.z - body.z);
        if (d < bd && Math.abs(m.group.position.y - body.y) < 1.4) {
          bd = d;
          best = id;
        }
      });
      return best as string | null;
    };
    const pickupMedkit = (id: string) => {
      if (!player.alive || player.isProp || isGhostSpectator) return;
      if (botMode || !currentRoom) {
        player.medkits += 1;
        removeMedkit(id);
        soundFX.playClink(0.12);
        feed(`✚ Picked up a medkit (${player.medkits}) — press 4 to heal`);
      } else if (!pendingMedkitPickups.has(id)) {
        pendingMedkitPickups.add(id);
        currentRoom.send('player_pickup_medkit', { medkitId: id });
      }
    };
    let medkitCastStart = -1;
    const cancelMedkit = (why?: string) => {
      if (medkitCastStart < 0) return;
      medkitCastStart = -1;
      if (currentRoom && !botMode) currentRoom.send('player_medkit_cancel', {});
      if (why) feed(why);
    };
    const startMedkit = () => {
      if (medkitCastStart >= 0) return;
      if (!player.alive || player.isProp || isGhostSpectator || !deployedRef.current) return;
      if (player.medkits <= 0) {
        feed('✚ No medkits — enemies drop them 20 % of the time');
        return;
      }
      if (player.hp >= 100) {
        feed('✚ Already at full health');
        return;
      }
      medkitCastStart = performance.now() / 1000;
      firingRef.current = false;
      if (currentRoom && !botMode) currentRoom.send('player_medkit_start', {});
      feed('✚ Healing… stay still for 4 s');
    };
    const completeMedkit = () => {
      medkitCastStart = -1;
      if (currentRoom && !botMode) {
        // Server validates the 4 s stationary cast, rolls 40–80 HP and syncs health / count
        currentRoom.send('player_medkit_complete', {});
        return;
      }
      const heal = rollMedkitHeal();
      player.medkits = Math.max(0, player.medkits - 1);
      player.hp = Math.min(100, player.hp + heal);
      soundFX.playQuestComplete();
      feed(`✚ Healed +${heal} HP (${player.medkits} medkit${player.medkits === 1 ? '' : 's'} left)`);
    };
    medkitRef.current = startMedkit;

    // ---- Death / respawn rules ---------------------------------------------------------------
    const chestMeshes = new Map<string, THREE.Group>();
    let chestCounter = 0;
    const removeChest = (id: string) => {
      const g = chestMeshes.get(id);
      if (!g) return;
      scene.remove(g);
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
      chestMeshes.delete(id);
    };
    /** Bot mode: suicide / environmental death drops a 15 s bounty chest (EC progress only). */
    const spawnDeathChestLocal = (pos: THREE.Vector3) => {
      const id = `practice_death_chest_${chestCounter++}`;
      const g = createBountyChest(true);
      g.position.set(pos.x, world.groundHeightAt(pos.x, pos.z, 0.5, pos.y + 0.5), pos.z);
      g.userData.expires = performance.now() + 15000;
      scene.add(g);
      chestMeshes.set(id, g);
    };

    type DeathCause = { kind: 'bot'; name: string } | { kind: 'self'; reason: 'grenade' | 'fall' | 'suicide' };
    const killPlayer = (cause: DeathCause) => {
      if (!player.alive) return;
      player.alive = false;
      player.hp = 0;
      player.deaths += 1;
      player.respawnTimer = RESPAWN_SECONDS;
      respawnRequested = false;
      player.deathPos.set(body.x, body.y, body.z);
      firingRef.current = false;
      if (player.isProp) setProp(null);
      closePropMenu();
      cancelMedkit();
      maybeDropMedkit(player.deathPos);
      // Drop the primary where we fell (bots can't use it, but you can grab it back)
      if (inv.primary) dropWeapon(inv.primary, player.deathPos.clone().add(new THREE.Vector3(0.4, 0, 0.2)));
      inv.primary = null;
      if (cause.kind === 'bot') {
        bots?.creditKill(cause.name);
        feed(`☠️ You were eliminated by ${cause.name}`);
        return;
      }
      const label = cause.reason === 'grenade' ? 'your own grenade' : cause.reason === 'fall' ? 'a fall' : '/suicide';
      feed(`💀 You died by ${label} — a bounty chest dropped where you fell`);
      if (botMode) spawnDeathChestLocal(player.deathPos);
      else if (currentRoom) currentRoom.send('player_suicide', { cause: cause.reason, x: body.x, y: body.y, z: body.z });
    };
    /** The server already killed us (weapon drop + death chest are server-side): local death state only. */
    const serverDeath = () => {
      if (!player.alive) return;
      player.alive = false;
      player.hp = 0;
      player.deaths += 1;
      player.respawnTimer = RESPAWN_SECONDS;
      respawnRequested = false;
      player.deathPos.set(body.x, body.y, body.z);
      firingRef.current = false;
      if (player.isProp) setProp(null, false);
      closePropMenu();
      medkitCastStart = -1;
      stanceRef.current = 'stand';
      inv.primary = null;
      setIsAdsActive(false);
    };
    let respawnRequested = false;

    // ---- Stealth radar: gunshot blips (2 s) ---------------------------------------------------
    const blips: RadarBlip[] = [];
    const addBlip = (x: number, z: number) => {
      blips.push({ x, z, at: performance.now() });
      if (blips.length > 40) blips.splice(0, blips.length - 40);
    };
    let lastFireRelay = 0;

    const damagePlayer = (amount: number, from: THREE.Vector3 | null, cause: DeathCause) => {
      if (!player.alive || isGhostSpectator || !deployedRef.current) return;
      player.hp = Math.max(0, player.hp - amount);
      player.lastDamageAt = performance.now() / 1000;
      soundFX.playDamage();
      if (from) {
        const ang = Math.atan2(from.x - body.x, from.z - body.z);
        const rel = -(ang - Math.atan2(-Math.sin(look.yaw), -Math.cos(look.yaw)));
        setDamageIndicators((list) => [...list.slice(-5), { id: Math.random(), angle: rel, at: performance.now() }]);
      }
      setDamageFlash(0.6);
      if (player.hp <= 0) killPlayer(cause);
    };
    commandRef.current = (raw: string) => {
      const cmd = raw.trim().toLowerCase();
      if (cmd === '/suicide' || cmd === '/kill') {
        if (player.alive && deployedRef.current && !isGhostSpectator) damagePlayer(999, null, { kind: 'self', reason: 'suicide' });
      } else if (cmd) feed(`❔ Unknown command: ${raw.trim().slice(0, 24)} (try /suicide)`);
    };

    const onPlayerHit = (damage: number, from: THREE.Vector3, botName: string) => {
      if (player.isProp) {
        // Taking fire breaks the disguise
        setProp(null);
        feed('📦 Disguise broken by enemy fire!');
      }
      damagePlayer(damage, from, { kind: 'bot', name: botName });
    };

    const startBotMode = (reason: 'practice' | 'offline') => {
      if (bots || destroyed) return;
      botMode = true;
      bots = new BotManager(scene, world, layout.nav, layout.posts, effects, {
        onPlayerHit,
        onBotKilledByBot: (victimId, killerName) => {
          if (!bots) return;
          const v = bots.botById(victimId);
          maybeDropMedkit(new THREE.Vector3(v.body.x, v.body.y, v.body.z));
          feed(`☠️ ${killerName} eliminated ${v.name}`);
        },
        onShot: (from) => {
          soundFX.playEnemyShot(from.distanceTo(camera.position));
          addBlip(from.x, from.z);
        },
      }, { count: BOT_COUNT, accuracy: BOT_ACCURACY, playerHalf: playHalf, spawnPoints: layout.spawnPoints });
      setConnectionStatus(reason === 'practice' ? 'solo_bots' : 'offline_practice');
      feed(`🤖 ${BOT_COUNT} AI bots deployed (70% skill)`);
      feed('⚔️ FREE-FOR-ALL • bots fight each other too • 0 EC / 0 Micro-USD per kill');
    };

    const onBotKilled = (botId: number, how: string) => {
      if (!bots) return;
      const bot = bots.botById(botId);
      player.kills += 1;
      bots.creditKill('You');
      maybeDropMedkit(new THREE.Vector3(bot.body.x, bot.body.y, bot.body.z));
      // Killed opponents drop their primary (glowing pickup, 5-minute despawn). No chest.
      const def = WEAPONS[bot.weapon];
      dropWeapon({ id: bot.weapon, mag: def.magSize, reserve: def.magSize }, new THREE.Vector3(bot.body.x, bot.body.y, bot.body.z));
      awardPracticeProgress(1, `🎯 ${how}Eliminated ${bot.name}`);
    };

    // ---- Colyseus multiplayer ---------------------------------------------------------------
    interface Remote {
      rig: CharacterRig;
      target: THREE.Vector3;
      yaw: number;
      speed: number;
      prop: THREE.Group | null;
      propId: PropId | null;
      stance: Stance;
      /** Dead (waiting to respawn) or a spectator: no mesh, no hitbox. */
      hidden: boolean;
    }
    const validStance = (v: unknown): Stance => (v === 'crouch' || v === 'prone' ? v : 'stand');
    const remotePlayers = new Map<string, Remote>();
    let currentRoom: Room | null = null;
    const validProp = (v: unknown): PropId => (PROPS.some((p) => p.id === v) ? (v as PropId) : 'supply_crate');
    const setRemoteProp = (key: string, rp: Remote, isProp: boolean, propType: unknown) => {
      const want = isProp ? validProp(propType) : null;
      if (want === rp.propId) return;
      if (rp.prop) {
        scene.remove(rp.prop);
        disposeObject(rp.prop);
        rp.prop = null;
      }
      rp.propId = want;
      rp.rig.root.visible = !want && !rp.hidden;
      world.setDynamicBox(`remote_${key}`, null);
      if (want) {
        rp.prop = createPropModel(want);
        rp.prop.position.copy(rp.rig.root.position);
        rp.prop.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) o.userData.remoteId = key;
        });
        scene.add(rp.prop);
      }
    };

    async function initColyseus() {
      const colyseusUrl =
        process.env.NEXT_PUBLIC_GAME_SERVER_URL ||
        (/(^|\.)mwar\.win$|(^|\.)mwar-web\.pages\.dev$/.test(window.location.hostname) ? 'wss://game.mwar.win' : 'ws://localhost:2567');
      const colyseusClient = new ColyseusClient(colyseusUrl);
      try {
        let meData: any = null;
        try {
          meData = await apiFetch('/api/auth/me');
        } catch {
          // Guest mode
        }
        // Room per mode: standard_100 / mini_30 (large map), fast_mini (small map); spectators watch mini_30
        const roomName =
          arenaMode === 'spectator' ? readSpectateRoom() : arenaMode === 'standard_100' ? 'standard_100' : arenaMode === 'fast_mini' ? 'fast_mini' : 'mini_30';
        const roomCode = readRoomCode();
        // Paid arena: spend the room's EC cost for a signed entry ticket. Without one you still play, unpaid.
        let entryToken: string | undefined;
        // Spectators never spend EC and never enter a paid seat
        if (meData?.user && !isGhostSpectator) {
          try {
            const enter = await apiFetch<{ entryToken: string | null; energyTickets: number; free?: boolean }>('/api/game/enter', {
              method: 'POST',
              body: JSON.stringify({ mode: roomName, roomCode: roomCode || undefined }),
            });
            entryToken = enter.entryToken || undefined;
            setHudStats((prev) => ({ ...prev, energyTickets: enter.energyTickets }));
            feed(enter.free ? '🎮 Free room: no EC used, no cash rewards' : `⚡ EC used to enter the paid arena (${enter.energyTickets} left)`);
          } catch {
            feed('⚡ No Energy Tickets — playing unpaid. Practice mode recharges EC.');
          }
        }
        let deviceId = '';
        try {
          deviceId = localStorage.getItem('mwar_device_id') || crypto.randomUUID();
          localStorage.setItem('mwar_device_id', deviceId);
        } catch {
          // storage blocked
        }
        // Admin-configured rooms join the 'arena' room type by code; the server applies mode, map and caps
        const joinPromise = colyseusClient.joinOrCreate(roomCode ? 'arena' : roomName, {
          ...(roomCode ? { roomCode } : {}),
          entryToken,
          deviceId,
          userId: meData?.user?.id || `guest_${Math.random().toString(36).substring(2, 6)}`,
          username: meData?.user?.username || `Guest_${Math.floor(Math.random() * 900 + 100)}`,
          avatarId: loadoutCharacter,
          primaryWeapon: loadoutPrimary,
          // Ghost Spectator joins as an invisible observer (no body, no hitbox, no damage)
          spectator: isGhostSpectator,
        });
        if (meData?.user) {
          const u = meData.user;
          setHudStats((prev) => ({
            ...prev,
            energyTickets: entryToken ? prev.energyTickets : u.energy_tickets ?? INITIAL_ENERGY_TICKETS,
            maxEnergyTickets: Math.min(u.max_energy_tickets ?? MAX_ENERGY_TICKETS, MAX_ENERGY_TICKETS),
            ecProgress: u.energy_progress_pct ?? 0,
          }));
        }
        const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('join timeout')), 6000));
        const roomInstance = (await Promise.race([joinPromise, timeout])) as Room;
        if (destroyed) {
          roomInstance.leave();
          return;
        }
        currentRoom = roomInstance;
        setRoom(roomInstance);
        setConnectionStatus('connected');

        const state = roomInstance.state as any;
        state.players.onAdd((p: any, key: string) => {
          if (key === roomInstance.sessionId) {
            setHudStats((prev) => ({ ...prev, health: p.health, kills: p.kills, chests: p.chestsCollected, isGhost: p.isGhost }));
          } else {
            // Opponents get their chosen avatar rig (or fallback) + weapon
            const rig = createCharacter((p.avatarId as CharacterId) || randomCharacterId(), {
              name: p.username || 'Enemy',
              tagColor: '#7dd3fc',
              weapon: (p.currentWeapon as WeaponId) || PRIMARY_IDS[Math.floor(Math.random() * PRIMARY_IDS.length)],
            });
            rig.root.position.set(p.x, p.y || 0, p.z);
            rig.hitMeshes.forEach((m) => (m.userData.remoteId = key));
            scene.add(rig.root);
            const rp: Remote = {
              rig,
              target: new THREE.Vector3(p.x, p.y || 0, p.z),
              yaw: p.rotationY || 0,
              speed: 0,
              prop: null,
              propId: null,
              stance: validStance(p.stance),
              hidden: !!p.isGhost || !!p.isSpectator,
            };
            rig.root.visible = !rp.hidden;
            remotePlayers.set(key, rp);
            setRemoteProp(key, rp, !!p.isProp && !rp.hidden, p.propType);
          }
          p.onChange(() => {
            if (key === roomInstance.sessionId) {
              player.hp = p.health;
              if (typeof p.medkits === 'number') player.medkits = p.medkits;
              // Killed on the server (another player / grenade): enter the clean 3 s death state
              if (p.isGhost && player.alive && !isGhostSpectator) serverDeath();
              setHudStats((prev) => ({
                ...prev,
                health: p.health,
                kills: p.kills,
                chests: p.chestsCollected,
                earningsMicroUsd: p.sessionEarningsMicroUsd,
                bountyMicroUsd: p.bountyMicroUsd ?? 0,
                ticketMicroUsd: p.ticketMicroUsd ?? 0,
                isGhost: p.isGhost,
              }));
              if (!p.isProp && player.isProp) setProp(null, false);
            } else {
              const rp = remotePlayers.get(key);
              if (rp) {
                const wasHidden = rp.hidden;
                rp.hidden = !!p.isGhost || !!p.isSpectator;
                rp.target.set(p.x, p.y || 0, p.z);
                // Respawned: snap to the new spawn point instead of sliding across the map
                if (wasHidden && !rp.hidden) rp.rig.root.position.copy(rp.target);
                rp.yaw = p.rotationY || 0;
                rp.stance = validStance(p.stance);
                setRemoteProp(key, rp, !!p.isProp && !rp.hidden, p.propType);
                rp.rig.root.visible = !rp.hidden && !rp.propId;
              }
            }
          });
        });
        state.players.onRemove((_p: any, key: string) => {
          const rp = remotePlayers.get(key);
          if (rp) {
            setRemoteProp(key, rp, false, null);
            scene.remove(rp.rig.root);
            rp.rig.dispose();
            remotePlayers.delete(key);
          }
        });
        state.chests.onAdd((chest: any, key: string) => {
          const g = createBountyChest(!!chest.isDeathDrop);
          g.position.set(chest.x, chest.y || 0, chest.z);
          scene.add(g);
          chestMeshes.set(key, g);
        });
        state.chests.onRemove((_c: any, key: string) => removeChest(key));

        if (state.droppedWeapons) {
          state.medkits?.onAdd?.((kit: any, key: string) => addMedkit(key, kit.x, kit.y, kit.z, Number(kit.expiresAt) || Date.now() + MEDKIT_TTL_MS));
          state.medkits?.onRemove?.((_kit: any, key: string) => removeMedkit(key));
          state.droppedWeapons.onAdd((dw: any, key: string) => {
            const exists = worldWeapons.some((w) => String(w.uid) === key || String(w.uid) === dw.id);
            if (!exists && (dw.magAmmo > 0 || dw.reserveAmmo > 0)) {
              const w = createWorldWeapon(dw.weaponId as any, dw.magAmmo, dw.reserveAmmo);
              w.group.position.set(dw.x, dw.y, dw.z);
              w.ttl = Math.max(1, (dw.expiresAt - Date.now()) / 1000);
              scene.add(w.group);
              worldWeapons.push(w);
            }
          });
          state.droppedWeapons.onRemove((_dw: any, key: string) => {
            const w = worldWeapons.find((x) => String(x.uid) === key);
            if (w) removeWorldWeapon(w);
          });
        }

        roomInstance.onMessage('weapon_dropped', (data: any) => {
          const exists = worldWeapons.some((w) => String(w.uid) === data.dropId);
          if (!exists && (data.magAmmo > 0 || data.reserveAmmo > 0)) {
            const w = createWorldWeapon(data.weaponId as any, data.magAmmo, data.reserveAmmo);
            w.group.position.set(data.x, data.y, data.z);
            w.ttl = Math.max(1, (data.expiresAt - Date.now()) / 1000);
            scene.add(w.group);
            worldWeapons.push(w);
          }
        });
        roomInstance.onMessage('medkit_spawned', (data: any) => {
          if (typeof data?.medkitId === 'string') addMedkit(data.medkitId, data.x, data.y, data.z, Number(data.expiresAt) || Date.now() + MEDKIT_TTL_MS);
        });
        roomInstance.onMessage('medkit_expired', (data: any) => removeMedkit(String(data?.medkitId)));
        roomInstance.onMessage('medkit_picked_up', (data: any) => {
          removeMedkit(String(data?.medkitId));
          if (data?.sessionId === roomInstance.sessionId) {
            if (typeof data.count === 'number') player.medkits = data.count;
            soundFX.playClink(0.12);
            feed(`✚ Picked up a medkit (${player.medkits}) — press 4 to heal`);
          }
        });
        roomInstance.onMessage('medkit_used', (data: any) => {
          if (typeof data?.health === 'number') player.hp = data.health;
          if (typeof data?.count === 'number') player.medkits = data.count;
          soundFX.playQuestComplete();
          feed(`✚ Healed +${data?.heal ?? 0} HP`);
        });
        roomInstance.onMessage('weapon_picked_up', (data: any) => {
          const w = worldWeapons.find((x) => String(x.uid) === data.dropId);
          if (w) removeWorldWeapon(w);
        });
        roomInstance.onMessage('grenade_thrown', (data: any) => {
          if (data.throwerSessionId !== roomInstance.sessionId) {
            const g = buildGrenadeModel();
            g.group.scale.setScalar(1.3);
            g.group.position.set(data.x, data.y, data.z);
            scene.add(g.group);
            const vel = new THREE.Vector3(data.vx, data.vy, data.vz);
            grenades.push({ mesh: g.group, vel, fuse: GRENADE.fuse, byPlayer: false, bounces: 0 });
          }
        });
        roomInstance.onMessage('grenade_exploded', (data: any) => {
          effects.explosion(new THREE.Vector3(data.x, data.y, data.z));
          soundFX.playExplosion(new THREE.Vector3(data.x, data.y, data.z).distanceTo(camera.position));
        });

        roomInstance.onMessage('player_respawned', (data: any) => {
          if (isGhostSpectator) return;
          if ([data?.x, data?.y, data?.z].every((v: unknown) => typeof v === 'number')) respawnPlayer({ x: data.x, y: data.y, z: data.z });
          else respawnPlayer();
        });
        roomInstance.onMessage('player_eliminated', (data: any) => {
          if (data?.killerUsername) feed(`☠️ Eliminated by ${data.killerUsername} — respawning…`);
        });
        roomInstance.onMessage('player_fired', (data: any) => {
          if (typeof data?.x === 'number' && typeof data?.z === 'number') addBlip(data.x, data.z);
        });
        roomInstance.onMessage('player_killed', (data: any) => {
          soundFX.playHitMarker();
          // V1.1: a kill is worth the victim's real ticket value V; the shooter gets 55 % of V (+ the victim's head bounty)
          const bounty = Number(data.bountyClaimedMicroUsd) || 0;
          const tt = tRef.current;
          feed(
            `⚔️ ${tt('econ.feed.kill', { killer: data.killerUsername, victim: data.victimUsername, v: formatCoinsAndUsd(Number(data.rewardMicroUsd) || 0) })}${
              bounty > 0 ? ` · ${tt('econ.feed.bounty', { v: formatCoinsAndUsd(bounty) })}` : ''
            }`
          );
        });
        roomInstance.onMessage('player_suicide', (data: any) => feed(`💀 ${data.victimUsername} died (${data.cause}) — bounty chest dropped!`));
        roomInstance.onMessage('chest_destroyed', (data: any) => {
          soundFX.playChestPickup();
          feed(`💰 ${tRef.current('econ.feed.chest', { name: data.collectedByUsername, v: formatCoinsAndUsd(Number(data.rewardMicroUsd) || 0) })}`);
        });
        roomInstance.onMessage('afk_warning', (data: any) => setAfkPrompt(data.message));
        roomInstance.onMessage('afk_cleared', () => setAfkPrompt(null));
      } catch (err) {
        console.warn('Colyseus server offline. Activating solo bot mode (energy recharge rules).', err);
        if (!destroyed) startBotMode('offline');
      }
    }

    if (arenaMode === 'practice') startBotMode('practice');
    else initColyseus();

    // ---- Prop disguise (radial C wheel) -------------------------------------------------------
    let propModel: THREE.Group | null = null;
    let propId: PropId | null = null;
    const setProp = (id: PropId | null, notifyServer = true) => {
      const wasProp = player.isProp;
      if (propModel) {
        scene.remove(propModel);
        disposeObject(propModel);
        propModel = null;
      }
      world.setDynamicBox('local', null);
      propId = id;
      player.isProp = !!id;
      viewmodel.setVisible(!id);
      if (id) {
        propModel = createPropModel(id);
        scene.add(propModel);
        // Start facing the camera direction (snapped), then it stays put while you look around
        if (!wasProp) player.propYaw = Math.round(look.yaw / (Math.PI / 2)) * (Math.PI / 2);
        player.orbitPitch = 0.35;
        firingRef.current = false;
        player.reloadTimer = -1;
        feed(`🎭 Disguised as ${propDef(id).name}${propDef(id).solid ? ' (solid)' : ' (small, pass-through)'}`);
      }
      setCurrentProp(id);
      if (notifyServer && currentRoom) currentRoom.send('player_set_prop', { isProp: !!id, propType: id ?? undefined });
      setHudStats((prev) => ({ ...prev, isProp: !!id, propName: id ? propDef(id).name : null }));
    };
    selectPropRef.current = (id) => {
      closePropMenu();
      if (!player.alive || isGhostSpectator || !deployedRef.current) return;
      setProp(id);
    };
    togglePropRef.current = () => {
      // C: open the radial wheel; C while disguised reverts to human; C while open closes it
      if (!player.alive || isGhostSpectator || !deployedRef.current) return;
      if (propMenuOpenRef.current) {
        closePropMenu();
        return;
      }
      if (player.isProp) {
        setProp(null);
        feed('🧍 Disguise dropped');
        return;
      }
      openPropMenu();
    };
    // ---- Stance: Standing → Crouch → Prone → Standing ----------------------------------------
    // Need head room for the taller capsule before rising (e.g. crawling under a low table)
    const canStandTo = (target: Stance) => world.hasHeadroom(body, STANCE_HEIGHT[target]);
    const setStance = (next: Stance) => {
      if (isGhostSpectator) return;
      if (!player.alive || player.isProp) next = 'stand';
      const cur = stanceRef.current;
      if (next === cur) return;
      if (STANCE_HEIGHT[next] > STANCE_HEIGHT[cur] && !canStandTo(next)) {
        feed('⛔ No room to stand up here');
        return;
      }
      stanceRef.current = next;
      setStanceUi(next);
    };
    setStanceRef.current = setStance;
    const cycleStance = () => setStance(stanceRef.current === 'stand' ? 'crouch' : stanceRef.current === 'crouch' ? 'prone' : 'stand');
    triggerJumpRef.current = () => {
      if (!player.alive || !deployedRef.current) return;
      // Space from crouch / prone stands you up first
      if (stanceRef.current !== 'stand') {
        setStance('stand');
        return;
      }
      world.jump(body, 7.4);
    };
    // ── Window vault: find a window you are facing within reach, then carry the body through ──
    let vault: { t: number; dur: number; a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3 } | null = null;
    let vaultCandidate: { w: WindowSpot; dir: number } | null = null;
    let vaultScanT = 0;
    const vaultEnd = (w: WindowSpot, dir: number) => {
      const off = w.t / 2 + body.radius + 0.25;
      return new THREE.Vector3(w.x + w.nx * dir * off, w.sill + 0.02, w.z + w.nz * dir * off);
    };
    const findVaultWindow = (): { w: WindowSpot; dir: number } | null => {
      if (!player.alive || player.isProp || vault) return null;
      const fx = -Math.sin(look.yaw);
      const fz = -Math.cos(look.yaw);
      let best: { w: WindowSpot; dir: number } | null = null;
      let bestD = Infinity;
      for (const w of MAP2D.windows) {
        const rx = body.x - w.x;
        const rz = body.z - w.z;
        if (Math.abs(rx) > 3 || Math.abs(rz) > 3) continue;
        const s = rx * w.nx + rz * w.nz; // signed distance from the wall plane
        if (Math.abs(s) > w.t / 2 + 1.3) continue;
        const lat = Math.abs(rx * -w.nz + rz * w.nx);
        if (lat > w.halfW + 0.15) continue;
        const rise = w.sill - body.y;
        if (rise > 1.7 || rise < -0.5) continue;
        const dir = s >= 0 ? -1 : 1; // go to the other side
        if (fx * w.nx * dir + fz * w.nz * dir < 0.35) continue; // must be facing the window
        const e = vaultEnd(w, dir);
        if (world.pointInSolid(e.x, e.y + 0.2, e.z) || world.pointInSolid(e.x, e.y + 1.0, e.z)) continue;
        const d = Math.abs(s) + lat * 0.5;
        if (d < bestD) {
          bestD = d;
          best = { w, dir };
        }
      }
      return best;
    };
    vaultWindowRef.current = () => {
      if (!deployedRef.current) return;
      const cand = findVaultWindow();
      if (!cand) return;
      const { w, dir } = cand;
      const a = new THREE.Vector3(body.x, body.y, body.z);
      // Pass through the middle of the opening, feet just above the sill
      const lat = (body.x - w.x) * -w.nz + (body.z - w.z) * w.nx;
      const latC = THREE.MathUtils.clamp(lat, -(w.halfW - 0.3), w.halfW - 0.3);
      const mid = new THREE.Vector3(w.x - w.nz * latC, w.sill + 0.05, w.z + w.nx * latC);
      const end = vaultEnd(w, dir);
      end.x -= w.nz * latC;
      end.z += w.nx * latC;
      vault = { t: 0, dur: 0.42, a, b: mid, c: end };
      body.velY = 0;
    };
    const startReload = () => {
      const gun = currentGun();
      if (!gun || player.reloadTimer >= 0 || !player.alive || player.isProp) return;
      const def = WEAPONS[gun.id];
      if (gun.mag >= def.magSize || gun.reserve <= 0) return;
      player.reloadTimer = 0;
      player.reloadTime = def.reloadTime;
      soundFX.playReload();
    };
    reloadRef.current = startReload;

    // ---- Frag grenades ---------------------------------------------------------------------
    interface LiveGrenade {
      mesh: THREE.Group;
      vel: THREE.Vector3;
      fuse: number;
      byPlayer: boolean;
      bounces: number;
    }
    const grenades: LiveGrenade[] = [];
    let pendingThrow = -1; // seconds until the grenade leaves the hand
    let restoreSlotTimer = -1;
    let restoreSlot: Slot | null = null;
    const releaseGrenade = () => {
      const g = buildGrenadeModel();
      g.group.scale.setScalar(1.3);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      g.group.position.copy(camera.position).addScaledVector(dir, 0.45).addScaledVector(right, 0.15);
      scene.add(g.group);
      const vel = dir.multiplyScalar(GRENADE.throwSpeed).add(new THREE.Vector3(0, 3.2, 0));
      grenades.push({ mesh: g.group, vel, fuse: GRENADE.fuse, byPlayer: true, bounces: 0 });
      if (currentRoom) {
        currentRoom.send('player_throw_grenade', {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z,
          vx: vel.x,
          vy: vel.y,
          vz: vel.z,
        });
      }
    };
    const throwGrenade = (quick: boolean) => {
      if (!player.alive || player.isProp || inv.grenades <= 0 || pendingThrow >= 0) return;
      inv.grenades -= 1;
      player.reloadTimer = -1;
      if (quick && inv.slot !== 'grenade') {
        restoreSlot = inv.slot;
        viewmodel.setWeapon('grenade', true);
        restoreSlotTimer = 0.7;
      }
      viewmodel.throwSwing();
      pendingThrow = 0.2;
      feed(`💣 Frag out! (${inv.grenades} left)`);
    };
    quickGrenadeRef.current = () => throwGrenade(true);
    const explode = (g: LiveGrenade) => {
      const c = g.mesh.position.clone();
      effects.explosion(c);
      soundFX.playExplosion(c.distanceTo(camera.position));
      // Bots (walls occlude the blast)
      if (bots) {
        const killed = bots.explosion(c, GRENADE.radius, GRENADE.maxDamage);
        if (g.byPlayer) killed.forEach((id) => onBotKilled(id, '💣 GRENADE • '));
        if (g.byPlayer && killed.length) setHitMarker({ at: performance.now(), kill: true, head: false });
      }
      // Remote players: blast damage is simulated by the game server from 'player_throw_grenade'
      // (server-authoritative), so the client no longer reports it — no double damage.
      // Self / player damage
      if (player.alive && !isGhostSpectator) {
        const chest = new THREE.Vector3(body.x, body.y + 1.0, body.z);
        const d = chest.distanceTo(c);
        if (d < GRENADE.radius && world.lineOfSight(c.x, c.y + 0.2, c.z, chest.x, chest.y, chest.z)) {
          const dmg = GRENADE.maxDamage * (1 - d / GRENADE.radius) ** 0.8;
          damagePlayer(dmg, c, g.byPlayer ? { kind: 'self', reason: 'grenade' } : { kind: 'bot', name: 'grenade' });
        }
        // Screen shake proportional to proximity
        player.recoilPitch += Math.max(0, 0.06 * (1 - d / 25));
      }
      scene.remove(g.mesh);
      disposeObject(g.mesh);
    };
    const updateGrenades = (dt: number) => {
      for (let i = grenades.length - 1; i >= 0; i--) {
        const g = grenades[i];
        g.fuse -= dt;
        if (g.fuse <= 0) {
          grenades.splice(i, 1);
          explode(g);
          continue;
        }
        const p = g.mesh.position;
        g.vel.y -= 20 * dt;
        let remaining = g.vel.length() * dt;
        let guard = 0;
        while (remaining > 1e-4 && guard++ < 3) {
          const dir = g.vel.clone().normalize();
          const hit = world.raycast(p.x, p.y, p.z, dir.x, dir.y, dir.z, remaining + 0.06);
          if (hit && hit.distance <= remaining + 0.06) {
            // Bounce off walls / floors with energy loss
            const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
            if (n.lengthSq() < 0.5) n.set(-dir.x, -dir.y, -dir.z).normalize();
            p.set(hit.point.x, hit.point.y, hit.point.z).addScaledVector(n, 0.06);
            const vn = g.vel.dot(n);
            g.vel.addScaledVector(n, -2 * vn).multiplyScalar(n.y > 0.6 ? 0.42 : 0.55);
            if (n.y > 0.6) g.vel.x *= 0.7;
            if (n.y > 0.6) g.vel.z *= 0.7;
            if (Math.abs(vn) > 2.5 && g.bounces++ < 8) soundFX.playClink(0.06);
            remaining = Math.max(0, remaining - hit.distance);
            if (n.y > 0.6 && g.vel.length() < 1.0) {
              g.vel.set(0, 0, 0);
              remaining = 0;
            }
          } else {
            p.addScaledVector(dir, remaining);
            remaining = 0;
          }
        }
        if (p.y < 0.05) {
          p.y = 0.05;
          if (g.vel.y < 0) g.vel.y = -g.vel.y * 0.35;
        }
        g.mesh.rotation.x += g.vel.length() * dt * 2;
        g.mesh.rotation.z += g.vel.length() * dt * 1.3;
      }
    };

    // ---- Shooting ---------------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const tmpV = new THREE.Vector3();
    const ndc = new THREE.Vector2();

    const shootWeapon = () => {
      const gun = currentGun();
      if (!gun || !player.alive || player.isProp || isGhostSpectator) return;
      if (player.reloadTimer >= 0 || viewmodel.switching) return;
      const def = WEAPONS[gun.id];
      if (gun.mag <= 0) {
        soundFX.playDryFire();
        player.fireCooldown = 0.25;
        if (gun.reserve > 0) startReload();
        else switchToAnyGun();
        return;
      }
      gun.mag -= 1;
      player.fireCooldown = def.fireInterval;
      soundFX.playWeaponShot(def.id);
      if (currentRoom && performance.now() - lastFireRelay > 400) {
        lastFireRelay = performance.now();
        currentRoom.send('player_fired');
      }
      viewmodel.fire(def.id === 'sniper' ? 1.8 : def.id === 'uzi' ? 0.55 : def.id === 'pistol' ? 0.8 : 1);
      if (def.mode === 'bolt') viewmodel.cycleBolt(def.fireInterval * 0.9);
      worldMuzzleLight.intensity = 7;
      worldMuzzleLight.position.copy(camera.position);

      // Spread: per-weapon hip / ADS cone, larger when moving / airborne
      const ads = viewmodel.adsProgress;
      let spread = THREE.MathUtils.lerp(def.hipSpread, def.adsSpread, ads);
      if (player.speed > 1) spread += def.moveSpread * Math.min(1, player.speed / 6) * (1 - ads * 0.6);
      if (!body.onGround) spread += 0.03;
      if (stanceRef.current === 'crouch') spread *= 0.75;
      else if (stanceRef.current === 'prone') spread *= 0.55;
      ndc.set((Math.random() - 0.5) * spread * 2, (Math.random() - 0.5) * spread * 2);
      raycaster.setFromCamera(ndc, camera);
      const origin = raycaster.ray.origin;
      const dir = raycaster.ray.direction;

      // Recoil (camera kick; AK climbs hard and wanders sideways, M16 stays controllable)
      const adsRecoil = THREE.MathUtils.lerp(1, 0.7, ads);
      player.recoilPitch += def.recoilPitch * adsRecoil * (0.85 + Math.random() * 0.3);
      player.recoilYaw += (Math.random() - (def.id === 'ak47' ? 0.35 : 0.5)) * def.recoilYaw * 2 * adsRecoil;
      player.recoilRecover = def.recoilRecover;

      // 1) Solid world (walls, buildings, terrain) — bullets never pass through
      const wallHit = world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 400);
      const maxDist = wallHit ? wallHit.distance : 400;
      raycaster.far = maxDist;

      // 2) Chests
      const chestHits = raycaster.intersectObjects(Array.from(chestMeshes.values()), true);
      // 3) Bots / remote players (and remote prop disguises)
      const targetObjs: THREE.Object3D[] = bots ? bots.targets.slice() : [];
      remotePlayers.forEach((rp) => {
        if (rp.hidden) return;
        if (rp.prop) targetObjs.push(rp.prop);
        else targetObjs.push(...rp.rig.hitMeshes);
      });
      const targetHits = raycaster.intersectObjects(targetObjs, true);

      const chestDist = chestHits[0]?.distance ?? Infinity;
      const targetDist = targetHits[0]?.distance ?? Infinity;
      let endPoint: THREE.Vector3;

      if (targetDist < chestDist && targetHits[0]) {
        const hit = targetHits[0];
        endPoint = hit.point.clone();
        const head = hit.object.userData.hitZone === 'head';
        const dmg = def.damage * falloff(def, hit.distance) * (head ? def.headMult : 1);
        if (bots && hit.object.userData.botId !== undefined) {
          const killed = bots.damage(hit.object.userData.botId, dmg, camera.position);
          soundFX.playHitMarker();
          setHitMarker({ at: performance.now(), kill: killed, head });
          if (killed) onBotKilled(hit.object.userData.botId, head ? 'HEADSHOT • ' : '');
        } else if (hit.object.userData.remoteId && currentRoom) {
          currentRoom.send('player_shoot', { targetType: 'player', targetId: hit.object.userData.remoteId, damage: Math.min(100, Math.round(dmg)), headshot: head });
          soundFX.playHitMarker();
          setHitMarker({ at: performance.now(), kill: false, head });
        }
      } else if (chestHits[0]) {
        endPoint = chestHits[0].point.clone();
        let g: THREE.Object3D | null = chestHits[0].object;
        let foundId: string | null = null;
        while (g && !foundId) {
          for (const [id, cg] of chestMeshes) if (cg === g) foundId = id;
          g = g.parent;
        }
        soundFX.playHitMarker();
        if (foundId) {
          if (currentRoom && !botMode) {
            currentRoom.send('player_shoot', { targetType: 'chest', targetId: foundId, damage: 25 });
          } else {
            soundFX.playChestPickup();
            player.chests += 1;
            removeChest(foundId);
            awardPracticeProgress(1, '📦 Death-drop Bounty Chest opened (practice • no coins / EC)');
          }
        }
      } else if (wallHit) {
        endPoint = new THREE.Vector3(wallHit.point.x, wallHit.point.y, wallHit.point.z);
        effects.impact(endPoint, new THREE.Vector3(wallHit.normal.x, wallHit.normal.y, wallHit.normal.z));
      } else {
        endPoint = origin.clone().addScaledVector(dir, 200);
      }
      // Tracer from the gun muzzle area
      const right = tmpV.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));
      const start = camera.position.clone().addScaledVector(dir, 0.9).addScaledVector(right, 0.12 * (1 - ads)).add(new THREE.Vector3(0, -0.1 * (1 - ads), 0));
      effects.tracer(start, endPoint);

      // Auto-reload when the magazine runs dry
      if (gun.mag <= 0 && gun.reserve > 0) setTimeout(() => !destroyed && startReload(), def.mode === 'bolt' ? 450 : 120);
    };

    // ---- Deploy (from the loadout screen) --------------------------------------------------
    deployRef.current = (primary, character) => {
      player.loadoutPrimary = primary;
      player.character = character;
      const arms = characterArmColors(character);
      viewmodel.setTint(arms.glove, arms.sleeve);
      inv.primary = fullGun(primary);
      inv.pistol = fullGun('pistol');
      inv.grenades = GRENADE.start;
      inv.slot = 'primary';
      inv.lastGunSlot = 'primary';
      syncViewmodelWeapon(true);
      const s = pickSpawn(null);
      body.x = s.x;
      body.y = s.y;
      body.z = s.z;
      body.velY = 0;
      player.renderY = s.y;
      look.yaw = Math.atan2(s.x, s.z);
      if (currentRoom) {
        currentRoom.send('player_deploy', {
          avatarId: character,
          primary: primary,
        });
      }
      feed(`🪂 Deployed as ${character.replace(/_/g, ' ')} with ${WEAPONS[primary].name} + Pistol + ${GRENADE.start} frags`);
      // Redeploy after a Solo Bot death: bring the player back with the newly picked loadout
      if (!player.alive) respawnPlayer({ x: s.x, y: s.y, z: s.z });
    };
    reopenLoadoutRef.current = () => {
      deployedRef.current = false;
      setDeployed(false);
      setRespawnLoadout(true);
      setIsAdsActive(false);
      firingRef.current = false;
      if (document.pointerLockElement) document.exitPointerLock?.();
    };

    if (new URLSearchParams(window.location.search).has('debug')) {
      (window as any).__mwar = {
        body,
        vault: () => vaultWindowRef.current(),
        windows: MAP2D.windows,
        setStance,
        stance: () => stanceRef.current,
        animateCharacter,
        look,
        keys,
        player,
        inv,
        world,
        camera,
        renderer,
        layout,
        viewmodel,
        worldWeapons,
        grenades,
        get bots() {
          return bots;
        },
        setProp: (id: PropId | null) => setProp(id),
        equip,
        throwGrenade: () => throwGrenade(false),
        throwWeapon: () => throwWeaponRef.current(),
        pickup: () => pickupRef.current(),
        command: (c: string) => commandRef.current(c),
        fire: (on: boolean) => (firingRef.current = on),
        ads: (on: boolean) => setIsAdsActive(on),
        medkits: worldMedkits,
        dropMedkitHere: () => addMedkit(`dbg_${Date.now()}`, body.x + 0.3, body.y, body.z, Date.now() + MEDKIT_TTL_MS),
        startMedkit,
      };
    }

    // ---- Input ------------------------------------------------------------------------------
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (commandOpenRef.current) return;
      keys[e.code] = true;
      if (!deployedRef.current) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) triggerJumpRef.current();
      }
      if (e.code === 'KeyC' && !e.repeat) togglePropRef.current();
      if (e.code === 'KeyT' && !e.repeat) vaultWindowRef.current();
      if (e.code === 'Escape' && propMenuOpenRef.current) closePropMenu();
      if (e.code === 'KeyF' && !e.repeat) {
        // F = pick up a nearby weapon (falls back to fire when nothing is near)
        const kitId = !player.isProp ? nearestMedkit(2.0) : null;
        if (kitId) pickupMedkit(kitId);
        else if (nearestWeapon(2.0) && !player.isProp) pickupRef.current();
        else firingRef.current = true;
      }
      if ((e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyZ') && !e.repeat) cycleStance();
      if (e.code === 'KeyX' && !e.repeat) setStance(stanceRef.current === 'prone' ? 'stand' : 'prone');
      if (e.code === 'KeyG' && !e.repeat) throwWeaponRef.current();
      if (e.code === 'KeyV' && !e.repeat) throwGrenade(true);
      if (e.code === 'Digit1') equip('primary');
      if (e.code === 'Digit2') equip('pistol');
      if (e.code === 'Digit3') equip('grenade');
      if (e.code === 'Digit4' && !e.repeat) startMedkit();
      if (e.code === 'KeyR') startReload();
      if ((e.code === 'Enter' || e.code === 'Slash') && !e.repeat) {
        e.preventDefault();
        setCommandText(e.code === 'Slash' ? '/' : '');
        setCommandOpen(true);
        commandOpenRef.current = true;
        Object.keys(keys).forEach((k) => (keys[k] = false));
        firingRef.current = false;
      }
      // Ctrl is crouch in-game: stop the browser acting on Ctrl+<key> (Ctrl+W is captured by keyboard lock)
      if (e.ctrlKey && guard.isArmed) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys[e.code] = false;
      if (e.code === 'KeyF') firingRef.current = isMouseDownRef.current;
    };
    const onBlur = () => {
      Object.keys(keys).forEach((k) => (keys[k] = false));
      firingRef.current = false;
      isMouseDownRef.current = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      // Browser pointer-lock bug: a single bogus event can report a huge jump (hundreds of px), which
      // flips the view backwards. Drop such spikes when they are far above the recent motion.
      const mag = Math.max(Math.abs(dx), Math.abs(dy));
      if (mag > 120 && mag > lastMouseAbs * 6 + 40) {
        lastMouseAbs = Math.max(lastMouseAbs * 0.5, 1);
        return;
      }
      lastMouseAbs = lastMouseAbs * 0.6 + mag * 0.4;
      if (propMenuOpenRef.current) {
        // Virtual cursor for the radial wheel while the pointer is locked
        if (!isPointerLockedRef.current) return;
        const c = menuCursorRef.current;
        c.x += dx * 0.9;
        c.y += dy * 0.9;
        const r = Math.hypot(c.x, c.y);
        if (r > RADIAL.max) {
          c.x *= RADIAL.max / r;
          c.y *= RADIAL.max / r;
        }
        const idx = propIndexAt(c.x, c.y);
        menuHoverRef.current = idx;
        setPropMenu((m) => ({ ...m, hover: idx, cursor: { x: c.x, y: c.y } }));
        return;
      }
      const free = isPointerLockedRef.current || ((isDragLookRef.current || isGhostSpectator) && isMouseDownRef.current);
      if (!free) return;
      const sens = 0.0022 * (viewmodel.adsProgress > 0.5 ? (inv.slot === 'primary' && inv.primary?.id === 'sniper' ? 0.3 : 0.6) : 1);
      look.yaw -= dx * sens;
      if (player.isProp) player.orbitPitch = THREE.MathUtils.clamp(player.orbitPitch + dy * sens, -0.25, 1.1);
      else look.pitch = THREE.MathUtils.clamp(look.pitch - dy * sens, -1.45, 1.45);
      look.dx += dx;
      look.dy += dy;
    };

    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === container;
      isPointerLockedRef.current = locked;
      setIsPointerLocked(locked);
      if (locked) {
        setIsOverlayDismissed(true);
        isOverlayDismissedRef.current = true;
      } else {
        firingRef.current = false;
        isMouseDownRef.current = false;
        setIsAdsActive(false);
        if (propMenuOpenRef.current) closePropMenu();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isGhostSpectator) {
        // Spectator: click to lock the mouse for free look (or hold + drag if lock is refused)
        if (e.button === 0) {
          isMouseDownRef.current = true;
          if (!isPointerLockedRef.current && !isMobileRef.current) {
            try {
              const pr = container.requestPointerLock?.() as unknown as Promise<void> | undefined;
              pr?.catch?.(() => {});
            } catch {
              /* drag-look still works */
            }
          }
        }
        return;
      }
      if (!deployedRef.current) return;
      if (propMenuOpenRef.current) {
        if (e.button === 0 && isPointerLockedRef.current) {
          const idx = menuHoverRef.current;
          if (idx !== null) selectPropRef.current(PROPS[idx].id);
          else closePropMenu();
        }
        if (e.button === 2) closePropMenu();
        return;
      }
      if (e.button === 0) {
        isMouseDownRef.current = true;
        if (isPointerLockedRef.current || isDragLookRef.current) {
          firingRef.current = !isDragLookRef.current || isPointerLockedRef.current;
          if (firingRef.current) player.fireQueued = true;
        }
        if (!isPointerLockedRef.current && !isDragLookRef.current && !isMobileRef.current) engageControls();
      }
      if (e.button === 2) {
        e.preventDefault();
        setIsAdsActive(true);
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDownRef.current = false;
        firingRef.current = !!keys.KeyF && !nearestWeapon(2.0);
      }
      if (e.button === 2) setIsAdsActive(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (!deployedRef.current || propMenuOpenRef.current || !isPointerLockedRef.current) return;
      cycleSlot(e.deltaY > 0 ? 1 : -1);
    };
    const preventContext = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('wheel', onWheel, { passive: true });
    document.addEventListener('pointerlockchange', onPointerLockChange);
    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('contextmenu', preventContext);

    // ---- Main loop --------------------------------------------------------------------------
    let lastTime = performance.now();
    let animId = 0;
    let hudTimer = 0;
    let netTimer = 0;
    let lastSentKey = '';
    let prevFiring = false;
    let lastScoped = false;
    const right = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    const orbitTarget = new THREE.Vector3();
    const tmpEye = new THREE.Vector3();
    const tmpFwd = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    let aimLock: string | null = null;
    let reticleLocked = false;
    const debugAim = new URLSearchParams(window.location.search).has('debug');
    let dwellId: string | null = null;
    let dwellT = 0;
    let lastMouseAbs = 0;
    let aimCooldown = 0;
    let minimapTimer = 0;

    const respawnPlayer = (at?: { x: number; y: number; z: number }) => {
      stanceRef.current = 'stand';
      setStanceUi('stand');
      const s = at ?? pickSpawn(player.deathPos);
      body.x = s.x;
      body.y = s.y;
      body.z = s.z;
      body.velY = 0;
      body.onGround = true;
      player.renderY = s.y;
      player.hp = 100;
      player.alive = true;
      player.reloadTimer = -1;
      // Fresh loadout every life
      inv.primary = fullGun(player.loadoutPrimary);
      inv.pistol = fullGun('pistol');
      inv.grenades = GRENADE.start;
      inv.slot = 'primary';
      inv.lastGunSlot = 'primary';
      syncViewmodelWeapon(true);
      feed('🛡️ Respawned at a random location — back in the fight');
      look.pitch = 0;
      lastSentKey = '';
    };

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const tSec = now / 1000;
      const active = deployedRef.current || isGhostSpectator;

      if (player.isProp && stanceRef.current !== 'stand') {
        stanceRef.current = 'stand';
        setStanceUi('stand');
      }
      const stance: Stance = active && !player.isProp && player.alive ? stanceRef.current : 'stand';
      const crouching = stance !== 'stand';
      const gunNow = currentGun();
      const adsWanted = isAdsActiveRef.current && !player.isProp && player.alive && inv.slot !== 'grenade' && !propMenuOpenRef.current;
      const heldDef = gunNow ? WEAPONS[gunNow.id] : WEAPONS.pistol;

      // --- Movement input
      let mx = 0;
      let mz = 0;
      if (player.alive && active) {
        if (isMobileRef.current) {
          mx = mobileInputRef.current.moveX;
          mz = mobileInputRef.current.moveZ;
        } else {
          if (keys.KeyW) mz -= 1;
          if (keys.KeyS) mz += 1;
          if (keys.KeyA) mx -= 1;
          if (keys.KeyD) mx += 1;
        }
      }
      const mlen = Math.hypot(mx, mz);
      if (mlen > 1) {
        mx /= mlen;
        mz /= mlen;
      }
      forward.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
      right.set(Math.cos(look.yaw), 0, -Math.sin(look.yaw));

      // Medkit cast: 4 s stationary; any movement / jump / shooting cancels without consuming
      if (medkitCastStart >= 0) {
        if (!player.alive) medkitCastStart = -1;
        else if (Math.hypot(mx, mz) > 0.05 || keys.Space || firingRef.current) cancelMedkit('✚ Healing cancelled (you moved) — medkit kept');
        else if (tSec - medkitCastStart >= MEDKIT_CAST_SECONDS) completeMedkit();
      }

      if (isGhostSpectator) {
        // Free flight, bounded to the arena
        const fly = 12;
        const dir3 = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
        camera.position.addScaledVector(dir3, -mz * fly * dt).addScaledVector(right, mx * fly * dt);
        if (keys.Space) camera.position.y += 8 * dt;
        if (keys.ControlLeft || keys.KeyZ) camera.position.y -= 8 * dt;
        camera.position.y = THREE.MathUtils.clamp(camera.position.y, 1, 80);
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, -playHalf, playHalf);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, -playHalf, playHalf);
        camera.quaternion.setFromEuler(camEuler.set(look.pitch, look.yaw, 0, 'YXZ'));
      } else {
        let speed = 6.2 * (player.isProp ? 1 : heldDef.moveMult);
        if (keys.ShiftLeft || keys.ShiftRight) speed = 3.0; // walk slow (quiet)
        if (stance !== 'stand') speed = STANCE_SPEED[stance];
        if (adsWanted) speed *= heldDef.scope ? 0.5 : 0.65;
        if (player.isProp) speed = 4.2;
        const dx = (forward.x * -mz + right.x * mx) * speed * dt;
        const dz = (forward.z * -mz + right.z * mx) * speed * dt;
        const px = body.x;
        const pz = body.z;
        body.height = STANCE_HEIGHT[stance];
        const wasAir = !body.onGround;
        const fallSpeed = -body.velY;
        if (vault) {
          // Scripted vault: start → over the sill → far side, collision ignored for 0.42 s
          vault.t += dt;
          const k = Math.min(1, vault.t / vault.dur);
          const p = k < 0.5 ? vault.a.clone().lerp(vault.b, k / 0.5) : vault.b.clone().lerp(vault.c, (k - 0.5) / 0.5);
          if (k < 0.5) p.y = vault.a.y + (vault.b.y + 0.25 - vault.a.y) * Math.sin((k / 0.5) * Math.PI * 0.5);
          else p.y = Math.max(vault.c.y, vault.b.y + 0.25 - (vault.b.y + 0.25 - vault.c.y) * ((k - 0.5) / 0.5));
          body.x = p.x;
          body.y = p.y;
          body.z = p.z;
          body.velY = 0;
          body.onGround = false;
          if (k >= 1) vault = null;
        } else world.moveBody(body, dx, dz, dt);
        vaultScanT -= dt;
        if (vaultScanT <= 0) {
          vaultScanT = 0.1;
          const c = findVaultWindow();
          if (!!c !== !!vaultCandidate) setCanVault(!!c);
          vaultCandidate = c;
        }
        player.speed = Math.hypot(body.x - px, body.z - pz) / Math.max(dt, 1e-4);
        // Fall damage (environmental death → counts as a suicide-type death)
        const impact = Math.max(fallSpeed, -body.velY);
        if (wasAir && body.onGround && impact > FALL_SAFE_SPEED && player.alive) {
          damagePlayer((impact - FALL_SAFE_SPEED) * 9, null, { kind: 'self', reason: 'fall' });
        }
        // Solid prop disguise blocks other players / bots (owner 'local' is ignored for us)
        if (propModel && propId) {
          // Camera look only orbits; the prop keeps its own yaw (Q / E or the < > buttons rotate it)
          const def = propDef(propId);
          let rot = propRotateRef.current;
          if (keys.KeyQ) rot += 1;
          if (keys.KeyE) rot -= 1;
          player.propYaw += rot * 1.4 * dt;
          const [w, d] = rotatedExtent(def.size[0], def.size[1], player.propYaw);
          propModel.position.set(body.x, body.y, body.z);
          propModel.rotation.y = player.propYaw;
          if (def.solid) world.setDynamicBox('local', { minX: body.x - w / 2, maxX: body.x + w / 2, minZ: body.z - d / 2, maxZ: body.z + d / 2, minY: body.y, maxY: body.y + def.size[2] });
        }
      }

      // --- Respawn / regen
      if (!player.alive && !isGhostSpectator) {
        player.respawnTimer -= dt;
        if (player.respawnTimer <= 0 && botMode) {
          if (deployedRef.current) reopenLoadoutRef.current();
        }
        // Multiplayer: the server respawns us after 3 s (player_respawned); nudge it once as a fallback
        else if (player.respawnTimer <= -0.5 && currentRoom && !respawnRequested) {
          respawnRequested = true;
          currentRoom.send('player_respawn', {});
        }
      }
      // No passive HP regeneration in any mode — heal with medkits (slot 4)

      // --- Eye height (crouch smoothing + stair step smoothing)
      player.eyeHeight = THREE.MathUtils.damp(player.eyeHeight, !player.alive ? 0.4 : stance === 'prone' ? PRONE_EYE : stance === 'crouch' ? CROUCH_EYE : STAND_EYE, 8, dt);
      const dy = body.y - player.renderY;
      player.renderY = dy > 0 && dy < 0.7 ? THREE.MathUtils.damp(player.renderY, body.y, 16, dt) : body.y;

      // --- True lateral lean (Q / E): shift camera sideways + roll, with wall-clip prevention
      let leanInput = 0;
      if (player.alive && !player.isProp && active) {
        if (keys.KeyQ || leanStateRef.current === 'left') leanInput -= 1;
        if (keys.KeyE || leanStateRef.current === 'right') leanInput += 1;
      }
      player.leanT = THREE.MathUtils.damp(player.leanT, leanInput, 10, dt);
      const eyeBase = tmpV.set(body.x, player.renderY + player.eyeHeight, body.z);
      let leanOffset = player.leanT * LEAN_DISTANCE;
      if (Math.abs(leanOffset) > 0.001) {
        const s = Math.sign(leanOffset);
        const hit = world.raycast(eyeBase.x, eyeBase.y, eyeBase.z, right.x * s, 0, right.z * s, LEAN_DISTANCE + LEAN_WALL_MARGIN, 'movement');
        // Also probe slightly lower (shoulder) so we never peek through a window sill edge
        const hit2 = world.raycast(eyeBase.x, eyeBase.y - 0.35, eyeBase.z, right.x * s, 0, right.z * s, LEAN_DISTANCE + LEAN_WALL_MARGIN, 'movement');
        const free = Math.min(hit ? hit.distance : Infinity, hit2 ? hit2.distance : Infinity) - LEAN_WALL_MARGIN;
        const allowed = Math.max(0, Math.min(Math.abs(leanOffset), free));
        leanOffset = s * allowed;
      }
      const roll = -player.leanT * LEAN_ROLL;

      // --- Soft magnetic aim-assist: pull gently toward the nearest visible enemy's upper torso
      // Lock detection always runs (it drives the reticle colour); the camera pull only when assist is on.
      let lockedNow = false;
      if (player.alive && !player.isProp && deployedRef.current && !isGhostSpectator) {
        const userSwipe = Math.hypot(look.dx, look.dy);
        if (userSwipe > 28) {
          // A forceful swipe breaks the lock and suppresses re-acquiring for a moment
          aimLock = null;
          aimCooldown = 0.35;
        }
        aimCooldown = Math.max(0, aimCooldown - dt);
        const eye = tmpEye.set(body.x, player.renderY + player.eyeHeight, body.z);
        const fwdLook = tmpFwd.set(0, 0, -1).applyEuler(camEuler.set(look.pitch, look.yaw, 0, 'YXZ'));
        const candidates: { id: string; p: THREE.Vector3 }[] = [];
        if (bots) {
          for (const b of bots.bots) {
            if (b.state === 'dead') continue;
            candidates.push({ id: `bot_${b.id}`, p: new THREE.Vector3(b.body.x, b.body.y + 1.35 - b.crouchT * 0.45, b.body.z) });
          }
        }
        remotePlayers.forEach((rp, key) => {
          if (rp.hidden || rp.prop) return;
          const q = rp.rig.root.position;
          candidates.push({ id: key, p: new THREE.Vector3(q.x, q.y + (rp.stance === 'prone' ? 0.35 : rp.stance === 'crouch' ? 0.95 : 1.35), q.z) });
        });
        const angleTo = (pt: THREE.Vector3) => {
          const d = tmpDir.copy(pt).sub(eye);
          const dist = d.length();
          if (dist < 0.5 || dist > (isAdsActiveRef.current ? AIM_ASSIST_ADS_RANGE : AIM_ASSIST_HIP_RANGE)) return Infinity;
          return fwdLook.angleTo(d.divideScalar(dist));
        };
        const visible = (pt: THREE.Vector3) => world.lineOfSight(eye.x, eye.y, eye.z, pt.x, pt.y, pt.z);
        let target: THREE.Vector3 | null = null;
        if (aimLock) {
          const c = candidates.find((k) => k.id === aimLock);
          if (c && angleTo(c.p) < (isMobileRef.current ? AIM_ASSIST_BREAK : AIM_ASSIST_BREAK_PC) && visible(c.p)) target = c.p;
          else aimLock = null;
        }
        // Acquire only when the crosshair rests on a visible enemy (not mid-sweep) for AIM_ASSIST_DWELL
        if (!target && aimCooldown <= 0 && userSwipe < (isMobileRef.current ? 9 : 6)) {
          let best = isMobileRef.current ? AIM_ASSIST_ACQUIRE : AIM_ASSIST_ACQUIRE_PC;
          let pick: { id: string; p: THREE.Vector3 } | null = null;
          for (const c of candidates) {
            const a = angleTo(c.p);
            if (a < best && visible(c.p)) {
              best = a;
              pick = c;
            }
          }
          if (pick && pick.id === dwellId) dwellT += dt;
          else {
            dwellId = pick ? pick.id : null;
            dwellT = 0;
          }
          if (pick && dwellT >= AIM_ASSIST_DWELL) {
            target = pick.p;
            aimLock = pick.id;
          }
        } else if (!target) {
          dwellId = null;
          dwellT = 0;
        }
        if (debugAim) (window as any).__aimDbg = { swipe: userSwipe, cd: aimCooldown, dwellId, dwellT, n: candidates.length, angles: candidates.slice(0, 3).map((c) => angleTo(c.p)), lock: aimLock };
        lockedNow = !!target;
        if (target && aimAssistRef.current) {
          const d = tmpDir.copy(target).sub(eye).normalize();
          const wantYaw = Math.atan2(-d.x, -d.z);
          const wantPitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
          let dYaw = wantYaw - look.yaw;
          dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
          // Gentle: stronger while aiming down sights or firing, never a hard snap
          // Soft pull (never a snap); weaker on PC so the mouse stays fully in control
          const strength = (isAdsActiveRef.current ? 7 : 4.5) * (firingRef.current ? 1.3 : 1) * (isMobileRef.current ? 1 : 0.45);
          const k = 1 - Math.exp(-strength * dt);
          look.yaw += dYaw * k;
          look.pitch = THREE.MathUtils.clamp(look.pitch + (wantPitch - look.pitch) * k, -1.45, 1.45);
        }
      } else aimLock = null;
      if (lockedNow !== reticleLocked) {
        reticleLocked = lockedNow;
        setTargetLocked(lockedNow);
      }

      // --- Recoil recovery
      player.recoilPitch = THREE.MathUtils.damp(player.recoilPitch, 0, player.recoilRecover, dt);
      player.recoilYaw = THREE.MathUtils.damp(player.recoilYaw, 0, player.recoilRecover, dt);

      // --- Camera
      if (!isGhostSpectator) {
        if (player.isProp && propId) {
          // Smooth 3rd-person orbit around the disguise (distance scales with prop size; pulled in by walls)
          const size = propDef(propId).size;
          orbitTarget.set(body.x, body.y + Math.max(0.5, size[2] * 0.75), body.z);
          const cp = Math.cos(player.orbitPitch);
          const back = new THREE.Vector3(Math.sin(look.yaw) * cp, Math.sin(player.orbitPitch), Math.cos(look.yaw) * cp);
          let dist = 2.6 + Math.max(size[0], size[2]) * 1.4;
          const hit = world.raycast(orbitTarget.x, orbitTarget.y, orbitTarget.z, back.x, back.y, back.z, dist + 0.3);
          if (hit) dist = Math.max(0.8, hit.distance - 0.3);
          const desired = orbitTarget.clone().addScaledVector(back, dist);
          camera.position.lerp(desired, 1 - Math.exp(-14 * dt));
          camera.lookAt(orbitTarget);
        } else {
          camera.position.set(eyeBase.x + right.x * leanOffset, eyeBase.y - Math.abs(player.leanT) * 0.06, eyeBase.z + right.z * leanOffset);
          camEuler.set(look.pitch + player.recoilPitch, look.yaw + player.recoilYaw, roll, 'YXZ');
          camera.quaternion.setFromEuler(camEuler);
        }
      }

      // --- Viewmodel + ADS FOV (per-weapon; sniper zooms to a 25° scope)
      viewmodel.update(dt, {
        moveFactor: player.speed / 6.2,
        ads: adsWanted,
        lean: player.leanT,
        lookDeltaX: look.dx,
        lookDeltaY: look.dy,
        grounded: body.onGround,
        crouching: !!crouching,
        reload: player.reloadTimer >= 0 ? player.reloadTimer / player.reloadTime : -1,
      });
      look.dx = 0;
      look.dy = 0;
      const isScope = !!heldDef.scope && inv.slot === 'primary';
      viewmodel.setScoped(isScope);
      const nowScoped = isScope && viewmodel.adsProgress > 0.85 && player.alive && !player.isProp;
      if (nowScoped !== lastScoped) {
        lastScoped = nowScoped;
        setScoped(nowScoped);
      }
      const targetFov = player.isProp ? 70 : THREE.MathUtils.lerp(HIP_FOV, inv.slot === 'grenade' ? HIP_FOV : heldDef.adsFov, viewmodel.adsProgress);
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }

      // --- Weapon state
      player.fireCooldown -= dt;
      if (player.reloadTimer >= 0) {
        player.reloadTimer += dt;
        if (player.reloadTimer >= player.reloadTime) {
          player.reloadTimer = -1;
          const g = currentGun();
          if (g) {
            const need = WEAPONS[g.id].magSize - g.mag;
            const take = Math.min(need, g.reserve);
            g.mag += take;
            g.reserve -= take;
          }
        }
      }
      const firing = firingRef.current && active && !propMenuOpenRef.current;
      if (firing && !prevFiring) player.fireQueued = true;
      if (!firing) player.fireQueued = false;
      prevFiring = firing;
      if (firing && player.alive && !player.isProp) {
        if (inv.slot === 'grenade') {
          if (player.fireQueued) {
            player.fireQueued = false;
            throwGrenade(false);
          }
        } else if (player.fireCooldown <= 0) {
          const auto = heldDef.mode === 'auto';
          if (auto || player.fireQueued) {
            player.fireQueued = false;
            shootWeapon();
          }
        }
      }
      // Grenade leaves the hand mid-swing
      if (pendingThrow >= 0) {
        pendingThrow -= dt;
        if (pendingThrow < 0) {
          releaseGrenade();
          pendingThrow = -1;
          if (inv.slot === 'grenade' && inv.grenades <= 0) {
            inv.slot = inv.primary ? 'primary' : inv.pistol ? 'pistol' : 'grenade';
            setTimeout(() => !destroyed && syncViewmodelWeapon(), 300);
          }
        }
      }
      if (restoreSlotTimer >= 0) {
        restoreSlotTimer -= dt;
        if (restoreSlotTimer < 0 && restoreSlot) {
          inv.slot = restoreSlot;
          restoreSlot = null;
          syncViewmodelWeapon();
        }
      }
      worldMuzzleLight.intensity = Math.max(0, worldMuzzleLight.intensity - dt * 120);
      updateGrenades(dt);
      updateWorldWeapons(dt, tSec);

      // Medkits: despawn after 10 min, bob / glow, walk-over pickup
      const nowEpoch = Date.now();
      worldMedkits.forEach((m, id) => {
        if (nowEpoch >= m.expiresAt) removeMedkit(id);
        else animateMedkit(m.group, tSec);
      });
      if (player.alive && !player.isProp && active && !isGhostSpectator) {
        const kitId = nearestMedkit(1.1);
        if (kitId) pickupMedkit(kitId);
      }

      // Walk-over auto pickup when the matching slot is empty
      let pickupPrompt: string | null = null;
      if (player.alive && !player.isProp && active) {
        const near = nearestWeapon(2.0);
        if (near) {
          const slotEmpty = near.id === 'pistol' ? !inv.pistol : !inv.primary;
          const d = Math.hypot(near.group.position.x - body.x, near.group.position.z - body.z);
          if (slotEmpty && d < 1.1) takeWorldWeapon(near);
          else pickupPrompt = `F — Pick up ${WEAPONS[near.id].name} (${near.mag}/${near.reserve})`;
        }
      }
      if (!pickupPrompt && vaultCandidate && !isMobileRef.current) pickupPrompt = 'T — Vault through window';

      // --- Bots (paused until the player deploys)
      if (bots && active) {
        playerInfo.position.set(body.x, body.y, body.z);
        playerInfo.eye.set(body.x, body.y + player.eyeHeight, body.z).addScaledVector(right, leanOffset);
        playerInfo.speed = player.speed;
        playerInfo.crouching = !!crouching;
        playerInfo.prone = stance === 'prone';
        playerInfo.alive = player.alive;
        playerInfo.disguised = player.isProp && player.speed < 0.5;
        bots.update(dt, playerInfo);
      }
      chestMeshes.forEach((g, id) => {
        if (g.userData.expires && now > g.userData.expires) removeChest(id);
      });

      // --- Remote players interpolation
      remotePlayers.forEach((rp, key) => {
        const before = rp.rig.root.position.clone();
        rp.rig.root.position.lerp(rp.target, 1 - Math.exp(-10 * dt));
        rp.rig.root.rotation.y = rp.yaw;
        rp.speed = before.distanceTo(rp.rig.root.position) / Math.max(dt, 1e-4);
        if (rp.prop && rp.propId) {
          const p = rp.rig.root.position;
          rp.prop.position.copy(p);
          rp.prop.rotation.y = rp.yaw;
          const def = propDef(rp.propId);
          if (def.solid) {
            const [w, d] = rotatedExtent(def.size[0], def.size[1], rp.yaw);
            world.setDynamicBox(`remote_${key}`, { minX: p.x - w / 2, maxX: p.x + w / 2, minZ: p.z - d / 2, maxZ: p.z + d / 2, minY: p.y, maxY: p.y + def.size[2] });
          }
        } else animateCharacter(rp.rig, tSec, rp.speed, false, rp.stance === 'crouch' ? 1 : 0, 0.2, rp.stance === 'prone' ? 1 : 0);
      });

      chestMeshes.forEach((g) => animateBountyChest(g, now));
      effects.update(dt);
      layout.terrain.update(dt, camera);
      cullTimer -= dt;
      if (chunkedMeshes.length && cullTimer <= 0) {
        cullTimer = 0.25;
        for (const m of chunkedMeshes) {
          const sph = (m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).boundingSphere : m.geometry.boundingSphere;
          if (!sph) continue;
          m.visible = camera.position.distanceTo(sph.center) - sph.radius < CHUNK_CULL_DIST;
        }
      }

      // --- Network (20 Hz)
      netTimer -= dt;
      if (currentRoom && netTimer <= 0 && active && !isGhostSpectator && player.alive) {
        netTimer = 0.05;
        const key = `${body.x.toFixed(2)},${body.y.toFixed(2)},${body.z.toFixed(2)},${(player.isProp ? player.propYaw : look.yaw).toFixed(2)},${stance}`;
        if (key !== lastSentKey) {
          lastSentKey = key;
          currentRoom.send('player_move', { x: body.x, y: body.y, z: body.z, rotationY: player.isProp ? player.propYaw : look.yaw, stance });
        }
      }

      // --- HUD (10 Hz)
      minimapTimer -= dt;
      const mm = minimapRef.current;
      if (mm && minimapTimer <= 0) {
        minimapTimer = 1 / 30;
        const ctx2d = mm.getContext('2d');
        if (ctx2d) {
          const nowMs = performance.now();
          while (blips.length && nowMs - blips[0].at > BLIP_LIFETIME_MS) blips.shift();
          const cx = isGhostSpectator ? camera.position.x : body.x;
          const cz = isGhostSpectator ? camera.position.z : body.z;
          drawMinimap(ctx2d, mm.width, { x: cx, z: cz, yaw: look.yaw, radius: 70, fovDeg: camera.fov * camera.aspect }, blips, nowMs);
        }
      }

      hudTimer -= dt;
      if (hudTimer <= 0) {
        hudTimer = 0.1;
        const g = currentGun();
        setHudStats((prev) => ({
          ...prev,
          health: Math.round(player.hp),
          kills: botMode ? player.kills : prev.kills,
          deaths: player.deaths,
          chests: botMode ? player.chests : prev.chests,
          earningsMicroUsd: botMode ? 0 : prev.earningsMicroUsd,
          ammo: g ? g.mag : inv.grenades,
          reserve: g ? g.reserve : 0,
          weaponName: inv.slot === 'grenade' ? GRENADE.name : g ? WEAPONS[g.id].name : '—',
          slot: inv.slot,
          primaryLabel: inv.primary ? WEAPONS[inv.primary.id].tag : null,
          primaryAmmo: inv.primary ? `${inv.primary.mag}/${inv.primary.reserve}` : '',
          pistolLabel: inv.pistol ? WEAPONS.pistol.tag : null,
          pistolAmmo: inv.pistol ? `${inv.pistol.mag}/${inv.pistol.reserve}` : '',
          grenades: inv.grenades,
          pickupPrompt,
          reloading: player.reloadTimer >= 0,
          botsAlive: bots ? bots.aliveCount() : 0,
          roundKills: player.roundKills,
          roundsCompleted: player.roundsCompleted,
          weaponId: inv.slot === 'grenade' ? null : g ? g.id : null,
          medkits: player.medkits,
          medkitCast: medkitCastStart >= 0 ? Math.min(1, (tSec - medkitCastStart) / MEDKIT_CAST_SECONDS) : -1,
          leaderboard: bots ? bots.leaderboard(5) : [],
          alive: player.alive,
          respawnIn: Math.max(0, Math.ceil(player.respawnTimer)),
          leanDir: player.leanT < -0.3 ? -1 : player.leanT > 0.3 ? 1 : 0,
          crouching: !!crouching,
          stance,
          keyboardLocked: guard.isKeyboardLocked,
        }));
      }

      // --- Render: world, then the first-person viewmodel on top
      renderer.clear();
      renderer.render(scene, camera);
      if (!isGhostSpectator && player.alive && deployedRef.current && !player.isProp) viewmodel.render(renderer);
    };
    animate();

    // Resize: only update aspect + projection + drawing-buffer size (never re-init), rAF-throttled.
    let resizeRaf = 0;
    const applyResize = () => {
      resizeRaf = 0;
      const w = Math.max(1, container.clientWidth || window.innerWidth);
      const h = Math.max(1, container.clientHeight || window.innerHeight);
      if (w === width && h === height) return;
      width = w;
      height = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      viewmodel.setAspect(w / h);
      renderer.setSize(w, h, false);
    };
    const handleResize = () => {
      if (!resizeRaf) resizeRaf = requestAnimationFrame(applyResize);
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('contextmenu', preventContext);
      guard.detach();
      guard.exitFullscreen();
      guardRef.current = null;
      currentRoom?.leave();
      bots?.dispose();
      remotePlayers.forEach((rp) => {
        rp.rig.dispose();
        if (rp.prop) disposeObject(rp.prop);
      });
      worldWeapons.slice().forEach(removeWorldWeapon);
      grenades.forEach((g) => disposeObject(g.mesh));
      if (propModel) disposeObject(propModel);
      effects.dispose();
      viewmodel.dispose();
      layout.terrain.dispose();
      layout.staticMeshes.forEach((m) => m.geometry.dispose());
      lib.dispose();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isGhostSpectator = mode === 'spectator';
  const isBotMode = connectionStatus === 'solo_bots' || connectionStatus === 'offline_practice';
  const showLoadout = !deployed && !isGhostSpectator && !loadingWorld;
  const SLOT_KEYS: { slot: Slot; key: string; label: string | null; ammo: string }[] = [
    { slot: 'primary', key: '1', label: hudStats.primaryLabel, ammo: hudStats.primaryAmmo },
    { slot: 'pistol', key: '2', label: hudStats.pistolLabel, ammo: hudStats.pistolAmmo },
    { slot: 'grenade', key: '3', label: hudStats.grenades > 0 ? 'FRAG' : null, ammo: `x${hudStats.grenades}` },
  ];
  const applyEcResult = (r: AdEcResult) => {
    if (r.format === 'banner' && typeof r.ecProgressAddedPct === 'number' && r.ecProgressAddedPct > 0) {
      const n = r.impressions ?? 1;
      setEcToast(`${n > 1 ? `${n} banner impressions` : 'Banner impression'} credited (+${r.ecProgressAddedPct.toFixed(1)}% EC)`);
      if (ecToastTimer.current) clearTimeout(ecToastTimer.current);
      ecToastTimer.current = setTimeout(() => setEcToast(null), 4000);
    }
    setHudStats((prev) => ({
      ...prev,
      energyTickets: r.energy_tickets ?? prev.energyTickets,
      maxEnergyTickets: r.max_energy_tickets ?? prev.maxEnergyTickets,
      ecProgress: r.energy_progress_pct ?? prev.ecProgress,
    }));
    if (r.ticketsAwarded) {
      setRoundBanner(`⚡ +${r.ticketsAwarded} ENERGY TICKET (EC) recharged from ads!`);
      setTimeout(() => setRoundBanner(null), 3500);
    }
  };
  const openVideoAd = (f: 'video_15s' | 'video_30s') => {
    flushBannerImpressions();
    if (document.pointerLockElement) document.exitPointerLock?.();
    firingRef.current = false;
    setVideoAd(f);
  };
  // Bottom banner ad: only in Solo Bot / Practice and Ghost Spectator (never in paid PvP)
  // Also shown over the Solo / Practice loadout screen (first deploy and after every death) so the
  // impression clock keeps running while the player picks a new weapon / operator.
  const showAdBanner = (isBotMode || isGhostSpectator) && !loadingWorld;
  // Anti-AFK (spec §5.3): Practice / Solo bots and Ghost Spectator only — never in paid PvP rooms.
  // 35 s without input or a hidden tab pauses the 30–45 s banner clock and unmounts the banner.
  const chargeGuard = useIdleChargeGuard({ enabled: showAdBanner });
  const bannerPaused = chargeGuard.isPaused;
  const liftForAd = showAdBanner && isMobile && !compactLandscape; // portrait phones: raise thumbs above the ad

  // FIRE button = fire + drag-to-aim with the same finger (independent of the joystick finger)
  const onFireTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const t = e.changedTouches[0];
    if (!t || fireTouchIdRef.current !== null) return;
    fireTouchIdRef.current = t.identifier;
    lastFireTouchRef.current = { x: t.clientX, y: t.clientY };
    firingRef.current = true;
  };
  const onFireTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    let t: React.Touch | null = null;
    for (let i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === fireTouchIdRef.current) t = e.changedTouches[i];
    if (!t || !lastFireTouchRef.current) return;
    const dx = t.clientX - lastFireTouchRef.current.x;
    const dy = t.clientY - lastFireTouchRef.current.y;
    lastFireTouchRef.current = { x: t.clientX, y: t.clientY };
    const sens = isAdsActiveRef.current ? 0.0032 : 0.005;
    const look = lookRef.current;
    look.yaw -= dx * sens;
    look.pitch = THREE.MathUtils.clamp(look.pitch - dy * sens, -1.45, 1.45);
    look.dx += dx;
    look.dy += dy;
  };
  const onFireTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === fireTouchIdRef.current) {
        fireTouchIdRef.current = null;
        lastFireTouchRef.current = null;
        firingRef.current = false;
      }
    }
  };
  /**
   * Right-hand touch pad (container-local px, anchored bottom-right). Right-edge column top→bottom:
   * Reload, Frag (with a wide gap above the action cluster), Jump, Crouch, Prone. FIRE sits in the
   * open thumb zone left of Jump / Crouch; ADS directly below FIRE; Prop left of ADS (‹ › beside it).
   */
  const PAD_W = 330;
  const PAD_H = 330;
  const EDGE_X = PAD_W - 36;
  const PAD = {
    reload: { x: EDGE_X, y: 44 },
    nade: { x: EDGE_X, y: 102 },
    jump: { x: EDGE_X, y: 172 },
    crouch: { x: EDGE_X, y: 232 },
    prone: { x: EDGE_X, y: 292 },
    fire: { x: EDGE_X - 96, y: 202 },
    ads: { x: EDGE_X - 96, y: 292 },
    prop: { x: EDGE_X - 158, y: 292 },
    rotR: { x: EDGE_X - 210, y: 292 },
    rotL: { x: EDGE_X - 254, y: 292 },
    vault: { x: EDGE_X - 96, y: 104 },
  };

  return (
    <div
      ref={rootRef}
      className={`${
        // Phones held sideways always get the whole screen (covers the site nav / dev panel)
        isFullscreen || compactLandscape ? 'fixed inset-0 z-[60] h-[100dvh] w-screen rounded-none border-0' : 'relative w-full h-[calc(100dvh-5rem)] max-md:h-[calc(100dvh-9rem)] rounded-3xl border border-slate-800'
      } overflow-hidden bg-black select-none shadow-2xl`}
    >
      {/* 3D WebGL Canvas */}
      <div ref={mountRef} className="w-full h-full cursor-crosshair" />

      {loadingWorld && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950 text-slate-300 text-sm font-black tracking-widest">
          BUILDING ARENA…
        </div>
      )}

      {/* Damage vignette (never in Ghost Spectator or on the loadout screen) */}
      <div
        className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-150"
        style={{
          opacity: isGhostSpectator || !deployed ? 0 : Math.max(damageFlash, hudStats.alive ? Math.max(0, (40 - hudStats.health) / 60) : 0.8),
          background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(220,38,38,0.75) 100%)',
        }}
      />
      {/* Directional damage indicators */}
      <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
        {damageIndicators.map((d) => (
          <div key={d.id} className="absolute w-64 h-64" style={{ transform: `rotate(${d.angle}rad)` }}>
            <div className="absolute left-1/2 -translate-x-1/2 -top-2 w-16 h-5 rounded-b-full bg-gradient-to-b from-rose-500/90 to-rose-600/0 blur-[1px]" />
          </div>
        ))}
      </div>

      {/* Mobile Touch Aim Surface */}
      {isMobile && (
        <div
          className={`absolute top-16 right-0 bottom-0 ${isGhostSpectator ? 'left-0' : 'left-1/3'} pointer-events-auto touch-none select-none z-10`}
          onTouchStart={handleTouchLookStart}
          onTouchMove={handleTouchLookMove}
          onTouchEnd={handleTouchLookEnd}
          onTouchCancel={handleTouchLookEnd}
        />
      )}

      {/* Reticle: green ● by default; red ( ● ) with lock brackets while the narrow aim-assist lock is on a visible enemy */}
      {!isGhostSpectator && !hudStats.isProp && hudStats.alive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20">
          {!isAdsActive && (
            <div className="absolute w-8 h-8 opacity-70">
              <div className="absolute left-1/2 top-0 -translate-x-1/2 w-0.5 h-2 bg-white/80" />
              <div className="absolute left-1/2 bottom-0 -translate-x-1/2 w-0.5 h-2 bg-white/80" />
              <div className="absolute top-1/2 left-0 -translate-y-1/2 h-0.5 w-2 bg-white/80" />
              <div className="absolute top-1/2 right-0 -translate-y-1/2 h-0.5 w-2 bg-white/80" />
            </div>
          )}
          <div
            data-reticle={targetLocked ? 'locked' : 'free'}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: isAdsActive ? 4 : 5,
              height: isAdsActive ? 4 : 5,
              background: targetLocked ? '#ef4444' : '#22c55e',
              boxShadow: `0 0 4px ${targetLocked ? 'rgba(239,68,68,0.95)' : 'rgba(34,197,94,0.9)'}`,
            }}
          />
          {targetLocked && (
            <svg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" width={isAdsActive ? 26 : 30} height={isAdsActive ? 26 : 30} viewBox="0 0 30 30" aria-hidden="true">
              <path d="M10 5 A11 11 0 0 0 10 25" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" />
              <path d="M20 5 A11 11 0 0 1 20 25" fill="none" stroke="#ef4444" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          )}
          {hitMarker && (
            <div className={`absolute w-7 h-7 ${hitMarker.kill ? 'text-rose-500' : hitMarker.head ? 'text-amber-300' : 'text-white'}`}>
              <div className="absolute left-1/2 top-1/2 w-6 h-0.5 bg-current -translate-x-1/2 -translate-y-1/2 rotate-45" />
              <div className="absolute left-1/2 top-1/2 w-6 h-0.5 bg-current -translate-x-1/2 -translate-y-1/2 -rotate-45" />
            </div>
          )}
        </div>
      )}

      {/* Prop Disguise banner */}
      {hudStats.isProp && (
        <div className="absolute top-24 left-1/2 transform -translate-x-1/2 pointer-events-none z-30">
          <div className="bg-slate-950/60 text-amber-200/90 font-bold text-[11px] px-3 py-1 rounded-full border border-amber-400/30 flex items-center gap-1.5 whitespace-nowrap">
            <span>🎭 {hudStats.propName ?? 'Prop'}</span>
            <span className="text-slate-400">• {isMobile ? '‹ › rotate • PROP to revert' : 'Q / E rotate • C to revert'}</span>
          </div>
        </div>
      )}

      {videoAd &&
        (adCfg?.adMode === 'live' && adCfg.directLink ? (
          <DirectLinkAdModal seconds={videoAd === 'video_15s' ? 15 : 30} onClose={() => setVideoAd(null)} onResult={applyEcResult} />
        ) : (
          <RewardedVideoModal format={videoAd} onClose={() => setVideoAd(null)} onResult={applyEcResult} />
        ))}

      {/* Medkit cast progress (4 s, stand still) */}
      {hudStats.medkitCast >= 0 && hudStats.alive && (
        <div className="absolute left-1/2 top-[58%] -translate-x-1/2 z-30 pointer-events-none flex flex-col items-center gap-1">
          <div className="relative w-14 h-14">
            <svg viewBox="0 0 36 36" className="w-14 h-14 -rotate-90">
              <circle cx="18" cy="18" r="15.5" fill="rgba(2,6,23,0.6)" stroke="rgba(255,255,255,0.15)" strokeWidth="3" />
              <circle cx="18" cy="18" r="15.5" fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${hudStats.medkitCast * 97.4} 97.4`} />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center"><MedkitIcon size={22} /></div>
          </div>
          <div className="text-[10px] font-black text-emerald-300 bg-slate-950/60 px-2 py-0.5 rounded-full">HEALING… DON&apos;T MOVE</div>
        </div>
      )}

      {roundBanner && (
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="bg-amber-400 text-slate-950 font-black text-sm px-6 py-3 rounded-2xl shadow-2xl border-2 border-white animate-bounce">{roundBanner}</div>
        </div>
      )}

      {/* Death overlay */}
      {!hudStats.alive && !isGhostSpectator && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-950/80 border border-rose-500/60 rounded-3xl px-8 py-5 text-center">
            <div className="text-rose-400 font-black text-xl tracking-widest">ELIMINATED — Respawning…</div>
            <div className="text-slate-300 text-xs font-bold mt-1">Back in the fight in {Math.max(1, hudStats.respawnIn)}s</div>
            {!isBotMode && (
              <div className="mt-2 text-xs font-bold text-emerald-300 font-mono" data-death-summary>
                {t('econ.death.summary', { kills: hudStats.kills, v: formatCoinsAndUsd(hudStats.earningsMicroUsd) })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Center top: single slim status row, then the video-ad EC recharge row strictly below it */}
      <div
        className={`absolute -translate-x-1/2 z-20 pointer-events-none flex flex-col items-center gap-1.5 ${compactLandscape ? 'top-3' : 'top-4'}`}
        // Phones: centre in the gap between the minimap (~112 px) and the K/D + weapon panel (~335 px)
        style={{ left: isMobile ? 'calc(50% - 110px)' : '50%' }}
      >
        <div
          className={`flex flex-nowrap items-center whitespace-nowrap rounded-full bg-slate-950/30 backdrop-blur-[2px] border border-white/10 font-black text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.7)] ${
            isMobile ? 'h-[26px] px-2.5 gap-2 text-[10px]' : 'h-8 px-3.5 gap-3 text-[11px]'
          }`}
        >
          {!isGhostSpectator && (
            <span className="flex items-center gap-1.5">
              <span className="text-slate-300/80">HP</span>
              <span className={`${isMobile ? 'w-12' : 'w-20'} h-1.5 bg-white/15 rounded-full overflow-hidden`}>
                <span
                  className={`block h-full transition-all duration-300 ${hudStats.health > 50 ? 'bg-emerald-400' : hudStats.health > 25 ? 'bg-amber-400' : 'bg-rose-500'}`}
                  style={{ width: `${hudStats.health}%` }}
                />
              </span>
              <span className="tabular-nums">{hudStats.health}</span>
            </span>
          )}
          <span className="w-px h-3 bg-white/15" />
          {connectionStatus === 'connected' ? (
            <span className="flex items-center gap-1 text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {MODE_SHORT[mode]}
            </span>
          ) : isBotMode ? (
            <span className="flex items-center gap-1 text-amber-300" title={`${hudStats.botsAlive} bots alive`}>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {connectionStatus === 'solo_bots' ? 'SOLO BOT' : 'OFFLINE BOT'}
              {!isMobile && <span className="text-amber-200/60">• {hudStats.botsAlive} alive</span>}
            </span>
          ) : isGhostSpectator ? (
            <span className="text-purple-300">👻 SPECTATOR</span>
          ) : (
            <span className="flex items-center gap-1 text-sky-300">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
              CONNECTING…
            </span>
          )}
          {deployed && !isGhostSpectator && (
            <>
              <span className="w-px h-3 bg-white/15" />
              <span className={hudStats.stance === 'prone' ? 'text-lime-300' : hudStats.stance === 'crouch' ? 'text-slate-100' : 'text-slate-300/80'}>
                {hudStats.isProp ? 'PROP' : hudStats.stance === 'prone' ? 'PRONE' : hudStats.stance === 'crouch' ? 'CROUCH' : 'STAND'}
                {hudStats.leanDir !== 0 && <span className="text-sky-300"> {hudStats.leanDir < 0 ? '◀' : '▶'}</span>}
              </span>
            </>
          )}
          <span className="w-px h-3 bg-white/15" />
          <span className="text-yellow-300">
            ⚡ {hudStats.energyTickets} / {hudStats.maxEnergyTickets} EC • {(Math.floor(hudStats.ecProgress * 10) / 10).toFixed(1)}%{pendingBanners > 0 ? ` (+${pendingBanners} ad${pendingBanners > 1 ? 's' : ''} pending)` : ''}
          </span>
          {ecToast && <span className="text-[10px] font-semibold text-yellow-200/70">{ecToast}</span>}
          {hudStats.isGhost && <span className="text-purple-300 animate-pulse">👻 GHOST</span>}
        </div>
        {(isBotMode || isGhostSpectator) && (deployed || isGhostSpectator) && <RechargeVideoButtons compact={isMobile} onPick={openVideoAd} />}
        {isGhostSpectator && !compactLandscape && (
          <div className="bg-slate-950/90 backdrop-blur-md border border-indigo-500/50 px-4 py-2 rounded-2xl flex items-center space-x-3 shadow-lg shadow-indigo-500/20 pointer-events-auto">
            <QuestSpectateIcon size={22} className="animate-pulse" />
            <div>
              <div className="flex items-center justify-between space-x-3 text-xs font-black">
                <span className="text-indigo-300">DAILY QUEST: SPECTATE 90s</span>
                <span className="text-amber-400 font-mono">{Math.min(90, spectatorSeconds)}s / 90s</span>
              </div>
              <div className="w-36 bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${spectatorQuestCompleted ? 'bg-emerald-400' : 'bg-indigo-500'}`}
                  style={{ width: `${Math.min(100, Math.round((spectatorSeconds / 90) * 100))}%` }}
                />
              </div>
            </div>
            {spectatorQuestCompleted && (
              <span className="bg-emerald-500 text-slate-950 font-black text-[10px] px-2 py-0.5 rounded-md animate-bounce">READY TO CLAIM!</span>
            )}
          </div>
        )}

      </div>

      {/* Top HUD */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none z-20">
        {/* Left column: minimap → latest status line → Top-5 leaderboard (separate stacked slots, never overlap) */}
        <div className={`flex flex-col items-start gap-1 ${compactLandscape ? 'max-w-[26%]' : 'max-w-[30%]'}`}>
          {(deployed || isGhostSpectator) && (
            <canvas
              ref={minimapRef}
              width={230}
              height={230}
              aria-label="Tactical minimap"
              className={`${compactLandscape ? 'w-[96px] h-[96px]' : 'w-[115px] h-[115px]'} shrink-0 rounded-[14px] border border-white/25 shadow-xl bg-slate-900/40`}
            />
          )}
          {/* Single latest status line: replaces the previous one instantly, fades + unmounts after 10 s */}
          <div className="min-h-[16px]">
            {toast && (
              <div
                key={toast.id}
                className={`pl-1 text-xs leading-snug text-slate-300/75 [text-shadow:0_1px_2px_rgba(0,0,0,0.85)] transition-opacity duration-700 ${toastFading ? 'opacity-0' : 'opacity-100'}`}
              >
                {toast.text}
              </div>
            )}
          </div>
          {/* Free-for-all kill leaderboard (Top 5) — faint text, no box */}
          {isBotMode && deployed && hudStats.leaderboard.length > 0 && (
            <div className="pl-1 text-[11px] text-slate-300/60 leading-[1.35] font-semibold" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
              {hudStats.leaderboard.map((r, i) => (
                <div key={r.name} className={r.name === 'You' ? 'text-amber-200/70' : undefined}>
                  {i + 1}. {r.name} — {r.kills}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2 pointer-events-auto mr-11">
          <div className={`bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-2xl flex items-center text-right shadow-xl ${isMobile ? 'p-2 space-x-2' : 'p-3 sm:p-3.5 space-x-4'}`}>
            {isBotMode ? (
              <div>
                <span className="text-[10px] text-slate-400 font-bold block uppercase">Payout</span>
                <span className="text-xs sm:text-sm font-black text-amber-300 font-mono">EC ONLY</span>
              </div>
            ) : (
              <div data-hud-round-earned>
                <span className="text-[10px] text-slate-400 font-bold block uppercase">{t('econ.hud.roundEarned')}</span>
                <span className="text-sm sm:text-base font-black text-emerald-400 font-mono block leading-tight">{formatCoins2(hudStats.earningsMicroUsd)}</span>
                <span className="text-[10px] font-bold text-emerald-300/70 font-mono block leading-tight">{formatUsdPrecise(hudStats.earningsMicroUsd)}</span>
              </div>
            )}
            {!isBotMode && (
              <div className="border-l border-slate-800 pl-3" title={t('econ.hud.bountyHint')} data-hud-head-bounty>
                <span className="text-[10px] text-slate-400 font-bold block uppercase">{t('econ.hud.headBounty')}</span>
                <span className="text-sm sm:text-base font-black text-rose-300 font-mono block leading-tight">{formatCoins2(hudStats.bountyMicroUsd)}</span>
                <span className="text-[10px] font-bold text-rose-200/70 font-mono block leading-tight">{formatUsdPrecise(hudStats.bountyMicroUsd)}</span>
                {hudStats.ticketMicroUsd > 0 && (
                  <span className="text-[9px] font-bold text-amber-300/80 font-mono block leading-tight" title={t('econ.hud.ticketHint')} data-hud-ticket>
                    {t('econ.hud.ticket', { v: formatCoins2(hudStats.ticketMicroUsd) })}
                  </span>
                )}
              </div>
            )}
            <div className="border-l border-slate-800 pl-3">
              <span className="text-[10px] text-slate-400 font-bold block uppercase">K / D</span>
              <span className="text-sm sm:text-base font-black text-white">
                {hudStats.kills} / {hudStats.deaths}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleMute}
              className="bg-slate-900/90 hover:bg-slate-800 border border-slate-700 w-9 h-9 rounded-xl text-white flex items-center justify-center transition shadow-md active:scale-95"
              title={isMuted ? 'Unmute Sound' : 'Mute Sound'}
              aria-label={isMuted ? 'Unmute sound' : 'Mute sound'}
            >
              {isMuted ? <SpeakerOffIcon /> : <SpeakerOnIcon />}
            </button>
          </div>
        </div>
      </div>

      {/* Sniper scope overlay */}
      {scoped && !hudStats.isProp && hudStats.alive && (
        <div className="pointer-events-none absolute inset-0 z-20">
          <div
            className="absolute inset-0"
            style={{ background: 'radial-gradient(circle at center, rgba(0,0,0,0) 0, rgba(0,0,0,0) min(38vh,38vw), rgba(0,0,0,0.96) calc(min(38vh,38vw) + 2px))' }}
          />
          <div className="absolute left-1/2 top-[10%] bottom-[10%] w-px -translate-x-1/2 bg-black/85" />
          <div className="absolute top-1/2 left-[10%] right-[10%] h-px -translate-y-1/2 bg-black/85" />
          <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-rose-500" />
          {[1, 2, 3].map((i) => (
            <div key={i} className="absolute left-1/2 h-px w-4 -translate-x-1/2 bg-black/85" style={{ top: `calc(50% + ${i * 4}vh)` }} />
          ))}
        </div>
      )}

      {/* Pickup prompt */}
      {hudStats.pickupPrompt && hudStats.alive && !hudStats.isProp && (
        <div className="pointer-events-none absolute left-1/2 top-[62%] -translate-x-1/2 z-20">
          <div className="bg-slate-950/85 border border-amber-400/70 text-amber-200 text-xs font-black px-3 py-1.5 rounded-xl shadow-lg">{hudStats.pickupPrompt}</div>
        </div>
      )}

      {/* Compact top-right weapon switcher: Primary · Pistol · Frag · Drop + live ammo (keeps the thumb area clear) */}
      {!isGhostSpectator && !hudStats.isProp && deployed && hudStats.alive && (
        <div className={`absolute right-4 z-20 pointer-events-auto flex flex-col items-end gap-1 ${compactLandscape ? 'top-[4.1rem] scale-90 origin-top-right' : 'top-[5.4rem]'}`}>
          <div className="flex items-stretch gap-1 bg-slate-950/70 border border-slate-700/70 backdrop-blur-md rounded-2xl p-1 shadow-xl">
            {SLOT_KEYS.map((sl) => (
              <button
                key={sl.slot}
                onClick={() => equipRef.current(sl.slot)}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  equipRef.current(sl.slot);
                }}
                disabled={!sl.label}
                className={`px-2 py-1 rounded-xl text-[9px] font-black leading-tight text-center min-w-[46px] border transition ${
                  hudStats.slot === sl.slot
                    ? 'bg-amber-400 text-slate-950 border-white'
                    : sl.label
                      ? 'bg-slate-900/80 text-slate-200 border-slate-700'
                      : 'bg-slate-900/40 text-slate-600 border-slate-800'
                }`}
              >
                <div>{sl.slot === 'grenade' ? `${sl.key} · FRAG` : `${sl.key} · ${sl.label ?? '—'}`}</div>
                {sl.label && <div className="font-mono opacity-80">{sl.ammo}</div>}
              </button>
            ))}
            <button
              onClick={() => throwWeaponRef.current()}
              onTouchStart={(e) => {
                e.stopPropagation();
                e.preventDefault();
                throwWeaponRef.current();
              }}
              title="Drop / throw weapon (G)"
              aria-label="Drop weapon"
              className="px-2 rounded-xl bg-slate-900/80 border border-slate-700 text-slate-200 flex flex-col items-center justify-center active:scale-95"
            >
              <DropIcon />
              <span className="text-[8px] font-black">DROP</span>
            </button>
            {!isMobile && (
              <button
                onClick={() => medkitRef.current()}
                title="Use medkit (4) — 4 s, stand still"
                aria-label="Use medkit"
                className={`px-2 rounded-xl border flex flex-col items-center justify-center text-[8px] font-black ${hudStats.medkits > 0 ? 'bg-slate-900/80 border-emerald-500/50 text-emerald-200' : 'bg-slate-900/40 border-slate-800 text-slate-600'}`}
              >
                <MedkitIcon size={16} />
                <span>4 · ×{hudStats.medkits}</span>
              </button>
            )}
          </div>
          <div className="bg-slate-950/70 border border-slate-700/70 backdrop-blur-md rounded-xl px-2.5 py-0.5 text-right shadow-xl">
            {hudStats.slot === 'grenade' ? (
              <div className="font-mono font-black text-lg leading-tight text-white">FRAG × {hudStats.grenades}</div>
            ) : (
              <div className={`font-mono font-black text-lg leading-tight ${hudStats.ammo <= 3 ? 'text-rose-400' : 'text-white'}`}>
                {hudStats.reloading ? 'RELOAD' : hudStats.ammo}
                <span className={`text-xs ${hudStats.reserve === 0 ? 'text-rose-400' : 'text-slate-400'}`}> / {hudStats.reserve}</span>
              </div>
            )}
          </div>
          {hudStats.pickupPrompt && (
            <button
              onClick={() => pickupRef.current()}
              onTouchStart={(e) => {
                e.stopPropagation();
                e.preventDefault();
                pickupRef.current();
              }}
              className="bg-amber-500 text-slate-950 border border-white text-[10px] font-black px-2.5 py-1 rounded-lg active:scale-95"
            >
              F · PICK UP
            </button>
          )}
        </div>
      )}

      {/* Pre-deploy loadout (primary weapon + operator avatar) */}
      {showLoadout && (
        <LoadoutScreen
          modeLabel={MODE_LABEL[mode]}
          practice={mode === 'practice'}
          isMobile={isMobile}
          primary={loadoutPrimary}
          character={loadoutCharacter}
          portraits={portraits}
          kbLockSupported={kbLockSupported}
          onPrimary={setLoadoutPrimary}
          onCharacter={setLoadoutCharacter}
          onDeploy={deploy}
          respawn={respawnLoadout}
          bottomPad={showAdBanner ? (isMobile ? 80 : 92) : 0}
        />
      )}

      {/* Radial prop disguise wheel (C) */}
      {propMenu.open && (
        <RadialPropMenu
          hover={propMenu.hover}
          cursor={propMenu.cursor}
          current={currentProp}
          onHover={(i) => {
            menuHoverRef.current = i;
            setPropMenu((m) => ({ ...m, hover: i }));
          }}
          onSelect={(id) => selectPropRef.current(id)}
          onClose={closePropMenu}
        />
      )}

      {/* Command bar (/suicide) */}
      {commandOpen && (
        <form
          className="absolute left-1/2 bottom-28 -translate-x-1/2 z-50 w-[min(90vw,420px)]"
          onSubmit={(e) => {
            e.preventDefault();
            commandRef.current(commandText);
            setCommandText('');
            setCommandOpen(false);
            commandOpenRef.current = false;
          }}
        >
          <input
            autoFocus
            value={commandText}
            onChange={(e) => setCommandText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setCommandOpen(false);
                commandOpenRef.current = false;
              }
            }}
            onBlur={() => {
              setCommandOpen(false);
              commandOpenRef.current = false;
            }}
            placeholder="Type a command, e.g. /suicide"
            className="w-full bg-slate-950/90 border border-slate-600 rounded-xl px-3 py-2 text-sm font-mono text-white outline-none focus:border-amber-400"
          />
        </form>
      )}

      {/* Floating status pill when mouse is unlocked */}
      {!isMobile && deployed && isOverlayDismissed && !isPointerLocked && !isGhostSpectator && !propMenu.open && !commandOpen && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <div className="bg-slate-900/90 border border-slate-700/80 backdrop-blur-md px-3.5 py-1.5 rounded-full text-[11px] font-bold text-slate-300 shadow-xl flex items-center gap-2.5">
            <span>{isDragLookMode ? '🖱️ Drag-Look Mode (Hold Left-Click to Aim)' : '⏸ Paused — mouse released'}</span>
            <button onClick={() => engageControls()} className="bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-extrabold px-2.5 py-0.5 rounded-full transition active:scale-95">
              Resume
            </button>
          </div>
        </div>
      )}
      {!isMobile && isPointerLocked && hudStats.keyboardLocked && (
        <div className="absolute bottom-20 left-4 z-20 pointer-events-none text-[10px] font-bold text-sky-300/80 bg-slate-950/60 px-2 py-1 rounded-lg">
          🔒 Browser shortcuts locked (Ctrl+W safe) • Esc to release mouse
        </div>
      )}

      {isGhostSpectator && (
        <div
          data-spectator-hint
          className="absolute bottom-2 left-3 z-20 pointer-events-none text-[11px] font-semibold text-white/60 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]"
        >
          👻 Ghost Spectator • {isMobile ? 'Joystick: Fly • Buttons: Up / Down • Drag: Look' : 'WASD: Fly • Space: Up • Ctrl: Down • Drag: Look'}
        </div>
      )}

      {/* Mobile / Tablet Touch Controls — every button handles its own finger (true multi-touch) */}
      {isMobile && (deployed || isGhostSpectator) && (
        <div
          className={`absolute pointer-events-auto touch-none select-none z-20 ${compactLandscape ? 'bottom-4 left-5' : 'bottom-6 left-6'}`}
          style={liftForAd ? { marginBottom: 58 } : undefined}
        >
          <div
            className={`relative rounded-full border-2 border-white/20 bg-slate-900/50 backdrop-blur-md flex items-center justify-center shadow-2xl active:border-rose-500/50 ${
              compactLandscape ? 'w-28 h-28' : 'w-32 h-32'
            }`}
            onTouchStart={handleJoystickTouchStart}
            onTouchMove={handleJoystickTouchMove}
            onTouchEnd={handleJoystickTouchEnd}
            onTouchCancel={handleJoystickTouchEnd}
          >
            <div className="absolute inset-2 rounded-full border border-dashed border-white/10 pointer-events-none" />
            <div
              className="w-12 h-12 rounded-full bg-gradient-to-tr from-rose-600 to-amber-500 shadow-lg shadow-rose-600/40 border border-white/40 flex items-center justify-center pointer-events-none transition-transform duration-75"
              style={{ transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)` }}
            >
              <div className="w-3.5 h-3.5 rounded-full bg-white/70" />
            </div>
          </div>
          {!isGhostSpectator && deployed && hudStats.alive && !hudStats.isProp && (
            <button
              aria-label="Use medkit"
              onTouchStart={(e) => {
                e.stopPropagation();
                e.preventDefault();
                medkitRef.current();
              }}
              onClick={() => medkitRef.current()}
              className={`absolute bottom-1 rounded-full border flex items-center justify-center backdrop-blur-sm shadow-lg active:scale-95 ${
                compactLandscape ? 'left-[7.6rem] w-11 h-11' : 'left-[8.6rem] w-12 h-12'
              } ${hudStats.medkits > 0 ? 'bg-slate-900/55 border-emerald-400/60' : 'bg-slate-900/35 border-white/20 opacity-70'}`}
            >
              <MedkitIcon size={22} />
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[10px] font-black flex items-center justify-center border border-white/70">
                {hudStats.medkits}
              </span>
            </button>
          )}
        </div>
      )}
      {isGhostSpectator && isMobile && (
        <div className="absolute right-5 bottom-8 z-20 flex flex-col gap-2 pointer-events-auto touch-none select-none" style={showAdBanner ? { marginBottom: 58 } : undefined}>
          {[{ label: 'Fly up', key: 'Space', icon: <JumpIcon /> }, { label: 'Fly down', key: 'ControlLeft', icon: <CrouchIcon /> }].map((b) => (
            <button
              key={b.key}
              aria-label={b.label}
              onTouchStart={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new KeyboardEvent('keydown', { code: b.key }));
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new KeyboardEvent('keyup', { code: b.key }));
              }}
              className="w-12 h-12 rounded-full bg-slate-900/55 border border-white/25 text-white flex items-center justify-center backdrop-blur-sm active:bg-white/30"
            >
              {b.icon}
            </button>
          ))}
        </div>
      )}

      {isMobile && deployed && !isGhostSpectator && hudStats.alive && (
        <div
          className="absolute right-0 bottom-0 z-20 pointer-events-none select-none origin-bottom-right"
          style={{ width: PAD_W, height: PAD_H, transform: compactLandscape ? 'scale(0.82)' : undefined, marginBottom: liftForAd ? 58 : 0 }}
        >
          {/* FIRE: open right-thumb zone left of the Jump / Crouch column — hold to shoot, drag the same finger to aim */}
          <button
            aria-label="Fire (drag to aim)"
            onTouchStart={onFireTouchStart}
            onTouchMove={onFireTouchMove}
            onTouchEnd={onFireTouchEnd}
            onTouchCancel={onFireTouchEnd}
            className="absolute pointer-events-auto touch-none rounded-full bg-rose-600/55 border-[3px] border-white/70 text-white flex items-center justify-center shadow-2xl shadow-rose-600/40 backdrop-blur-sm active:bg-rose-500/80 active:scale-95 transition"
            style={{ left: PAD.fire.x - 44, top: PAD.fire.y - 44, width: 88, height: 88 }}
          >
            <BulletIcon size={38} />
          </button>
          {(hudStats.isProp
            ? [
                { k: 'jump', at: PAD.jump, icon: <JumpIcon />, label: 'Jump', act: () => triggerJumpRef.current?.() },
                { k: 'prop', at: PAD.prop, icon: <CrateIcon />, label: 'Leave disguise', act: () => togglePropRef.current?.(), on: true },
                { k: 'rotR', at: PAD.rotR, small: true, icon: <ChevronRightIcon />, label: 'Rotate prop right', hold: -1 as const },
                { k: 'rotL', at: PAD.rotL, small: true, icon: <ChevronLeftIcon />, label: 'Rotate prop left', hold: 1 as const },
              ]
            : [
                { k: 'reload', at: PAD.reload, icon: <ReloadIcon />, label: 'Reload', act: () => reloadRef.current?.() },
                { k: 'nade', at: PAD.nade, icon: <GrenadeIcon />, label: 'Throw grenade', act: () => quickGrenadeRef.current() },
                { k: 'jump', at: PAD.jump, icon: <JumpIcon />, label: stanceUi === 'stand' ? 'Jump' : 'Stand up', act: () => triggerJumpRef.current?.() },
                { k: 'crouch', at: PAD.crouch, icon: <CrouchIcon />, label: 'Crouch', act: () => setStanceRef.current(stanceRef.current === 'crouch' ? 'stand' : 'crouch'), on: stanceUi === 'crouch' },
                { k: 'prone', at: PAD.prone, icon: <ProneIcon />, label: 'Prone', act: () => setStanceRef.current(stanceRef.current === 'prone' ? 'stand' : 'prone'), on: stanceUi === 'prone' },
                { k: 'ads', at: PAD.ads, icon: <ScopeIcon />, label: 'Aim down sights', act: () => setIsAdsActive((v) => !v), on: isAdsActive },
                { k: 'prop', at: PAD.prop, icon: <CrateIcon />, label: 'Prop disguise', act: () => togglePropRef.current?.() },
                ...(canVault ? [{ k: 'vault', at: PAD.vault, icon: <VaultIcon />, label: 'Vault through window', act: () => vaultWindowRef.current(), on: true }] : []),
              ]
          ).map((b) => {
            const size = 'small' in b && b.small ? 40 : 50;
            const hold = 'hold' in b ? b.hold : 0;
            return (
              <button
                key={b.k}
                aria-label={b.label}
                title={b.label}
                data-btn={b.k}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  if (hold) propRotateRef.current = hold;
                  else if ('act' in b && b.act) b.act();
                }}
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  if (hold) propRotateRef.current = 0;
                }}
                onTouchCancel={() => {
                  if (hold) propRotateRef.current = 0;
                }}
                className={`absolute pointer-events-auto touch-none rounded-full border flex items-center justify-center backdrop-blur-sm shadow-lg active:scale-95 transition ${
                  'on' in b && b.on ? 'bg-amber-400/85 text-slate-950 border-white' : 'bg-slate-900/45 text-white border-white/30 active:bg-white/30'
                }`}
                style={{ left: b.at.x - size / 2, top: b.at.y - size / 2, width: size, height: size }}
              >
                {b.icon}
              </button>
            );
          })}
        </div>
      )}

      {/* Compact bottom banner ad slot — Solo Bot / Practice and Ghost Spectator only (never paid PvP) */}
      {showAdBanner && chargeGuard.paused && <ChargePausedModal reason={chargeGuard.paused} onResume={chargeGuard.resume} />}

      {showAdBanner && !bannerPaused && (
        <div className={`absolute bottom-0 left-1/2 -translate-x-1/2 ${showLoadout ? 'z-[45]' : 'z-[15]'} pointer-events-auto flex flex-col items-center`}>
          {showLoadout && (
            <div className="mb-1 text-[11px] font-black text-yellow-300 drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] whitespace-nowrap">
              ⚡ {hudStats.energyTickets} / {hudStats.maxEnergyTickets} EC • {(Math.floor(hudStats.ecProgress * 10) / 10).toFixed(1)}%{pendingBanners > 0 ? ` (+${pendingBanners} ad${pendingBanners > 1 ? 's' : ''} pending)` : ''}
              {ecToast && <span className="ml-2 font-semibold text-yellow-200/70">{ecToast}</span>}
            </div>
          )}
          {adCfg?.adMode === 'live' && adCfg.adsterraEnabled && adCfg.banner320x50 ? (
            // Live: real Adsterra 320×50 in a sandboxed iframe; random 30–45 s visible-tab impression ping → EC
            <AdsterraBanner spec={adCfg.banner320x50} pingSlot="adsterra_320x50" onResult={applyEcResult} className="bg-slate-950 border border-slate-700/70 border-b-0 rounded-t-lg" />
          ) : (
            <SimulatedAdBanner
              onResult={applyEcResult}
              className={`${isMobile ? 'w-[320px] h-[50px]' : 'w-[468px] h-[60px]'} border border-slate-700/70 border-b-0 rounded-t-lg`}
            />
          )}
        </div>
      )}

      {/* Dedicated fullscreen toggle (never automatic): top-right of the viewport, under the top HUD */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          toggleFullscreen();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        className="absolute top-4 right-4 z-[100] w-9 h-9 rounded-xl bg-slate-900/85 hover:bg-slate-800 border border-slate-600 text-white text-base font-black flex items-center justify-center shadow-lg active:scale-95 transition"
      >
        {isFullscreen ? <ExitFullscreenIcon /> : <EnterFullscreenIcon />}
      </button>

      {/* Anti-AFK Verification Modal */}
      {afkPrompt && (
        <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-amber-500 p-6 rounded-3xl max-w-sm text-center space-y-4 shadow-2xl">
            <h3 className="text-base font-black text-amber-400">⚠️ ANTI-AFK BOT CHECK</h3>
            <p className="text-xs text-slate-300">{afkPrompt}</p>
            <button
              onClick={() => room?.send('afk_captcha_solved')}
              className="w-full bg-amber-500 hover:bg-amber-400 text-slate-950 font-black py-2.5 rounded-xl text-xs transition"
            >
              I AM HERE (VERIFY)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MedkitIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6" width="18" height="14" rx="3" fill="#f8fafc" stroke="#0f172a" strokeWidth="1.2" />
      <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" fill="none" stroke="#f8fafc" strokeWidth="1.6" />
      <path d="M12 9v8M8 13h8" stroke="#e11d48" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
