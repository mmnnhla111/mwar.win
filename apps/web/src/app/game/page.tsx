'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Client as ColyseusClient, Room } from 'colyseus.js';
import { apiFetch, progressQuest } from '../../lib/api';
import { formatCoins, formatMicroUsd } from '@mwar/shared';
import { GhostSpectatorIcon, QuestSpectateIcon } from '../../components/icons';

// ----------------------------------------------------------------------------
// Procedural Web Audio API Sound Synthesizer (Zero External Audio Bloat)
// ----------------------------------------------------------------------------
class SoundSynthesizer {
  private ctx: AudioContext | null = null;
  public isMuted: boolean = false;

  private init() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playGunshot() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Filtered noise burst (punchy muzzle blast)
    const bufferSize = Math.floor(this.ctx.sampleRate * 0.12);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.25));
    }
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1200, now);
    filter.frequency.exponentialRampToValueAtTime(150, now + 0.12);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);

    // Sub-bass thump
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + 0.1);

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.7, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    noise.connect(filter).connect(gain).connect(this.ctx.destination);
    osc.connect(oscGain).connect(this.ctx.destination);

    noise.start(now);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  playHitMarker() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(2400, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);

    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  playChestPickup() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;

    // Upbeat major arpeggio (C5 -> E5 -> G5 -> C6)
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + idx * 0.06);

      const gain = this.ctx!.createGain();
      gain.gain.setValueAtTime(0.3, now + idx * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.06 + 0.12);

      osc.connect(gain).connect(this.ctx!.destination);
      osc.start(now + idx * 0.06);
      osc.stop(now + idx * 0.06 + 0.12);
    });
  }

  playQuestComplete() {
    if (this.isMuted) return;
    this.init();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const chords = [523.25, 659.25, 783.99, 1046.5];
    chords.forEach((freq) => {
      const osc = this.ctx!.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      const gain = this.ctx!.createGain();
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

      osc.connect(gain).connect(this.ctx!.destination);
      osc.start(now);
      osc.stop(now + 0.6);
    });
  }
}

const soundFX = new SoundSynthesizer();

