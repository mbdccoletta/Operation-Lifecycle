// TEMPORARY — remove this file (and its imports) after the visualization
// tuning phase is finished. The floating debug panel uses this to swap
// real problems for synthetic ones that exercise the app's full feature
// surface (every Show by mode, every impact band, every list filter).
//
// 0.0.117 — full scenario rewrite. Goals:
//   • Coherent counts: hub rings = Σ per-cell active = Σ per-bubble
//     (within-cell). Closed totals feed the RESOLVED zone.
//   • Davis AI severity: each synthetic problem's `event.severity`
//     is derived from its category, matching the official spec the
//     v0.0.115 fix introduced (AVAILABILITY/MONITORING_UNAVAIL = Sev 1,
//     ERROR = Sev 2, SLOWDOWN/RC/CUSTOM_ALERT = Sev 3). No more random
//     severities; the bubble and per-row severity chip now match what
//     a real Davis tenant would produce.
//   • Correct animation timing: `event.start` always lands in the
//     right window for the cell bubble it represents — Rising under
//     1 h, Stuck 1–8 h, Ancient 8 h–7 d. Closed problems get an
//     `event.end` that drives the RESOLVED ring's +N /1h delta.
//   • Dynamic environment sizes: small / medium / large / xlarge,
//     the latter with >3000 active per category so the dense-cell
//     UX (lens, aggregation, leader frame) is exercised at scale.

import { useEffect, useState } from "react";
import type { Problem } from "../hooks/useProblems";

export type Scenario =
  | "real"            // no override — use real data as-is
  // ── Size scenarios — dynamic environments at growing scale ──
  | "quiet"           // ~3 active · empty-state UI
  | "small"           // ~13 active · calm operations
  | "medium"          // ~90 active · busy SRE day
  | "large"           // ~550 active · incident in progress
  | "xlarge"          // >3000 active PER category · enterprise crisis
  // ── Animation / mode-exercising scenarios ──
  | "all-rising"      // every active < 1 h · Rising bubble lit
  | "all-stuck"       // every active > 4 h · Stuck bubble lit
  | "time-cluster"    // 8 actives in a 1-min window · bar drill-down
  // ── Leader-highlight (Total mode) scenarios ──
  | "single-leader"   // ERROR ≫ others · single Total leader cell
  | "tied-leaders"    // AVAIL + ERROR tied · two leader frames
  // ── RESOLVED zone scenarios ──
  | "wave-resolved"   // big wave of closures < 1 h · RESOLVED ▲ spikes
  // ── Segments / MTTA — preserved domains, no changes ──
  | "seg-empty" | "seg-few" | "seg-overflow"
  | "seg-unassigned" | "seg-multi" | "seg-imbalanced"
  | "mtta-fast" | "mtta-slow" | "mtta-mixed"
  | "mtta-degrading" | "mtta-spotty";

let current: Scenario = "real";
const listeners = new Set<(s: Scenario) => void>();

export function getScenario(): Scenario { return current; }
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

// ── Categories ──────────────────────────────────────────────────
const SIM_CATEGORIES = [
  "AVAILABILITY",
  "ERROR",
  "SLOWDOWN",
  "RESOURCE_CONTENTION",
  "CUSTOM_ALERT",
  "MONITORING_UNAVAILABLE",
] as const;
type Cat = typeof SIM_CATEGORIES[number];

// Davis AI severity per category — single source of truth for
// synthetic problems. Matches `SEVERITY_CATEGORIES` in
// `utils/grouping.ts` (Sev 1 critical, Sev 2 high, Sev 3 medium).
const SEVERITY_BY_CATEGORY: Record<Cat, string> = {
  AVAILABILITY:           "1",
  MONITORING_UNAVAILABLE: "1",
  ERROR:                  "2",
  SLOWDOWN:               "3",
  RESOURCE_CONTENTION:    "3",
  CUSTOM_ALERT:           "3",
};

