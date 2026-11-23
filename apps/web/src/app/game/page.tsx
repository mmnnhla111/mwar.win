'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Client as ColyseusClient, Room } from 'colyseus.js';
import { apiFetch, progressQuest } from '../../lib/api';
import { formatMicroUsd } from '@mwar/shared';
import { QuestSpectateIcon } from '../../components/icons';
import { soundFX } from '../../game/audio';
import { CollisionWorld, MoveBody } from '../../game/physics/collision';
import { MaterialLibrary } from '../../game/assets/materials';
import { buildArena } from '../../game/assets/mapLayout';
import { PLAY_HALF } from '../../game/assets/skyAndTerrain';
import { animateBountyChest, createBountyChest } from '../../game/assets/props';
import { Viewmodel } from '../../game/viewmodel';
import { CombatEffects } from '../../game/effects';
import { BotManager } from '../../game/ai/bots';
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
const LOADOUT_STORAGE_KEY = 'mwar_fps_loadout_v2';
const FALL_SAFE_SPEED = 13; // m/s landing speed before fall damage (~3.8 m drop)
const BOT_COUNT = 10; // 8–12 bots
const BOT_ACCURACY = 0.7; // 70 % skill
const PRACTICE_ROUND_GOAL = 10; // eliminations per practice round
const EC_PROGRESS_PER_ROUND = 25; // % of one Energy Ticket recharged per completed round
const EC_STORAGE_KEY = 'mwar_practice_ec_recharge_progress';

type ArenaMode = 'mini_30' | 'standard_100' | 'fast_mini' | 'practice' | 'spectator';

function readMode(): ArenaMode {
  if (typeof window === 'undefined') return 'mini_30';
  const m = new URLSearchParams(window.location.search).get('mode');
  if (m === 'standard_100' || m === 'fast_mini' || m === 'practice' || m === 'spectator') return m;
  return 'mini_30';
}

const MODE_LABEL: Record<ArenaMode, string> = {
  mini_30: '30-PLAYER SKIRMISH',
  standard_100: '100-PLAYER WARZONE',
  fast_mini: 'FAST & MINI MODE',
  practice: 'PRACTICE RANGE / SOLO BOTS',
  spectator: 'GHOST SPECTATOR',
};

