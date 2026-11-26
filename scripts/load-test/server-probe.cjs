/**
 * server-probe.cjs — preloaded into the game server by run-load-and-security-test.mjs
 * (node --expose-gc --require ./server-probe.cjs --import tsx src/index.ts).
 *
 * Measures from inside the server process, without changing game code:
 *   - simulation tick gaps (every room's setSimulationInterval callback) and tick cost
 *   - patch broadcast gaps and cost (Room#broadcastPatch)
 *   - event-loop delay (perf_hooks.monitorEventLoopDelay, minus its 10 ms sampling interval)
 *   - heap / RSS, and how many room objects were created vs. garbage collected
 * Every second it prints one line "@@PROBE {json}" to stdout (histograms are cumulative since the
 * last "reset"). Commands on stdin, one per line:
 *   reset → start a new measurement window
 *   gc    → run a full GC, then print "@@PROBE_GC {json}" (the leak check)
 */
'use strict';
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const ELD_RESOLUTION_MS = 10;
const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
const lag = (ns) => Math.max(0, +(ns / 1e6 - ELD_RESOLUTION_MS).toFixed(2));
eld.enable();

// Histograms in 1 ms buckets up to 1000 ms (last bucket = overflow)
const newHist = () => ({ b: new Uint32Array(1001), n: 0, sum: 0, max: 0 });
const add = (h, v) => {
  const i = Math.min(1000, Math.max(0, Math.round(v)));
  h.b[i]++;
  h.n++;
  h.sum += v;
  if (v > h.max) h.max = v;
};
const pct = (h, p) => {
  if (!h.n) return 0;
  const target = Math.ceil(h.n * p);
  let acc = 0;
  for (let i = 0; i < h.b.length; i++) {
    acc += h.b[i];
    if (acc >= target) return i;
  }
  return 1000;
};
const summary = (h) => ({ n: h.n, mean: h.n ? +(h.sum / h.n).toFixed(2) : 0, p50: pct(h, 0.5), p95: pct(h, 0.95), p99: pct(h, 0.99), max: +h.max.toFixed(1) });

let tickGap = newHist();
let tickCost = newHist();
let patchGap = newHist();
let patchCost = newHist();
let roomsCreated = 0;
let roomsCollected = 0;
const finalizer = new FinalizationRegistry(() => {
  roomsCollected++;
});

function patchColyseus() {
  let colyseus;
  try {
    colyseus = require(require.resolve('colyseus', { paths: [process.cwd()] }));
  } catch (e) {
    console.log('@@PROBE_ERR ' + JSON.stringify({ error: 'colyseus not found: ' + e.message }));
    return;
  }
  const Room = colyseus.Room;
  const origSim = Room.prototype.setSimulationInterval;
  Room.prototype.setSimulationInterval = function (cb, delay) {
    if (typeof cb === 'function') {
      roomsCreated++;
      finalizer.register(this, null);
      let last = 0;
      const wrapped = (dt) => {
        const t0 = performance.now();
        if (last) add(tickGap, t0 - last);
        last = t0;
        const r = cb(dt);
        add(tickCost, performance.now() - t0);
        return r;
      };
      return origSim.call(this, wrapped, delay);
    }
    return origSim.call(this, cb, delay);
  };
  const origPatch = Room.prototype.broadcastPatch;
  if (typeof origPatch === 'function') {
    const lastPatch = new WeakMap();
    Room.prototype.broadcastPatch = function () {
      const t0 = performance.now();
      const last = lastPatch.get(this);
      if (last) add(patchGap, t0 - last);
      lastPatch.set(this, t0);
      const r = origPatch.apply(this, arguments);
      add(patchCost, performance.now() - t0);
      return r;
    };
  }
}
patchColyseus();

function snapshot() {
  const m = process.memoryUsage();
  const s = {
    t: Date.now(),
    heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
    rssMB: +(m.rss / 1048576).toFixed(1),
    // The histogram records the full gap between two 10 ms sampling timers (an idle loop reads ~10 ms),
    // so the sampling interval is subtracted: this is the extra delay the loop actually added.
    eventLoopDelayMs: { p50: lag(eld.percentile(50)), p99: lag(eld.percentile(99)), max: lag(eld.max) },
    tickGapMs: summary(tickGap),
    tickCostMs: summary(tickCost),
    patchGapMs: summary(patchGap),
    patchCostMs: summary(patchCost),
    roomsCreated,
    roomsCollected,
  };
  return s;
}

setInterval(() => process.stdout.write('@@PROBE ' + JSON.stringify(snapshot()) + '\n'), 1000).unref();

function reset() {
  eld.reset();
  tickGap = newHist();
  tickCost = newHist();
  patchGap = newHist();
  patchCost = newHist();
}

async function fullGc() {
  const gc = global.gc;
  if (gc) {
    for (let i = 0; i < 4; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 150)); // let FinalizationRegistry callbacks run
    }
  }
  const m = process.memoryUsage();
  process.stdout.write('@@PROBE_GC ' + JSON.stringify({ t: Date.now(), gcExposed: !!gc, heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), rssMB: +(m.rss / 1048576).toFixed(1), roomsCreated, roomsCollected }) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const cmd = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (cmd === 'reset') reset();
    else if (cmd === 'gc') void fullGc();
  }
});
process.stdin.unref?.();
