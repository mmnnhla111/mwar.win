'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Client as ColyseusClient, Room } from 'colyseus.js';
import { apiFetch, progressQuest } from '../../lib/api';
import { formatCoins, formatMicroUsd } from '@mwar/shared';
import { GhostSpectatorIcon, QuestSpectateIcon } from '../../components/icons';

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

  useEffect(() => {
    // Detect mobile touch
    setIsMobile('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }, []);

  // Spectator timer heartbeat
  useEffect(() => {
    const isSpectatorMode = typeof window !== 'undefined' && (
      window.location.search.includes('mode=spectator') || hudStats.isGhost
    );

    if (!isSpectatorMode) return;

    const timer = setInterval(async () => {
      setSpectatorSeconds((prev) => {
        const next = prev + 1;
        // Every 15 seconds, ping API progress
        if (next % 15 === 0 && next <= 90) {
          progressQuest('Q_SPECTATE', 15).catch(() => {});
        }
        if (next >= 90 && !spectatorQuestCompleted) {
          setSpectatorQuestCompleted(true);
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
    scene.background = new THREE.Color(0x0e131f);
    scene.fog = new THREE.FogExp2(0x0e131f, 0.015);

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, 1.7, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // 2. Lighting & Environment
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    dirLight.position.set(50, 80, 50);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Ground Plane (Grid tactical map)
    const groundGeo = new THREE.PlaneGeometry(300, 300, 30, 30);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x182030,
      roughness: 0.8,
      metalness: 0.2,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const gridHelper = new THREE.GridHelper(300, 60, 0xe63946, 0x243248);
    gridHelper.position.y = 0.02;
    scene.add(gridHelper);

    // Buildings & Obstacles (Procedural)
    const buildingGeo = new THREE.BoxGeometry(10, 8, 10);
    const buildingMat = new THREE.MeshStandardMaterial({ color: 0x2b384e, roughness: 0.9 });
    for (let i = 0; i < 10; i++) {
      const b = new THREE.Mesh(buildingGeo, buildingMat);
      b.position.set((Math.random() - 0.5) * 180, 4, (Math.random() - 0.5) * 180);
      b.castShadow = true;
      b.receiveShadow = true;
      scene.add(b);
    }

    // 3. Connect to Colyseus Game Server
    const colyseusClient = new ColyseusClient(
      process.env.NEXT_PUBLIC_GAME_SERVER_URL || 'ws://localhost:2567'
    );

    const remotePlayersMeshes = new Map<string, THREE.Group>();
    const chestMeshes = new Map<string, THREE.Mesh>();

    let currentRoom: Room | null = null;

    async function initColyseus() {
      try {
        let meData: any = null;
        try {
          meData = await apiFetch('/api/auth/me');
        } catch {
          // Play as guest if not logged in
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

        // Player Join / Move / Prop synchronization
        const state = roomInstance.state as any;
        state.players.onAdd((player: any, key: string) => {
          if (key === roomInstance.sessionId) {
            // Local player
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
            // Remote player mesh
            const pGroup = new THREE.Group();
            const bodyGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.8, 16);
            const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00b4d8 });
            const body = new THREE.Mesh(bodyGeo, bodyMat);
            body.position.y = 0.9;
            pGroup.add(body);
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

        // 15-Second Treasure Chests synchronization
        state.chests.onAdd((chest: any, key: string) => {
          const cGeo = new THREE.BoxGeometry(1.2, 1, 1.2);
          const cMat = new THREE.MeshStandardMaterial({
            color: chest.isDeathDrop ? 0xff9f1c : 0xffd166,
            roughness: 0.3,
            metalness: 0.7,
            emissive: chest.isDeathDrop ? 0x663300 : 0x443300,
          });
          const cMesh = new THREE.Mesh(cGeo, cMat);
          cMesh.position.set(chest.x, chest.y + 0.5, chest.z);
          scene.add(cMesh);
          chestMeshes.set(key, cMesh);
        });

        state.chests.onRemove((_chest: any, key: string) => {
          const cMesh = chestMeshes.get(key);
          if (cMesh) {
            scene.remove(cMesh);
            chestMeshes.delete(key);
          }
        });

        // Events
        roomInstance.onMessage('player_killed', (data: any) => {
          setKillFeed((prev) => [`⚔️ ${data.killerUsername} killed ${data.victimUsername} (+$0.10)`, ...prev.slice(0, 4)]);
        });

        roomInstance.onMessage('chest_destroyed', (data: any) => {
          setKillFeed((prev) => [`💰 ${data.collectedByUsername} opened 15s Chest!`, ...prev.slice(0, 4)]);
        });

        roomInstance.onMessage('afk_warning', (data: any) => {
          setAfkPrompt(data.message);
        });

        roomInstance.onMessage('afk_cleared', () => {
          setAfkPrompt(null);
        });
      } catch (err: any) {
        console.error('Colyseus connection error:', err);
      }
    }

    initColyseus();

    // 4. Input & Controls (PC PointerLock & Keys)
    const keys = { w: false, a: false, s: false, d: false, shift: false };
    let euler = new THREE.Euler(0, 0, 0, 'YXZ');

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w') keys.w = true;
      if (k === 'a') keys.a = true;
      if (k === 's') keys.s = true;
      if (k === 'd') keys.d = true;
      if (k === 'shift') keys.shift = true;
      if (k === 'c') {
        currentRoom?.send('player_toggle_prop');
      }
      if (k === 'f' || e.code === 'Space') {
        // Fire weapon
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

    const shootWeapon = () => {
      if (!currentRoom) return;
      // Raycast shooting
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

      // Check chests first
      const chestEntries = Array.from(chestMeshes.entries());
      const chestObjects = chestEntries.map((c) => c[1]);
      const chestIntersects = raycaster.intersectObjects(chestObjects);

      if (chestIntersects.length > 0) {
        const hitMesh = chestIntersects[0].object as THREE.Mesh;
        const entry = chestEntries.find((c) => c[1] === hitMesh);
        if (entry) {
          currentRoom.send('player_shoot', {
            targetType: 'chest',
            targetId: entry[0],
            damage: 25,
          });
          return;
        }
      }

      // Check remote players
      const playerEntries = Array.from(remotePlayersMeshes.entries());
      const playerObjects = playerEntries.map((p) => p[1]);
      const playerIntersects = raycaster.intersectObjects(playerObjects, true);

      if (playerIntersects.length > 0) {
        let rootGroup: THREE.Object3D | null = playerIntersects[0].object;
        while (rootGroup && !remotePlayersMeshes.has((rootGroup as any).name) && rootGroup.parent) {
          const found = playerEntries.find((p) => p[1] === rootGroup);
          if (found) {
            currentRoom.send('player_shoot', {
              targetType: 'player',
              targetId: found[0],
              damage: 35,
            });
            return;
          }
          rootGroup = rootGroup.parent;
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);

    // Canvas click requests pointer lock
    const handleCanvasClick = () => {
      if (!isMobile && !document.pointerLockElement) {
        container.requestPointerLock();
      } else {
        shootWeapon();
      }
    };
    container.addEventListener('click', handleCanvasClick);

    const onPointerLockChange = () => {
      setIsPointerLocked(document.pointerLockElement === container);
    };
    document.addEventListener('pointerlockchange', onPointerLockChange);

    // 5. Game Render & Physics Loop
    let lastTime = performance.now();
    let animId: number;

    const animate = (time: number) => {
      animId = requestAnimationFrame(animate);
      const delta = (time - lastTime) / 1000;
      lastTime = time;

      // Handle Movement
      const speed = keys.shift ? 12 : 6;
      const moveVec = new THREE.Vector3();

      if (keys.w) moveVec.z -= 1;
      if (keys.s) moveVec.z += 1;
      if (keys.a) moveVec.x -= 1;
      if (keys.d) moveVec.x += 1;

      // Mobile joystick inputs
      if (mobileInputRef.current.moveX !== 0 || mobileInputRef.current.moveZ !== 0) {
        moveVec.x += mobileInputRef.current.moveX;
        moveVec.z += mobileInputRef.current.moveZ;
      }

      if (moveVec.lengthSq() > 0) {
        moveVec.normalize();
        moveVec.applyEuler(new THREE.Euler(0, euler.y, 0));
        camera.position.addScaledVector(moveVec, speed * delta);

        // Inform Colyseus server of position (Server-Authoritative bounding)
        currentRoom?.send('player_move', {
          x: camera.position.x,
          y: camera.position.y - 1.7,
          z: camera.position.z,
          rotationY: euler.y,
        });
      }

      // Rotate 15s chests slowly for visual effect
      chestMeshes.forEach((mesh) => {
        mesh.rotation.y += delta * 1.5;
      });

      renderer.render(scene, camera);
    };

    animId = requestAnimationFrame(animate);

    // Resize Handler
    const handleResize = () => {
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
    <div className="relative w-full h-[calc(100vh-5rem)] rounded-2xl overflow-hidden border border-gray-800 bg-black select-none">
      {/* 3D WebGL Canvas */}
      <div ref={mountRef} className="w-full h-full cursor-crosshair" />

      {/* Crosshair (PC) */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="w-4 h-4 border border-red-500/80 rounded-full flex items-center justify-center">
          <div className="w-1 h-1 bg-red-500 rounded-full"></div>
        </div>
      </div>

      {/* Top HUD: Combat & Financial Statistics */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-none">
        {/* Left: Health & Status */}
        <div className="bg-surface/80 backdrop-blur-md border border-gray-800 p-3 rounded-xl flex items-center space-x-4">
          <div>
            <span className="text-[10px] text-gray-400 font-bold block">HEALTH</span>
            <div className="w-32 h-3 bg-gray-800 rounded-full overflow-hidden mt-0.5">
              <div
                className={`h-full transition-all duration-300 ${
                  hudStats.health > 50 ? 'bg-emerald-500' : hudStats.health > 25 ? 'bg-yellow-500' : 'bg-red-600'
                }`}
                style={{ width: `${hudStats.health}%` }}
              />
            </div>
          </div>
          {hudStats.isProp && (
            <span className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 text-[10px] font-black px-2 py-0.5 rounded">
              📦 PROP DISGUISE ACTIVE
            </span>
          )}
          {hudStats.isGhost && (
            <span className="bg-cyan-500/20 text-cyan-400 border border-cyan-500/40 text-[10px] font-black px-2 py-0.5 rounded animate-pulse">
              👻 GHOST SPECTATOR MODE
            </span>
          )}
        </div>

        {/* Center: Spectator Quest Progress (90s) */}
        {(typeof window !== 'undefined' && window.location.search.includes('mode=spectator') || hudStats.isGhost) && (
          <div className="bg-slate-900/90 backdrop-blur-md border border-indigo-500/50 px-4 py-2 rounded-2xl flex items-center space-x-3 shadow-lg shadow-indigo-500/20">
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

        {/* Right: Round Earnings & Kills */}
        <div className="bg-surface/80 backdrop-blur-md border border-gray-800 p-3 rounded-xl flex items-center space-x-4 text-right">
          <div>
            <span className="text-[10px] text-gray-400 font-bold block">SESSION EARNED</span>
            <span className="text-base font-black text-emerald-400">
              {formatMicroUsd(hudStats.earningsMicroUsd)}
            </span>
            <span className="text-[10px] text-gray-500 block">
              {formatCoins(hudStats.earningsMicroUsd)}
            </span>
          </div>
          <div className="border-l border-gray-700 pl-3">
            <span className="text-[10px] text-gray-400 font-bold block">ELIMINATIONS</span>
            <span className="text-base font-black text-white">{hudStats.kills} Kills</span>
          </div>
        </div>
      </div>

      {/* Killfeed Notifications */}
      <div className="absolute top-20 right-4 space-y-1 pointer-events-none">
        {killFeed.map((feed, idx) => (
          <div key={idx} className="bg-black/60 border border-gray-800 text-xs text-gray-200 px-3 py-1 rounded backdrop-blur-sm">
            {feed}
          </div>
        ))}
      </div>

      {/* Controls Hint / PointerLock Overlay */}
      {!isPointerLocked && !isMobile && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center pointer-events-auto">
          <div className="bg-surface border border-gray-700 p-6 rounded-2xl text-center max-w-sm space-y-3">
            <h3 className="text-lg font-black text-white">CLICK SCREEN TO ENGAGE CONTROLS</h3>
            <p className="text-xs text-gray-400">
              WASD: Move | Shift: Sprint | Mouse: Aim | Left-Click: Fire | C: Prop-Hide Disguise | Esc: Release
            </p>
            <div className="text-[11px] bg-red-950/40 border border-red-900/50 text-red-300 py-1.5 px-3 rounded-lg font-semibold">
              🎁 15-Second Treasure Chests spawn randomly. Destroy them to earn Micro-USD!
            </div>
          </div>
        </div>
      )}

      {/* Mobile PUBG-Style Controls Overlay */}
      {isMobile && (
        <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4">
          <div />
          <div className="flex justify-between items-end pointer-events-auto">
            {/* Left Joystick Area */}
            <div className="w-32 h-32 rounded-full border-2 border-white/20 bg-white/5 flex items-center justify-center">
              <span className="text-xs text-gray-400 font-bold">MOVE</span>
            </div>

            {/* Right Action Buttons */}
            <div className="flex flex-col space-y-3 items-end">
              <button
                onClick={() => room?.send('player_toggle_prop')}
                className="w-14 h-14 rounded-full bg-yellow-600/80 active:bg-yellow-500 text-white font-bold text-xs flex items-center justify-center shadow-lg border border-yellow-400/50"
              >
                📦 PROP
              </button>
              <button
                onClick={() => {
                  // Fire weapon via mobile touch
                  room?.send('player_shoot', { targetType: 'chest', targetId: 'any', damage: 25 });
                }}
                className="w-20 h-20 rounded-full bg-red-600 active:bg-red-500 text-white font-black text-sm flex items-center justify-center shadow-xl border-2 border-white/40"
              >
                🔥 FIRE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Anti-AFK Captcha Popup */}
      {afkPrompt && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center z-50">
          <div className="bg-surface border border-yellow-500 p-6 rounded-2xl max-w-sm text-center space-y-4">
            <h3 className="text-base font-black text-yellow-400">⚠️ ANTI-AFK VERIFICATION</h3>
            <p className="text-xs text-gray-300">{afkPrompt}</p>
            <button
              onClick={() => room?.send('afk_captcha_solved')}
              className="w-full bg-yellow-500 hover:bg-yellow-400 text-black font-black py-2 rounded-xl text-sm"
            >
              I AM HERE (VERIFY)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