// Entity TYPE bias so the Impact column distributes realistically.
const ENTITY_TYPES_BY_CAT: Record<Cat, string[]> = {
  AVAILABILITY:           ["APPLICATION", "WEB_APPLICATION", "MOBILE_APPLICATION"],
  ERROR:                  ["SERVICE", "SERVICE", "SERVICE", "APPLICATION"],
  SLOWDOWN:               ["SERVICE", "SERVICE", "HOST"],
  RESOURCE_CONTENTION:    ["HOST", "DISK", "PROCESS_GROUP_INSTANCE", "HOST_GROUP"],
  CUSTOM_ALERT:           ["SERVICE", "HOST", "APPLICATION"],
  MONITORING_UNAVAILABLE: ["HOST", "PROCESS_GROUP_INSTANCE"],
};

const SIM_NAMES: Record<Cat, string[]> = {
  AVAILABILITY:           ["Service unavailable", "DNS resolution failed", "Health check failing", "Endpoint unreachable", "Unexpected low traffic"],
  ERROR:                  ["Failure rate increase", "5xx spike", "Connection reset", "Database timeout", "Payment gateway error", "Auth token rejected"],
  SLOWDOWN:               ["Response time degradation", "P95 latency spike", "Slow database query", "Queue backlog growing"],
  RESOURCE_CONTENTION:    ["Low disk space", "Memory pressure", "CPU saturation", "Thread pool exhausted"],
  CUSTOM_ALERT:           ["Custom threshold breached", "Anomaly detected", "User-defined alert"],
  MONITORING_UNAVAILABLE: ["OneAgent disconnected", "Synthetic monitor failed", "Metric collection lost"],
};

let simUidSeed = 0;

