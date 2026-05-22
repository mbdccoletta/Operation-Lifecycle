// Perf Lab UI — Run benchmark + Sweep + JSON export.
//
// Renders inside the DEMO panel's "Perf lab" section. When the user
// taps "Run benchmark", the runner from `benchmarkRunner.ts` scripts
// the canonical interaction sequence against the currently-selected
// `perf-*` scenario. "Run sweep" walks all four scenario sizes
// back-to-back so the user gets a single-pass comparison.
//
// Results stay in component state until the panel unmounts — the
// user can re-run and the previous result is replaced. "Download
// JSON" serialises whatever's currently on-screen for archival /
// shipping to engineering.

import React, { useState, useCallback, useEffect } from "react";
import { useScenario, Scenario } from "../utils/debugScenario";
import {
  runBenchmark, runSweep,
  BenchmarkResult, BenchmarkProgress,
} from "../utils/benchmarkRunner";

// All four perf scenarios in size order. Kept in sync with the
// `Scenario` union — adding a new perf-* size means adding it here
// AND to the DebugScenarioPanel sections list.
const PERF_SCENARIOS: Scenario[] = ["perf-1k", "perf-10k", "perf-30k", "perf-50k"];

// Module-level store for benchmark results so they SURVIVE the
// component's unmount/remount cycle (which happens when the user
// toggles between perf-* scenarios outside of the panel, or if a
// teardown step accidentally drops the panel's render condition).
// The pattern mirrors `useScenario` itself — single source of truth
// outside React's reconciliation tree, listeners notified on change.
let cachedResults: BenchmarkResult[] = [];
const resultsListeners = new Set<(rs: BenchmarkResult[]) => void>();
function setCachedResults(rs: BenchmarkResult[]): void {
  cachedResults = rs;
  resultsListeners.forEach((cb) => cb(rs));
}

interface ProgressState {
  scenarioIndex: number;
  scenarioId: Scenario;
  step: BenchmarkProgress | null;
}

/** Trigger a browser download of `data` as a JSON file named `name`. */
function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Safari has time to start the download. Two RAF
  // frames is the platform-recommended minimum.
  requestAnimationFrame(() => requestAnimationFrame(() => URL.revokeObjectURL(url)));
}

