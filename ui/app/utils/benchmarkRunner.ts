// Automated benchmark sequence for the Perf Lab.
//
// Drives the app through a scripted interaction sequence — activate
// scenario, wait first paint, stress canvas + list + filters — and
// records perf metrics at each step. Returns a structured result the
// UI can render as a table and export as JSON.
//
// Design constraints:
//   • Pure runtime — no Playwright / Puppeteer dependency. Runs in the
//     same browser the user is staring at.
//   • Event dispatch (not React state manipulation) — the synthetic
//     events flow through the same code paths a real click/hover
//     would, so the numbers reflect REAL interaction cost, not
//     contrived micro-benchmarks.
//   • Yields to the event loop between steps so the browser can
//     actually paint each one — measurements taken on the next
//     animation frame after each step are meaningful.

import { setScenario, Scenario } from "./debugScenario";
import { readPerfSnapshot, resetDqlStats, PerfSnapshot } from "./perfMetrics";

export interface BenchmarkStep {
  /** Human-readable label shown in the result table. */
  name: string;
  /** Wall-clock duration of the step (start → snapshot). */
  elapsedMs: number;
  /** Metrics snapshot taken AFTER the step completes (and after one
   *  RAF tick so the browser has had a chance to repaint). */
  snapshot: PerfSnapshot;
}

export interface BenchmarkResult {
  /** Synthetic scenario used for this run. */
  scenarioId: Scenario;
  /** ISO timestamp at start. */
  startedAt: string;
  /** Total wall-clock duration of the full sequence. */
  durationMs: number;
  /** One entry per step. */
  steps: BenchmarkStep[];
  /** Aggregate stats across all steps — handy for comparison. */
  summary: {
    fpsMin: number;
    fpsMax: number;
    fpsMean: number;
    memPeakMB: number | null;
    memDeltaMB: number | null;
    domNodesPeak: number;
    avgDqlMs: number | null;
    dqlTotal: number;
    /** True when every step completed under its expected budget. */
    passed: boolean;
  };
}

export interface BenchmarkProgress {
  stepIndex: number;
  totalSteps: number;
  stepName: string;
}

interface BenchmarkOptions {
  /** Called once per step boundary so the UI can show progress. */
  onProgress?: (p: BenchmarkProgress) => void;
  /** Per-step settle wait before the snapshot. Default 800ms — long
   *  enough for React to flush + paint + first RAF tick. */
  settleMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Resolve on the next animation frame so the browser has actually
 *  composited recent DOM mutations before we measure. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Best-effort find the constellation canvas. Returns null when the
 *  user is on the list view and the canvas isn't mounted. */
function findCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>(".neo-constellation canvas");
}

/** Dispatch a synthetic pointer-move on the canvas. Uses real
 *  PointerEvent so the same handlers the user's mouse triggers fire. */
function dispatchHover(canvas: HTMLCanvasElement, x: number, y: number): void {
  const rect = canvas.getBoundingClientRect();
  const ev = new PointerEvent("pointermove", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    pointerType: "mouse",
  });
  canvas.dispatchEvent(ev);
  // Some handlers also listen to `mousemove`. Fire both for parity
  // with what a real mouse generates.
  const mev = new MouseEvent("mousemove", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
  });
  canvas.dispatchEvent(mev);
}

/** Smoothly scroll the page through `n` pixels by yielding between
 *  scrollBy calls — closer to real touch/wheel behaviour than a
 *  single jumpy `scrollTo`. */
async function smoothScroll(totalPx: number, steps: number = 20): Promise<void> {
  const stepPx = totalPx / steps;
  for (let i = 0; i < steps; i++) {
    window.scrollBy({ top: stepPx, behavior: "auto" });
    await nextFrame();
  }
}

// ── Runner ────────────────────────────────────────────────────────────

/** Execute a full benchmark sequence against the chosen scenario.
 *  Resolves with the result; never rejects (errors are caught and
 *  surfaced in the summary's `passed` flag plus a thrown step). */