interface HudState {
  health: number;
  kills: number;
  deaths: number;
  chests: number;
  earningsMicroUsd: number;
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
    energyTickets: 6,
    maxEnergyTickets: 6,
    roundsCompleted: 0,
    alive: true,
    respawnIn: 0,
    leanDir: 0,
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
  const [damageIndicators, setDamageIndicators] = useState<DamageIndicator[]>([]);
  const [hitMarker, setHitMarker] = useState<{ at: number; kill: boolean; head: boolean } | null>(null);
  const [roundBanner, setRoundBanner] = useState<string | null>(null);
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
  const lookRef = useRef({ yaw: 0, pitch: 0, dx: 0, dy: 0 });
  const togglePropRef = useRef<() => void>(() => {});
  const triggerJumpRef = useRef<() => void>(() => {});
  const reloadRef = useRef<() => void>(() => {});
  const deployRef = useRef<(primary: PrimaryId, character: CharacterId) => void>(() => {});
  const deployedRef = useRef(false);
  const propMenuOpenRef = useRef(false);
  const menuCursorRef = useRef({ x: 0, y: 0 });
  const menuHoverRef = useRef<number | null>(null);
  const selectPropRef = useRef<(id: PropId | null) => void>(() => {});
  const equipRef = useRef<(slot: Slot) => void>(() => {});
  const throwWeaponRef = useRef<() => void>(() => {});
  const pickupRef = useRef<() => void>(() => {});
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
    const isSpectatorMode = mode === 'spectator' || hudStats.isGhost;
    if (!isSpectatorMode) return;
    const timer = setInterval(() => {
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

    const world = new CollisionWorld({ halfSize: PLAY_HALF, stepHeight: 0.45, gravity: -22 });
    const lib = new MaterialLibrary();
    const layout = buildArena(scene, world, lib);
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
    const body: MoveBody = { x: spawn.x, y: 0, z: spawn.z, velY: 0, onGround: true, radius: 0.36, height: 1.78, owner: 'local' };
    const look = lookRef.current;
    look.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
    look.pitch = 0;
    if (isGhostSpectator) camera.position.set(0, 18, 40);

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

    let ecProgress = 0;
    try {
      ecProgress = Number(localStorage.getItem(EC_STORAGE_KEY) || '0') || 0;
    } catch {
      ecProgress = 0;
    }

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

    let roundStartTime = Date.now();
    const awardPracticeProgress = (points: number, reason: string) => {
      // ENERGY RECHARGE RULE: no Micro-USD / coins in solo bot mode — only EC recharge progress.
      player.roundKills += points;
      if (player.roundKills >= PRACTICE_ROUND_GOAL) {
        player.roundKills -= PRACTICE_ROUND_GOAL;
        player.roundsCompleted += 1;
        const roundDurationSeconds = Math.max(15, Math.round((Date.now() - roundStartTime) / 1000));
        roundStartTime = Date.now();

        ecProgress += EC_PROGRESS_PER_ROUND;
        let msg = `⚡ Practice round complete! +${EC_PROGRESS_PER_ROUND}% Energy Ticket recharge`;
        if (ecProgress >= 100) {
          ecProgress -= 100;
          msg = '⚡ +1 ENERGY TICKET (EC) recharged from practice!';
        }
        try {
          localStorage.setItem(EC_STORAGE_KEY, String(ecProgress));
        } catch {
          /* storage unavailable */
        }
        soundFX.playQuestComplete();
        setRoundBanner(msg);
        setTimeout(() => setRoundBanner(null), 3500);
        feed(msg);

        // Sync EC progress and Energy Tickets to Cloudflare D1 & PostgreSQL Audit Logs
        apiFetch('/api/practice/claim-ec', {
          method: 'POST',
          body: JSON.stringify({
            roundKills: 10,
            roundDurationSeconds,
          }),
        })
          .then((res: any) => {
            if (res && res.success) {
              ecProgress = res.energy_progress_pct;
              setHudStats((prev) => ({
                ...prev,
                ecProgress: res.energy_progress_pct,
                energyTickets: res.energy_tickets,
                maxEnergyTickets: res.max_energy_tickets,
              }));
              if (res.ticketAwarded) {
                feed('⚡ +1 ENERGY TICKET (EC) credited to your account!');
              }
            }
          })
          .catch((err) => {
            console.warn('Practice EC claim failed (guest mode or offline):', err.message);
          });
      } else if (reason) {
        feed(reason);
      }
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
      player.respawnTimer = 4;
      player.deathPos.set(body.x, body.y, body.z);
      firingRef.current = false;
      if (player.isProp) setProp(null);
      closePropMenu();
      // Drop the primary where we fell (bots can't use it, but you can grab it back)
      if (inv.primary) dropWeapon(inv.primary, player.deathPos.clone().add(new THREE.Vector3(0.4, 0, 0.2)));
      inv.primary = null;
      if (cause.kind === 'bot') {
        feed(`☠️ You were eliminated by BOT ${cause.name}`);
        return;
      }
      const label = cause.reason === 'grenade' ? 'your own grenade' : cause.reason === 'fall' ? 'a fall' : '/suicide';
      feed(`💀 You died by ${label} — a bounty chest dropped where you fell`);
      if (botMode) spawnDeathChestLocal(player.deathPos);
      else if (currentRoom) currentRoom.send('player_suicide', { cause: cause.reason, x: body.x, y: body.y, z: body.z });
    };
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
        onShot: (from) => soundFX.playEnemyShot(from.distanceTo(camera.position)),
      }, { count: BOT_COUNT, accuracy: BOT_ACCURACY, playerHalf: PLAY_HALF, spawnPoints: layout.spawnPoints });
      setConnectionStatus(reason === 'practice' ? 'solo_bots' : 'offline_practice');
      feed(`🤖 ${BOT_COUNT} AI bots deployed (70% skill)`);
      feed('⚡ ENERGY RECHARGE MODE • No Micro-USD / Coin payouts');
    };

    const onBotKilled = (botId: number, how: string) => {
      if (!bots) return;
      const bot = bots.botById(botId);
      player.kills += 1;
      // Killed opponents drop their primary (glowing pickup, 5-minute despawn). No chest.
      const def = WEAPONS[bot.weapon];
      dropWeapon({ id: bot.weapon, mag: def.magSize, reserve: def.magSize }, new THREE.Vector3(bot.body.x, bot.body.y, bot.body.z));
      awardPracticeProgress(1, `🎯 ${how}Eliminated BOT ${bot.name} (+EC progress • no coins)`);
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
      rp.rig.root.visible = !want;
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
        (window.location.hostname === 'mwar.win' || window.location.hostname.endsWith('.mwar.win') ? 'wss://game.mwar.win' : 'ws://localhost:2567');
      const colyseusClient = new ColyseusClient(colyseusUrl);
      try {
        let meData: any = null;
        try {
          meData = await apiFetch('/api/auth/me');
        } catch {
          // Guest mode
        }
        const roomName = arenaMode === 'standard_100' ? 'standard_100' : 'mini_30';
        // Paid arena: spend 1 EC for a signed entry ticket. Without one you still play, unpaid.
        let entryToken: string | undefined;
        if (meData?.user) {
          try {
            const enter = await apiFetch<{ entryToken: string; energyTickets: number }>('/api/game/enter', {
              method: 'POST',
              body: JSON.stringify({ mode: roomName }),
            });
            entryToken = enter.entryToken;
            setHudStats((prev) => ({ ...prev, energyTickets: enter.energyTickets }));
            feed(`⚡ 1 EC used to enter the paid arena (${enter.energyTickets} left)`);
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
        const joinPromise = colyseusClient.joinOrCreate(roomName, {
          entryToken,
          deviceId,
          userId: meData?.user?.id || `guest_${Math.random().toString(36).substring(2, 6)}`,
          username: meData?.user?.username || `Guest_${Math.floor(Math.random() * 900 + 100)}`,
          avatarId: loadoutCharacter,
          primaryWeapon: loadoutPrimary,
        });
        if (meData?.user) {
          const u = meData.user;
          setHudStats((prev) => ({
            ...prev,
            energyTickets: entryToken ? prev.energyTickets : u.energy_tickets ?? 6,
            maxEnergyTickets: u.max_energy_tickets ?? 6,
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
            const rp: Remote = { rig, target: new THREE.Vector3(p.x, p.y || 0, p.z), yaw: p.rotationY || 0, speed: 0, prop: null, propId: null, stance: validStance(p.stance) };
            remotePlayers.set(key, rp);
            setRemoteProp(key, rp, !!p.isProp, p.propType);
          }
          p.onChange(() => {
            if (key === roomInstance.sessionId) {
              player.hp = p.health;
              setHudStats((prev) => ({
                ...prev,
                health: p.health,
                kills: p.kills,
                chests: p.chestsCollected,
                earningsMicroUsd: p.sessionEarningsMicroUsd,
                isGhost: p.isGhost,
              }));
              if (!p.isProp && player.isProp) setProp(null, false);
            } else {
              const rp = remotePlayers.get(key);
              if (rp) {
                rp.target.set(p.x, p.y || 0, p.z);
                rp.yaw = p.rotationY || 0;
                rp.stance = validStance(p.stance);
                setRemoteProp(key, rp, !!p.isProp, p.propType);
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

        roomInstance.onMessage('player_killed', (data: any) => {
          soundFX.playHitMarker();
          feed(`⚔️ ${data.killerUsername} eliminated ${data.victimUsername} (+$0.10)`);
        });
        roomInstance.onMessage('player_suicide', (data: any) => feed(`💀 ${data.victimUsername} died (${data.cause}) — bounty chest dropped!`));
        roomInstance.onMessage('chest_destroyed', (data: any) => {
          soundFX.playChestPickup();
          feed(`💰 ${data.collectedByUsername} claimed a Bounty Chest!`);
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
            awardPracticeProgress(1, '📦 Death-drop Bounty Chest opened (+EC progress • no coins)');
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
    };

    if (new URLSearchParams(window.location.search).has('debug')) {
      (window as any).__mwar = {
        body,
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
      if (e.code === 'Escape' && propMenuOpenRef.current) closePropMenu();
      if (e.code === 'KeyF' && !e.repeat) {
        // F = pick up a nearby weapon (falls back to fire when nothing is near)
        if (nearestWeapon(2.0) && !player.isProp) pickupRef.current();
        else firingRef.current = true;
      }
      if ((e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyZ') && !e.repeat) cycleStance();
      if (e.code === 'KeyX' && !e.repeat) setStance(stanceRef.current === 'prone' ? 'stand' : 'prone');
      if (e.code === 'KeyG' && !e.repeat) throwWeaponRef.current();
      if (e.code === 'KeyV' && !e.repeat) throwGrenade(true);
      if (e.code === 'Digit1') equip('primary');
      if (e.code === 'Digit2') equip('pistol');
      if (e.code === 'Digit3') equip('grenade');
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

    const respawnPlayer = () => {
      stanceRef.current = 'stand';
      setStanceUi('stand');
      const s = pickSpawn(player.deathPos);
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
      // Server revives the ghost (health, ammo) and accepts the jump to the new spawn point
      currentRoom?.send('player_respawn', { x: body.x, y: body.y, z: body.z, primary: inv.primary?.id });
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

      if (isGhostSpectator) {
        // Free flight, bounded to the arena
        const fly = 12;
        const dir3 = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
        camera.position.addScaledVector(dir3, -mz * fly * dt).addScaledVector(right, mx * fly * dt);
        if (keys.Space) camera.position.y += 8 * dt;
        if (keys.ControlLeft || keys.KeyZ) camera.position.y -= 8 * dt;
        camera.position.y = THREE.MathUtils.clamp(camera.position.y, 1, 80);
        camera.position.x = THREE.MathUtils.clamp(camera.position.x, -PLAY_HALF, PLAY_HALF);
        camera.position.z = THREE.MathUtils.clamp(camera.position.z, -PLAY_HALF, PLAY_HALF);
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
        world.moveBody(body, dx, dz, dt);
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
        if (player.respawnTimer <= 0 && botMode) respawnPlayer();
      } else if (botMode && player.hp < 100 && tSec - player.lastDamageAt > 6) {
        player.hp = Math.min(100, player.hp + 10 * dt);
      }

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

      // --- Network (20 Hz)
      netTimer -= dt;
      if (currentRoom && netTimer <= 0 && active) {
        netTimer = 0.05;
        const key = `${body.x.toFixed(2)},${body.y.toFixed(2)},${body.z.toFixed(2)},${(player.isProp ? player.propYaw : look.yaw).toFixed(2)},${stance}`;
        if (key !== lastSentKey) {
          lastSentKey = key;
          currentRoom.send('player_move', { x: body.x, y: body.y, z: body.z, rotationY: player.isProp ? player.propYaw : look.yaw, stance });
        }
      }

      // --- HUD (10 Hz)
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
          ecProgress,
          roundsCompleted: player.roundsCompleted,
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

  const isGhostSpectator = mode === 'spectator' || hudStats.isGhost;
  const isBotMode = connectionStatus === 'solo_bots' || connectionStatus === 'offline_practice';
  const showLoadout = !deployed && !isGhostSpectator && !loadingWorld;
  const SLOT_KEYS: { slot: Slot; key: string; label: string | null; ammo: string }[] = [
    { slot: 'primary', key: '1', label: hudStats.primaryLabel, ammo: hudStats.primaryAmmo },
    { slot: 'pistol', key: '2', label: hudStats.pistolLabel, ammo: hudStats.pistolAmmo },
    { slot: 'grenade', key: '3', label: hudStats.grenades > 0 ? 'FRAG' : null, ammo: `x${hudStats.grenades}` },
  ];
  const ecRoundPct = Math.min(100, Math.round((hudStats.roundKills / PRACTICE_ROUND_GOAL) * 100));

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

      {/* Damage vignette */}
      <div
        className="pointer-events-none absolute inset-0 z-20 transition-opacity duration-150"
        style={{
          opacity: Math.max(damageFlash, hudStats.alive ? Math.max(0, (40 - hudStats.health) / 60) : 0.8),
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
          className="absolute top-16 right-0 bottom-0 left-1/3 pointer-events-auto touch-none select-none z-10"
          onTouchStart={handleTouchLookStart}
          onTouchMove={handleTouchLookMove}
          onTouchEnd={handleTouchLookEnd}
          onTouchCancel={handleTouchLookEnd}
        />
      )}

      {/* Crosshair (hidden while aiming: the rifle's red-dot sight is centred instead) */}
      {!isGhostSpectator && !hudStats.isProp && hudStats.alive && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20">
          {!isAdsActive && (
            <div className="relative w-8 h-8">
              <div className="absolute left-1/2 top-0 -translate-x-1/2 w-0.5 h-2.5 bg-white/90 shadow" />
              <div className="absolute left-1/2 bottom-0 -translate-x-1/2 w-0.5 h-2.5 bg-white/90 shadow" />
              <div className="absolute top-1/2 left-0 -translate-y-1/2 h-0.5 w-2.5 bg-white/90 shadow" />
              <div className="absolute top-1/2 right-0 -translate-y-1/2 h-0.5 w-2.5 bg-white/90 shadow" />
              <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-1 rounded-full bg-rose-500" />
            </div>
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

      {/* Energy Recharge Mode banner (solo bots — zero cash payout) */}
      {isBotMode && (
        <div className={`absolute left-1/2 -translate-x-1/2 z-20 pointer-events-none ${isMobile ? 'hidden' : 'bottom-4 w-[min(92vw,560px)]'}`}>
          <div className="bg-slate-950/85 border border-amber-400/60 backdrop-blur-md rounded-2xl px-4 py-2 shadow-xl shadow-amber-500/10">
            <div className="text-[11px] font-black text-amber-300 text-center tracking-wide flex items-center justify-center gap-2">
              <span>⚡ ENERGY RECHARGE MODE</span>
              <span className="text-amber-400/60">•</span>
              <span className="text-yellow-300 font-extrabold">EC TICKETS: {hudStats.energyTickets}/{hudStats.maxEnergyTickets}</span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">
                ROUND {hudStats.roundKills}/{PRACTICE_ROUND_GOAL}
              </span>
              <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-amber-400 to-yellow-300 transition-all" style={{ width: `${ecRoundPct}%` }} />
              </div>
              <span className="text-[10px] font-black text-yellow-300 whitespace-nowrap">EC RECHARGE {Math.round(hudStats.ecProgress)}%</span>
            </div>
          </div>
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
            <div className="text-rose-400 font-black text-xl tracking-widest">ELIMINATED</div>
            <div className="text-slate-300 text-xs font-bold mt-1">Respawning in {hudStats.respawnIn}s…</div>
          </div>
        </div>
      )}

      {/* Top HUD */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none z-20">
        <div className="flex flex-col items-start gap-1 max-w-[60%]">
        <div className={`bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-2xl flex flex-wrap items-center shadow-xl pointer-events-auto ${isMobile ? 'p-2 gap-1.5' : 'p-3 sm:p-3.5 gap-3'}`}>
          <div>
            <div className="flex justify-between items-center text-[10px] text-slate-400 font-black uppercase">
              <span>HP</span>
              <span>{hudStats.health}</span>
            </div>
            <div className="w-24 sm:w-32 h-2.5 bg-slate-800 rounded-full overflow-hidden mt-1">
              <div
                className={`h-full transition-all duration-300 ${hudStats.health > 50 ? 'bg-emerald-500' : hudStats.health > 25 ? 'bg-amber-500' : 'bg-rose-600'}`}
                style={{ width: `${hudStats.health}%` }}
              />
            </div>
          </div>
          {connectionStatus === 'connected' ? (
            <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              20Hz MULTIPLAYER • {MODE_LABEL[mode]}
            </span>
          ) : isBotMode ? (
            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              {connectionStatus === 'solo_bots' ? 'SOLO BOT MODE' : 'OFFLINE • SOLO BOTS'} • {hudStats.botsAlive} BOTS ALIVE
            </span>
          ) : (
            <span className="bg-blue-500/20 text-blue-300 border border-blue-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
              CONNECTING…
            </span>
          )}
          {hudStats.leanDir !== 0 && (
            <span className="bg-sky-500/20 text-sky-300 border border-sky-500/40 text-[10px] font-black px-2 py-0.5 rounded-full">
              {hudStats.leanDir < 0 ? '◀ LEAN L' : 'LEAN R ▶'}
            </span>
          )}
          {deployed && !hudStats.isProp && (
            <span
              className={`text-[10px] font-black px-2 py-0.5 rounded-full border ${
                hudStats.stance === 'prone'
                  ? 'bg-lime-500/20 text-lime-300 border-lime-500/40'
                  : hudStats.stance === 'crouch'
                    ? 'bg-slate-600/50 text-slate-100 border-slate-500/50'
                    : 'bg-slate-800/50 text-slate-400 border-slate-700/60'
              }`}
            >
              {hudStats.stance === 'prone' ? '🐍 PRONE' : hudStats.stance === 'crouch' ? '🧎 CROUCH' : '🧍 STAND'}
            </span>
          )}
          <span className="bg-amber-500/20 text-yellow-300 border border-amber-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1">
            <span>⚡ EC:</span>
            <span>{hudStats.energyTickets}/{hudStats.maxEnergyTickets}</span>
            <span className="text-amber-400/80">({Math.round(hudStats.ecProgress)}%)</span>
          </span>
          {hudStats.isGhost && (
            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/40 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">👻 GHOST</span>
          )}
        </div>
        {/* Single latest status line: replaces the previous one instantly, fades + unmounts after 10 s */}
        {toast && (
          <div
            key={toast.id}
            className={`pl-1 text-xs text-slate-300/75 [text-shadow:0_1px_2px_rgba(0,0,0,0.85)] transition-opacity duration-700 ${toastFading ? 'opacity-0' : 'opacity-100'}`}
          >
            {toast.text}
          </div>
        )}
        </div>

        {isGhostSpectator && (
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

        <div className="flex items-center space-x-2 pointer-events-auto mr-11">
          <div className={`bg-slate-950/85 backdrop-blur-md border border-slate-800 rounded-2xl flex items-center text-right shadow-xl ${isMobile ? 'p-2 space-x-2' : 'p-3 sm:p-3.5 space-x-4'}`}>
            {isBotMode ? (
              <div>
                <span className="text-[10px] text-slate-400 font-bold block uppercase">Payout</span>
                <span className="text-xs sm:text-sm font-black text-amber-300 font-mono">EC ONLY</span>
              </div>
            ) : (
              <div>
                <span className="text-[10px] text-slate-400 font-bold block uppercase">Round Earned</span>
                <span className="text-sm sm:text-base font-black text-emerald-400 font-mono">{formatMicroUsd(hudStats.earningsMicroUsd)}</span>
              </div>
            )}
            <div className="border-l border-slate-800 pl-3">
              <span className="text-[10px] text-slate-400 font-bold block uppercase">K / D</span>
              <span className="text-sm sm:text-base font-black text-white">
                {hudStats.kills} / {hudStats.deaths}
              </span>
            </div>
          </div>
          <button
            onClick={toggleMute}
            className="bg-slate-900/90 hover:bg-slate-800 border border-slate-700 p-2.5 rounded-2xl text-xs font-bold transition shadow-md active:scale-95"
            title={isMuted ? 'Unmute Sound' : 'Mute Sound'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
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

      {/* Weapon / ammo HUD (strict limited ammo: MAG / RESERVE) */}
      {!isGhostSpectator && !hudStats.isProp && deployed && (
        <div className={`absolute ${isMobile ? 'top-16 right-4' : 'bottom-16 right-4'} z-20 pointer-events-none flex flex-col items-end gap-1.5`}>
          <div className={`gap-1 ${isMobile ? 'hidden' : 'flex'}`}>
            {SLOT_KEYS.map((s) => (
              <div
                key={s.slot}
                className={`px-2 py-1 rounded-lg border text-[9px] font-black leading-tight text-center min-w-[54px] ${
                  hudStats.slot === s.slot ? 'bg-amber-400 text-slate-950 border-white' : s.label ? 'bg-slate-950/80 text-slate-300 border-slate-700' : 'bg-slate-950/50 text-slate-600 border-slate-800'
                }`}
              >
                <div>
                  {s.key} · {s.label ?? 'EMPTY'}
                </div>
                {s.label && <div className="font-mono opacity-80">{s.ammo}</div>}
              </div>
            ))}
          </div>
          <div className={`bg-slate-950/85 border border-slate-800 backdrop-blur-md rounded-2xl text-right shadow-xl ${isMobile ? 'px-2.5 py-1 scale-90 origin-top-right' : 'px-4 py-2'}`}>
            <div className="text-[10px] font-black text-slate-400 tracking-widest uppercase">{hudStats.weaponName}</div>
            {hudStats.slot === 'grenade' ? (
              <div className="font-mono font-black text-2xl leading-none text-white">💣 {hudStats.grenades}</div>
            ) : (
              <div className={`font-mono font-black text-2xl leading-none ${hudStats.ammo <= 3 ? 'text-rose-400' : 'text-white'}`}>
                {hudStats.reloading ? 'RELOAD' : hudStats.ammo}
                <span className={`text-sm ${hudStats.reserve === 0 ? 'text-rose-400' : 'text-slate-400'}`}> / {hudStats.reserve}</span>
              </div>
            )}
            {hudStats.slot !== 'grenade' && hudStats.ammo === 0 && hudStats.reserve === 0 && !hudStats.reloading && (
              <div className="text-[9px] font-black text-rose-400">EMPTY — G to discard, F to pick up</div>
            )}
          </div>
          <div className="flex gap-1 pointer-events-auto">
            <button
              onClick={() => throwWeaponRef.current()}
              onTouchStart={(e) => {
                e.stopPropagation();
                throwWeaponRef.current();
              }}
              className="bg-slate-900/90 hover:bg-slate-800 border border-slate-600 text-[10px] font-black text-slate-200 px-2.5 py-1 rounded-lg active:scale-95"
            >
              G · DROP
            </button>
            {hudStats.pickupPrompt && (
              <button
                onClick={() => pickupRef.current()}
                onTouchStart={(e) => {
                  e.stopPropagation();
                  pickupRef.current();
                }}
                className="bg-amber-500 text-slate-950 border border-white text-[10px] font-black px-2.5 py-1 rounded-lg active:scale-95"
              >
                F · PICKUP
              </button>
            )}
          </div>
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
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <div className="bg-purple-950/90 border border-purple-500/60 backdrop-blur-md px-4 py-1.5 rounded-full text-xs font-bold text-purple-200 shadow-xl flex items-center gap-2">
            <span>👻 GHOST SPECTATOR</span>
            <span className="text-slate-400">•</span>
            <span className="text-[11px] text-purple-300 font-mono">WASD: Fly | Space: Up | Ctrl: Down | Drag: Look</span>
          </div>
        </div>
      )}

      {/* Mobile / Tablet Touch Controls — every button handles its own finger (true multi-touch) */}
      {isMobile && deployed && (
        <>
          <div className={`absolute pointer-events-auto touch-none select-none z-20 ${compactLandscape ? 'bottom-4 left-5' : 'bottom-6 left-6'}`}>
            <div
              className={`relative rounded-full border-2 border-white/20 bg-slate-900/60 backdrop-blur-md flex items-center justify-center shadow-2xl active:border-rose-500/50 ${
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
          </div>

          {/* Prop rotation (only while disguised): hold to turn the prop, camera keeps orbiting freely */}
          {hudStats.isProp && (
            <div className={`absolute z-20 pointer-events-auto touch-none select-none flex gap-2 ${compactLandscape ? 'bottom-36 left-5' : 'bottom-44 left-6'}`}>
              {([1, -1] as const).map((dir) => (
                <button
                  key={dir}
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    propRotateRef.current = dir;
                  }}
                  onTouchEnd={(e) => {
                    e.stopPropagation();
                    propRotateRef.current = 0;
                  }}
                  onTouchCancel={() => {
                    propRotateRef.current = 0;
                  }}
                  aria-label={dir === 1 ? 'Rotate prop counter-clockwise' : 'Rotate prop clockwise'}
                  className="w-12 h-12 rounded-2xl bg-slate-900/80 active:bg-amber-500 active:text-slate-950 text-white text-xl font-black flex items-center justify-center shadow-lg border border-amber-400/40"
                >
                  {dir === 1 ? '‹' : '›'}
                </button>
              ))}
            </div>
          )}

          <div
            className={`absolute pointer-events-auto touch-none flex select-none z-20 ${
              compactLandscape ? 'bottom-2 right-3 flex-row-reverse items-end gap-2 scale-[0.85] origin-bottom-right' : 'bottom-6 right-4 flex-col items-end gap-2 opacity-80'
            }`}
          >
            <button
              onTouchStart={(e) => {
                e.stopPropagation();
                firingRef.current = true;
              }}
              onTouchEnd={(e) => {
                e.stopPropagation();
                firingRef.current = false;
              }}
              onTouchCancel={() => {
                firingRef.current = false;
              }}
              className={`${compactLandscape ? 'w-[4.5rem] h-[4.5rem]' : 'w-20 h-20 order-last'} rounded-3xl bg-gradient-to-tr from-rose-600 via-rose-500 to-amber-500 active:scale-95 text-white font-black text-base flex flex-col items-center justify-center shadow-2xl shadow-rose-600/50 border-2 border-white/60 transition`}
            >
              <span>🔥</span>
              <span className="text-[11px] tracking-wider">FIRE</span>
            </button>
            <div className="flex flex-col items-end gap-2">
              {!hudStats.isProp && (
                <div className="flex items-center gap-1.5">
                  {SLOT_KEYS.map((sl) => (
                    <button
                      key={sl.slot}
                      onTouchStart={(e) => {
                        e.stopPropagation();
                        equipRef.current(sl.slot);
                      }}
                      className={`h-9 px-2 rounded-xl text-[10px] font-black border shadow ${
                        hudStats.slot === sl.slot ? 'bg-amber-400 text-slate-950 border-white' : 'bg-slate-900/80 text-white border-slate-700'
                      }`}
                    >
                      {sl.key} {sl.label ?? '—'}
                    </button>
                  ))}
                  <button
                    onTouchStart={(e) => {
                      e.stopPropagation();
                      quickGrenadeRef.current();
                    }}
                    className="h-9 px-2 rounded-xl text-[10px] font-black border shadow bg-emerald-800/90 text-white border-emerald-500/60"
                  >
                    💣 V
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                {!hudStats.isProp &&
                  (['left', 'right'] as const).map((side) => (
                    <button
                      key={side}
                      onTouchStart={(e) => {
                        e.stopPropagation();
                        setLeanState((prev) => (prev === side ? 'none' : side));
                      }}
                      className={`w-11 h-11 rounded-xl text-xs font-black flex items-center justify-center shadow-md border transition ${
                        leanState === side ? 'bg-amber-500 text-slate-950 border-white' : 'bg-slate-900/80 text-white border-slate-700'
                      }`}
                    >
                      {side === 'left' ? '◀ Q' : 'E ▶'}
                    </button>
                  ))}
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setIsAdsActive((prev) => !prev);
                  }}
                  className={`w-12 h-12 rounded-2xl text-xs font-black flex items-center justify-center shadow-lg border transition ${
                    isAdsActive ? 'bg-emerald-500 text-slate-950 border-white shadow-emerald-500/50 scale-105' : 'bg-slate-900/80 text-white border-slate-700'
                  }`}
                >
                  🎯 ADS
                </button>
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    reloadRef.current?.();
                  }}
                  className="w-12 h-12 rounded-2xl bg-slate-800/90 text-white font-black text-xs flex items-center justify-center shadow-lg border border-slate-600 active:scale-95 transition"
                >
                  🔄 R
                </button>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    togglePropRef.current?.();
                  }}
                  className="w-12 h-12 rounded-2xl bg-amber-600/90 active:bg-amber-500 text-white font-black text-xs flex items-center justify-center shadow-lg border border-amber-400/50 active:scale-95 transition"
                >
                  📦 PROP
                </button>
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setStanceRef.current(stanceRef.current === 'crouch' ? 'stand' : 'crouch');
                  }}
                  className={`w-12 h-12 rounded-2xl text-[10px] font-black flex flex-col items-center justify-center shadow-lg border transition ${
                    stanceUi === 'crouch' ? 'bg-amber-500 text-slate-950 border-white scale-105' : 'bg-slate-900/80 text-white border-slate-700'
                  }`}
                >
                  <span>🧎</span>
                  <span>CROUCH</span>
                </button>
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    setStanceRef.current(stanceRef.current === 'prone' ? 'stand' : 'prone');
                  }}
                  className={`w-12 h-12 rounded-2xl text-[10px] font-black flex flex-col items-center justify-center shadow-lg border transition ${
                    stanceUi === 'prone' ? 'bg-lime-500 text-slate-950 border-white scale-105' : 'bg-slate-900/80 text-white border-slate-700'
                  }`}
                >
                  <span>🐍</span>
                  <span>นอนราบ</span>
                </button>
                <button
                  onTouchStart={(e) => {
                    e.stopPropagation();
                    triggerJumpRef.current?.();
                  }}
                  className="w-12 h-12 rounded-2xl bg-indigo-600/90 active:bg-indigo-500 text-white font-black text-[10px] flex flex-col items-center justify-center shadow-lg border border-indigo-400/50 active:scale-95 transition"
                >
                  <span>⬆️</span>
                  <span>{stanceUi === 'stand' ? 'JUMP' : 'STAND'}</span>
                </button>
              </div>
            </div>
          </div>
        </>
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
        {isFullscreen ? '🗗' : '⛶'}
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
