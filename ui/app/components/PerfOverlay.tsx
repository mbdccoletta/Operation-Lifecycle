// Floating perf-metrics overlay used by the Performance Lab.
//
// Renders ONLY when a synthetic scenario is active (`scenario !== "real"`)
// — outside the lab, real customer sessions never see this. Position is
// bottom-LEFT so it doesn't fight with the DEMO panel (bottom-right).
// Collapsible to a single chip when the user wants to focus on the app
// itself but still see the FPS pulse.
//
// Data comes from `usePerfMetrics` (1 Hz poll) — see that file for the
// measurement strategy. Nothing here drives the app; the overlay is a
// strict read-only sink.

import React, { useState } from "react";
import { useScenario } from "../utils/debugScenario";
import { usePerfMetrics } from "../utils/perfMetrics";

/** Colour the FPS chip red below 30 fps, amber 30-50, green ≥50.
 *  Numbers picked to match the user-perceived smoothness bands. */
function fpsTone(fps: number): "good" | "warn" | "bad" {
  if (fps >= 50) return "good";
  if (fps >= 30) return "warn";
  return "bad";
}

/** Colour memory chip by absolute heap usage — 100 MB threshold
 *  matches the inflection where Chrome starts aggressive GC. */
function memTone(memMB: number | null): "good" | "warn" | "bad" | "muted" {
  if (memMB == null) return "muted";
  if (memMB < 100) return "good";
  if (memMB < 250) return "warn";
  return "bad";
}

/** Colour DQL chip by trailing-100 average. >2s is user-noticeable. */
function dqlTone(ms: number | null): "good" | "warn" | "bad" | "muted" {
  if (ms == null) return "muted";
  if (ms < 500) return "good";
  if (ms < 2_000) return "warn";
  return "bad";
}

export const PerfOverlay: React.FC = () => {
  const [scenario] = useScenario();
  const [collapsed, setCollapsed] = useState(false);
  // Hook is called unconditionally to satisfy React's rules. The
  // overlay itself short-circuits below when the scenario is "real".
  const m = usePerfMetrics(1_000);

  // Only show during a synthetic scenario — outside the Perf Lab the
  // overlay would be visual noise for normal users.
  if (scenario === "real") return null;

  if (collapsed) {
    return (
      <button
        type="button"
        className="neo-perf-overlay neo-perf-overlay-collapsed"
        onClick={() => setCollapsed(false)}
        aria-label="Expand performance overlay"
        title={`${m.fps} fps · ${m.memMB ?? "?"} MB · ${m.avgDqlMs ?? "?"} ms avg DQL`}
      >
        <span className={`neo-perf-chip neo-perf-chip-${fpsTone(m.fps)}`}>
          {m.fps}<small>fps</small>
        </span>
      </button>
    );
  }

  return (
    <div className="neo-perf-overlay" role="region" aria-label="Performance metrics">
      <header className="neo-perf-overlay-header">
        <span className="neo-perf-overlay-title">PERF</span>
        <span className="neo-perf-overlay-scenario">{scenario}</span>
        <button
          type="button"
          className="neo-perf-overlay-collapse"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse performance overlay"
          title="Collapse"
        >
          —
        </button>
      </header>
      <dl className="neo-perf-overlay-grid">
        <div className={`neo-perf-row neo-perf-row-${fpsTone(m.fps)}`}>
          <dt>FPS</dt>
          <dd>{m.fps}</dd>
        </div>
        <div className={`neo-perf-row neo-perf-row-${memTone(m.memMB)}`}>
          <dt>Heap</dt>
          <dd>{m.memMB != null ? `${m.memMB} MB` : "—"}</dd>
        </div>
        <div className="neo-perf-row">
          <dt>DOM</dt>
          <dd>{m.domNodes.toLocaleString()}</dd>
        </div>
        <div className={`neo-perf-row neo-perf-row-${dqlTone(m.avgDqlMs)}`}>
          <dt>DQL avg</dt>
          <dd>{m.avgDqlMs != null ? `${m.avgDqlMs} ms` : "—"}</dd>
        </div>
        <div className="neo-perf-row">
          <dt>DQL last</dt>
          <dd>{m.lastDqlMs != null ? `${m.lastDqlMs} ms` : "—"}</dd>
        </div>
        <div className="neo-perf-row">
          <dt>DQL #</dt>
          <dd>{m.dqlCount}</dd>
        </div>
      </dl>
    </div>
  );
};