export async function runBenchmark(
  scenarioId: Scenario,
  options: BenchmarkOptions = {},
): Promise<BenchmarkResult> {
  const settle = options.settleMs ?? 800;
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const steps: BenchmarkStep[] = [];

  const captureStep = async (name: string, action: () => Promise<void> | void) => {
    const stepStart = performance.now();
    options.onProgress?.({
      stepIndex: steps.length,
      totalSteps: STEP_COUNT,
      stepName: name,
    });
    try { await action(); } catch { /* swallow — overall pass flag will flip */ }
    // Let React commit + paint settle before reading metrics.
    await sleep(settle);
    await nextFrame();
    steps.push({
      name,
      elapsedMs: Math.round(performance.now() - stepStart),
      snapshot: readPerfSnapshot(),
    });
  };

  // ── Run the canonical sequence ──
  // Each step exists for a reason — kept in sync with the perf audit's
  // identified hot paths. Add new steps at the END so result schemas
  // stay backwards-comparable across runs.
  resetDqlStats();
  await captureStep("baseline (before scenario)", async () => {
    // No-op — captures the steady-state cost before we change anything.
  });

  await captureStep("activate scenario", async () => {
    setScenario(scenarioId);
    // Give Overview's `getSimulatedProblems` time to run + propagate.
    await sleep(600);
  });

  await captureStep("first paint", async () => {
    // Two RAF ticks ensure stars are computed, layout settled.
    await nextFrame();
    await nextFrame();
  });

  await captureStep("scroll list down", async () => {
    await smoothScroll(1200);
  });

  await captureStep("scroll list up", async () => {
    await smoothScroll(-1200);
  });

  await captureStep("canvas hover x50", async () => {
    const c = findCanvas();
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    for (let i = 0; i < 50; i++) {
      // Deterministic positions (no Math.random) so reruns are
      // comparable. 5×10 grid covering the canvas interior.
      const x = (w * (0.1 + (i % 10) * 0.085)) | 0;
      const y = (h * (0.15 + Math.floor(i / 10) * 0.18)) | 0;
      dispatchHover(c, x, y);
      // Yield occasionally so React can process re-renders that the
      // hover handler triggers.
      if (i % 10 === 9) await nextFrame();
    }
  });

  await captureStep("dataMode toggles x4", async () => {
    // Click the Show by toolbar buttons in sequence. They live as
    // `<button>`s with text content matching the mode label.
    const labels = ["Oldest Open", "Criticality", "Total", "Rising"];
    for (const label of labels) {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === label,
      );
      btn?.click();
      await sleep(180);
    }
  });

  await captureStep("category chip toggle", async () => {
    // First category chip in the FILTERS strip. Click → re-filter →
    // click again → restore.
    const chip = document.querySelector<HTMLButtonElement>(".neo-cat-chip, [data-category-chip]");
    chip?.click();
    await sleep(150);
    chip?.click();
  });

  await captureStep("teardown", async () => {
    // INTENTIONALLY does NOT call `setScenario("real")`. Doing so
    // would unmount the PerfBenchmarkPanel (its render condition is
    // `scenario.startsWith("perf-")`), which would tear down the
    // `results` state mid-run and orphan the ⤓ JSON button. Leaving
    // the synthetic scenario active keeps the panel mounted so the
    // user can inspect + export results. Real-data restore is a
    // manual "Real" click in the DEMO panel.
    await sleep(400);
  });

  // ── Aggregate ──
  const durationMs = Math.round(performance.now() - t0);
  const fpsValues = steps.map((s) => s.snapshot.fps).filter((v) => v > 0);
  const memValues = steps.map((s) => s.snapshot.memMB).filter((v): v is number => v != null);
  const baselineMem = steps[0]?.snapshot.memMB ?? null;
  const peakMem = memValues.length > 0 ? Math.max(...memValues) : null;
  const domNodesPeak = Math.max(...steps.map((s) => s.snapshot.domNodes));
  // Pull avg + count from the LATEST snapshot — the ring is
  // module-level so it accumulates across all steps.
  const last = steps[steps.length - 1]?.snapshot;
  const avgDqlMs = last?.avgDqlMs ?? null;
  const dqlTotal = last?.dqlCount ?? 0;
  const fpsMin = fpsValues.length > 0 ? Math.min(...fpsValues) : 0;
  const fpsMax = fpsValues.length > 0 ? Math.max(...fpsValues) : 0;
  const fpsMean = fpsValues.length > 0
    ? Math.round(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length)
    : 0;

  // Pass criteria — conservative, intentionally generous so the chip
  // only flips red on serious regressions:
  //   • FPS never drops below 24 (smoothness floor a user notices)
  //   • Heap stays under 400 MB (Chrome OOM hits around 1 GB but
  //     paging starts earlier)
  //   • Avg DQL stays under 3 s (anything slower and the user is
  //     watching a spinner instead of using the app)
  const passed = fpsMin >= 24
    && (peakMem == null || peakMem < 400)
    && (avgDqlMs == null || avgDqlMs < 3_000);

  return {
    scenarioId,
    startedAt,
    durationMs,
    steps,
    summary: {
      fpsMin,
      fpsMax,
      fpsMean,
      memPeakMB: peakMem,
      memDeltaMB: peakMem != null && baselineMem != null ? peakMem - baselineMem : null,
      domNodesPeak,
      avgDqlMs,
      dqlTotal,
      passed,
    },
  };
}

// Update in lockstep when adding/removing steps in `runBenchmark`.
// Kept as a top-level constant so progress callbacks can show
// "step X of N" without parsing the sequence.
const STEP_COUNT = 9;

/** Run the same benchmark against multiple scenarios back-to-back.
 *  Used by the comparative-sweep button (Phase 4). */
export async function runSweep(
  scenarios: Scenario[],
  options: BenchmarkOptions & { onScenarioStart?: (id: Scenario, i: number) => void } = {},
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (let i = 0; i < scenarios.length; i++) {
    const id = scenarios[i];
    options.onScenarioStart?.(id, i);
    const r = await runBenchmark(id, options);
    results.push(r);
    // Give the GC a beat between huge scenarios — without this the
    // 50k scenario's memory holdover skews the next baseline read.
    await sleep(1_000);
  }
  return results;
}
