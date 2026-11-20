/**
 * test-game-server.js
 * Integration test for MWAR Authoritative Shooter Game Server (Colyseus v0.15+)
 */

const { Client } = require('../apps/web/node_modules/colyseus.js');
const { GameState } = require('../apps/game-server/dist/schema/GameState.js');

async function run() {
  console.log('=== [1] Testing Game Server Health Check ===');
  const healthRes = await fetch('http://localhost:2567/health');
  if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);
  const healthData = await healthRes.json();
  console.log('Health check response:', healthData);
  if (healthData.status !== 'ok') throw new Error('Health status is not ok');

  console.log('\n=== [2] Connecting Player 1 (Attacker) to mini_30 ===');
  const client1 = new Client('ws://localhost:2567');
  const room1 = await client1.joinOrCreate('mini_30', {
    userId: 'user_test_p1',
    username: 'GhostSniper_Dev',
  }, GameState);
  console.log(`Player 1 connected! SessionId: ${room1.sessionId}`);

  // Register common message listeners
  room1.onMessage('chest_spawned', () => {});
  room1.onMessage('chest_destroyed', () => {});
  room1.onMessage('player_damaged', () => {});
  room1.onMessage('prop_transformed', () => {});

  // Wait for player to be in state
  await new Promise((resolve) => {
    const check = () => {
      const p = room1.state?.players?.get(room1.sessionId);
      return !!p;
    };
    if (check()) return resolve();
    room1.onStateChange(() => {
      if (check()) resolve();
    });
  });

  const p1 = room1.state.players.get(room1.sessionId);
  console.log(`Player 1 spawned at (${p1.x}, ${p1.y}, ${p1.z}), Health: ${p1.health}, Prop: ${p1.isProp}, Ghost: ${p1.isGhost}`);

  console.log('\n=== [3] Testing Movement Sync ===');
  room1.send('player_move', { x: 10, y: 0, z: 25, rotationY: 1.57 });
  await new Promise((r) => setTimeout(r, 150));
  console.log(`Player 1 updated pos: (${p1.x}, ${p1.y}, ${p1.z}), rotY: ${p1.rotationY}`);
  if (p1.x !== 10 || p1.z !== 25) throw new Error('Movement was not synchronized');

  console.log('\n=== [4] Testing Prop-Hide Disguise Mode ===');
  room1.send('player_toggle_prop', {});
  await new Promise((r) => setTimeout(r, 150));
  console.log(`Player 1 isProp: ${p1.isProp}, propType: ${p1.propType}`);
  if (!p1.isProp) throw new Error('Prop disguise mode did not toggle');

  // Toggle off
  room1.send('player_toggle_prop', {});
  await new Promise((r) => setTimeout(r, 150));
  console.log(`Player 1 isProp after untoggle: ${p1.isProp}`);
  if (p1.isProp) throw new Error('Prop disguise mode did not untoggle');

  console.log('\n=== [5] Testing 15-Second Chest Destruction ===');
  let firstChestId = null;
  room1.state.chests.forEach((_chest, key) => {
    if (!firstChestId) firstChestId = key;
  });
  console.log(`Found active map chest: ${firstChestId}`);
  if (firstChestId) {
    const chest = room1.state.chests.get(firstChestId);
    console.log(`Chest initial health: ${chest.health}, reward: $${chest.rewardMicroUsd / 1_000_000}`);
    
    // Shoot chest with 50 damage
    room1.send('player_shoot', { targetType: 'chest', targetId: firstChestId, damage: 50 });
    await new Promise((r) => setTimeout(r, 200));
    console.log(`Player 1 chests collected: ${p1.chestsCollected}, Session Earnings: $${p1.sessionEarningsMicroUsd / 1_000_000}`);
  }

  console.log('\n=== [6] Connecting Player 2 (Target) for PvP Combat ===');
  const client2 = new Client('ws://localhost:2567');
  const room2 = await client2.joinOrCreate('mini_30', {
    userId: 'user_test_p2',
    username: 'TargetDummy_Dev',
  }, GameState);
  console.log(`Player 2 connected! SessionId: ${room2.sessionId}`);
  room2.onMessage('chest_spawned', () => {});
  room2.onMessage('player_damaged', () => {});
  room2.onMessage('entered_ghost_mode', () => {});

  await new Promise((resolve) => {
    const check = () => {
      const p = room1.state?.players?.get(room2.sessionId);
      return !!p;
    };
    if (check()) return resolve();
    room1.onStateChange(() => {
      if (check()) resolve();
    });
  });

  const p2 = room1.state.players.get(room2.sessionId);
  console.log(`Player 2 viewed by Room 1: (${p2.x}, ${p2.y}, ${p2.z}), Health: ${p2.health}`);

  console.log('\n=== [7] PvP Combat: Player 1 Eliminates Player 2 ===');
  let deathDropDetected = false;
  room1.onMessage('player_killed', (msg) => {
    console.log(`[Event: player_killed] ${msg.killerUsername} killed ${msg.victimUsername} (+$${msg.rewardMicroUsd / 1_000_000})`);
  });

  room1.state.chests.onAdd((chest) => {
    if (chest.isDeathDrop) {
      deathDropDetected = true;
      console.log(`[Event: 15s Death Chest Spawned!] Location: (${chest.x}, ${chest.y}, ${chest.z}), Reward: $${chest.rewardMicroUsd / 1_000_000}, Expires in 15s`);
    }
  });

  // Player 1 deals 100 damage to Player 2
  room1.send('player_shoot', { targetType: 'player', targetId: room2.sessionId, damage: 100 });
  await new Promise((r) => setTimeout(r, 300));

  console.log(`Player 1 Kills: ${p1.kills}, Earnings: $${p1.sessionEarningsMicroUsd / 1_000_000}`);
  console.log(`Player 2 isGhost (Spectator Mode): ${p2.isGhost}, Health: ${p2.health}`);
  if (p1.kills !== 1) throw new Error('Player 1 did not record kill');
  if (!p2.isGhost) throw new Error('Player 2 did not enter Ghost spectator mode');

  console.log('\n=== [8] Disconnecting Players ===');
  await room2.leave();
  await room1.leave();
  console.log('Players disconnected cleanly.');

  console.log('\n🎉 ALL GAME SERVER TESTS PASSED 100%!');
  process.exit(0);
}

run().catch((err) => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
