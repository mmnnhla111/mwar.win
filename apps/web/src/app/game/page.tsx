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

  useEffect(() => {
    setIsMobile('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

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

    // 8. Input & Controls
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    let euler = new THREE.Euler(0, 0, 0, 'YXZ');

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

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = true;
      if (k === 'a') keys.a = true;
      if (k === 's') keys.s = true;
      if (k === 'd') keys.d = true;
      if (k === 'shift') keys.shift = true;
      if (k === 'c') {
        if (currentRoom) {
          currentRoom.send('player_toggle_prop');
        } else {
          setHudStats((prev) => ({ ...prev, isProp: !prev.isProp }));
        }
      }
      if (k === 'f' || e.code === 'Space') {
        shootWeapon();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = false;
      if (k === 'a') keys.a = false;
      if (k === 's') keys.s = false;
      if (k === 'd') keys.d = false;
      if (k === 'shift') keys.shift = false;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isPointerLocked) return;
      const movementX = e.movementX || 0;
      const movementY = e.movementY || 0;

      euler.setFromQuaternion(camera.quaternion);
      euler.y -= movementX * 0.0025;
      euler.x -= movementY * 0.0025;
      euler.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, euler.x));
      camera.quaternion.setFromEuler(euler);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);

    const onPointerLockChange = () => {
      setIsPointerLocked(document.pointerLockElement === container);
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    const handleCanvasClick = () => {
      if (!isPointerLocked && !isMobile) {
        container.requestPointerLock?.();
      } else if (isPointerLocked) {
        shootWeapon();
      }
    };
    container.addEventListener('click', handleCanvasClick);

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
      const speed = keys.shift ? 10.0 : 6.0;
      let moveX = 0;
      let moveZ = 0;

      if (isMobile) {
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
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        right.y = 0;
        right.normalize();

        const dir = new THREE.Vector3();
        dir.addScaledVector(forward, -moveZ);
        dir.addScaledVector(right, moveX);
        dir.normalize();

        camera.position.addScaledVector(dir, speed * delta);

        if (currentRoom) {
          currentRoom.send('player_move', {
            x: camera.position.x,
            y: 0,
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
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      container.removeEventListener('click', handleCanvasClick);
      currentRoom?.leave();
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [isPointerLocked, isMobile]);

  return (
    <div className="relative w-full h-[calc(100vh-5rem)] rounded-3xl overflow-hidden border border-slate-800 bg-black select-none shadow-2xl">
      {/* 3D WebGL Canvas */}
      <div ref={mountRef} className="w-full h-full cursor-crosshair" />

      {/* Crosshair (PC) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-rose-500/80 rounded-full flex items-center justify-center shadow-lg shadow-rose-500/50">
          <div className="w-1.5 h-1.5 bg-rose-500 rounded-full" />
        </div>
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
        <div className="bg-slate-950/85 backdrop-blur-md border border-slate-800 p-3 sm:p-3.5 rounded-2xl flex items-center space-x-3 sm:space-x-4 shadow-xl">
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
        {(typeof window !== 'undefined' && window.location.search.includes('mode=spectator') || hudStats.isGhost) && (
          <div className="bg-slate-950/90 backdrop-blur-md border border-indigo-500/50 px-4 py-2 rounded-2xl flex items-center space-x-3 shadow-lg shadow-indigo-500/20">
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
        <div className="flex items-center space-x-2">
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
            className="pointer-events-auto bg-slate-900/90 hover:bg-slate-800 border border-slate-700 p-2.5 rounded-2xl text-xs font-bold transition shadow-md"
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

      {/* Controls Hint / PointerLock Overlay (PC) */}
      {!isPointerLocked && !isMobile && (
        <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center pointer-events-auto z-30">
          <div className="bg-slate-900 border border-slate-700 p-6 rounded-3xl text-center max-w-sm space-y-3.5 shadow-2xl">
            <h3 className="text-lg font-black text-white tracking-tight">CLICK SCREEN TO ENGAGE CONTROLS</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              WASD: Move | Shift: Sprint | Mouse: Aim | Left-Click: Fire | C: Prop-Hide Disguise | Esc: Release
            </p>
            <div className="text-[11px] bg-amber-500/20 border border-amber-500/40 text-amber-300 py-2 px-3 rounded-xl font-bold">
              🎁 15-Second Bounty Chests spawn on player kills. Shoot them to claim instant Micro-USD Coins!
            </div>
          </div>
        </div>
      )}

      {/* Mobile Touch Controls */}
      {isMobile && (
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4 z-20">
          <div />
          <div className="flex justify-between items-end pointer-events-auto">
            <div className="w-28 h-28 rounded-full border-2 border-white/20 bg-slate-900/40 backdrop-blur-md flex items-center justify-center">
              <span className="text-xs text-slate-400 font-bold">JOYSTICK</span>
            </div>

            <div className="flex flex-col space-y-3 items-end">
              <button
                onClick={() => room?.send('player_toggle_prop')}
                className="w-14 h-14 rounded-2xl bg-amber-600/90 active:bg-amber-500 text-white font-black text-xs flex items-center justify-center shadow-lg border border-amber-400/50"
              >
                📦 PROP
              </button>
              <button
                onClick={() => {
                  soundFX.playGunshot();
                  room?.send('player_shoot', { targetType: 'chest', targetId: 'any', damage: 25 });
                }}
                className="w-18 h-18 rounded-3xl bg-gradient-to-tr from-rose-600 to-rose-500 active:scale-95 text-white font-black text-sm flex items-center justify-center shadow-2xl border-2 border-white/40"
              >
                🔥 FIRE
              </button>
            </div>
          </div>
        </div>
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
