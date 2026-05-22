// Runtime perf instrumentation for the Perf Lab.
//
// Three measurement primitives, all read-mostly so adding the overlay
// doesn't itself become a performance hazard:
//
//   • FPS counter — RAF-driven sliding 1s window. Cheap (1 closure
//     callback per frame, no DOM reads).
//   • DQL latency — PerformanceObserver hooks the browser's resource
//     timing entries; no app-code instrumentation needed, so this
//     keeps working even when hooks are added/removed.
//   • Memory + DOM size — synchronous reads, throttled to 1 Hz.
//
// All three are exposed via `usePerfMetrics()` which returns the
// latest snapshot on every poll tick. The overlay reads from that;
// nothing else in the app depends on these numbers.

import { useEffect, useRef, useState } from "react";

export interface PerfSnapshot {
  /** Frames per second over the last ~1 s. `0` until the first
   *  frame lands. */
  fps: number;
  /** Number of times the consuming overlay has re-rendered since
   *  mount. Useful as a smoke test: if it grows wildly above the
   *  expected ~1 Hz polling cadence, something upstream is shoving
   *  it through more re-renders than the poll loop. */
  renderCount: number;
  /** JS heap in MB, rounded. `null` when `performance.memory` is
   *  unavailable (Firefox, Safari). */
  memMB: number | null;
  /** Total live DOM nodes — fastest proxy for "is this page heavy". */
  domNodes: number;
  /** Most recent DQL `query:execute` round-trip in ms (transport +
   *  server time). `null` until the first query lands. */
  lastDqlMs: number | null;
  /** Trailing-100 average DQL round-trip in ms. `null` until at least
   *  one query has landed. */
  avgDqlMs: number | null;
  /** Count of DQL `query:execute` calls observed since mount. Reveals
   *  query storms (per-card fan-out, auto-refresh hammering). */
  dqlCount: number;
}

// ── FPS ────────────────────────────────────────────────────────────────
// One module-level RAF loop keeps the latest FPS in a ref. Consumers
// read from the snapshot via the hook below, so multiple overlays
// would share the same loop (we only ever instantiate one in practice
// but this keeps the cost flat regardless).
let fpsValue = 0;
let fpsFramesInWindow = 0;
let fpsWindowStart = 0;
let fpsRafId: number | null = null;
let fpsConsumers = 0;

function startFpsLoop() {
  if (fpsRafId != null) return;
  fpsWindowStart = performance.now();
  const tick = (now: number) => {
    fpsFramesInWindow++;
    const elapsed = now - fpsWindowStart;
    if (elapsed >= 1_000) {
      fpsValue = Math.round((fpsFramesInWindow * 1_000) / elapsed);
      fpsFramesInWindow = 0;
      fpsWindowStart = now;
    }
    fpsRafId = requestAnimationFrame(tick);
  };
  fpsRafId = requestAnimationFrame(tick);
}
function stopFpsLoop() {
  if (fpsRafId != null) {
    cancelAnimationFrame(fpsRafId);
    fpsRafId = null;
  }
}

// ── DQL latency ────────────────────────────────────────────────────────
// PerformanceObserver listens for resource-timing entries matching the
// query endpoints. Stores the most recent + rolling average of the
// last 100. Initialised lazily on first hook mount.
let lastDqlMs: number | null = null;
const dqlRing: number[] = [];           // bounded to RING_CAP
const DQL_RING_CAP = 100;
let dqlTotal = 0;
let dqlObserver: PerformanceObserver | null = null;
let dqlConsumers = 0;

function isDqlEntry(name: string): boolean {
  // Matches both `query:execute` (the primary cost) and `query:poll`
  // (cheap follow-ups when the engine queues a long DQL). We sum both
  // because, from the user's perspective, the wall-clock cost of a
  // query is execute + N polls.
  return name.includes("query:execute") || name.includes("query:poll");
}

function startDqlObserver() {
  if (dqlObserver) return;
  if (typeof PerformanceObserver === "undefined") return;
  try {
    dqlObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!isDqlEntry(entry.name)) continue;
        const dur = Math.round(entry.duration);
        lastDqlMs = dur;
        dqlRing.push(dur);
        dqlTotal++;
        if (dqlRing.length > DQL_RING_CAP) dqlRing.shift();
      }
    });
    dqlObserver.observe({ type: "resource", buffered: true });
  } catch {
    // Some browsers (older Safari) don't support buffered resource
    // observation. Silently degrade — `lastDqlMs` stays null.
    dqlObserver = null;
  }
}
function stopDqlObserver() {
  if (dqlObserver) {
    dqlObserver.disconnect();
    dqlObserver = null;
  }
}

// ── Snapshot poll ──────────────────────────────────────────────────────
// One-shot read of all metrics. Called on the 1 Hz tick below.
function readSnapshot(renderCount: number): PerfSnapshot {
  let memMB: number | null = null;
  // `performance.memory` is a Chrome non-standard API. Cast carefully.
  const perfWithMem = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  if (perfWithMem.memory?.usedJSHeapSize) {
    memMB = Math.round(perfWithMem.memory.usedJSHeapSize / (1024 * 1024));
  }
  const avgDqlMs = dqlRing.length > 0
    ? Math.round(dqlRing.reduce((a, b) => a + b, 0) / dqlRing.length)
    : null;
  return {
    fps: fpsValue,
    renderCount,
    memMB,
    domNodes: document.getElementsByTagName("*").length,
    lastDqlMs,
    avgDqlMs,
    dqlCount: dqlTotal,
  };
}

/** React hook: polls the metric ring at the requested cadence and
 *  yields a fresh snapshot on each tick. Default 1 Hz keeps the
 *  overlay readable without itself spinning the render loop. */
export function usePerfMetrics(intervalMs: number = 1_000): PerfSnapshot {
  const [snapshot, setSnapshot] = useState<PerfSnapshot>(() => ({
    fps: 0,
    renderCount: 0,
    memMB: null,
    domNodes: 0,
    lastDqlMs: null,
    avgDqlMs: null,
    dqlCount: 0,
  }));
  const renderCountRef = useRef(0);

  // Bring up the shared module-level observers exactly once per
  // consumer, tear them down on unmount. Reference-counted so multiple
  // overlays don't accidentally orphan the loops.
  useEffect(() => {
    fpsConsumers++;
    dqlConsumers++;
    startFpsLoop();
    startDqlObserver();
    return () => {
      fpsConsumers--;
      dqlConsumers--;
      if (fpsConsumers === 0) stopFpsLoop();
      if (dqlConsumers === 0) stopDqlObserver();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      renderCountRef.current++;
      setSnapshot(readSnapshot(renderCountRef.current));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return snapshot;
}

/** Standalone read — used by the benchmark runner (Phase 3) where a
 *  React hook would be awkward to drive from an async sequence. */
export function readPerfSnapshot(): PerfSnapshot {
  return readSnapshot(0);
}

/** Reset the DQL ring and counter. Useful before starting a
 *  benchmark run so the avg/count reflect only the run itself. */
export function resetDqlStats(): void {
  dqlRing.length = 0;
  dqlTotal = 0;
  lastDqlMs = null;
}