export default function GamePage() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [hudStats, setHudStats] = useState({
    health: 100,
    kills: 0,
    chests: 0,
    earningsMicroUsd: 0,
    isProp: false,
    isGhost: false,
    ping: 15,
  });
  const [killFeed, setKillFeed] = useState<string[]>([]);
  const [afkPrompt, setAfkPrompt] = useState<string | null>(null);
  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'offline_practice'>('connecting');

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
  const playerYRef = useRef(0);
  const jumpVelocityRef = useRef(0);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const eulerRef = useRef<THREE.Euler>(new THREE.Euler(0, 0, 0, 'YXZ'));
  const shootWeaponRef = useRef<() => void>(() => {});
  const togglePropRef = useRef<() => void>(() => {});
  const triggerJumpRef = useRef<() => void>(() => {});
  const joystickCenterRef = useRef<{ x: number; y: number } | null>(null);
  const lastTouchLookRef = useRef<{ x: number; y: number } | null>(null);

  // Sync ref values
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

  // Mobile virtual joystick input states
  const mobileInputRef = useRef({
    moveX: 0,
    moveZ: 0,
    lookPitch: 0,
    lookYaw: 0,
    isShooting: false,
  });

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    soundFX.isMuted = next;
  };

  // Auto-detect Touch / Mobile / Tablet Devices
  useEffect(() => {
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

  // Helper to engage controls without getting stuck
  const engageControls = (targetEl?: HTMLElement | null) => {
    setIsOverlayDismissed(true);
    isOverlayDismissedRef.current = true;
    if (!isMobileRef.current) {
      const el = targetEl || mountRef.current;
      if (el) {
        try {
          const promise = el.requestPointerLock?.();
          if (promise && typeof (promise as any).catch === 'function') {
            (promise as any).catch((err: any) => {
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
      }
    }
  };

  // Joystick touch handlers
  const handleJoystickTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joystickCenterRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    updateJoystick(touch.clientX, touch.clientY);
  };

  const handleJoystickTouchMove = (e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    updateJoystick(touch.clientX, touch.clientY);
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

    // Map: nx / maxRadius -> moveX, ny / maxRadius -> moveZ
    mobileInputRef.current.moveX = nx / maxRadius;
    mobileInputRef.current.moveZ = ny / maxRadius;
  };

  const handleJoystickTouchEnd = (e: React.TouchEvent) => {
    e.stopPropagation();
    setJoystickPos({ x: 0, y: 0 });
    mobileInputRef.current.moveX = 0;
    mobileInputRef.current.moveZ = 0;
    joystickCenterRef.current = null;
  };

  // Touch look handlers for the right side of the screen
  const handleTouchLookStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    lastTouchLookRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchLookMove = (e: React.TouchEvent) => {
    if (!lastTouchLookRef.current || !cameraRef.current) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - lastTouchLookRef.current.x;
    const deltaY = touch.clientY - lastTouchLookRef.current.y;
    lastTouchLookRef.current = { x: touch.clientX, y: touch.clientY };

    eulerRef.current.setFromQuaternion(cameraRef.current.quaternion);
    eulerRef.current.y -= deltaX * 0.005;
    eulerRef.current.x -= deltaY * 0.005;
    eulerRef.current.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, eulerRef.current.x));
    cameraRef.current.quaternion.setFromEuler(eulerRef.current);
  };

  const handleTouchLookEnd = () => {
    lastTouchLookRef.current = null;
  };

  // Spectator timer heartbeat
  useEffect(() => {
    const isSpectatorMode = typeof window !== 'undefined' && (
      window.location.search.includes('mode=spectator') || hudStats.isGhost
    );

    if (!isSpectatorMode) return;

    const timer = setInterval(() => {
      setSpectatorSeconds((prev) => {
        const next = prev + 1;
        if (next % 15 === 0 && next <= 90) {
          progressQuest('Q_SPECTATE', 15).catch(() => {});
        }
        if (next >= 90 && !spectatorQuestCompleted) {
          setSpectatorQuestCompleted(true);
          soundFX.playQuestComplete();
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [hudStats.isGhost, spectatorQuestCompleted]);

  useEffect(() => {
    if (!mountRef.current) return;

    let destroyed = false;
    const container = mountRef.current;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    // 1. Three.js Scene Setup
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0f1d);
    scene.fog = new THREE.FogExp2(0x0a0f1d, 0.012);

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 1.7, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // 2. Lighting & Tactical Environment
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff1d0, 1.4);
    dirLight.position.set(60, 90, 60);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    // Ground Plane with Grid
    const groundGeo = new THREE.PlaneGeometry(300, 300, 30, 30);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x111827,
      roughness: 0.8,
      metalness: 0.2,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(300, 60, 0xef4444, 0x1f2937);
    gridHelper.position.y = 0.02;
    scene.add(gridHelper);

    // 3. Stylized Buildings with Neon Trims & Windows
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
    const trimMatCyan = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const trimMatOrange = new THREE.MeshBasicMaterial({ color: 0xf59e0b });

    const buildingCoords = [
      { x: -35, z: -35, w: 14, h: 12, d: 14 },
      { x: 35, z: -40, w: 16, h: 16, d: 16 },
      { x: -40, z: 40, w: 18, h: 10, d: 12 },
      { x: 45, z: 35, w: 12, h: 14, d: 14 },
      { x: 0, z: -70, w: 20, h: 18, d: 20 },
      { x: 0, z: 70, w: 20, h: 14, d: 20 },
    ];

    buildingCoords.forEach((bc, idx) => {
      const bGroup = new THREE.Group();
      const bMesh = new THREE.Mesh(new THREE.BoxGeometry(bc.w, bc.h, bc.d), buildingMat);
      bMesh.position.y = bc.h / 2;
      bMesh.castShadow = true;
      bMesh.receiveShadow = true;
      bGroup.add(bMesh);

      // Neon Roof Trim
      const roofTrim = new THREE.Mesh(
        new THREE.BoxGeometry(bc.w + 0.2, 0.4, bc.d + 0.2),
        idx % 2 === 0 ? trimMatCyan : trimMatOrange
      );
      roofTrim.position.y = bc.h;
      bGroup.add(roofTrim);

      bGroup.position.set(bc.x, 0, bc.z);
      scene.add(bGroup);
    });

    // 4. Tactical Cover Barricades
    const barricadeMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9 });
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const radius = 25 + (i % 3) * 15;
      const barrier = new THREE.Mesh(new THREE.BoxGeometry(4, 1.3, 0.8), barricadeMat);
      barrier.position.set(Math.cos(angle) * radius, 0.65, Math.sin(angle) * radius);
      barrier.rotation.y = angle + Math.PI / 2;
      barrier.castShadow = true;
      barrier.receiveShadow = true;
      scene.add(barrier);
    }

    // 5. Stylized Low-Poly Foliage Trees
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 });
    const foliageMat = new THREE.MeshStandardMaterial({ color: 0x059669, roughness: 0.6 });

    for (let i = 0; i < 12; i++) {
      const treeGroup = new THREE.Group();
      // Trunk
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2, 8), trunkMat);
      trunk.position.y = 1;
      trunk.castShadow = true;
      treeGroup.add(trunk);
      // Leaves (stacked cones)
      for (let j = 0; j < 3; j++) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(2 - j * 0.4, 2, 8), foliageMat);
        cone.position.y = 2.2 + j * 1.1;
        cone.castShadow = true;
        treeGroup.add(cone);
      }
      const angle = (i / 12) * Math.PI * 2 + 0.2;
      treeGroup.position.set(Math.cos(angle) * 85, 0, Math.sin(angle) * 85);
      scene.add(treeGroup);
    }

    // 6. Connect to Colyseus Game Server (or Offline Practice Mode Fallback)
    const colyseusUrl =
      process.env.NEXT_PUBLIC_GAME_SERVER_URL ||
      (typeof window !== 'undefined' && (window.location.hostname === 'mwar.win' || window.location.hostname.endsWith('.mwar.win'))
        ? 'wss://game.mwar.win'
        : 'ws://localhost:2567');
    const colyseusClient = new ColyseusClient(colyseusUrl);

    const remotePlayersMeshes = new Map<string, THREE.Group>();
    const chestMeshes = new Map<string, THREE.Group>();

    let currentRoom: Room | null = null;

    function spawnPracticeObjects() {
      // Spawn 2 practice bounty chests
      const chestPositions = [
        { x: -10, y: 0, z: -15, id: 'practice_chest_1' },
        { x: 14, y: 0, z: -20, id: 'practice_chest_2' },
      ];
      chestPositions.forEach((pos) => {
        const chestGroup = new THREE.Group();
        const cGeo = new THREE.BoxGeometry(1.2, 0.9, 1.0);
        const cMat = new THREE.MeshStandardMaterial({
          color: 0xf59e0b,
          roughness: 0.3,
          metalness: 0.8,
          emissive: 0xb45309,
          emissiveIntensity: 0.6,
        });
        const cMesh = new THREE.Mesh(cGeo, cMat);
        cMesh.position.y = 0.45;
        cMesh.castShadow = true;
        chestGroup.add(cMesh);

        const chestLight = new THREE.PointLight(0xf59e0b, 1.5, 6);
        chestLight.position.y = 1.0;
        chestGroup.add(chestLight);

        const ringGeo = new THREE.TorusGeometry(0.9, 0.05, 8, 24);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.05;
        chestGroup.add(ring);

        chestGroup.position.set(pos.x, pos.y, pos.z);
        scene.add(chestGroup);
        chestMeshes.set(pos.id, chestGroup);
      });

      // Spawn 2 practice target dummies
      const dummyPositions = [
        { x: 0, y: 0, z: -25, id: 'practice_dummy_1' },
        { x: -18, y: 0, z: -35, id: 'practice_dummy_2' },
      ];
      dummyPositions.forEach((pos) => {
        const pGroup = new THREE.Group();
        (pGroup as any).name = pos.id;
        const bodyGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.8, 16);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0xef4444 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = 0.9;
        body.castShadow = true;
        pGroup.add(body);

        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.4), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
        visor.position.set(0, 1.4, 0.35);
        pGroup.add(visor);

        pGroup.position.set(pos.x, pos.y, pos.z);
        scene.add(pGroup);
        remotePlayersMeshes.set(pos.id, pGroup);
      });
    }

    async function initColyseus() {
      try {
        let meData: any = null;
        try {
          meData = await apiFetch('/api/auth/me');
        } catch {
          // Guest mode
        }

        const roomInstance = await colyseusClient.joinOrCreate('mini_30', {
          userId: meData?.user?.id || `guest_${Math.random().toString(36).substring(2, 6)}`,
          username: meData?.user?.username || `Guest_${Math.floor(Math.random() * 900 + 100)}`,
        });

        if (destroyed) {
          roomInstance.leave();
          return;
        }

        currentRoom = roomInstance;
        setRoom(roomInstance);
        setConnectionStatus('connected');

        // Player Join / Move / Prop synchronization
        const state = roomInstance.state as any;
        state.players.onAdd((player: any, key: string) => {
          if (key === roomInstance.sessionId) {
            camera.position.set(player.x, player.y + 1.7, player.z);
            setHudStats((prev) => ({
              ...prev,
              health: player.health,
              kills: player.kills,
              chests: player.chestsCollected,
              isProp: player.isProp,
              isGhost: player.isGhost,
            }));
          } else {
            const pGroup = new THREE.Group();
            const bodyGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.8, 16);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x0284c7 });
            const body = new THREE.Mesh(bodyGeo, bodyMat);
            body.position.y = 0.9;
            body.castShadow = true;
            pGroup.add(body);

            // Visor
            const visor = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.25, 0.4), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
            visor.position.set(0, 1.4, 0.35);
            pGroup.add(visor);

            pGroup.position.set(player.x, player.y, player.z);
            scene.add(pGroup);
            remotePlayersMeshes.set(key, pGroup);
          }

          player.onChange(() => {
            if (key === roomInstance.sessionId) {
              setHudStats((prev) => ({
                ...prev,
                health: player.health,
                kills: player.kills,
                chests: player.chestsCollected,
                earningsMicroUsd: player.sessionEarningsMicroUsd,
                isProp: player.isProp,
                isGhost: player.isGhost,
              }));
            } else {
              const mesh = remotePlayersMeshes.get(key);
              if (mesh) {
                mesh.position.set(player.x, player.y, player.z);
                mesh.rotation.y = player.rotationY || 0;
              }
            }
          });
        });

        state.players.onRemove((_player: any, key: string) => {
          const mesh = remotePlayersMeshes.get(key);
          if (mesh) {
            scene.remove(mesh);
            remotePlayersMeshes.delete(key);
          }
        });

        // 7. Glowing 15-Second Bounty Treasure Chests (Pulsing Light & Gold Sheen)
        state.chests.onAdd((chest: any, key: string) => {
          const chestGroup = new THREE.Group();

          // Chest Base Box
          const cGeo = new THREE.BoxGeometry(1.2, 0.9, 1.0);
          const cMat = new THREE.MeshStandardMaterial({
            color: chest.isDeathDrop ? 0xd97706 : 0xf59e0b,
            roughness: 0.3,
            metalness: 0.8,
            emissive: chest.isDeathDrop ? 0x92400e : 0xb45309,
            emissiveIntensity: 0.6,
          });
          const cMesh = new THREE.Mesh(cGeo, cMat);
          cMesh.position.y = 0.45;
          cMesh.castShadow = true;
          chestGroup.add(cMesh);

          // Golden Pulsing PointLight Beacon
          const chestLight = new THREE.PointLight(0xf59e0b, 1.5, 6);
          chestLight.position.y = 1.0;
          chestGroup.add(chestLight);

          // Glowing Aura Ring
          const ringGeo = new THREE.TorusGeometry(0.9, 0.05, 8, 24);
          const ringMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
          const ring = new THREE.Mesh(ringGeo, ringMat);
          ring.rotation.x = Math.PI / 2;
          ring.position.y = 0.05;
          chestGroup.add(ring);

          chestGroup.position.set(chest.x, chest.y, chest.z);
          scene.add(chestGroup);
          chestMeshes.set(key, chestGroup);
        });

        state.chests.onRemove((_chest: any, key: string) => {
          const cGroup = chestMeshes.get(key);
          if (cGroup) {
            scene.remove(cGroup);
            chestMeshes.delete(key);
          }
        });

        // Event Listeners with Audio Feedback
        roomInstance.onMessage('player_killed', (data: any) => {
          soundFX.playHitMarker();
          setKillFeed((prev) => [`⚔️ ${data.killerUsername} eliminated ${data.victimUsername} (+$0.10)`, ...prev.slice(0, 4)]);
        });

        roomInstance.onMessage('chest_destroyed', (data: any) => {
          soundFX.playChestPickup();
          setKillFeed((prev) => [`💰 ${data.collectedByUsername} claimed 15s Bounty Chest!`, ...prev.slice(0, 4)]);
        });

        roomInstance.onMessage('afk_warning', (data: any) => {
          setAfkPrompt(data.message);
        });

        roomInstance.onMessage('afk_cleared', () => {
          setAfkPrompt(null);
        });
      } catch (err: any) {
        console.warn('Colyseus server offline. Activating Offline Practice Mode.', err);
        setConnectionStatus('offline_practice');
        spawnPracticeObjects();
        setKillFeed((prev) => [
          '🟡 Offline Practice Mode active (Solo Physics)',
          '🎯 Practice targets & bounty chests spawned',
          ...prev.slice(0, 2),
        ]);
      }
    }

    initColyseus();

    const shootWeapon = () => {
      soundFX.playGunshot();

      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

      // Check chests
      const chestEntries = Array.from(chestMeshes.entries());
      const chestObjects = chestEntries.map((c) => c[1]);
      const chestIntersects = raycaster.intersectObjects(chestObjects, true);

      if (chestIntersects.length > 0) {
        soundFX.playHitMarker();
        let targetGroup: THREE.Object3D | null = chestIntersects[0].object;
        while (targetGroup && targetGroup.parent && !chestEntries.some((c) => c[1] === targetGroup)) {
          targetGroup = targetGroup.parent;
        }
        const found = chestEntries.find((c) => c[1] === targetGroup);
        if (found) {
          if (currentRoom) {
            currentRoom.send('player_shoot', {
              targetType: 'chest',
              targetId: found[0],
              damage: 25,
            });
          } else {
            // Local practice chest feedback
            soundFX.playChestPickup();
            setHudStats((prev) => ({
              ...prev,
              chests: prev.chests + 1,
              earningsMicroUsd: prev.earningsMicroUsd + 100000,
            }));
            setKillFeed((prev) => ['💰 Claimed Practice Bounty Chest! (+100 Coins)', ...prev.slice(0, 4)]);
          }
          return;
        }
      }

      // Check remote players / practice targets
      const playerEntries = Array.from(remotePlayersMeshes.entries());
      const playerObjects = playerEntries.map((p) => p[1]);
      const playerIntersects = raycaster.intersectObjects(playerObjects, true);

      if (playerIntersects.length > 0) {
        soundFX.playHitMarker();
        let rootGroup: THREE.Object3D | null = playerIntersects[0].object;
        while (rootGroup && !remotePlayersMeshes.has((rootGroup as any).name) && rootGroup.parent) {
          const found = playerEntries.find((p) => p[1] === rootGroup);
          if (found) {
            if (currentRoom) {
              currentRoom.send('player_shoot', {
                targetType: 'player',
                targetId: found[0],
                damage: 35,
              });
            } else {
              setHudStats((prev) => ({
                ...prev,
                kills: prev.kills + 1,
                earningsMicroUsd: prev.earningsMicroUsd + 100000,
              }));
              setKillFeed((prev) => ['🎯 Eliminated Practice Target! (+$0.10)', ...prev.slice(0, 4)]);
            }
            return;
          }
          rootGroup = rootGroup.parent;
        }
        if (!currentRoom) {
          setHudStats((prev) => ({
            ...prev,
            kills: prev.kills + 1,
            earningsMicroUsd: prev.earningsMicroUsd + 100000,
          }));
          setKillFeed((prev) => ['🎯 Hit Practice Target! (Solo Mode)', ...prev.slice(0, 4)]);
        }
      }
    };

    shootWeaponRef.current = shootWeapon;
    togglePropRef.current = () => {
      if (currentRoom) {
        currentRoom.send('player_toggle_prop');
      } else {
        setHudStats((prev) => ({ ...prev, isProp: !prev.isProp }));
      }
    };

    // 8. Input & Controls
    const keys = {
      w: false,
      a: false,
      s: false,
      d: false,
      q: false,
      e: false,
      shift: false,
      ctrl: false,
      space: false,
    };
    let euler = new THREE.Euler(0, 0, 0, 'YXZ');
    cameraRef.current = camera;
    eulerRef.current = euler;

    let jumpVelocity = 0;
    let playerY = 0;
    const gravity = -20;

    triggerJumpRef.current = () => {
      if (playerY === 0) {
        jumpVelocity = 8.0;
      }
    };

    const isGhostSpectator =
      (typeof window !== 'undefined' && window.location.search.includes('mode=spectator')) ||
      hudStats.isGhost;

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = true;
      if (k === 'a') keys.a = true;
      if (k === 's') keys.s = true;
      if (k === 'd') keys.d = true;
      if (k === 'q') keys.q = true;
      if (k === 'e') keys.e = true;
      if (k === 'shift') keys.shift = true;
      if (k === 'control') keys.ctrl = true;
      if (k === ' ') {
        keys.space = true;
        e.preventDefault();
      }
      if (k === 'c') {
        togglePropRef.current();
      }
      if (k === 'f') {
        shootWeapon();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = false;
      if (k === 'a') keys.a = false;
      if (k === 's') keys.s = false;
      if (k === 'd') keys.d = false;
      if (k === 'q') keys.q = false;
      if (k === 'e') keys.e = false;
      if (k === 'shift') keys.shift = false;
      if (k === 'control') keys.ctrl = false;
      if (k === ' ') keys.space = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      let deltaX = 0;
      let deltaY = 0;

      if (isPointerLockedRef.current) {
        deltaX = e.movementX || 0;
        deltaY = e.movementY || 0;
      } else if ((isDragLookRef.current || isGhostSpectator) && isMouseDownRef.current) {
        deltaX = e.movementX || 0;
        deltaY = e.movementY || 0;
      } else {
        return;
      }

      euler.setFromQuaternion(camera.quaternion);
      euler.y -= deltaX * 0.0025;
      euler.x -= deltaY * 0.0025;
      euler.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, euler.x));
      camera.quaternion.setFromEuler(euler);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);

    const onPointerLockChange = () => {
      const locked = document.pointerLockElement === container;
      isPointerLockedRef.current = locked;
      setIsPointerLocked(locked);
      if (locked) {
        setIsOverlayDismissed(true);
        isOverlayDismissedRef.current = true;
      }
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const handleCanvasClick = () => {
      if (isPointerLockedRef.current) {
        shootWeapon();
      } else if (!isOverlayDismissedRef.current && !isMobileRef.current) {
        engageControls(container);
      }
    };
    container.addEventListener('click', handleCanvasClick);

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDownRef.current = true;
        if (isPointerLockedRef.current) {
          shootWeapon();
        }
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 0) {
        isMouseDownRef.current = false;
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);

    // 9. Animation & Movement Loop
    let lastTime = performance.now();
    let animId: number;

    const animate = () => {
      animId = requestAnimationFrame(animate);

      const now = performance.now();
      const delta = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      // Animate chest bobbing & spinning aura
      chestMeshes.forEach((cGroup) => {
        cGroup.rotation.y += 0.02;
        cGroup.position.y = Math.sin(now * 0.003) * 0.1;
      });

      // Player Movement (Online & Offline Practice Mode)
      const isCrouching = keys.ctrl || isCrouchActiveRef.current;
      let speed = 7.0;
      if (keys.shift) {
        speed = 3.2; // Walk Slow per spec
      } else if (isCrouching) {
        speed = 3.5;
      }
      if (isGhostSpectator) {
        speed = 12.0;
      }

      // Lean roll angle
      let targetRoll = 0;
      if (keys.q || leanStateRef.current === 'left') {
        targetRoll = 0.25; // Lean Left
      } else if (keys.e || leanStateRef.current === 'right') {
        targetRoll = -0.25; // Lean Right
      }

      euler.setFromQuaternion(camera.quaternion);
      euler.z = THREE.MathUtils.lerp(euler.z, targetRoll, 0.2);
      camera.quaternion.setFromEuler(euler);

      // ADS FOV Zoom
      const targetFov = isAdsActiveRef.current ? 42 : 75;
      if (Math.abs(camera.fov - targetFov) > 0.5) {
        camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 0.25);
        camera.updateProjectionMatrix();
      }

      // Base eye height & jump physics
      const baseHeight = isGhostSpectator ? camera.position.y : (isCrouching ? 1.05 : 1.7);
      if (!isGhostSpectator) {
        if (keys.space && playerY === 0) {
          jumpVelocity = 8.0;
        }
        if (playerY > 0 || jumpVelocity !== 0) {
          playerY += jumpVelocity * delta;
          jumpVelocity += gravity * delta;
          if (playerY <= 0) {
            playerY = 0;
            jumpVelocity = 0;
          }
        }
        playerYRef.current = playerY;
        camera.position.y = baseHeight + playerY;
      } else {
        // Free flight in Ghost Spectator mode
        if (keys.space) camera.position.y += 8.0 * delta;
        if (keys.ctrl) camera.position.y -= 8.0 * delta;
      }

      let moveX = 0;
      let moveZ = 0;

      if (isMobileRef.current) {
        moveX = mobileInputRef.current.moveX;
        moveZ = mobileInputRef.current.moveZ;
      } else {
        if (keys.w) moveZ -= 1;
        if (keys.s) moveZ += 1;
        if (keys.a) moveX -= 1;
        if (keys.d) moveX += 1;
      }

      if (moveX !== 0 || moveZ !== 0) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        if (!isGhostSpectator) forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        if (!isGhostSpectator) right.y = 0;
        right.normalize();

        const dir = new THREE.Vector3();
        dir.addScaledVector(forward, -moveZ);
        dir.addScaledVector(right, moveX);
        dir.normalize();

        camera.position.addScaledVector(dir, speed * delta);

        if (currentRoom) {
          currentRoom.send('player_move', {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z,
            rotationY: euler.y,
          });
        }
      }

      renderer.render(scene, camera);
    };

    animate();

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      destroyed = true;
      cancelAnimationFrame(animId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      container.removeEventListener('click', handleCanvasClick);
      container.removeEventListener('mousedown', handleMouseDown);
      currentRoom?.leave();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

    const isGhostSpectator =
    (typeof window !== 'undefined' && window.location.search.includes('mode=spectator')) ||
    hudStats.isGhost;

  const showDesktopOverlay =
    !isOverlayDismissed && !isMobile && !isPointerLocked && !isGhostSpectator;

  return (
    <div className="relative w-full h-[calc(100vh-5rem)] rounded-3xl overflow-hidden border border-slate-800 bg-black select-none shadow-2xl">
      {/* 3D WebGL Canvas */}
      <div ref={mountRef} className="w-full h-full cursor-crosshair" />

      {/* Mobile Touch Aim Surface (Right 65% of screen for swipe-aiming) */}
      {isMobile && (
        <div
          className="absolute top-16 right-0 bottom-0 left-1/3 pointer-events-auto touch-none select-none z-10"
          onTouchStart={handleTouchLookStart}
          onTouchMove={handleTouchLookMove}
          onTouchEnd={handleTouchLookEnd}
          onTouchCancel={handleTouchLookEnd}
        />
      )}

      {/* Dynamic Crosshair (PC & Mobile ADS Scope) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-20">
        {isAdsActive ? (
          <div className="relative w-20 h-20 flex items-center justify-center animate-in zoom-in-75 duration-150">
            <div className="absolute inset-0 rounded-full border-2 border-emerald-400/80 shadow-[0_0_15px_rgba(52,211,153,0.5)]" />
            <div className="w-full h-0.5 bg-emerald-400/70" />
            <div className="h-full w-0.5 bg-emerald-400/70 absolute" />
            <div className="w-2 h-2 rounded-full bg-rose-500 shadow-md" />
            <div className="absolute -bottom-5 text-[9px] font-mono text-emerald-400 font-bold tracking-widest">
              ADS 2.5X
            </div>
          </div>
        ) : (
          <div className="w-6 h-6 border-2 border-rose-500/80 rounded-full flex items-center justify-center shadow-lg shadow-rose-500/50">
            <div className="w-1.5 h-1.5 bg-rose-500 rounded-full" />
          </div>
        )}
      </div>

      {/* Prop Disguise Overlay (When active) */}
      {hudStats.isProp && (
        <div className="absolute top-24 left-1/2 transform -translate-x-1/2 pointer-events-none z-30">
          <div className="bg-amber-500/90 text-slate-950 font-black text-xs px-4 py-2 rounded-2xl shadow-xl shadow-amber-500/40 border-2 border-white flex items-center space-x-2 animate-bounce">
            <span>📦</span>
            <span>PROP DISGUISE ACTIVE (DISGUISED AS SUPPLY CRATE) • PRESS 'C' TO EXIT</span>
          </div>
        </div>
      )}

      {/* Top HUD: Combat, Economy & Audio Controls */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none z-20">
        {/* Left: Health & Status */}
        <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 p-3 sm:p-3.5 rounded-2xl flex items-center space-x-3 sm:space-x-4 shadow-xl pointer-events-auto">
          <div>
            <div className="flex justify-between items-center text-[10px] text-slate-400 font-black uppercase">
              <span>HEALTH</span>
              <span>{hudStats.health}%</span>
            </div>
            <div className="w-24 sm:w-32 h-2.5 bg-slate-800 rounded-full overflow-hidden mt-1">
              <div
                className={`h-full transition-all duration-300 ${
                  hudStats.health > 50 ? 'bg-emerald-500' : hudStats.health > 25 ? 'bg-amber-500' : 'bg-rose-600'
                }`}
                style={{ width: `${hudStats.health}%` }}
              />
            </div>
          </div>

          {/* Connection Status Indicator */}
          {connectionStatus === 'connected' ? (
            <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              20Hz MULTIPLAYER
            </span>
          ) : connectionStatus === 'offline_practice' ? (
            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              OFFLINE PRACTICE MODE • Solo Physics Active
            </span>
          ) : (
            <span className="bg-blue-500/20 text-blue-300 border border-blue-500/40 text-[10px] font-black px-2.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
              CONNECTING...
            </span>
          )}

          {hudStats.isProp && (
            <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">
              📦 PROP
            </span>
          )}
          {hudStats.isGhost && (
            <span className="bg-purple-500/20 text-purple-300 border border-purple-500/40 text-[10px] font-black px-2 py-0.5 rounded-full animate-pulse">
              👻 GHOST
            </span>
          )}
        </div>

        {/* Center: Spectator Quest Progress (90s) */}
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
                  className={`h-full rounded-full transition-all duration-500 ${
                    spectatorQuestCompleted ? 'bg-emerald-400' : 'bg-indigo-500'
                  }`}
                  style={{ width: `${Math.min(100, Math.round((spectatorSeconds / 90) * 100))}%` }}
                />
              </div>
            </div>
            {spectatorQuestCompleted && (
              <span className="bg-emerald-500 text-slate-950 font-black text-[10px] px-2 py-0.5 rounded-md animate-bounce">
                READY TO CLAIM!
              </span>
            )}
          </div>
        )}

        {/* Right: Round Earnings & Audio Toggle */}
        <div className="flex items-center space-x-2 pointer-events-auto">
          <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 p-3 sm:p-3.5 rounded-2xl flex items-center space-x-4 text-right shadow-xl">
            <div>
              <span className="text-[10px] text-slate-400 font-bold block uppercase">Round Earned</span>
              <span className="text-sm sm:text-base font-black text-emerald-400 font-mono">
                {formatMicroUsd(hudStats.earningsMicroUsd)}
              </span>
            </div>
            <div className="border-l border-slate-800 pl-3">
              <span className="text-[10px] text-slate-400 font-bold block uppercase">Kills</span>
              <span className="text-sm sm:text-base font-black text-white">{hudStats.kills}</span>
            </div>
          </div>

          {/* Sound Toggle Button */}
          <button
            onClick={toggleMute}
            className="bg-slate-900/90 hover:bg-slate-800 border border-slate-700 p-2.5 rounded-2xl text-xs font-bold transition shadow-md active:scale-95"
            title={isMuted ? 'Unmute Sound' : 'Mute Sound'}
          >
            {isMuted ? '🔇' : '🔊'}
          </button>
        </div>
      </div>

      {/* Killfeed Notifications */}
      <div className="absolute top-20 right-4 space-y-1.5 pointer-events-none z-20">
        {killFeed.map((feed, idx) => (
          <div key={idx} className="bg-slate-950/80 border border-slate-800 text-xs font-bold text-slate-200 px-3 py-1.5 rounded-xl backdrop-blur-md shadow-lg animate-in fade-in slide-in-from-right-4">
            {feed}
          </div>
        ))}
      </div>

      {/* Desktop Controls Hint & PointerLock Modal */}
      {showDesktopOverlay && (
        <div
          onClick={() => engageControls()}
          className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center pointer-events-auto z-30 cursor-pointer"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-slate-700 p-6 sm:p-7 rounded-3xl text-center max-w-md space-y-4 shadow-2xl mx-4"
          >
            <h3 className="text-lg font-black text-white tracking-tight">CLICK SCREEN TO ENGAGE CONTROLS</h3>
            <p className="text-xs text-slate-300 leading-relaxed font-mono">
              W,A,S,D: Move | Q/E: Lean | Shift: Walk Slow | Ctrl: Crouch | C: Prop-Hide Disguise | Left-Click: Fire | Esc: Release
            </p>
            <div className="text-[11px] bg-amber-500/20 border border-amber-500/40 text-amber-300 py-2.5 px-3 rounded-xl font-bold">
              🎁 15-Second Bounty Chests spawn on player kills. Shoot them to claim instant Micro-USD Coins!
            </div>
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button
                onClick={() => engageControls()}
                className="flex-1 bg-rose-600 hover:bg-rose-500 text-white text-xs font-black py-2.5 px-4 rounded-xl shadow-lg transition active:scale-95"
              >
                🎮 CLICK TO PLAY (LOCK MOUSE)
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOverlayDismissed(true);
                  setIsDragLookMode(true);
                }}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold py-2.5 px-3 rounded-xl border border-slate-600 transition active:scale-95"
              >
                🖱️ Drag-Look Mode (No Lock)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Status Pill when mouse is unlocked (Desktop only, non-blocking) */}
      {!isMobile && isOverlayDismissed && !isPointerLocked && !isGhostSpectator && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto animate-in fade-in slide-in-from-top-2">
          <div className="bg-slate-900/90 border border-slate-700/80 backdrop-blur-md px-3.5 py-1.5 rounded-full text-[11px] font-bold text-slate-300 shadow-xl flex items-center gap-2.5">
            <span>{isDragLookMode ? '🖱️ Drag-Look Mode (Hold Left-Click to Aim)' : '🔓 Mouse Unlocked'}</span>
            <button
              onClick={() => engageControls()}
              className="bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-extrabold px-2.5 py-0.5 rounded-full transition active:scale-95"
            >
              Lock Mouse
            </button>
            {!isDragLookMode && (
              <button
                onClick={() => setIsDragLookMode(true)}
                className="text-slate-400 hover:text-white text-[10px] font-semibold underline"
              >
                Drag-Look
              </button>
            )}
          </div>
        </div>
      )}

      {/* Ghost Spectator Guidance Banner */}
      {isGhostSpectator && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <div className="bg-purple-950/90 border border-purple-500/60 backdrop-blur-md px-4 py-1.5 rounded-full text-xs font-bold text-purple-200 shadow-xl flex items-center gap-2">
            <span>👻 GHOST SPECTATOR</span>
            <span className="text-slate-400">•</span>
            <span className="text-[11px] text-purple-300 font-mono">WASD: Fly | Space: Up | Ctrl: Down | Drag: Look</span>
          </div>
        </div>
      )}

      {/* Mobile / Tablet PUBG-Style Touch Controls */}
      {isMobile && (
        <>
          {/* Left Virtual Joystick Container */}
          <div className="absolute bottom-6 left-6 pointer-events-auto touch-none select-none z-20">
            <div
              className="relative w-32 h-32 rounded-full border-2 border-white/20 bg-slate-900/60 backdrop-blur-md flex items-center justify-center shadow-2xl active:border-rose-500/50"
              onTouchStart={handleJoystickTouchStart}
              onTouchMove={handleJoystickTouchMove}
              onTouchEnd={handleJoystickTouchEnd}
              onTouchCancel={handleJoystickTouchEnd}
            >
              <div className="absolute inset-2 rounded-full border border-dashed border-white/10 pointer-events-none" />
              <span className="absolute top-1.5 text-[9px] font-black text-slate-500 pointer-events-none">W</span>
              <span className="absolute bottom-1.5 text-[9px] font-black text-slate-500 pointer-events-none">S</span>
              <span className="absolute left-2 text-[9px] font-black text-slate-500 pointer-events-none">A</span>
              <span className="absolute right-2 text-[9px] font-black text-slate-500 pointer-events-none">D</span>

              <div
                className="w-12 h-12 rounded-full bg-gradient-to-tr from-rose-600 to-amber-500 shadow-lg shadow-rose-600/40 border border-white/40 flex items-center justify-center pointer-events-none transition-transform duration-75"
                style={{
                  transform: `translate(${joystickPos.x}px, ${joystickPos.y}px)`,
                }}
              >
                <div className="w-3.5 h-3.5 rounded-full bg-white/70" />
              </div>
            </div>
          </div>

          {/* Right Action Buttons */}
          <div className="absolute bottom-6 right-6 pointer-events-auto flex flex-col items-end space-y-3 z-20 select-none">
            {/* Upper Action Row: Leans & ADS */}
            <div className="flex items-center space-x-2">
              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  setLeanState((prev) => (prev === 'left' ? 'none' : 'left'));
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setLeanState((prev) => (prev === 'left' ? 'none' : 'left'));
                }}
                className={`w-11 h-11 rounded-xl text-xs font-black flex items-center justify-center shadow-md border transition ${
                  leanState === 'left'
                    ? 'bg-amber-500 text-slate-950 border-white'
                    : 'bg-slate-900/80 text-white border-slate-700'
                }`}
              >
                ↖️ Q
              </button>

              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  setLeanState((prev) => (prev === 'right' ? 'none' : 'right'));
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setLeanState((prev) => (prev === 'right' ? 'none' : 'right'));
                }}
                className={`w-11 h-11 rounded-xl text-xs font-black flex items-center justify-center shadow-md border transition ${
                  leanState === 'right'
                    ? 'bg-amber-500 text-slate-950 border-white'
                    : 'bg-slate-900/80 text-white border-slate-700'
                }`}
              >
                ↗️ E
              </button>

              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  setIsAdsActive((prev) => !prev);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsAdsActive((prev) => !prev);
                }}
                className={`w-12 h-12 rounded-2xl text-xs font-black flex items-center justify-center shadow-lg border transition ${
                  isAdsActive
                    ? 'bg-emerald-500 text-slate-950 border-white shadow-emerald-500/50 scale-105'
                    : 'bg-slate-900/80 text-white border-slate-700'
                }`}
              >
                🎯 ADS
              </button>
            </div>

            {/* Secondary Actions: Crouch, Jump, Prop */}
            <div className="flex items-center space-x-2">
              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  togglePropRef.current?.();
                }}
                onClick={(e) => {
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
                onClick={(e) => {
                  e.stopPropagation();
                  setIsCrouchActive((prev) => !prev);
                }}
                className={`w-12 h-12 rounded-2xl text-xs font-black flex items-center justify-center shadow-lg border transition ${
                  isCrouchActive
                    ? 'bg-amber-500 text-slate-950 border-white scale-105'
                    : 'bg-slate-900/80 text-white border-slate-700'
                }`}
              >
                ⬇️ CROUCH
              </button>

              <button
                onTouchStart={(e) => {
                  e.stopPropagation();
                  triggerJumpRef.current?.();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  triggerJumpRef.current?.();
                }}
                className="w-12 h-12 rounded-2xl bg-indigo-600/90 active:bg-indigo-500 text-white font-black text-xs flex items-center justify-center shadow-lg border border-indigo-400/50 active:scale-95 transition"
              >
                ⬆️ JUMP
              </button>
            </div>

            {/* Primary Fire Button */}
            <button
              onTouchStart={(e) => {
                e.stopPropagation();
                shootWeaponRef.current?.();
              }}
              onClick={(e) => {
                e.stopPropagation();
                shootWeaponRef.current?.();
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