// Builds a 16-char hex string from the uid so synthetic entity IDs
// visually match the real Dynatrace `<TYPE>-<HEX16>` shape.
function hex16(uid: number): string {
  const base = (uid * 0x9E3779B1) >>> 0;
  const hi   = base.toString(16).toUpperCase().padStart(8, "0");
  const lo   = ((base ^ 0x12345678) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return (hi + lo).slice(0, 16);
}

interface BuildOptions {
  rootCauseId?: string;
  startTsOverride?: number;
}

function makeSimProblem(
  cat: Cat,
  start: string,
  status: "ACTIVE" | "CLOSED",
  end?: string,
  opts: BuildOptions = {},
): Problem {
  const uid = ++simUidSeed;
  const entityCount = 1 + (uid % 5);
  const names = SIM_NAMES[cat];
  const name  = names[uid % names.length];
  const severity = SEVERITY_BY_CATEGORY[cat];

  const types = ENTITY_TYPES_BY_CAT[cat];
  const affected_entity_ids = Array.from({ length: entityCount }, (_, i) => {
    const t = types[(uid + i) % types.length];
    return `${t}-${hex16(uid * 31 + i)}`;
  });
  const rootType = (types[0] === "APPLICATION" || types[0] === "WEB_APPLICATION" || types[0] === "MOBILE_APPLICATION")
    ? "SERVICE"
    : types[0];
  const root_cause_entity_id = opts.rootCauseId || `${rootType}-${hex16(uid * 17)}`;

  return {
    davis_problem_id: `${1_000_000_000_000_000 + uid}_${1_779_000_000_000 + uid * 60_000}V1`,
    "event.name":     name,
    "event.status":   status,
    "event.category": cat as Problem["event.category"],
    "event.start":    start,
    "event.end":      end,
    "event.severity": severity,
    affected_entity_ids,
    root_cause_entity_id,
    display_id:       `SIM-${String(uid).padStart(4, "0")}`,
  };
}

// ── Timestamp pickers ────────────────────────────────────────────
// Names map 1-to-1 to the constellation's bubble classification
// (cellSubsetBubbles in ConstellationView).
function tsRising(now: number): number {
  // 1–55 min ago → falls inside Rising window (<1 h).
  return now - (1 + Math.random() * 54) * 60_000;
}
function tsStuck(now: number): number {
  // 1–8 h ago → past Rising, recent enough to dominate the list.
  return now - (1 + Math.random() * 7) * 3600_000;
}
function tsAncient(now: number): number {
  // 8 h–7 d ago → very old actives (test long-duration UI).
  return now - (8 + Math.random() * 160) * 3600_000;
}
function tsClosedRecent(now: number): { start: number; end: number } {
  // Closed in the last 55 min → drives the RESOLVED ring's +N /1h.
  const end = now - Math.random() * 55 * 60_000;
  const start = end - (1 + Math.random() * 8) * 3600_000;
  return { start, end };
}
function tsClosedHistorical(now: number): { start: number; end: number } {
  // Closed > 1 h ago — RESOLVED total, no /1h delta.
  const end = now - (1 + Math.random() * 20) * 3600_000;
  const start = end - (1 + Math.random() * 12) * 3600_000;
  return { start, end };
}

// ── Bulk helpers ─────────────────────────────────────────────────
function pushActive(
  out: Problem[], cat: Cat, n: number,
  tsFn: (now: number) => number, now: number,
) {
  for (let i = 0; i < n; i++) {
    const ts = tsFn(now);
    out.push(makeSimProblem(cat, new Date(ts).toISOString(), "ACTIVE"));
  }
}
function pushClosed(out: Problem[], cat: Cat, n: number, recent: boolean, now: number) {
  for (let i = 0; i < n; i++) {
    const { start, end } = recent ? tsClosedRecent(now) : tsClosedHistorical(now);
    out.push(makeSimProblem(
      cat, new Date(start).toISOString(), "CLOSED", new Date(end).toISOString(),
    ));
  }
}

// ── Size config + builder ────────────────────────────────────────
interface SizeConfig {
  /** Active problems per category. */
  active: Record<Cat, number>;
  /** Fraction of active that should be Rising (<1 h). Rest are Stuck. */
  risingPct: number;
  /** Closed problems per category. */
  closed: Record<Cat, number>;
  /** Fraction of closed with end<1h ago (feeds RESOLVED +N /1h). */
  recentClosedPct: number;
}

function buildSized(config: SizeConfig, now: number): Problem[] {
  const out: Problem[] = [];
  for (const cat of SIM_CATEGORIES) {
    const a  = config.active[cat] || 0;
    const c  = config.closed[cat] || 0;
    const r  = Math.round(a * config.risingPct);
    const s  = a - r;
    const rc = Math.round(c * config.recentClosedPct);
    const hc = c - rc;
    pushActive(out, cat, r, tsRising, now);
    pushActive(out, cat, s, tsStuck,  now);
    pushClosed(out, cat, rc, true,  now);
    pushClosed(out, cat, hc, false, now);
  }
  return out;
}

// ── Size configs ─────────────────────────────────────────────────
// Distribution mirrors real-world weight: ERROR dominates (~30-40 %),
// AVAILABILITY is scarce (~5-10 %), the rest fall in between. The
// shape is preserved across all sizes — only magnitudes scale.
const SMALL: SizeConfig = {
  active:  { AVAILABILITY: 1, ERROR: 4, SLOWDOWN: 3, RESOURCE_CONTENTION: 2, CUSTOM_ALERT: 2, MONITORING_UNAVAILABLE: 1 },
  closed:  { AVAILABILITY: 3, ERROR: 8, SLOWDOWN: 6, RESOURCE_CONTENTION: 4, CUSTOM_ALERT: 3, MONITORING_UNAVAILABLE: 2 },
  risingPct: 0.20,
  recentClosedPct: 0.35,
};
const MEDIUM: SizeConfig = {
  active:  { AVAILABILITY: 8,  ERROR: 35,  SLOWDOWN: 20, RESOURCE_CONTENTION: 15, CUSTOM_ALERT: 8,  MONITORING_UNAVAILABLE: 4  },
  closed:  { AVAILABILITY: 15, ERROR: 60,  SLOWDOWN: 40, RESOURCE_CONTENTION: 30, CUSTOM_ALERT: 15, MONITORING_UNAVAILABLE: 10 },
  risingPct: 0.25,
  recentClosedPct: 0.30,
};
const LARGE: SizeConfig = {
  active:  { AVAILABILITY: 50, ERROR: 250, SLOWDOWN: 100, RESOURCE_CONTENTION: 80,  CUSTOM_ALERT: 40, MONITORING_UNAVAILABLE: 30 },
  closed:  { AVAILABILITY: 80, ERROR: 400, SLOWDOWN: 180, RESOURCE_CONTENTION: 150, CUSTOM_ALERT: 80, MONITORING_UNAVAILABLE: 60 },
  risingPct: 0.30,
  recentClosedPct: 0.25,
};
// >3000 active per category. ~22 k active total, ~53 k overall.
const XLARGE: SizeConfig = {
  active:  { AVAILABILITY: 3200, ERROR: 5500, SLOWDOWN: 3800, RESOURCE_CONTENTION: 3500, CUSTOM_ALERT: 3100, MONITORING_UNAVAILABLE: 3000 },
  closed:  { AVAILABILITY: 4500, ERROR: 8000, SLOWDOWN: 5500, RESOURCE_CONTENTION: 4800, CUSTOM_ALERT: 4200, MONITORING_UNAVAILABLE: 4000 },
  risingPct: 0.18,
  recentClosedPct: 0.15,
};

// ── Scenarios ────────────────────────────────────────────────────
export function getSimulatedProblems(scenario: Scenario, real: Problem[]): Problem[] {
  if (scenario === "real") return real;
  const segBase = SEGMENT_SCENARIO_BASE[scenario as SegmentScenario];
  if (segBase) return getSimulatedProblems(segBase, real);
  if (isMttaScenario(scenario)) return buildMttaProblems(scenario);

  simUidSeed = 0;
  const now = Date.now();

  switch (scenario) {
    case "quiet": {
      // 3 active total — exercise empty-cell / single-leader path.
      const out: Problem[] = [];
      pushActive(out, "ERROR",        2, tsStuck, now);
      pushActive(out, "AVAILABILITY", 1, tsStuck, now);
      pushClosed(out, "ERROR",    3, false, now);
      pushClosed(out, "SLOWDOWN", 2, false, now);
      return out;
    }
    case "small":  return buildSized(SMALL,  now);
    case "medium": return buildSized(MEDIUM, now);
    case "large":  return buildSized(LARGE,  now);
    case "xlarge": return buildSized(XLARGE, now);

    case "all-rising": {
      // Every active opened in the last hour — Rising bubble lights
      // up in every cell, Stuck stays empty.
      const out: Problem[] = [];
      for (const cat of SIM_CATEGORIES) {
        pushActive(out, cat, 10, tsRising, now);
        pushClosed(out, cat, 6,  false,    now);
      }
      return out;
    }
    case "all-stuck": {
      // Every active > 4 h old — Stuck bubble lit, no Rising.
      const out: Problem[] = [];
      for (const cat of SIM_CATEGORIES) {
        pushActive(out, cat, 8, tsAncient, now);
        pushClosed(out, cat, 4, false,     now);
      }
      return out;
    }
    case "time-cluster": {
      // 8 actives all started within the same 1-minute window 3 min
      // ago. Tests bar drill-down — clicking the histogram bar
      // filters the list to this exact second-precision cluster.
      const out: Problem[] = [];
      const clusterTs = now - 3 * 60_000;
      for (let i = 0; i < 8; i++) {
        const cat = SIM_CATEGORIES[i % SIM_CATEGORIES.length];
        out.push(makeSimProblem(
          cat, new Date(clusterTs + i * 5_000).toISOString(), "ACTIVE",
        ));
      }
      // Baseline so the cluster bar visibly spikes against history.
      for (const cat of SIM_CATEGORIES) {
        pushActive(out, cat, 2, tsStuck, now);
        pushClosed(out, cat, 4, false,   now);
      }
      return out;
    }
    case "single-leader": {
      // ERROR ≫ everything — exercises the Total-leader frame on a
      // single cell. Other categories have 1-3 active so the leader
      // stands out clearly.
      const out: Problem[] = [];
      pushActive(out, "ERROR", 60,  tsRising, now);
      pushActive(out, "ERROR", 140, tsStuck,  now);
      pushClosed(out, "ERROR", 80, false, now);
      for (const cat of SIM_CATEGORIES) {
        if (cat === "ERROR") continue;
        pushActive(out, cat, 2, tsStuck, now);
        pushClosed(out, cat, 3, false,   now);
      }
      return out;
    }
    case "tied-leaders": {
      // AVAILABILITY + ERROR both at exactly 30 active — both cells
      // get the Total-leader frame, validating tie-handling.
      const out: Problem[] = [];
      pushActive(out, "AVAILABILITY", 6,  tsRising, now);
      pushActive(out, "AVAILABILITY", 24, tsStuck,  now);
      pushActive(out, "ERROR",        6,  tsRising, now);
      pushActive(out, "ERROR",        24, tsStuck,  now);
      pushActive(out, "SLOWDOWN",     8,  tsStuck,  now);
      pushActive(out, "RESOURCE_CONTENTION", 5, tsStuck, now);
      pushActive(out, "CUSTOM_ALERT", 3,  tsStuck,  now);
      pushActive(out, "MONITORING_UNAVAILABLE", 2, tsStuck, now);
      for (const cat of SIM_CATEGORIES) pushClosed(out, cat, 6, false, now);
      return out;
    }
    case "wave-resolved": {
      // 80 % of all problems closed in the last hour — RESOLVED hub
      // ring gets a fat ▲ +N /1h delta. Few actives so the contrast
      // reads clearly.
      const out: Problem[] = [];
      for (const cat of SIM_CATEGORIES) {
        pushActive(out, cat, 3,  tsStuck, now);
        pushClosed(out, cat, 30, true,    now);  // recent (<1 h)
        pushClosed(out, cat, 8,  false,   now);  // historical
      }
      return out;
    }
  }

  return [];
}

// ────────────────────────────────────────────────────────────────────
// Segment-page test scenarios
// ────────────────────────────────────────────────────────────────────
// The /segments page reads two extra streams the rest of the app
// doesn't: a catalog of filter segments and a membership map (problem
// display_id → segment uids it belongs to).
//
// `getSimulatedFilterSegments(s)` and
// `getSimulatedSegmentMembership(s, problems)` return `null` for
// non-segment scenarios — `Overview.tsx` reads that as "use real
// segment data".

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

// Each segment scenario reuses one of the size scenarios as its
// underlying problem set; segment membership is painted on top.
// 0.0.117 — the legacy `stress` / `all-rising` bases were removed
// with the rewrite; map to the closest replacement.
const SEGMENT_SCENARIO_BASE: Record<SegmentScenario, Scenario> = {
  "seg-empty":      "medium",
  "seg-few":        "medium",
  "seg-overflow":   "large",
  "seg-unassigned": "medium",
  "seg-multi":      "medium",
  "seg-imbalanced": "medium",
};

interface SimSeg { uid: string; name: string; }
function makeSeg(name: string): SimSeg {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { uid: `sim-seg-${slug}`, name };
}

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

function assignSegments(scenario: SegmentScenario, i: number, segUids: string[]): string[] {
  if (segUids.length === 0) return [];
  switch (scenario) {
    case "seg-empty":      return [];
    case "seg-few":        return [segUids[i % segUids.length]];
    case "seg-overflow":
      if (i % 5 < 3) return [segUids[i % 6]];
      return [segUids[6 + (i % (segUids.length - 6))]];
    case "seg-unassigned":
      if (i % 5 === 0) return [];
      return [segUids[i % segUids.length]];
    case "seg-multi": {
      if (i % 10 < 3) {
        const a = i % segUids.length;
        const b = (i + 1) % segUids.length;
        return a === b ? [segUids[a]] : [segUids[a], segUids[b]];
      }
      return [segUids[i % segUids.length]];
    }
    case "seg-imbalanced":
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
// Two halves: a problems list spread over the last 14 days so the
// MTTA evolution chart has range, plus a synthetic first-comment
// map so `useTeamMetrics` short-circuits its DQL call.

export type MttaScenario =
  | "mtta-fast" | "mtta-slow" | "mtta-mixed"
  | "mtta-degrading" | "mtta-spotty";

export function isMttaScenario(s: Scenario): s is MttaScenario {
  return s.startsWith("mtta-");
}

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

function det(seed: number): number {
  return (((seed * 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
}

function mttaDelayMs(seed: number, medianMs: number, spread: number): number {
  const r = det(seed) - 0.5;
  const ms = medianMs * Math.pow(2, spread * r * 6);
  return Math.max(30_000, Math.min(14 * 86_400_000, Math.floor(ms)));
}

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
    const start = new Date(now - (FOURTEEN_DAYS_MS - ageMs)).toISOString();
    const isActive = scenario === "mtta-spotty" && i % 4 === 0;
    const end = isActive
      ? undefined
      : new Date(now - (FOURTEEN_DAYS_MS - ageMs) + 60 * 60_000).toISOString();
    out.push(makeSimProblem(cat, start, isActive ? "ACTIVE" : "CLOSED", end));
  }
  return out;
}

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
  at: string;
  text: string;
  authorName: string;
  authorId: string;
}
export interface SimAutomation {
  at: string;
  title: string;
  state: "SUCCESS" | "ERROR" | "CANCELLED";
  type: string;
  executionId: string;
}
export interface SimulatedProblemTimeline {
  comments:    SimComment[];
  automations: SimAutomation[];
}

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

    const firstAt = mttaMap?.get(pid);
    const comments: SimComment[] = [];
    if (firstAt) {
      const firstMs = new Date(firstAt).getTime();
      const baseCount =
        scenario === "mtta-fast"      ? 1 :
        scenario === "mtta-slow"      ? 3 :
        scenario === "mtta-degrading" ? 2 :
        scenario === "mtta-spotty"    ? 1 :
        2;
      const extra = Math.floor(det(seed * 3) * 2);
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

    const autoCount =
      scenario === "mtta-fast"      ? 1 + Math.floor(det(seed * 13) * 2) :
      scenario === "mtta-slow"      ? Math.floor(det(seed * 13) * 2)     :
      scenario === "mtta-degrading" ? 1 + Math.floor(det(seed * 13) * 3) :
      scenario === "mtta-spotty"    ? Math.floor(det(seed * 13) * 2)     :
      1 + Math.floor(det(seed * 13) * 3);
    const automations: SimAutomation[] = [];
    for (let a = 0; a < autoCount; a++) {
      const tpl = SIM_AUTOMATION_TITLES[(seed * 7 + a) % SIM_AUTOMATION_TITLES.length];
      const state = SIM_AUTOMATION_STATES[(seed * 11 + a) % SIM_AUTOMATION_STATES.length];
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

    const seed = i + 1;
    let delayMs: number | null = null;
    switch (scenario) {
      case "mtta-fast":
        delayMs = mttaDelayMs(seed, 5 * 60_000, 0.45);
        break;
      case "mtta-slow":
        delayMs = mttaDelayMs(seed, 4 * 3600_000, 0.55);
        break;
      case "mtta-mixed":
        if (i % 10 === 0) { delayMs = null; break; }
        delayMs = mttaDelayMs(seed, 30 * 60_000, 0.65);
        break;
      case "mtta-degrading": {
        const t = i / Math.max(1, problems.length - 1);
        const base = 5 * 60_000 + t * (8 * 3600_000 - 5 * 60_000);
        delayMs = Math.max(60_000, Math.floor(base * (0.85 + det(seed) * 0.30)));
        break;
      }
      case "mtta-spotty":
        if (det(seed * 7) > 0.40) { delayMs = null; break; }
        delayMs = mttaDelayMs(seed, 90 * 60_000, 0.75);
        break;
    }
    if (delayMs === null) continue;
    m.set(pid, new Date(start + delayMs).toISOString());
  }
  return m;
}