export const PerfBenchmarkPanel: React.FC = () => {
  const [scenario] = useScenario();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // Hydrate from the module-level cache so a previous run's results
  // re-appear when the panel re-mounts (e.g. after the scenario flips
  // through `real` during teardown).
  const [results, setResults] = useState<BenchmarkResult[]>(() => cachedResults);
  useEffect(() => {
    resultsListeners.add(setResults);
    return () => { resultsListeners.delete(setResults); };
  }, []);

  const runSingle = useCallback(async () => {
    // If the current scenario isn't a perf-*, default to perf-10k
    // — the middle of the road, a sensible single-shot benchmark.
    const target: Scenario = PERF_SCENARIOS.includes(scenario)
      ? scenario
      : "perf-10k";
    setRunning(true);
    setProgress({ scenarioIndex: 0, scenarioId: target, step: null });
    try {
      const r = await runBenchmark(target, {
        onProgress: (step) => setProgress({ scenarioIndex: 0, scenarioId: target, step }),
      });
      setCachedResults([r]);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [scenario]);

  const runFullSweep = useCallback(async () => {
    setRunning(true);
    setProgress({ scenarioIndex: 0, scenarioId: PERF_SCENARIOS[0], step: null });
    try {
      const rs = await runSweep(PERF_SCENARIOS, {
        onScenarioStart: (id, i) => setProgress({ scenarioIndex: i, scenarioId: id, step: null }),
        onProgress: (step) => setProgress((prev) =>
          prev ? { ...prev, step } : null
        ),
      });
      setCachedResults(rs);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, []);

  const exportJson = useCallback(() => {
    if (results.length === 0) return;
    const filename = results.length === 1
      ? `perf-${results[0].scenarioId}-${results[0].startedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`
      : `perf-sweep-${results[0].startedAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
    const payload = {
      app: "Operation Lifecycle",
      // Keep the schema versioned so older result files can be
      // detected + skipped by future result loaders.
      schemaVersion: 1,
      capturedAt: results[0].startedAt,
      results,
    };
    try {
      downloadJson(filename, payload);
    } catch (err) {
      // Some kiosked / locked-down browsers refuse `download` attribute.
      // Fallback: open the JSON in a new tab so the user can copy or
      // save it manually. Also dump to console for screenshot use.
      // eslint-disable-next-line no-console
      console.error("[PerfLab] downloadJson failed — opening in new tab", err);
      try {
        const w = window.open();
        if (w) {
          w.document.title = filename;
          w.document.body.style.fontFamily = "monospace";
          w.document.body.innerText = JSON.stringify(payload, null, 2);
        }
      } catch {
        // eslint-disable-next-line no-console
        console.warn("[PerfLab] Fallback also blocked. Payload dumped below — copy from console.");
        // eslint-disable-next-line no-console
        console.log(payload);
      }
    }
  }, [results]);

  return (
    <div className="neo-perf-bench">
      <div className="neo-perf-bench-actions">
        <button
          type="button"
          className="neo-perf-bench-btn"
          onClick={runSingle}
          disabled={running}
        >
          {running && progress?.scenarioIndex === 0 && results.length === 0
            ? "Running…"
            : "Run benchmark"}
        </button>
        <button
          type="button"
          className="neo-perf-bench-btn"
          onClick={runFullSweep}
          disabled={running}
        >
          {running && PERF_SCENARIOS.length > 1
            ? `Sweep ${(progress?.scenarioIndex ?? 0) + 1}/${PERF_SCENARIOS.length}`
            : "Run full sweep"}
        </button>
        <button
          type="button"
          className="neo-perf-bench-btn neo-perf-bench-btn-secondary"
          onClick={exportJson}
          disabled={running || results.length === 0}
          /* Label flips when disabled so the user understands WHY the
             button is unclickable — the `cursor: not-allowed` alone
             was opaque (the user reported "can't click" without
             knowing they had to run a benchmark first). */
          title={
            running ? "Wait for benchmark to finish"
            : results.length === 0 ? "Run a benchmark first to enable JSON export"
            : "Download results as JSON"
          }
        >
          {results.length === 0 ? "⤓ JSON (run first)" : "⤓ JSON"}
        </button>
      </div>

      {/* Inline hint when there are no results yet — surfaces the
          intent of the JSON button without requiring the user to
          discover the tooltip on a disabled element. Disappears the
          moment a benchmark lands. */}
      {!running && results.length === 0 && (
        <div className="neo-perf-bench-empty">
          Click <strong>Run benchmark</strong> (single) or <strong>Run full sweep</strong> (all 4 sizes).
          Results + the ⤓ JSON download will appear here when done.
        </div>
      )}

      {progress && progress.step && (
        <div className="neo-perf-bench-progress" role="status" aria-live="polite">
          <div className="neo-perf-bench-progress-label">
            <strong>{progress.scenarioId}</strong>
            {" — "}
            step {progress.step.stepIndex + 1}/{progress.step.totalSteps}: {progress.step.stepName}
          </div>
          <div className="neo-perf-bench-progress-bar">
            <div
              className="neo-perf-bench-progress-fill"
              style={{
                width: `${Math.round(((progress.step.stepIndex + 1) / progress.step.totalSteps) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {results.length > 0 && (
        <table className="neo-perf-bench-results">
          <thead>
            <tr>
              <th>Scenario</th>
              <th title="Mean / min FPS across all steps">FPS</th>
              <th title="Heap peak (delta from baseline)">Heap</th>
              <th title="Average DQL round-trip (transport + server)">DQL</th>
              <th title="Total wall-clock duration of the sequence">Time</th>
              <th>Pass</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={`${r.scenarioId}-${r.startedAt}`}>
                <td><strong>{r.scenarioId}</strong></td>
                <td>
                  {r.summary.fpsMean}
                  <small> · min {r.summary.fpsMin}</small>
                </td>
                <td>
                  {r.summary.memPeakMB != null ? `${r.summary.memPeakMB} MB` : "—"}
                  {r.summary.memDeltaMB != null && (
                    <small> · +{r.summary.memDeltaMB}</small>
                  )}
                </td>
                <td>
                  {r.summary.avgDqlMs != null ? `${r.summary.avgDqlMs} ms` : "—"}
                  <small> · {r.summary.dqlTotal}×</small>
                </td>
                <td>{(r.durationMs / 1_000).toFixed(1)} s</td>
                <td>
                  <span className={`neo-perf-bench-pass${r.summary.passed ? "" : "-fail"}`}>
                    {r.summary.passed ? "✓" : "✗"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
