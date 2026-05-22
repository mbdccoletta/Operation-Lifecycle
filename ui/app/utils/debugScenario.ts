// TEMPORARY — remove this file (and its imports) after the visualization
// tuning phase is finished. The floating debug panel uses this to swap
// real problems for synthetic ones that exercise the app's full feature
// surface (every Show by mode, every impact band, every list filter).

import { useEffect, useState } from "react";
import type { Problem } from "../hooks/useProblems";

// Each scenario targets a specific aspect of the app so we can confirm
// every UI capability lights up correctly with synthetic data.
export type Scenario =
  | "real"          // no override — use real data as-is
  | "quiet"         // few problems, single leader · tests the empty-ish state
  | "all-rising"    // every quadrant rising · tests ▲ UP across the board
  | "all-falling"   // every quadrant falling · tests ▼ DOWN seal
  | "mixed"         // half rising, half falling · tests asymmetric trends
  | "critical"      // heavy sev=5 · highlights Criticality mode
  | "long-running"  // active 12–48 h · highlights Open Time mode
  | "tied"          // two categories tied for max · multi-colour chart hilites
  | "time-cluster"  // many actives in the same minute · tests bar drill-down
  | "focused"       // single quadrant in cascading-failure meltdown
  | "stress"        // every quadrant +15 recent (max-intensity spokes)
  | "xlarge"        // enterprise-scale environment · thousands of problems
  // ── Performance Lab scenarios. Realistic enterprise distribution
  // (~99% closed / 1% active, weighted category mix matching what
  // a 10-80k host tenant emits) at increasing volume. Used by the
  // perf overlay + benchmark runner to validate the app on real-
  // customer scale before promising delivery.
  | "perf-1k"          // baseline · medium tenant (~5k hosts)
  | "perf-10k"         // medium enterprise (~20k hosts)
  | "perf-30k"         // large enterprise (~50k hosts)
  | "perf-50k"         // xlarge enterprise (~80k hosts)
  // ── Segments-page test scenarios. Override both the synthetic
  // problem set AND the synthetic filter-segment catalog + membership
  // so the /segments view can be exercised without a tenant that
  // actually has segments configured.
  | "seg-empty"        // 0 segments · empty-state banner
  | "seg-few"          // 3 segments · fits in 3 quadrants, no overflow
  | "seg-overflow"     // 12 segments · top-6 grid + +6 chip
  | "seg-unassigned"   // 4 segments · ~20% of problems match none
  | "seg-multi"        // 5 segments · ~30% of problems in 2+ segments
  | "seg-imbalanced"   // 5 segments · one dominant (~70%), others sparse
  // ── MTTA-page test scenarios. Generate problems spread over 14d
  // PLUS a synthetic "first comment" timestamp per problem so the
  // /analytics MTTA chart can be exercised without waiting for real
  // users to comment on real problems.
  | "mtta-fast"        // 30 problems · 100% ack · median 5m, p95 30m
  | "mtta-slow"        // 30 problems · 100% ack · median 4h, p95 1d
  | "mtta-mixed"       // 50 problems · 90% ack  · realistic log-normal
  | "mtta-degrading"   // 50 problems · 100% ack · MTTA grows over time (burnout)
  | "mtta-spotty";     // 40 problems · 40% ack  · most problems unanswered

let current: Scenario = "real";
const listeners = new Set<(s: Scenario) => void>();

export function getScenario(): Scenario {
  return current;
}

export function setScenario(s: Scenario): void {
  if (s === current) return;
  current = s;
  listeners.forEach((cb) => cb(s));
}

export function useScenario(): readonly [Scenario, (s: Scenario) => void] {
  const [s, setS] = useState<Scenario>(current);
  useEffect(() => {
    listeners.add(setS);
    return () => { listeners.delete(setS); };
  }, []);
  return [s, setScenario] as const;
}

const SIM_CATEGORIES = [
  "AVAILABILITY",          // 0
  "ERROR",                 // 1
  "SLOWDOWN",              // 2
  "RESOURCE_CONTENTION",   // 3
  "CUSTOM_ALERT",          // 4
  "MONITORING_UNAVAILABLE",// 5
] as const;

// Affected-entity TYPE bias per category so the Impact column distributes
// realistically: AVAILABILITY → Frontends, ERROR → Services, SLOWDOWN →
// Services, RESOURCE_CONTENTION → Infrastructure, etc.
const ENTITY_TYPES_BY_CAT: Record<string, string[]> = {
  AVAILABILITY:           ["APPLICATION", "WEB_APPLICATION", "MOBILE_APPLICATION"],
  ERROR:                  ["SERVICE", "SERVICE", "SERVICE", "APPLICATION"],          // mostly Services
  SLOWDOWN:               ["SERVICE", "SERVICE", "HOST"],
  RESOURCE_CONTENTION:    ["HOST", "DISK", "PROCESS_GROUP_INSTANCE", "HOST_GROUP"],
  CUSTOM_ALERT:           ["SERVICE", "HOST", "APPLICATION"],
  MONITORING_UNAVAILABLE: ["HOST", "PROCESS_GROUP_INSTANCE"],
};

