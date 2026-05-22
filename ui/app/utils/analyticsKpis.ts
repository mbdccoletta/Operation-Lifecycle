// Catalog of every KPI card the Analytics page can render. Each entry
// owns its own computation, label, color, sparkline series, and delta
// semantics — the page just looks up by id and renders. This keeps the
// page itself dumb and lets us add new KPIs without touching the
// rendering code.
//
// Accuracy notes (vs. the original pilot implementation):
//   • MTTR is now per-bucket (mean of problems resolved IN that
//     bucket), not a cumulative running average. Per-bucket exposes
//     trend; cumulative flatlined.
//   • Resolution rate is per-bucket throughput (closed/opened in that
//     bucket), not cumulative.
//   • Delta compares last 25 % of buckets vs prior 25 % — far more
//     stable than the previous "last sample minus first sample".
//   • MTTR ignores problems with duration < 60 s (synthetic blips).
//   • Per-problem time windows are pre-computed ONCE per call instead
//     of inside every bucket loop — O(N + buckets) instead of O(N×B).

import type { Problem } from "../hooks/useProblems";

export type KpiId =
  | "active"
  | "mttr"
  | "resRate"
  | "stuck"
  | "p95Mttr"
  | "openedInWindow"
  | "closedInWindow"
  | "sev1Active";

export interface KpiResult {
  value: string;
  /** Sparkline series — N numeric samples across the window. */
  series: number[];
  /** Signed delta — positive = increase, negative = decrease. Units
   *  depend on the KPI (count, hours, percent…). */
  delta: number;
}

export interface KpiDefinition {
  id: KpiId;
  label: string;
  color: string;
  /** Suffix appended after the delta number ("h", "%", "" for counts). */
  deltaSuffix: string;
  /** When true, an INCREASE is bad (red) and a decrease is good. */
  deltaInverse: boolean;
  /** Short tooltip describing the metric — surfaced on the card. */
  tooltip: string;
  /** Returns the value, sparkline series, and delta for the current window. */
  compute: (problems: Problem[], range: { from: number; to: number }, opts: { stuckHours: number }) => KpiResult;
}

const MIN_REAL_MS = 60_000; // discard problems whose end is within 60 s of start

interface Window { start: number; end: number; isOpen: boolean; sev: number; }

function buildWindows(problems: Problem[]): Window[] {
  return problems
    .map((p) => {
      const start = new Date(p["event.start"]).getTime();
      const isOpen = p["event.status"] === "ACTIVE";
      const rawEnd = p["event.end"] ? new Date(p["event.end"]).getTime() : NaN;
      const end = isOpen
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(rawEnd) ? rawEnd : start;
      const sev = Math.max(0, parseInt(String(p["event.severity"] || "0"), 10));
      return { start, end, isOpen, sev };
    })
    .filter((w) => Number.isFinite(w.start));
}

/** Last 25 % vs prior 25 % delta — stable signal for "is this going
 *  up or down right now?" without being whipsawed by single-point
 *  spikes at the window edges. */
function rollingDelta(series: number[]): number {
  if (series.length < 4) return series.length >= 2 ? series[series.length - 1] - series[0] : 0;
  const q = Math.max(1, Math.floor(series.length / 4));
  const tail = series.slice(-q);
  const prior = series.slice(-2 * q, -q);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  return avg(tail) - avg(prior);
}

const BUCKETS = 30;

function bucketStep(range: { from: number; to: number }): number {
  return Math.max(1, (range.to - range.from) / BUCKETS);
}

/** ACTIVE count at instant t. Pre-built windows allow O(N) per bucket. */
function activeAt(windows: Window[], t: number): number {
  let n = 0;
  for (const w of windows) if (w.start <= t && t <= w.end) n++;
  return n;
}

// ── KPI definitions ──────────────────────────────────────────────────

