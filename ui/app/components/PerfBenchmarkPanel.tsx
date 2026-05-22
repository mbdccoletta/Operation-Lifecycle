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

import React, { useState, useCallback } from "react";
import { useScenario, Scenario } from "../utils/debugScenario";
import {
  runBenchmark, runSweep,
  BenchmarkResult, BenchmarkProgress,
} from "../utils/benchmarkRunner";

// All four perf scenarios in size order. Kept in sync with the
// `Scenario` union — adding a new perf-* size means adding it here
// AND to the DebugScenarioPanel sections list.
const PERF_SCENARIOS: Scenario[] = ["perf-1k", "perf-10k", "perf-30k", "perf-50k"];

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
  const [results, setResults] = useState<BenchmarkResult[]>([]);

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
      setResults([r]);
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
      setResults(rs);
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
    downloadJson(filename, {
      app: "Operation Lifecycle",
      // Keep the schema versioned so older result files can be
      // detected + skipped by future result loaders.
      schemaVersion: 1,
      capturedAt: results[0].startedAt,
      results,
    });
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
          title="Download results as JSON"
        >
          ⤓ JSON
        </button>
      </div>

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