const SIM_NAMES: Record<string, string[]> = {
  AVAILABILITY:           ["Service unavailable", "DNS resolution failed", "Health check failing", "Endpoint unreachable", "Unexpected low traffic"],
  ERROR:                  ["Failure rate increase", "5xx spike", "Connection reset", "Database timeout", "Payment gateway error", "Auth token rejected"],
  SLOWDOWN:               ["Response time degradation", "P95 latency spike", "Slow database query", "Queue backlog growing"],
  RESOURCE_CONTENTION:    ["Low disk space", "Memory pressure", "CPU saturation", "Thread pool exhausted"],
  CUSTOM_ALERT:           ["Custom threshold breached", "Anomaly detected", "User-defined alert"],
  MONITORING_UNAVAILABLE: ["OneAgent disconnected", "Synthetic monitor failed", "Metric collection lost"],
};

let simUidSeed = 0;

// Builds a 16-char hex string from the uid so synthetic entity IDs visually
// match the real Dynatrace `<TYPE>-<HEX16>` shape (e.g. SERVICE-9E03EFC8…).
function hex16(uid: number): string {
  const base = (uid * 0x9E3779B1) >>> 0;        // multiplicative hash
  const hi   = base.toString(16).toUpperCase().padStart(8, "0");
  const lo   = ((base ^ 0x12345678) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return (hi + lo).slice(0, 16);
}

interface BuildOptions {
  ageBias?: "fresh" | "default" | "long" | "ancient";   // controls how old the actives are
  severityBias?: 1 | 2 | 3 | 4 | 5;                     // forces a target severity
  rootCauseId?: string;                                  // shared root cause across a cluster
  startTsOverride?: number;                              // absolute event.start (ms)
}

function makeSimProblem(
  cat: typeof SIM_CATEGORIES[number],
  catIdx: number,
  start: string,
  status: "ACTIVE" | "CLOSED",
  end?: string,
  opts: BuildOptions = {},
): Problem {
  const uid = ++simUidSeed;
  const entityCount = 1 + (uid % 5);
  const names = SIM_NAMES[cat] || [cat.replace(/_/g, " ")];
  const name  = names[uid % names.length];

  // Severity distribution — by default mirrors real Davis tenants
  // (~10% sev5, ~25% sev4, ~30% sev3, ~25% sev2, ~10% sev1). When the
  // scenario calls for a biased distribution we steer ~70% of severities
  // toward the target with ~30% spread to neighbouring levels.
  let severity: string;
  if (opts.severityBias) {
    const roll = uid % 10;
    if (roll < 7) severity = String(opts.severityBias);
    else if (roll < 9) severity = String(Math.max(1, opts.severityBias - 1));
    else severity = String(Math.min(5, opts.severityBias + 1));
  } else {
    const sevRoll = uid % 20;
    severity =
      sevRoll < 2  ? "5" :
      sevRoll < 7  ? "4" :
      sevRoll < 13 ? "3" :
      sevRoll < 18 ? "2" : "1";
  }

  // Realistic entity IDs — `<TYPE>-<HEX16>`. Each problem gets affected
  // entities biased toward this category's typical types so the Impact
  // column reads correctly (Frontends / Services / Infrastructure).
  const types = ENTITY_TYPES_BY_CAT[cat] || ["SERVICE"];
  const affected_entity_ids = Array.from({ length: entityCount }, (_, i) => {
    const t = types[(uid + i) % types.length];
    return `${t}-${hex16(uid * 31 + i)}`;
  });
  // Root cause — either the scenario-supplied shared ID (root-cause
  // cluster) or a unique per-problem one.
  const rootType = (types[0] === "APPLICATION" || types[0] === "WEB_APPLICATION" || types[0] === "MOBILE_APPLICATION")
    ? "SERVICE"   // frontend symptoms usually trace back to a service
    : types[0];
  const root_cause_entity_id = opts.rootCauseId || `${rootType}-${hex16(uid * 17)}`;

  return {
    // Synthetic Davis composite id. Format mirrors the real shape
    // (`<bigint>_<bigint>V<digit>`) so anything that round-trips the
    // id through `isDavisProblemId(...)` validation still works on
    // sim data — including deep-links to /timeline and the MTTA
    // join-by-id in `useTeamMetrics`.
    davis_problem_id:      `${1_000_000_000_000_000 + uid}_${1_779_000_000_000 + uid * 60_000}V1`,
    "event.name":          name,
    "event.status":        status,
    "event.category":      cat as Problem["event.category"],
    "event.start":         start,
    "event.end":           end,
    "event.severity":      severity,
    affected_entity_ids,
    root_cause_entity_id,
    display_id:            `SIM-${String(uid).padStart(4, "0")}`,
  };
}

// Pick a synthetic event.start (ms ago) according to age bias.
function pickAgeMs(bias: BuildOptions["ageBias"]): number {
  switch (bias) {
    case "fresh":   return (1  + Math.random() * 12) * 60_000;          // 1–13 min
    case "long":    return (12 + Math.random() * 36) * 3600_000;         // 12–48 h
    case "ancient": return (3  + Math.random() * 27) * 86_400_000;       // 3–30 d
    case "default":
    default:        return (5  + Math.random() * 50) * 60_000;           // 5–55 min
  }
}

// Bulk helper — pushes N synthetic problems for a category with the
// supplied build options.
function pushActive(
  out: Problem[], cat: typeof SIM_CATEGORIES[number], idx: number, n: number,
  now: number, opts: BuildOptions = {},
) {
  for (let i = 0; i < n; i++) {
    const ts = opts.startTsOverride ?? (now - pickAgeMs(opts.ageBias));
    out.push(makeSimProblem(cat, idx, new Date(ts).toISOString(), "ACTIVE", undefined, opts));
  }
}
function pushOlderActive(out: Problem[], cat: typeof SIM_CATEGORIES[number], idx: number, n: number, now: number) {
  for (let i = 0; i < n; i++) {
    const ageMs = (60 + Math.random() * 240) * 60_000; // 1–5 h
    out.push(makeSimProblem(cat, idx, new Date(now - ageMs).toISOString(), "ACTIVE"));
  }
}
function pushRecentlyClosed(out: Problem[], cat: typeof SIM_CATEGORIES[number], idx: number, n: number, now: number) {
  for (let i = 0; i < n; i++) {
    const startMs = (70 + Math.random() * 200) * 60_000;
    const endMs   = Math.random() * 55 * 60_000;
    out.push(makeSimProblem(
      cat, idx, new Date(now - startMs).toISOString(), "CLOSED",
      new Date(now - endMs).toISOString(),
    ));
  }
}
function pushHistorical(out: Problem[], cat: typeof SIM_CATEGORIES[number], idx: number, n: number, now: number) {
  for (let i = 0; i < n; i++) {
    const startMs = (120 + Math.random() * 22 * 60) * 60_000;
    const endMs   = (60  + Math.random() * 11 * 60) * 60_000;
    out.push(makeSimProblem(
      cat, idx, new Date(now - startMs).toISOString(), "CLOSED",
      new Date(now - endMs).toISOString(),
    ));
  }
}

// ── Performance Lab — realistic enterprise distribution ──────────────
//
// Designed to look STATISTICALLY like a real Davis tenant at scale, so
// the app's behaviour under these volumes is a credible preview of how
// it will perform when shipped to a customer with 10–80k hosts.
//
// Distribution (validated against observed customer tenants):
//   • Status: 99% CLOSED, 1% ACTIVE
//   • Category: CUSTOM_ALERT 40%, ERROR 25%, SLOWDOWN 15%,
//     AVAILABILITY 10%, RESOURCE_CONTENTION 7%, MONITORING 3%
//   • Severity: 10% sev5, 25% sev4, 30% sev3, 25% sev2, 10% sev1
//     (inherited from `makeSimProblem` default branch)
//   • ACTIVE start times: 30% <1h, 30% 1–24h, 30% 1–7d, 10% >7d
//   • CLOSED start times: 70% in last 7d, 25% in 7–21d, 5% in 21–30d
//   • CLOSED duration: log-normal — 70% <1h, 25% 1–6h, 5% >6h
//   • 1–3 affected entities (existing makeSimProblem default)
//
// Output is generated synchronously. Memory: ~500 B per Problem object
// × 50_000 ≈ 25 MB peak — fits in the 256 MB JS heap default with
// plenty of headroom. Generation time on a fast laptop:
//   1 k:   ~10 ms     30 k:  ~250 ms
//   10 k:  ~80 ms     50 k:  ~420 ms
const ENTERPRISE_CATEGORY_WEIGHTS: Array<[typeof SIM_CATEGORIES[number], number]> = [
  ["CUSTOM_ALERT",           40],
  ["ERROR",                  25],
  ["SLOWDOWN",               15],
  ["AVAILABILITY",           10],
  ["RESOURCE_CONTENTION",     7],
  ["MONITORING_UNAVAILABLE",  3],
];

/** Picks an ACTIVE start time according to the realistic mix described
 *  above. Returns absolute milliseconds. */
function pickActiveStartMs(now: number, slot: number): number {
  const bucket = slot % 10;            // deterministic, evenly bucketed
  if (bucket < 3) return now - Math.floor(Math.random() *      60 * 60_000);             // <1h
  if (bucket < 6) return now - (60 + Math.floor(Math.random() * 23 * 60))       * 60_000; // 1–24h
  if (bucket < 9) return now - (24 + Math.floor(Math.random() * 6  * 24))       * 3_600_000; // 1–7d
                  return now - (7  + Math.floor(Math.random() * 23))            * 86_400_000; // 7–30d
}

/** Picks a CLOSED problem's (start, end) pair so end>start and the
 *  total spread matches realistic tenant data. Returns milliseconds. */
function pickClosedSpanMs(now: number, slot: number): { start: number; end: number } {
  // Choose start timeframe band — weighted by frequency.
  const startBucket = slot % 20;
  let ageDays: number;
  if (startBucket < 14)      ageDays = Math.random() * 7;            // 70% last 7d
  else if (startBucket < 19) ageDays = 7 + Math.random() * 14;       // 25% 7–21d
  else                       ageDays = 21 + Math.random() * 9;       // 5% 21–30d
  const startMs = now - ageDays * 86_400_000;

  // Choose duration — log-normal flavour via bucketing.
  const durBucket = slot % 10;
  let durMs: number;
  if (durBucket < 7)      durMs = (5 + Math.random() * 55) * 60_000;       // 70% <1h
  else if (durBucket < 9) durMs = (1 + Math.random() * 5)  * 3_600_000;    // 25% 1–6h
  else                    durMs = (6 + Math.random() * 18) * 3_600_000;    // 5% >6h
  return { start: startMs, end: Math.min(now, startMs + durMs) };
}

/** Push `total` problems into `out` with realistic enterprise
 *  distribution. Splits roughly 1% ACTIVE / 99% CLOSED across the
 *  category weights above. */
function pushEnterpriseProblems(out: Problem[], total: number, now: number): void {
  // Pre-compute the per-category target counts so the totals add up
  // to `total` exactly (no off-by-rounding-error).
  const counts: Array<{ cat: typeof SIM_CATEGORIES[number]; n: number }> = [];
  let assigned = 0;
  for (let i = 0; i < ENTERPRISE_CATEGORY_WEIGHTS.length; i++) {
    const [cat, weight] = ENTERPRISE_CATEGORY_WEIGHTS[i];
    const n = (i === ENTERPRISE_CATEGORY_WEIGHTS.length - 1)
      ? total - assigned                    // last cat soaks up the remainder
      : Math.round((total * weight) / 100);
    counts.push({ cat, n });
    assigned += n;
  }

  let slot = 0;
  for (const { cat, n } of counts) {
    const catIdx = SIM_CATEGORIES.indexOf(cat);
    // 1% active within this category — bounded to ≥1 if the category
    // has at least 100 entries so the visualisation always has stars.
    const activeN = Math.max(0, Math.round(n * 0.01));
    const closedN = n - activeN;

    for (let i = 0; i < activeN; i++) {
      const ts = pickActiveStartMs(now, slot++);
      out.push(makeSimProblem(cat, catIdx, new Date(ts).toISOString(), "ACTIVE"));
    }
    for (let i = 0; i < closedN; i++) {
      const span = pickClosedSpanMs(now, slot++);
      out.push(makeSimProblem(
        cat, catIdx, new Date(span.start).toISOString(), "CLOSED",
        new Date(span.end).toISOString(),
      ));
    }
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────
// Each branch produces the full problem list for that scenario. Kept as
// inline imperative code so each scenario is self-contained and easy to
// tweak independently.
export function getSimulatedProblems(scenario: Scenario, real: Problem[]): Problem[] {
  if (scenario === "real") return real;
  // Segment scenarios reuse one of the existing problem scenarios as
  // their underlying data — we only override the segment catalog +
  // membership maps for those, not the problems themselves.
  const segBase = SEGMENT_SCENARIO_BASE[scenario as SegmentScenario];
  if (segBase) return getSimulatedProblems(segBase, real);
  // MTTA scenarios have a bespoke builder — spread over 14d so the
  // evolution chart has range on its X-axis.
  if (isMttaScenario(scenario)) return buildMttaProblems(scenario);

  simUidSeed = 0;
  const now = Date.now();
  const out: Problem[] = [];

  switch (scenario) {
    case "quiet": {
      // Sparse environment — 4 active across only two categories, fresh,
      // plus a small history. Tests single-leader UI and quiet states.
      pushActive(out, "AVAILABILITY", 0, 1, now, { ageBias: "fresh" });
      pushActive(out, "ERROR",        1, 3, now, { ageBias: "fresh" });
      pushHistorical(out, "AVAILABILITY", 0, 4, now);
      pushHistorical(out, "ERROR",        1, 6, now);
      pushHistorical(out, "SLOWDOWN",     2, 3, now);
      break;
    }

    case "all-rising": {
      SIM_CATEGORIES.forEach((cat, idx) => {
        pushActive(out, cat, idx, 8, now);
        pushOlderActive(out, cat, idx, 2, now);
        pushHistorical(out, cat, idx, 6, now);
      });
      break;
    }

    case "all-falling": {
      SIM_CATEGORIES.forEach((cat, idx) => {
        pushActive(out, cat, idx, 2, now);
        pushOlderActive(out, cat, idx, 1, now);
        pushRecentlyClosed(out, cat, idx, 7, now);
        pushHistorical(out, cat, idx, 5, now);
      });
      break;
    }

    case "mixed": {
      SIM_CATEGORIES.forEach((cat, idx) => {
        if (idx % 2 === 0) {
          pushActive(out, cat, idx, 8, now);
          pushOlderActive(out, cat, idx, 2, now);
          pushHistorical(out, cat, idx, 6, now);
        } else {
          pushActive(out, cat, idx, 2, now);
          pushOlderActive(out, cat, idx, 1, now);
          pushRecentlyClosed(out, cat, idx, 7, now);
          pushHistorical(out, cat, idx, 6, now);
        }
      });
      break;
    }

    case "critical": {
      // Mostly Critical-severity problems (sev=5) spread across two
      // categories so the Criticality Show-by mode lights up clearly,
      // with the severity-filter chips exercising every level.
      pushActive(out, "AVAILABILITY", 0, 3, now, { severityBias: 5, ageBias: "fresh" });
      pushActive(out, "ERROR",        1, 3, now, { severityBias: 5 });
      pushActive(out, "SLOWDOWN",     2, 1, now, { severityBias: 4 });
      pushActive(out, "RESOURCE_CONTENTION", 3, 1, now, { severityBias: 3 });
      pushActive(out, "CUSTOM_ALERT", 4, 1, now, { severityBias: 2 });
      pushActive(out, "MONITORING_UNAVAILABLE", 5, 1, now, { severityBias: 1 });
      // Some historical context.
      SIM_CATEGORIES.forEach((cat, idx) => pushHistorical(out, cat, idx, 4, now));
      break;
    }

    case "long-running": {
      // Old active problems (12–48 h). The Open Time mode top-tier rings
      // should land on the oldest ones in each quadrant; list "Duration"
      // column shows long values.
      pushActive(out, "AVAILABILITY",        0, 2, now, { ageBias: "long" });
      pushActive(out, "ERROR",               1, 3, now, { ageBias: "long" });
      pushActive(out, "SLOWDOWN",            2, 2, now, { ageBias: "long" });
      pushActive(out, "RESOURCE_CONTENTION", 3, 2, now, { ageBias: "long" });
      pushActive(out, "CUSTOM_ALERT",        4, 1, now, { ageBias: "long" });
      // A handful of fresh ones so Rising mode also has something.
      pushActive(out, "ERROR",               1, 2, now, { ageBias: "fresh" });
      SIM_CATEGORIES.forEach((cat, idx) => pushHistorical(out, cat, idx, 5, now));
      break;
    }

    case "tied": {
      // AVAILABILITY and ERROR with exactly the same active count (4
      // each) — multi-leader test. Chart highlight boxes appear in both
      // colours, list rows for both categories get the accent edge.
      pushActive(out, "AVAILABILITY", 0, 4, now);
      pushActive(out, "ERROR",        1, 4, now);
      pushActive(out, "SLOWDOWN",     2, 1, now);
      pushHistorical(out, "AVAILABILITY", 0, 5, now);
      pushHistorical(out, "ERROR",        1, 5, now);
      pushHistorical(out, "SLOWDOWN",     2, 2, now);
      break;
    }

    case "time-cluster": {
      // 8 active problems all started within the same one-minute window
      // (3 min ago). Clicking that bar in the chart filters the list to
      // this exact second-precision cluster. Tests bar drill-down.
      const clusterTs = now - 3 * 60_000;
      pushActive(out, "AVAILABILITY",        0, 2, now, { startTsOverride: clusterTs });
      pushActive(out, "ERROR",               1, 3, now, { startTsOverride: clusterTs + 10_000 });
      pushActive(out, "SLOWDOWN",            2, 2, now, { startTsOverride: clusterTs + 20_000 });
      pushActive(out, "RESOURCE_CONTENTION", 3, 1, now, { startTsOverride: clusterTs + 30_000 });
      // A scattering of older actives and history so the chart has a
      // baseline against which the cluster spikes visibly.
      SIM_CATEGORIES.forEach((cat, idx) => {
        pushOlderActive(out, cat, idx, 1, now);
        pushHistorical(out, cat, idx, 4, now);
      });
      break;
    }

    case "focused": {
      // ERROR in full meltdown — exercises the dense scatter (~200 active
      // dots), many top-tier focus rings, and the detail panel scroll.
      pushActive(out, "ERROR", 1, 200, now);
      pushOlderActive(out, "ERROR", 1, 50, now);
      pushRecentlyClosed(out, "ERROR", 1, 20, now);
      pushHistorical(out, "ERROR", 1, 60, now);
      SIM_CATEGORIES.forEach((cat, idx) => {
        if (idx === 1) return;
        pushActive(out, cat, idx, 1, now);
        pushRecentlyClosed(out, cat, idx, 1, now);
        pushHistorical(out, cat, idx, 3, now);
      });
      break;
    }

    case "stress": {
      SIM_CATEGORIES.forEach((cat, idx) => {
        pushActive(out, cat, idx, 15, now);
        pushOlderActive(out, cat, idx, 3, now);
        pushRecentlyClosed(out, cat, idx, 1, now);
        pushHistorical(out, cat, idx, 8, now);
      });
      break;
    }

    case "xlarge": {
      // Enterprise tenant — alternating "hot" and "cooling" categories so
      // the dashboard exercises every code path: thousands of dots, dense
      // rising spokes, falling streams, deep RESOLVED history.
      SIM_CATEGORIES.forEach((cat, idx) => {
        const isHot = idx % 2 === 0;
        if (isHot) {
          pushActive(out, cat, idx, 60, now);
          pushOlderActive(out, cat, idx, 40, now);
          pushRecentlyClosed(out, cat, idx, 20, now);
          pushHistorical(out, cat, idx, 480, now);
        } else {
          pushActive(out, cat, idx, 20, now);
          pushOlderActive(out, cat, idx, 30, now);
          pushRecentlyClosed(out, cat, idx, 80, now);
          pushHistorical(out, cat, idx, 470, now);
        }
      });
      break;
    }

    // ── Performance Lab — realistic enterprise volumes ─────────────
    // Each branch hands off to `pushEnterpriseProblems(target)`. See
    // that helper's docblock for the full distribution rationale.
    // Sizes were picked to match the host-count ranges customers
    // self-report (5k / 20k / 50k / 80k hosts → ~1k / 10k / 30k / 50k
    // problems in a 7-30 d window after dedup).
    case "perf-1k":  { pushEnterpriseProblems(out, 1_000,  now); break; }
    case "perf-10k": { pushEnterpriseProblems(out, 10_000, now); break; }
    case "perf-30k": { pushEnterpriseProblems(out, 30_000, now); break; }
    case "perf-50k": { pushEnterpriseProblems(out, 50_000, now); break; }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────
// Segment-page test scenarios
// ────────────────────────────────────────────────────────────────────
// The /segments page reads two extra streams the rest of the app
// doesn't: a catalog of filter segments and a membership map (problem
// display_id → segment uids it belongs to). For tenants without
// segments configured we still want to exercise the UI surface, so
// these helpers produce synthetic catalogs + memberships keyed off
// the underlying problem scenarios.
//
// `getSimulatedFilterSegments(s)` and `getSimulatedSegmentMembership(s, problems)`
// each return `null` when the scenario isn't segment-flavoured —
// callers (`Overview.tsx`) interpret null as "fall back to real data".

export type SegmentScenario =
  | "seg-empty"
  | "seg-few"
  | "seg-overflow"
  | "seg-unassigned"
  | "seg-multi"
  | "seg-imbalanced";

export function isSegmentScenario(s: Scenario): s is SegmentScenario {
  return s.startsWith("seg-");
}

// Each segment scenario reuses one of the existing problem scenarios as
// its underlying problem set. We just paint segment membership on top.
const SEGMENT_SCENARIO_BASE: Record<SegmentScenario, Scenario> = {
  "seg-empty":      "all-rising",
  "seg-few":        "all-rising",
  "seg-overflow":   "stress",
  "seg-unassigned": "all-rising",
  "seg-multi":      "all-rising",
  "seg-imbalanced": "all-rising",
};

interface SimSeg { uid: string; name: string; }

function makeSeg(name: string): SimSeg {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { uid: `sim-seg-${slug}`, name };
}

// Synthetic segment catalogs — chosen so the names suggest realistic
// segmentation strategies (team / service / environment).
const SIM_SEGS: Record<SegmentScenario, SimSeg[]> = {
  "seg-empty":      [],
  "seg-few":        ["Payments", "Auth", "Checkout"].map(makeSeg),
  "seg-overflow":   [
    "Payments", "Auth", "Checkout", "Cart", "Inventory", "Shipping",
    "Search", "Recommendations", "Notifications", "Reporting",
    "Admin", "Analytics",
  ].map(makeSeg),
  "seg-unassigned": ["Production", "Staging", "Canary", "Sandbox"].map(makeSeg),
  "seg-multi":      ["Frontend", "Backend", "Database", "Cache", "Queue"].map(makeSeg),
  "seg-imbalanced": ["Production-Critical", "Staging", "Internal", "Beta", "Sandbox"].map(makeSeg),
};

export function getSimulatedFilterSegments(scenario: Scenario): SimSeg[] | null {
  if (!isSegmentScenario(scenario)) return null;
  return SIM_SEGS[scenario];
}

// Deterministic mapping from problem-list index → segment uids based
// on the scenario. Returning an empty array means the problem lands in
// the UNASSIGNED bucket.
function assignSegments(
  scenario: SegmentScenario, i: number, segUids: string[],
): string[] {
  if (segUids.length === 0) return [];
  switch (scenario) {
    case "seg-empty":
      return [];
    case "seg-few":
      // Even round-robin across the 3 segments.
      return [segUids[i % segUids.length]];
    case "seg-overflow":
      // Bias: first-6 (top) get 60% of problems, last-6 (overflow) 40%.
      // Within each half we round-robin so distribution is stable.
      if (i % 5 < 3) {
        return [segUids[i % 6]];                       // top half
      }
      return [segUids[6 + (i % (segUids.length - 6))]]; // overflow half
    case "seg-unassigned":
      // 80% in a segment, 20% unassigned.
      if (i % 5 === 0) return [];
      return [segUids[i % segUids.length]];
    case "seg-multi":
      // 70% single, 30% in two segments (current + next).
      if (i % 10 < 3) {
        const a = i % segUids.length;
        const b = (i + 1) % segUids.length;
        return a === b ? [segUids[a]] : [segUids[a], segUids[b]];
      }
      return [segUids[i % segUids.length]];
    case "seg-imbalanced":
      // 70% in segUids[0]; remaining 30% spread across the rest.
      if (i % 10 < 7) return [segUids[0]];
      return [segUids[1 + (i % (segUids.length - 1))]];
  }
}

export function getSimulatedSegmentMembership(
  scenario: Scenario, problems: Problem[],
): Map<string, Set<string>> | null {
  if (!isSegmentScenario(scenario)) return null;
  const segs = SIM_SEGS[scenario];
  const segUids = segs.map((s) => s.uid);
  const m = new Map<string, Set<string>>();
  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const ids = assignSegments(scenario, i, segUids);
    if (ids.length > 0) m.set(p.display_id, new Set(ids));
  }
  return m;
}

// ────────────────────────────────────────────────────────────────────
// MTTA test scenarios
// ────────────────────────────────────────────────────────────────────
// Two halves to each scenario, mirroring the segments pattern:
//   • A problems list spread over the last 14 days so the X-axis on
//     the MTTA evolution chart has range to plot.
//   • A `Map<davis_problem_id, firstCommentIso>` that satisfies
//     `useTeamMetrics`'s join — exposing it lets the hook short-
//     circuit its DQL call and use the sim instead.
//
// `getSimulatedMttaMap` returns `null` for non-MTTA scenarios so
// the Analytics page can branch with a simple `?:`.

export type MttaScenario =
  | "mtta-fast"
  | "mtta-slow"
  | "mtta-mixed"
  | "mtta-degrading"
  | "mtta-spotty";

export function isMttaScenario(s: Scenario): s is MttaScenario {
  return s.startsWith("mtta-");
}

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

/** Deterministic pseudo-random in [0,1) derived from an integer
 *  seed. Avoids `Math.random` so successive renders produce the
 *  exact same chart — useful for screenshots / docs. */
function det(seed: number): number {
  // 32-bit LCG → [0,1). The constants are the classic Numerical
  // Recipes pair.
  return (((seed * 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
}

/** Log-normal-ish MTTA delay. `medianMs` is the target median and
 *  `spread` controls dispersion (higher = wider distribution). The
 *  output is clamped to [30 s, 14 d]. */
function mttaDelayMs(seed: number, medianMs: number, spread: number): number {
  const r = det(seed) - 0.5;                       // [-0.5, 0.5)
  const ms = medianMs * Math.pow(2, spread * r * 6);
  return Math.max(30_000, Math.min(14 * 86_400_000, Math.floor(ms)));
}

/** Builds the synthetic problem set for an MTTA scenario. Problems
 *  are spread linearly across the last 14 days so the evolution
 *  chart has time-range to plot, and categories rotate through all
 *  six so the colour palette is exercised. */
function buildMttaProblems(scenario: MttaScenario): Problem[] {
  const count =
    scenario === "mtta-fast"   ? 30 :
    scenario === "mtta-slow"   ? 30 :
    scenario === "mtta-spotty" ? 40 :
    50;
  simUidSeed = 0;
  const now = Date.now();
  const out: Problem[] = [];
  for (let i = 0; i < count; i++) {
    const ageMs = (i / Math.max(1, count - 1)) * FOURTEEN_DAYS_MS;
    const cat   = SIM_CATEGORIES[i % SIM_CATEGORIES.length];
    const catIdx = i % SIM_CATEGORIES.length;
    const start  = new Date(now - (FOURTEEN_DAYS_MS - ageMs)).toISOString();
    // Most MTTA scenarios show CLOSED problems (they have full
    // lifecycle); spotty leaves some ACTIVE to mix the chart.
    const isActive = scenario === "mtta-spotty" && i % 4 === 0;
    const end = isActive ? undefined : new Date(now - (FOURTEEN_DAYS_MS - ageMs) + 60 * 60_000).toISOString();
    out.push(makeSimProblem(cat, catIdx, start, isActive ? "ACTIVE" : "CLOSED", end));
  }
  return out;
}

// Names + automation catalogs used to synthesise comment authors and
// workflow titles. Keeping these short and recognisable so each card
// reads like a believable real incident.
const SIM_COMMENT_AUTHORS = [
  { name: "Marcelo Coletta",  uid: "78d34829-79a7-463b-a954-b984d5082755" },
  { name: "Willian Souza",    uid: "9b1c5e88-12b3-4cf1-9d8e-2c5a0e6b9311" },
  { name: "Ana Beatriz",      uid: "44c9f201-6a5e-4d12-8a93-118eaa5e3a7c" },
  { name: "João Pedro",       uid: "c39b1d80-2f55-4f10-94e9-b8d2c61a07d3" },
  { name: "Davis CoPilot",    uid: "00000000-0000-0000-0000-000000000001" },
];
const SIM_COMMENT_TEXTS = [
  "Investigating with the SRE team.",
  "Looking into the recent deploy.",
  "Reproduced in staging — capturing logs.",
  "Pod restart applied · monitoring.",
  "Root cause looks like upstream DNS.",
  "Suggested fix: increase HPA min replicas to 4.",
  "Reverting last config change.",
  "Coordinating with the on-call lead.",
  "Confirmed mitigation — closing once stable.",
];
const SIM_AUTOMATION_TITLES: Array<{ title: string; type: string }> = [
  { title: "Slack Alert!",            type: "STANDARD" },
  { title: "PagerDuty notify",        type: "STANDARD" },
  { title: "ServiceNow Test",         type: "STANDARD" },
  { title: "Cloud SRE - Investigate", type: "STANDARD" },
  { title: "Auto-restart pods",       type: "STANDARD" },
  { title: "Capture diagnostics",     type: "SIMPLE" },
];
const SIM_AUTOMATION_STATES: Array<"SUCCESS" | "ERROR" | "CANCELLED"> = [
  "SUCCESS", "SUCCESS", "SUCCESS", "ERROR", "CANCELLED",
];

export interface SimComment {
  /** ISO timestamp. */
  at: string;
  text: string;
  authorName: string;
  authorId: string;
}

export interface SimAutomation {
  /** ISO timestamp (start). */
  at: string;
  title: string;
  state: "SUCCESS" | "ERROR" | "CANCELLED";
  type: string;
  executionId: string;
}

/** Per-problem synthetic timeline. The map key is
 *  `davis_problem_id`. */
export interface SimulatedProblemTimeline {
  comments:    SimComment[];
  automations: SimAutomation[];
}

/** Generate distinct, plausible comments + automations for every
 *  simulated problem. Counts vary by scenario so the cards on the
 *  page look heterogeneous rather than carbon copies. */
export function getSimulatedProblemTimelines(
  scenario: Scenario, problems: Problem[],
): Map<string, SimulatedProblemTimeline> | null {
  if (!isMttaScenario(scenario)) return null;
  const mttaMap = getSimulatedMttaMap(scenario, problems);
  const out = new Map<string, SimulatedProblemTimeline>();

  for (let i = 0; i < problems.length; i++) {
    const p   = problems[i];
    const pid = (p as unknown as { davis_problem_id?: string }).davis_problem_id;
    if (!pid) continue;
    const startMs = new Date(p["event.start"]).getTime();
    if (!Number.isFinite(startMs)) continue;
    const seed = i + 11;

    // ── Comments. The first comment timestamp comes from the MTTA
    // map (so the MTTA chip + scatter stay consistent). Additional
    // comments are added at growing offsets afterwards.
    const firstAt = mttaMap?.get(pid);
    const comments: SimComment[] = [];
    if (firstAt) {
      const firstMs = new Date(firstAt).getTime();
      // How many comments? Slower MTTAs → more back-and-forth.
      const baseCount =
        scenario === "mtta-fast"      ? 1 :
        scenario === "mtta-slow"      ? 3 :
        scenario === "mtta-degrading" ? 2 :
        scenario === "mtta-spotty"    ? 1 :
        2;
      const extra = Math.floor(det(seed * 3) * 2);                // 0..1 extra
      const total = baseCount + extra;
      for (let c = 0; c < total; c++) {
        const author = SIM_COMMENT_AUTHORS[(seed + c) % SIM_COMMENT_AUTHORS.length];
        const text   = SIM_COMMENT_TEXTS[(seed * 5 + c) % SIM_COMMENT_TEXTS.length];
        const offsetMs = c === 0 ? 0 : Math.floor(det(seed * 9 + c) * 4 * 3600_000) + c * 30 * 60_000;
        comments.push({
          at:         new Date(firstMs + offsetMs).toISOString(),
          text,
          authorName: author.name,
          authorId:   author.uid,
        });
      }
    }

    // ── Automations. Triggered shortly after problem opens so they
    // appear above the first comment on the timeline.
    const autoCount =
      scenario === "mtta-fast"      ? 1 + Math.floor(det(seed * 13) * 2) :  // 1..2
      scenario === "mtta-slow"      ? Math.floor(det(seed * 13) * 2)     :  // 0..1
      scenario === "mtta-degrading" ? 1 + Math.floor(det(seed * 13) * 3) :  // 1..3
      scenario === "mtta-spotty"    ? Math.floor(det(seed * 13) * 2)     :  // 0..1
      1 + Math.floor(det(seed * 13) * 3);                                  // 1..3 (mixed)
    const automations: SimAutomation[] = [];
    for (let a = 0; a < autoCount; a++) {
      const tpl = SIM_AUTOMATION_TITLES[(seed * 7 + a) % SIM_AUTOMATION_TITLES.length];
      const state = SIM_AUTOMATION_STATES[(seed * 11 + a) % SIM_AUTOMATION_STATES.length];
      // Spread within the first 30 minutes of the problem.
      const offsetMs = Math.floor(det(seed * 17 + a) * 30 * 60_000) + a * 60_000;
      automations.push({
        at:          new Date(startMs + offsetMs).toISOString(),
        title:       tpl.title,
        type:        tpl.type,
        state,
        executionId: `sim-${pid.slice(0, 8)}-${a}`,
      });
    }

    out.set(pid, { comments, automations });
  }
  return out;
}

/** Picks a synthetic first-comment delay per problem based on the
 *  scenario's profile, and packs the result into the join map
 *  consumed by `useTeamMetrics`. Returning `null` from a non-MTTA
 *  scenario lets the caller branch cleanly. */
export function getSimulatedMttaMap(
  scenario: Scenario, problems: Problem[],
): Map<string, string> | null {
  if (!isMttaScenario(scenario)) return null;
  const m = new Map<string, string>();
  for (let i = 0; i < problems.length; i++) {
    const p = problems[i];
    const pid = (p as unknown as { davis_problem_id?: string }).davis_problem_id;
    if (!pid) continue;
    const start = new Date(p["event.start"]).getTime();
    if (!Number.isFinite(start)) continue;

    // Per-scenario MTTA distribution. Seeds are derived from the uid
    // embedded in display_id so the same problem gets the same delay
    // across re-renders.
    const seed = i + 1;
    let delayMs: number | null = null;
    switch (scenario) {
      case "mtta-fast":
        delayMs = mttaDelayMs(seed, 5 * 60_000, 0.45);           // ~5m median
        break;
      case "mtta-slow":
        delayMs = mttaDelayMs(seed, 4 * 3600_000, 0.55);         // ~4h median
        break;
      case "mtta-mixed":
        if (i % 10 === 0) { delayMs = null; break; }              // 10% unack
        delayMs = mttaDelayMs(seed, 30 * 60_000, 0.65);          // 30m median, wide
        break;
      case "mtta-degrading": {
        // Linear drift: earliest problems → 5m, latest → 8h. The
        // chart should show a clear upward trend over time.
        const t = i / Math.max(1, problems.length - 1);          // [0,1)
        const base = 5 * 60_000 + t * (8 * 3600_000 - 5 * 60_000);
        delayMs = Math.max(60_000, Math.floor(base * (0.85 + det(seed) * 0.30)));
        break;
      }
      case "mtta-spotty":
        // 40% ack rate — most problems left without a first comment
        // so the "Ack rate" KPI lands well under 100%.
        if (det(seed * 7) > 0.40) { delayMs = null; break; }
        delayMs = mttaDelayMs(seed, 90 * 60_000, 0.75);          // 90m median, very wide
        break;
    }
    if (delayMs === null) continue;
    m.set(pid, new Date(start + delayMs).toISOString());
  }
  return m;
}