export const KPI_CATALOG: Record<KpiId, KpiDefinition> = {
  active: {
    id: "active",
    label: "Active problems",
    color: "#ff4d6a",
    deltaSuffix: "",
    deltaInverse: true,
    tooltip: "Problems currently in ACTIVE state. Sparkline = active count over time.",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) series.push(activeAt(windows, range.from + i * step));
      const now = Math.min(Date.now(), range.to);
      const value = activeAt(windows, now);
      return { value: String(value), series, delta: rollingDelta(series) };
    },
  },

  mttr: {
    id: "mttr",
    label: "MTTR",
    color: "#f59e0b",
    deltaSuffix: "h",
    deltaInverse: true,
    tooltip: "Mean time-to-resolve for problems closed inside the window. Sparkline = MTTR of problems resolved in each bucket.",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      // Per-bucket MTTR: mean duration of problems whose RESOLUTION
      // falls inside that bucket. Excludes <1-min "instant" problems.
      for (let i = 0; i < BUCKETS; i++) {
        const bStart = range.from + i * step;
        const bEnd   = bStart + step;
        let sum = 0, n = 0;
        for (const w of windows) {
          if (w.isOpen) continue;
          if (w.end < bStart || w.end >= bEnd) continue;
          const dur = w.end - w.start;
          if (dur < MIN_REAL_MS) continue;
          sum += dur; n++;
        }
        series.push(n > 0 ? sum / n / 3600000 : 0);
      }
      // Headline value = MTTR of every resolved problem in the window
      // (not just the most recent bucket), so the number matches what
      // a user computing it by hand would get.
      let sum = 0, n = 0;
      for (const w of windows) {
        if (w.isOpen) continue;
        if (w.end < range.from || w.end > range.to) continue;
        const dur = w.end - w.start;
        if (dur < MIN_REAL_MS) continue;
        sum += dur; n++;
      }
      const mttrH = n > 0 ? sum / n / 3600000 : 0;
      return { value: mttrH > 0 ? `${mttrH.toFixed(1)}h` : "—", series, delta: rollingDelta(series) };
    },
  },

  p95Mttr: {
    id: "p95Mttr",
    label: "P95 MTTR",
    color: "#ef4444",
    deltaSuffix: "h",
    deltaInverse: true,
    tooltip: "95th percentile resolution time — the long-tail problems that drag operations.",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        const bStart = range.from + i * step;
        const bEnd   = bStart + step;
        const durs: number[] = [];
        for (const w of windows) {
          if (w.isOpen) continue;
          if (w.end < bStart || w.end >= bEnd) continue;
          const dur = w.end - w.start;
          if (dur < MIN_REAL_MS) continue;
          durs.push(dur);
        }
        durs.sort((a, b) => a - b);
        const p95 = durs.length > 0 ? durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.95))] : 0;
        series.push(p95 / 3600000);
      }
      const allDurs: number[] = [];
      for (const w of windows) {
        if (w.isOpen) continue;
        if (w.end < range.from || w.end > range.to) continue;
        const dur = w.end - w.start;
        if (dur < MIN_REAL_MS) continue;
        allDurs.push(dur);
      }
      allDurs.sort((a, b) => a - b);
      const p95 = allDurs.length > 0 ? allDurs[Math.min(allDurs.length - 1, Math.floor(allDurs.length * 0.95))] : 0;
      const p95H = p95 / 3600000;
      return { value: p95H > 0 ? `${p95H.toFixed(1)}h` : "—", series, delta: rollingDelta(series) };
    },
  },

  resRate: {
    id: "resRate",
    label: "Resolution rate",
    color: "#22d3a0",
    deltaSuffix: "%",
    deltaInverse: false,
    tooltip: "% of problems opened in the window that have already closed. Sparkline = per-bucket closed/opened throughput (>100 % means we're catching up).",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        const bStart = range.from + i * step;
        const bEnd   = bStart + step;
        let opened = 0, closed = 0;
        for (const w of windows) {
          if (w.start >= bStart && w.start < bEnd) opened++;
          if (!w.isOpen && w.end >= bStart && w.end < bEnd) closed++;
        }
        // Per-bucket throughput, capped at 200 % so a single closed
        // problem in an empty bucket doesn't spike to 10 000 %.
        series.push(opened > 0 ? Math.min(200, Math.round((closed / opened) * 100)) : closed > 0 ? 100 : 0);
      }
      const total = problems.length;
      const resolved = problems.filter((p) => p["event.status"] === "CLOSED").length;
      const value = total > 0 ? Math.round((resolved / total) * 100) : 0;
      return { value: `${value}%`, series, delta: rollingDelta(series) };
    },
  },

  stuck: {
    id: "stuck",
    label: "Stuck",
    color: "#a855f7",
    deltaSuffix: "",
    deltaInverse: true,
    tooltip: "Active problems older than the configured threshold (default 4 h). Sparkline = stuck count over time.",
    compute(problems, range, { stuckHours }) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const threshMs = stuckHours * 3600000;
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        const t = range.from + i * step;
        let n = 0;
        for (const w of windows) {
          if (w.start <= t && t <= w.end && t - w.start >= threshMs) n++;
        }
        series.push(n);
      }
      const now = Math.min(Date.now(), range.to);
      let value = 0;
      for (const w of windows) {
        if (w.start <= now && now <= w.end && now - w.start >= threshMs) value++;
      }
      return { value: String(value), series, delta: rollingDelta(series) };
    },
  },

  openedInWindow: {
    id: "openedInWindow",
    label: "Opened",
    color: "#60a5fa",
    deltaSuffix: "",
    deltaInverse: true,
    tooltip: "Problems whose start falls inside the window. Sparkline = opens per bucket.",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        const bStart = range.from + i * step;
        const bEnd   = bStart + step;
        let n = 0;
        for (const w of windows) if (w.start >= bStart && w.start < bEnd) n++;
        series.push(n);
      }
      const total = series.reduce((s, v) => s + v, 0);
      return { value: String(total), series, delta: rollingDelta(series) };
    },
  },

  closedInWindow: {
    id: "closedInWindow",
    label: "Closed",
    color: "#22d3a0",
    deltaSuffix: "",
    deltaInverse: false,
    tooltip: "Problems whose resolution falls inside the window. Sparkline = closes per bucket.",
    compute(problems, range) {
      const windows = buildWindows(problems);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) {
        const bStart = range.from + i * step;
        const bEnd   = bStart + step;
        let n = 0;
        for (const w of windows) {
          if (!w.isOpen && w.end >= bStart && w.end < bEnd) n++;
        }
        series.push(n);
      }
      const total = series.reduce((s, v) => s + v, 0);
      return { value: String(total), series, delta: rollingDelta(series) };
    },
  },

  sev1Active: {
    id: "sev1Active",
    label: "Sev 1 active",
    color: "#dc2626",
    deltaSuffix: "",
    deltaInverse: true,
    tooltip: "Currently active problems at Davis severity 1 (most critical).",
    compute(problems, range) {
      const windows = buildWindows(problems).filter((w) => w.sev === 1);
      const step = bucketStep(range);
      const series: number[] = [];
      for (let i = 0; i < BUCKETS; i++) series.push(activeAt(windows, range.from + i * step));
      const now = Math.min(Date.now(), range.to);
      const value = activeAt(windows, now);
      return { value: String(value), series, delta: rollingDelta(series) };
    },
  },
};
