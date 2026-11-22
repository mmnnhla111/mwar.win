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
import { animateBountyChest, createBountyChest, createWoodenCrate } from '../../game/assets/props';
import { Viewmodel } from '../../game/viewmodel';
import { CombatEffects } from '../../game/effects';
import { BotManager } from '../../game/ai/bots';
import { createSoldier, animateSoldier, SoldierRig } from '../../game/ai/soldier';
import { BrowserGuard, keyboardLockSupported } from '../../game/input/browserGuard';

// ----------------------------------------------------------------------------
// Tuning constants
// ----------------------------------------------------------------------------
const STAND_EYE = 1.62;
const CROUCH_EYE = 1.05;
const LEAN_DISTANCE = 0.65; // metres sideways along the camera's horizontal right vector
const LEAN_ROLL = THREE.MathUtils.degToRad(12);
const LEAN_WALL_MARGIN = 0.28;
const HIP_FOV = 75;
const ADS_FOV = 48;
const MAG_SIZE = 30;
const FIRE_INTERVAL = 0.1; // 600 RPM
const RELOAD_TIME = 2.1;
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
  reloading: boolean;
  botsAlive: number;
  roundKills: number;
  ecProgress: number;
  roundsCompleted: number;
  alive: boolean;
  respawnIn: number;
  leanDir: -1 | 0 | 1;
  crouching: boolean;
  keyboardLocked: boolean;
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
    ammo: MAG_SIZE,
    reloading: false,
    botsAlive: 0,
    roundKills: 0,
    ecProgress: 0,
    roundsCompleted: 0,
    alive: true,
    respawnIn: 0,
    leanDir: 0,
    crouching: false,
    keyboardLocked: false,
  });
  const [killFeed, setKillFeed] = useState<string[]>([]);
  const [afkPrompt, setAfkPrompt] = useState<string | null>(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'offline_practice' | 'solo_bots'>('connecting');
  const [loadingWorld, setLoadingWorld] = useState(true);
  const [damageFlash, setDamageFlash] = useState(0);
  const [damageIndicators, setDamageIndicators] = useState<DamageIndicator[]>([]);
  const [hitMarker, setHitMarker] = useState<{ at: number; kill: boolean; head: boolean } | null>(null);
  const [roundBanner, setRoundBanner] = useState<string | null>(null);
  const [kbLockSupported, setKbLockSupported] = useState(false);

  // Interactive UI Overlay & Controls Mode States
  const [isOverlayDismissed, setIsOverlayDismissed] = useState(false);
  const [isDragLookMode, setIsDragLookMode] = useState(false);
  const [isAdsActive, setIsAdsActive] = useState(false);
  const [isCrouchActive, setIsCrouchActive] = useState(false);
  const [leanState, setLeanState] = useState<'none' | 'left' | 'right'>('none');
  const [joystickPos, setJoystickPos] = useState({ x: 0, y: 0 });

  // Refs for real-time loops and cross-event communication
  const isPointerLockedRef = useRef(false);
  const isDragLookRef = useRef(false);
  const isMouseDownRef = useRef(false);
  const isMobileRef = useRef(false);
  const isOverlayDismissedRef = useRef(false);
  const isAdsActiveRef = useRef(false);
  const isCrouchActiveRef = useRef(false);
  const leanStateRef = useRef<'none' | 'left' | 'right'>('none');
  const firingRef = useRef(false);
  const lookRef = useRef({ yaw: 0, pitch: 0, dx: 0, dy: 0 });
  const togglePropRef = useRef<() => void>(() => {});
  const triggerJumpRef = useRef<() => void>(() => {});
  const reloadRef = useRef<() => void>(() => {});
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
    isCrouchActiveRef.current = isCrouchActive;
  }, [isCrouchActive]);
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
    setMode(readMode());
    setKbLockSupported(keyboardLockSupported());
    const isTouch =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window ||
        navigator.maxTouchPoints > 0 ||
        (window.matchMedia && window.matchMedia('(pointer: coarse)').matches));
    setIsMobile(isTouch);
    isMobileRef.current = isTouch;
    if (isTouch) {
      setIsOverlayDismissed(true);
      isOverlayDismissedRef.current = true;
    }
  }, []);

  // Engage controls: fullscreen + keyboard lock (blocks Ctrl+W etc.) + pointer lock.
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
      guard
        .arm({ fullscreen: true })
        .then(() => setHudStats((p) => ({ ...p, keyboardLocked: guard.isKeyboardLocked })))
        .finally(lockPointer);
    } else lockPointer();
  };

  // Joystick touch handlers
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
    const touch = e.touches[0];
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joystickCenterRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    updateJoystick(touch.clientX, touch.clientY);
  };
  const handleJoystickTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    updateJoystick(touch.clientX, touch.clientY);
  };
  const handleJoystickTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    setJoystickPos({ x: 0, y: 0 });
    mobileInputRef.current.moveX = 0;
    mobileInputRef.current.moveZ = 0;
    joystickCenterRef.current = null;
  };

  // Touch look (right side of the screen)
  const handleTouchLookStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    lastTouchLookRef.current = { x: touch.clientX, y: touch.clientY };
  };
  const handleTouchLookMove = (e: React.TouchEvent) => {
    if (!lastTouchLookRef.current) return;
    const touch = e.touches[0];
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
  const handleTouchLookEnd = () => {
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

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // ---- Renderer / scene / cameras ---------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileRef.current ? 1.5 : 2));
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

    // Prop disguise crate (same model as the static crate props)
    const disguiseCrate = createWoodenCrate(1.2);
    disguiseCrate.visible = false;
    scene.add(disguiseCrate);

    // ---- Player ------------------------------------------------------------------------------
    const isGhostSpectator = arenaMode === 'spectator';
    const spawn = layout.playerSpawns[Math.floor(Math.random() * layout.playerSpawns.length)];
    const body: MoveBody = { x: spawn.x, y: 0, z: spawn.z, velY: 0, onGround: true, radius: 0.36, height: 1.78 };
    const look = lookRef.current;
    look.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
    look.pitch = 0;
    if (isGhostSpectator) camera.position.set(0, 18, 40);

    const player = {
      hp: 100,
      alive: true,
      respawnTimer: 0,
      ammo: MAG_SIZE,
      reloadTimer: -1,
      fireCooldown: 0,
      recoilPitch: 0,
      recoilYaw: 0,
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
    };
    let ecProgress = 0;
    try {
      ecProgress = Number(localStorage.getItem(EC_STORAGE_KEY) || '0') || 0;
    } catch {
      ecProgress = 0;
    }

    const keys: Record<string, boolean> = {};
    if (new URLSearchParams(window.location.search).has('debug')) {
      (window as any).__mwar = { body, look, keys, player, world, camera, renderer, get bots() { return bots; }, setProp: (v: boolean) => setProp(v), fire: (on: boolean) => (firingRef.current = on), ads: (on: boolean) => setIsAdsActive(on) };
    }

    // ---- Bot mode (practice or offline) & economy ----------------------------------------------
    let bots: BotManager | null = null;
    let botMode = false;
    const feed = (msg: string) => setKillFeed((prev) => [msg, ...prev.slice(0, 4)]);

    const playerInfo = {
      position: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      speed: 0,
      crouching: false,
      alive: true,
      disguised: false,
    };

    const awardPracticeProgress = (points: number, reason: string) => {
      // ENERGY RECHARGE RULE: no Micro-USD / coins in solo bot mode — only EC recharge progress.
      player.roundKills += points;
      if (player.roundKills >= PRACTICE_ROUND_GOAL) {
        player.roundKills -= PRACTICE_ROUND_GOAL;
        player.roundsCompleted += 1;
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
      } else if (reason) {
        feed(reason);
      }
    };

    const onPlayerHit = (damage: number, from: THREE.Vector3, botName: string) => {
      if (!player.alive || isGhostSpectator) return;
      player.hp = Math.max(0, player.hp - damage);
      player.lastDamageAt = performance.now() / 1000;
      soundFX.playDamage();
      const ang = Math.atan2(from.x - body.x, from.z - body.z);
      // Screen-space angle relative to view (0 = in front)
      const rel = -(ang - Math.atan2(-Math.sin(look.yaw), -Math.cos(look.yaw)));
      setDamageIndicators((list) => [...list.slice(-5), { id: Math.random(), angle: rel, at: performance.now() }]);
      setDamageFlash(0.6);
      if (player.hp <= 0) {
        player.alive = false;
        player.deaths += 1;
        player.respawnTimer = 4;
        feed(`☠️ You were eliminated by BOT ${botName}`);
        if (player.isProp) setProp(false);
      }
    };

    const startBotMode = (reason: 'practice' | 'offline') => {
      if (bots || destroyed) return;
      botMode = true;
      bots = new BotManager(scene, world, layout.nav, layout.posts, effects, {
        onPlayerHit,
        onShot: (from) => soundFX.playEnemyShot(from.distanceTo(camera.position)),
      }, { count: BOT_COUNT, accuracy: BOT_ACCURACY, playerHalf: PLAY_HALF });
      setConnectionStatus(reason === 'practice' ? 'solo_bots' : 'offline_practice');
      feed(`🤖 ${BOT_COUNT} AI bots deployed (70% skill)`);
      feed('⚡ ENERGY RECHARGE MODE • No Micro-USD / Coin payouts');
    };

    // ---- Chests (bot mode: local 15 s chests; online: server-driven) ---------------------------
    const chestMeshes = new Map<string, THREE.Group>();
    let chestSpawnTimer = 3;
    let chestCounter = 0;
    const spawnLocalChest = () => {
      const near = layout.chestSpots.filter((c) => Math.hypot(c.x - body.x, c.z - body.z) < 70);
      const pool = near.length ? near : layout.chestSpots;
      const spot = pool[Math.floor(Math.random() * pool.length)];
      const id = `practice_chest_${chestCounter++}`;
      const g = createBountyChest(false);
      g.position.set(spot.x, world.groundHeightAt(spot.x, spot.z, 0.5, 50), spot.z);
      g.userData.expires = performance.now() + 15000;
      scene.add(g);
      chestMeshes.set(id, g);
    };
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

    // ---- Colyseus multiplayer ---------------------------------------------------------------
    const remotePlayers = new Map<string, { rig: SoldierRig; target: THREE.Vector3; yaw: number; speed: number }>();
    let currentRoom: Room | null = null;

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
        const joinPromise = colyseusClient.joinOrCreate(roomName, {
          userId: meData?.user?.id || `guest_${Math.random().toString(36).substring(2, 6)}`,
          username: meData?.user?.username || `Guest_${Math.floor(Math.random() * 900 + 100)}`,
        });
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
            body.x = p.x;
            body.y = p.y || 0;
            body.z = p.z;
            setHudStats((prev) => ({ ...prev, health: p.health, kills: p.kills, chests: p.chestsCollected, isProp: p.isProp, isGhost: p.isGhost }));
          } else {
            const rig = createSoldier({ uniform: 0x334155, vest: 0x1e293b, accent: 0x38bdf8, name: p.username || 'Enemy', tagColor: '#7dd3fc' });
            rig.root.position.set(p.x, p.y || 0, p.z);
            rig.hitMeshes.forEach((m) => (m.userData.remoteId = key));
            scene.add(rig.root);
            remotePlayers.set(key, { rig, target: new THREE.Vector3(p.x, p.y || 0, p.z), yaw: p.rotationY || 0, speed: 0 });
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
                isProp: p.isProp,
                isGhost: p.isGhost,
              }));
              if (p.isProp !== player.isProp) setProp(!!p.isProp, false);
            } else {
              const rp = remotePlayers.get(key);
              if (rp) {
                rp.target.set(p.x, p.y || 0, p.z);
                rp.yaw = p.rotationY || 0;
              }
            }
          });
        });
        state.players.onRemove((_p: any, key: string) => {
          const rp = remotePlayers.get(key);
          if (rp) {
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

        roomInstance.onMessage('player_killed', (data: any) => {
          soundFX.playHitMarker();
          feed(`⚔️ ${data.killerUsername} eliminated ${data.victimUsername} (+$0.10)`);
        });
        roomInstance.onMessage('chest_destroyed', (data: any) => {
          soundFX.playChestPickup();
          feed(`💰 ${data.collectedByUsername} claimed 15s Bounty Chest!`);
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

    // ---- Prop disguise ----------------------------------------------------------------------
    const setProp = (value: boolean, notifyServer = true) => {
      player.isProp = value;
      disguiseCrate.visible = value;
      viewmodel.setVisible(!value);
      if (value) {
        player.orbitPitch = 0.35;
        firingRef.current = false;
      }
      if (notifyServer && currentRoom) currentRoom.send('player_toggle_prop');
      setHudStats((prev) => ({ ...prev, isProp: value }));
    };
    togglePropRef.current = () => {
      if (!player.alive || isGhostSpectator) return;
      setProp(!player.isProp);
    };
    triggerJumpRef.current = () => {
      if (player.alive) world.jump(body, 7.4);
    };
    const startReload = () => {
      if (player.reloadTimer >= 0 || player.ammo >= MAG_SIZE || !player.alive || player.isProp) return;
      player.reloadTimer = 0;
      soundFX.playReload();
    };
    reloadRef.current = startReload;

    // ---- Shooting ---------------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const tmpV = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const ndc = new THREE.Vector2();

    const shootWeapon = () => {
      if (!player.alive || player.isProp || isGhostSpectator) return;
      if (player.reloadTimer >= 0) return;
      if (player.ammo <= 0) {
        soundFX.playDryFire();
        startReload();
        return;
      }
      player.ammo -= 1;
      player.fireCooldown = FIRE_INTERVAL;
      soundFX.playGunshot();
      viewmodel.fire();
      worldMuzzleLight.intensity = 7;
      worldMuzzleLight.position.copy(camera.position);

      // Spread: tight when aiming, larger when moving / airborne
      const ads = viewmodel.adsProgress;
      let spread = THREE.MathUtils.lerp(0.012, 0.0015, ads);
      if (player.speed > 1) spread += THREE.MathUtils.lerp(0.02, 0.004, ads) * Math.min(1, player.speed / 6);
      if (!body.onGround) spread += 0.03;
      if (keys.ControlLeft || keys.KeyZ || isCrouchActiveRef.current) spread *= 0.75;
      ndc.set((Math.random() - 0.5) * spread * 2, (Math.random() - 0.5) * spread * 2);
      raycaster.setFromCamera(ndc, camera);
      const origin = raycaster.ray.origin;
      const dir = raycaster.ray.direction;

      // Recoil (camera kick, recovers smoothly)
      player.recoilPitch += THREE.MathUtils.lerp(0.014, 0.008, ads);
      player.recoilYaw += (Math.random() - 0.5) * 0.006;

      // 1) Solid world (walls, buildings, terrain) — bullets never pass through
      const wallHit = world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, 400);
      const maxDist = wallHit ? wallHit.distance : 400;
      raycaster.far = maxDist;

      // 2) Chests
      const chestHits = raycaster.intersectObjects(Array.from(chestMeshes.values()), true);
      // 3) Bots / remote players
      const targetObjs: THREE.Object3D[] = bots ? bots.targets : [];
      remotePlayers.forEach((rp) => targetObjs.push(...rp.rig.hitMeshes));
      const targetHits = raycaster.intersectObjects(targetObjs, false);

      const chestDist = chestHits[0]?.distance ?? Infinity;
      const targetDist = targetHits[0]?.distance ?? Infinity;
      let endPoint: THREE.Vector3;

      if (targetDist < chestDist && targetHits[0]) {
        const hit = targetHits[0];
        endPoint = hit.point.clone();
        const head = hit.object.userData.hitZone === 'head';
        if (bots && hit.object.userData.botId !== undefined) {
          const killed = bots.damage(hit.object.userData.botId, head ? 100 : 34, camera.position);
          soundFX.playHitMarker();
          setHitMarker({ at: performance.now(), kill: killed, head });
          if (killed) {
            player.kills += 1;
            const name = bots.botById(hit.object.userData.botId).name;
            awardPracticeProgress(1, `🎯 ${head ? 'HEADSHOT • ' : ''}Eliminated BOT ${name} (+EC progress • no coins)`);
          }
        } else if (hit.object.userData.remoteId && currentRoom) {
          currentRoom.send('player_shoot', { targetType: 'player', targetId: hit.object.userData.remoteId, damage: head ? 100 : 35 });
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
            awardPracticeProgress(1, '📦 Practice Bounty Chest opened (+EC progress • no coins)');
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
    };

    // ---- Input ------------------------------------------------------------------------------
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      keys[e.code] = true;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) triggerJumpRef.current();
      }
      if (e.code === 'KeyC' && !e.repeat) togglePropRef.current();
      if (e.code === 'KeyF') firingRef.current = true;
      if (e.code === 'KeyR') startReload();
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
      const free = isPointerLockedRef.current || ((isDragLookRef.current || isGhostSpectator) && isMouseDownRef.current);
      if (!free) return;
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      const sens = 0.0022 * (viewmodel.adsProgress > 0.5 ? 0.6 : 1);
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
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDownRef.current = true;
        if (isPointerLockedRef.current || isDragLookRef.current) firingRef.current = !isDragLookRef.current || isPointerLockedRef.current;
        if (!isOverlayDismissedRef.current && !isMobileRef.current) engageControls();
      }
      if (e.button === 2) {
        e.preventDefault();
        setIsAdsActive(true);
      }
    };
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDownRef.current = false;
        firingRef.current = !!keys.KeyF;
      }
      if (e.button === 2) setIsAdsActive(false);
    };
    const preventContext = (e: Event) => e.preventDefault();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouseMove);
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
    const right = new THREE.Vector3();
    const forward = new THREE.Vector3();
    const camEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    const orbitTarget = new THREE.Vector3();

    const respawnPlayer = () => {
      // Pick the spawn farthest from living bots
      let best = layout.playerSpawns[0];
      let bestScore = -Infinity;
      for (const s of layout.playerSpawns) {
        let minD = 999;
        bots?.bots.forEach((b) => {
          if (b.state !== 'dead') minD = Math.min(minD, Math.hypot(b.body.x - s.x, b.body.z - s.z));
        });
        if (minD > bestScore) {
          bestScore = minD;
          best = s;
        }
      }
      body.x = best.x;
      body.y = 0;
      body.z = best.z;
      body.velY = 0;
      player.hp = 100;
      player.alive = true;
      player.ammo = MAG_SIZE;
      player.reloadTimer = -1;
      feed('🛡️ Respawned — back in the fight');
    };

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;
      const tSec = now / 1000;

      const crouching = !player.isProp && (keys.ControlLeft || keys.ControlRight || keys.KeyZ || isCrouchActiveRef.current);
      const adsWanted = isAdsActiveRef.current && !player.isProp && player.alive;

      // --- Movement input
      let mx = 0;
      let mz = 0;
      if (player.alive) {
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
        let speed = 6.2;
        if (keys.ShiftLeft || keys.ShiftRight) speed = 3.0; // walk slow (quiet)
        if (crouching) speed = 2.8;
        if (adsWanted) speed *= 0.65;
        if (player.isProp) speed = 4.2;
        const dx = (forward.x * -mz + right.x * mx) * speed * dt;
        const dz = (forward.z * -mz + right.z * mx) * speed * dt;
        const px = body.x;
        const pz = body.z;
        body.height = crouching ? 1.2 : 1.78;
        world.moveBody(body, dx, dz, dt);
        player.speed = Math.hypot(body.x - px, body.z - pz) / Math.max(dt, 1e-4);
      }

      // --- Respawn / regen
      if (!player.alive) {
        player.respawnTimer -= dt;
        if (player.respawnTimer <= 0) respawnPlayer();
      } else if (botMode && player.hp < 100 && tSec - player.lastDamageAt > 6) {
        player.hp = Math.min(100, player.hp + 10 * dt);
      }

      // --- Eye height (crouch smoothing + stair step smoothing)
      player.eyeHeight = THREE.MathUtils.damp(player.eyeHeight, !player.alive ? 0.4 : crouching ? CROUCH_EYE : STAND_EYE, 12, dt);
      const dy = body.y - player.renderY;
      player.renderY = dy > 0 && dy < 0.7 ? THREE.MathUtils.damp(player.renderY, body.y, 16, dt) : body.y;

      // --- True lateral lean (Q / E): shift camera sideways + roll, with wall-clip prevention
      let leanInput = 0;
      if (player.alive && !player.isProp) {
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
      player.recoilPitch = THREE.MathUtils.damp(player.recoilPitch, 0, 7, dt);
      player.recoilYaw = THREE.MathUtils.damp(player.recoilYaw, 0, 7, dt);

      // --- Camera
      if (!isGhostSpectator) {
        if (player.isProp) {
          // Smooth 3rd-person orbit around the crate disguise (camera pulled in by walls)
          disguiseCrate.position.set(body.x, body.y, body.z);
          disguiseCrate.rotation.y = look.yaw;
          orbitTarget.set(body.x, body.y + 0.9, body.z);
          const cp = Math.cos(player.orbitPitch);
          const back = new THREE.Vector3(Math.sin(look.yaw) * cp, Math.sin(player.orbitPitch), Math.cos(look.yaw) * cp);
          let dist = 4.4;
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

      // --- ADS FOV
      viewmodel.update(dt, {
        moveFactor: player.speed / 6.2,
        ads: adsWanted,
        lean: player.leanT,
        lookDeltaX: look.dx,
        lookDeltaY: look.dy,
        grounded: body.onGround,
        crouching: !!crouching,
        reload: player.reloadTimer >= 0 ? player.reloadTimer / RELOAD_TIME : -1,
      });
      look.dx = 0;
      look.dy = 0;
      const targetFov = player.isProp ? 70 : THREE.MathUtils.lerp(HIP_FOV, ADS_FOV, viewmodel.adsProgress);
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = targetFov;
        camera.updateProjectionMatrix();
      }

      // --- Weapon
      player.fireCooldown -= dt;
      if (player.reloadTimer >= 0) {
        player.reloadTimer += dt;
        if (player.reloadTimer >= RELOAD_TIME) {
          player.reloadTimer = -1;
          player.ammo = MAG_SIZE;
        }
      }
      if (firingRef.current && player.fireCooldown <= 0) shootWeapon();
      worldMuzzleLight.intensity = Math.max(0, worldMuzzleLight.intensity - dt * 120);

      // --- Bots
      if (bots) {
        playerInfo.position.set(body.x, body.y, body.z);
        playerInfo.eye.set(body.x, body.y + player.eyeHeight, body.z).addScaledVector(right, leanOffset);
        playerInfo.speed = player.speed;
        playerInfo.crouching = !!crouching;
        playerInfo.alive = player.alive;
        playerInfo.disguised = player.isProp && player.speed < 0.5;
        bots.update(dt, playerInfo);

        // 15-second practice chests
        chestSpawnTimer -= dt;
        if (chestSpawnTimer <= 0 && chestMeshes.size < 2) {
          spawnLocalChest();
          chestSpawnTimer = 15;
        }
        chestMeshes.forEach((g, id) => {
          if (g.userData.expires && now > g.userData.expires) removeChest(id);
        });
      }

      // --- Remote players interpolation
      remotePlayers.forEach((rp) => {
        const before = rp.rig.root.position.clone();
        rp.rig.root.position.lerp(rp.target, 1 - Math.exp(-10 * dt));
        rp.rig.root.rotation.y = rp.yaw;
        rp.speed = before.distanceTo(rp.rig.root.position) / Math.max(dt, 1e-4);
        animateSoldier(rp.rig, tSec, rp.speed, false);
      });

      chestMeshes.forEach((g) => animateBountyChest(g, now));
      effects.update(dt);
      layout.terrain.update(dt, camera);

      // --- Network (20 Hz)
      netTimer -= dt;
      if (currentRoom && netTimer <= 0) {
        netTimer = 0.05;
        const key = `${body.x.toFixed(2)},${body.y.toFixed(2)},${body.z.toFixed(2)},${look.yaw.toFixed(2)}`;
        if (key !== lastSentKey) {
          lastSentKey = key;
          currentRoom.send('player_move', { x: body.x, y: body.y, z: body.z, rotationY: look.yaw });
        }
      }

      // --- HUD (10 Hz)
      hudTimer -= dt;
      if (hudTimer <= 0) {
        hudTimer = 0.1;
        setHudStats((prev) => ({
          ...prev,
          health: Math.round(player.hp),
          kills: botMode ? player.kills : prev.kills,
          deaths: player.deaths,
          chests: botMode ? player.chests : prev.chests,
          earningsMicroUsd: botMode ? 0 : prev.earningsMicroUsd,
          ammo: player.ammo,
          reloading: player.reloadTimer >= 0,
          botsAlive: bots ? bots.aliveCount() : 0,
          roundKills: player.roundKills,
          ecProgress,
          roundsCompleted: player.roundsCompleted,
          alive: player.alive,
          respawnIn: Math.max(0, Math.ceil(player.respawnTimer)),
          leanDir: player.leanT < -0.3 ? -1 : player.leanT > 0.3 ? 1 : 0,
          crouching: !!crouching,
          keyboardLocked: guard.isKeyboardLocked,
        }));
      }

      // --- Render: world, then the first-person viewmodel on top
      renderer.clear();
      renderer.render(scene, camera);
      if (!isGhostSpectator && player.alive) viewmodel.render(renderer);
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      viewmodel.setAspect(w / h);
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(container);
    window.addEventListener('resize', handleResize);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
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
      remotePlayers.forEach((rp) => rp.rig.dispose());
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
  const showDesktopOverlay = !isOverlayDismissed && !isMobile && !isPointerLocked && !isGhostSpectator;
  const ecRoundPct = Math.min(100, Math.round((hudStats.roundKills / PRACTICE_ROUND_GOAL) * 100));

  return (
    <div
      ref={rootRef}
      className="relative w-full h-[calc(100vh-5rem)] rounded-3xl overflow-hidden border border-slate-800 bg-black select-none shadow-2xl [&:fullscreen]:h-screen [&:fullscreen]:rounded-none [&:fullscreen]:border-0"
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
          <div className="bg-amber-500/90 text-slate-950 font-black text-xs px-4 py-2 rounded-2xl shadow-xl shadow-amber-500/40 border-2 border-white flex items-center space-x-2">
            <span>📦</span>
            <span>PROP DISGUISE ACTIVE • 3RD-PERSON VIEW • PRESS &apos;C&apos; TO EXIT</span>
          </div>
        </div>
      )}

      {/* Energy Recharge Mode banner (solo bots — zero cash payout) */}
      {isBotMode && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none w-[min(92vw,560px)]">
          <div className="bg-slate-950/85 border border-amber-400/60 backdrop-blur-md rounded-2xl px-4 py-2 shadow-xl shadow-amber-500/10">
            <div className="text-[11px] font-black text-amber-300 text-center tracking-wide">
              ⚡ ENERGY RECHARGE MODE • Practice &amp; EC Recharge Only (No Micro-USD/Coins)
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
        <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 p-3 sm:p-3.5 rounded-2xl flex flex-wrap items-center gap-3 shadow-xl pointer-events-auto max-w-[60%]">
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
          {hudStats.crouching && <span className="bg-slate-700/60 text-slate-200 text-[10px] font-black px-2 py-0.5 rounded-full">CROUCH</span>}
          {hudStats.isGhost && (
            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/40 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">👻 GHOST</span>
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

        <div className="flex items-center space-x-2 pointer-events-auto">
          <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 p-3 sm:p-3.5 rounded-2xl flex items-center space-x-4 text-right shadow-xl">
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

      {/* Ammo counter */}
      {!isGhostSpectator && !hudStats.isProp && (
        <div className={`absolute ${isMobile ? 'top-24 left-4' : 'bottom-6 right-6'} z-20 pointer-events-none`}>
          <div className="bg-slate-950/85 border border-slate-800 backdrop-blur-md rounded-2xl px-4 py-2 text-right shadow-xl">
            <div className="text-[10px] font-black text-slate-400 tracking-widest">M4 CARBINE</div>
            <div className={`font-mono font-black text-2xl leading-none ${hudStats.ammo <= 5 ? 'text-rose-400' : 'text-white'}`}>
              {hudStats.reloading ? 'RELOAD' : hudStats.ammo}
              <span className="text-xs text-slate-500"> / {MAG_SIZE}</span>
            </div>
          </div>
        </div>
      )}

      {/* Killfeed */}
      <div className="absolute top-20 right-4 space-y-1.5 pointer-events-none z-20">
        {killFeed.map((f, idx) => (
          <div key={idx} className="bg-slate-950/80 border border-slate-800 text-xs font-bold text-slate-200 px-3 py-1.5 rounded-xl backdrop-blur-md shadow-lg">
            {f}
          </div>
        ))}
      </div>

      {/* Desktop Controls / Engage overlay */}
      {showDesktopOverlay && (
        <div onClick={() => engageControls()} className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center pointer-events-auto z-30 cursor-pointer">
          <div onClick={(e) => e.stopPropagation()} className="bg-slate-900 border border-slate-700 p-6 sm:p-7 rounded-3xl text-center max-w-lg space-y-4 shadow-2xl mx-4">
            <div className="text-[10px] font-black tracking-widest text-slate-400">{MODE_LABEL[mode]}</div>
            <h3 className="text-lg font-black text-white tracking-tight">CLICK TO ENGAGE (FULLSCREEN + MOUSE LOCK)</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-300 font-mono text-left">
              <span>W A S D — Move</span>
              <span>Mouse — Look</span>
              <span>Left-Click / F — Fire</span>
              <span>Right-Click — Aim (ADS)</span>
              <span>Q / E — Lean (peek)</span>
              <span>Ctrl / Z — Crouch</span>
              <span>Space — Jump</span>
              <span>Shift — Walk slow</span>
              <span>R — Reload</span>
              <span>C — Crate disguise</span>
              <span>Esc — Release mouse</span>
            </div>
            <div className="text-[11px] bg-sky-500/15 border border-sky-500/40 text-sky-200 py-2 px-3 rounded-xl font-semibold">
              🔒 In-game browser shortcuts are blocked{kbLockSupported ? ' (Ctrl+W is safe while fullscreen)' : ' — your browser will ask before closing the tab'}.
            </div>
            {mode === 'practice' ? (
              <div className="text-[11px] bg-amber-500/20 border border-amber-500/40 text-amber-300 py-2.5 px-3 rounded-xl font-bold">
                ⚡ ENERGY RECHARGE / TRAINING MODE — 70% skill AI bots • No Micro-USD / coin payouts
              </div>
            ) : (
              <div className="text-[11px] bg-amber-500/20 border border-amber-500/40 text-amber-300 py-2.5 px-3 rounded-xl font-bold">
                🎁 15-Second Bounty Chests spawn on player kills. Shoot them to claim instant Micro-USD Coins!
              </div>
            )}
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button
                onClick={() => engageControls()}
                className="flex-1 bg-rose-600 hover:bg-rose-500 text-white text-xs font-black py-2.5 px-4 rounded-xl shadow-lg transition active:scale-95"
              >
                🎮 CLICK TO PLAY
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOverlayDismissed(true);
                  setIsDragLookMode(true);
                  guardRef.current?.arm({ fullscreen: false });
                }}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2.5 px-3 rounded-xl border border-slate-600 transition active:scale-95"
              >
                🖱️ Drag-Look Mode (No Lock)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating status pill when mouse is unlocked */}
      {!isMobile && isOverlayDismissed && !isPointerLocked && !isGhostSpectator && (
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
          🔒 Browser shortcuts locked (Ctrl+W safe) • Esc to exit
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

      {/* Mobile / Tablet Touch Controls */}
      {isMobile && (
        <>
          <div className="absolute bottom-6 left-6 pointer-events-auto touch-none select-none z-20">
            <div
              className="relative w-32 h-32 rounded-full border-2 border-white/20 bg-slate-900/60 backdrop-blur-md flex items-center justify-center shadow-2xl active:border-rose-500/50"
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

          <div className="absolute bottom-6 right-6 pointer-events-auto flex flex-col items-end space-y-3 z-20 select-none">
            <div className="flex items-center space-x-2">
              {(['left', 'right'] as const).map((side) => (
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
            </div>
            <div className="flex items-center space-x-2">
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
                  setIsCrouchActive((prev) => !prev);
                }}
                className={`w-12 h-12 rounded-2xl text-xs font-black flex items-center justify-center shadow-lg border transition ${
                  isCrouchActive ? 'bg-amber-500 text-slate-950 border-white scale-105' : 'bg-slate-900/80 text-white border-slate-700'
                }`}
              >
                ⬇️ CROUCH
              </button>
              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  triggerJumpRef.current?.();
                }}
                className="w-12 h-12 rounded-2xl bg-indigo-600/90 active:bg-indigo-500 text-white font-black text-xs flex items-center justify-center shadow-lg border border-indigo-400/50 active:scale-95 transition"
              >
                ⬆️ JUMP
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
              className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-rose-600 via-rose-500 to-amber-500 active:scale-95 text-white font-black text-base flex flex-col items-center justify-center shadow-2xl shadow-rose-600/50 border-2 border-white/60 transition"
            >
              <span>🔥</span>
              <span className="text-[11px] tracking-wider">FIRE</span>
            </button>
          </div>
        </>
      )}

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
