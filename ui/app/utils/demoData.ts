// Demo-mode synthetic dataset.
//
// Why this exists:
//   • Lets us drive the full app UX (constellation cells, modal,
//     trend chart, list, leader frames) WITHOUT hitting Grail —
//     useful for screenshots, walkthroughs, and offline review.
//   • Activated by the URL param `?demo=1` (see DemoModeContext).
//     No persistence, no toggle in prod views by default.
//
// Anti-drift contract (the reason v0.0.159 removed the old demo
// infra — see commit 510764c):
//   • This module is the ONLY synthetic-data source. Every hook
//     reads from `getDemo*()` here; nothing computes "demo numbers"
//     inline at component level.
//   • The dataset is a single `Problem[]` array. Every count
//     (`ACTIVE`, `STUCK`, `OLDER`, trend buckets, focused fetches)
//     is DERIVED from that one array using the same thresholds the
//     real DQL applies (1 h Rising, 4 h Stuck). So the "sample" and
//     "count query" paths cannot disagree in demo mode.
//
// Timestamps are anchored to `Date.now()` (bucketed to the minute
// for render stability). As wall-clock time advances, problems
// naturally age into Stuck or out of Rising — exercising the time
// windows authentically.

import type { Problem } from "../hooks/useProblems";

// ── Categories (mirrors ALLOWED_CATEGORIES in dql-queries.ts) ──
const CATS = [
  "AVAILABILITY",
  "ERROR",
  "SLOWDOWN",
  "RESOURCE_CONTENTION",
  "CUSTOM_ALERT",
  "MONITORING_UNAVAILABLE",
] as const;

type Cat = typeof CATS[number];

// Per-category distribution — designed so each constellation mode
// has a clear leader, exercising the leader-frame highlight in all
// three views:
//   • Stuck leader:  AVAILABILITY (5)
//   • Rising leader: RESOURCE_CONTENTION (5)
//   • Total leader:  ERROR (42 total)
//   • Calm cell:     MONITORING_UNAVAILABLE (0 active)
//
// Active = rising + gap + stuck per category. The "gap" cohort is
// 1 h–4 h old — not labelled but visually present, so the user can
// see why `active != stuck + rising`.
interface Spec {
  rising: number; // event.start in the last 1 h
  gap:    number; // event.start in the 1 h–4 h window
  stuck:  number; // event.start older than 4 h
  closed: number; // status = CLOSED somewhere in the last 7 d
}

const SPEC: Record<Cat, Spec> = {
  AVAILABILITY:           { rising: 1, gap: 0, stuck: 5, closed: 5 },
  ERROR:                  { rising: 3, gap: 2, stuck: 7, closed: 30 },
  SLOWDOWN:               { rising: 1, gap: 1, stuck: 2, closed: 8 },
  RESOURCE_CONTENTION:    { rising: 5, gap: 0, stuck: 0, closed: 4 },
  CUSTOM_ALERT:           { rising: 0, gap: 0, stuck: 2, closed: 2 },
  MONITORING_UNAVAILABLE: { rising: 0, gap: 0, stuck: 0, closed: 1 },
};

// Severity by category — mirrors the convention in production data
// (AVAILABILITY/MONITORING_UNAVAILABLE = Sev 1, ERROR = Sev 2,
// SLOWDOWN/RC/CUSTOM_ALERT = Sev 3).
const SEV_BY_CAT: Record<Cat, string> = {
  AVAILABILITY:           "1",
  MONITORING_UNAVAILABLE: "1",
  ERROR:                  "2",
  SLOWDOWN:               "3",
  RESOURCE_CONTENTION:    "3",
  CUSTOM_ALERT:           "3",
};

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

// Bin "now" to the nearest minute so the dataset stays stable
// within a render window (multiple hooks calling `getDemoProblems`
// in the same React commit get identical arrays — no jitter).
function nowBin(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}

// Single cache slot keyed by minute. As wall-clock crosses a minute
// boundary the next call regenerates — the Rising cohort then slides
// forward as real-time advances.
let cached: { ts: number; data: Problem[] } | null = null;

/** Returns the FULL demo dataset (~79 problems). All other
 *  `getDemo*` helpers derive from this. Stable for one minute. */
export function getDemoProblems(): Problem[] {
  const now = nowBin();
  if (cached && cached.ts === now) return cached.data;

  const out: Problem[] = [];
  let seq = 1000;

  for (const cat of CATS) {
    const spec = SPEC[cat];

    // Rising cohort — event.start in the last 1 h, spread across
    // the window so they don't all stack at the same age. Newest
    // first (so a sort-by-start matches modal canvas order).
    for (let i = 0; i < spec.rising; i++) {
      const ageMin = 3 + Math.floor((54 / Math.max(1, spec.rising)) * i);
      out.push(mkProblem({
        id: seq++, cat,
        startMs: now - ageMin * 60_000,
        endMs:   null,
      }));
    }

    // 1 h–4 h gap — active, not Rising, not Stuck. Visible in the
    // canvas but unlabelled. Explains why `active - stuck > rising`.
    for (let i = 0; i < spec.gap; i++) {
      const ageMs = HOUR + (3 * HOUR / Math.max(1, spec.gap)) * (i + 0.5);
      out.push(mkProblem({
        id: seq++, cat,
        startMs: now - ageMs,
        endMs:   null,
      }));
    }

    // Stuck cohort — older than 4 h, still active. Ages spread from
    // 5 h to ~3 d so the trend chart shows them stretching across
    // many buckets (spread: timeframe semantic).
    for (let i = 0; i < spec.stuck; i++) {
      const ageHours = 5 + Math.floor((65 / Math.max(1, spec.stuck)) * i);
      out.push(mkProblem({
        id: seq++, cat,
        startMs: now - ageHours * HOUR,
        endMs:   null,
      }));
    }

    // Closed cohort — random spread over the last 7 days with
    // varied durations (5 min to 3 h). Drives the RESOLVED ring +
    // the CLOSED series in the trend chart.
    for (let i = 0; i < spec.closed; i++) {
      const startHoursAgo = 1 + Math.floor((7 * 24 / Math.max(1, spec.closed)) * i);
      const durationMin   = 5 + ((i * 17) % 180);
      const startMs = now - startHoursAgo * HOUR;
      const endMs   = startMs + durationMin * 60_000;
      out.push(mkProblem({
        id: seq++, cat,
        startMs, endMs,
      }));
    }
  }

  cached = { ts: now, data: out };
  return out;
}

interface MkInput {
  id: number;
  cat: Cat;
  startMs: number;
  endMs: number | null;
}

function mkProblem(input: MkInput): Problem {
  const isActive = input.endMs === null;
  // Reuse a small entity pool so the affected-entity list reads
  // like a small service mesh, not 79 unique random IDs.
  const idx = (input.id % 12) + 1;
  const entityId   = `SERVICE-DEMO-${idx.toString().padStart(2, "0")}`;
  const entityName = `demo-service-${idx}`;
  return {
    davis_problem_id: `DEMO_${input.id}_${input.startMs}`,
    "event.name":     `Demo ${input.cat.replace(/_/g, " ").toLowerCase()} on ${entityName}`,
    "event.status":   isActive ? "ACTIVE" : "CLOSED",
    "event.category": input.cat,
    "event.start":    new Date(input.startMs).toISOString(),
    "event.end":      input.endMs !== null ? new Date(input.endMs).toISOString() : undefined,
    "event.severity": SEV_BY_CAT[input.cat],
    affected_entity_ids:   [entityId],
    affected_entity_names: [entityName],
    affected_entity_types: ["SERVICE"],
    root_cause_entity_id:   entityId,
    root_cause_entity_name: entityName,
    display_id: `P-DEMO-${input.id}`,
  } as Problem;
}

// ─────────────────────────────────────────────────────────────────
//  Derived views — each replicates ONE hook's output shape.
//  All derive from `getDemoProblems()` so counts cannot drift.
// ─────────────────────────────────────────────────────────────────

/** Filter problems by the same filter set `useProblems` accepts.
 *  Mirrors the WHERE clauses in `buildFilteredQuery`. */
export function getDemoFilteredProblems(filters: {
  status?: string;
  category?: string;
  categories?: string[];
  timeframe?: string;
  from?: string;
  to?: string;
}, limit: number): Problem[] {
  let arr = getDemoProblems();
  if (filters.status === "ACTIVE" || filters.status === "CLOSED") {
    arr = arr.filter((p) => p["event.status"] === filters.status);
  }
  if (filters.category) {
    arr = arr.filter((p) => p["event.category"] === filters.category);
  }
  if (filters.categories && filters.categories.length > 0) {
    const set = new Set(filters.categories);
    arr = arr.filter((p) => set.has(p["event.category"]));
  }
  // Timeframe — restrict to problems whose event.start falls inside
  // the window. Matches the DQL convention (problems are anchored
  // to start, not to overlap, in the list query).
  const { from, to } = resolveTimeframe(filters.timeframe, filters.from, filters.to);
  arr = arr.filter((p) => {
    const t = new Date(p["event.start"]).getTime();
    return t >= from && t <= to;
  });
  // Newest first by start, ACTIVE before CLOSED on ties (matches
  // the dedup sort in dql-queries.ts post-v0.0.166).
  arr = [...arr].sort((a, b) => {
    const da = new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime();
    if (da !== 0) return da;
    if (a["event.status"] !== b["event.status"]) {
      return a["event.status"] === "ACTIVE" ? -1 : 1;
    }
    return 0;
  });
  return arr.slice(0, limit);
}

/** Mirrors `useStatusCategoryCounts`'s shape (counts + totals).
 *  Honours the same 4 h Stuck / 1 h OLDER cutoffs. */
export function getDemoStatusCategoryCounts(filters: {
  timeframe?: string;
  from?: string;
  to?: string;
}) {
  const { from, to } = resolveTimeframe(filters.timeframe, filters.from, filters.to);
  const now = nowBin();
  const stuckCut = now - 4 * HOUR;
  const olderCut = now - 1 * HOUR;

  const ACTIVE: Record<string, number> = {};
  const CLOSED: Record<string, number> = {};
  const STUCK:  Record<string, number> = {};
  const OLDER:  Record<string, number> = {};
  // 0.0.185 — count ACTIVE problems started in the last 1 h.
  const NEWLY_STARTED: Record<string, number> = {};

  for (const p of getDemoProblems()) {
    const cat = p["event.category"];
    const startMs = new Date(p["event.start"]).getTime();
    // Restrict to the user's timeframe (anchor on start, same as
    // the list query).
    if (startMs < from || startMs > to) continue;

    if (p["event.status"] === "ACTIVE") {
      ACTIVE[cat] = (ACTIVE[cat] || 0) + 1;
      if (startMs < stuckCut) STUCK[cat] = (STUCK[cat] || 0) + 1;
      // OLDER = problems alive 1 h ago. ACTIVE & start ≤ now-1h
      // satisfies that.
      if (startMs <= olderCut) OLDER[cat] = (OLDER[cat] || 0) + 1;
      // NEWLY_STARTED = ACTIVE & start within last 1 h. Mirrors
      // the new `newly_started_1h` DQL field.
      if (startMs > olderCut) NEWLY_STARTED[cat] = (NEWLY_STARTED[cat] || 0) + 1;
    } else {
      CLOSED[cat] = (CLOSED[cat] || 0) + 1;
      // OLDER also includes problems that were ACTIVE 1 h ago but
      // have since closed (end > now-1h). Matches the DQL
      // was_active_1h_ago predicate.
      const endMs = p["event.end"] ? new Date(p["event.end"]).getTime() : now;
      if (startMs <= olderCut && endMs > olderCut) {
        OLDER[cat] = (OLDER[cat] || 0) + 1;
      }
    }
  }

  const active = Object.values(ACTIVE).reduce((a, b) => a + b, 0);
  const closed = Object.values(CLOSED).reduce((a, b) => a + b, 0);
  const stuck  = Object.values(STUCK).reduce((a, b) => a + b, 0);
  return {
    counts: { ACTIVE, CLOSED, STUCK, OLDER, NEWLY_STARTED },
    totals: { active, closed, stuck, total: active + closed },
  };
}

/** Mirrors `useProblemTrend`'s output (Strato `TimeserieBucket[]`).
 *  Replicates the DQL `spread: timeframe(event.start, ... event.end)`
 *  by counting each problem in every bucket it overlaps. */
export function getDemoTrend(timeframe: string, status?: string) {
  const { from, to } = resolveTimeframe(timeframe);
  const BINS = 20;
  const step = (to - from) / BINS;
  const probs = status
    ? getDemoProblems().filter((p) => p["event.status"] === status)
    : getDemoProblems();
  const out: { timestamp: number; values: Record<string, number> }[] = [];
  for (let i = 0; i < BINS; i++) {
    const t0 = from + i * step;
    const t1 = t0 + step;
    const values: Record<string, number> = {};
    for (const p of probs) {
      const ps = new Date(p["event.start"]).getTime();
      const pe = p["event.end"] ? new Date(p["event.end"]).getTime() : Date.now();
      if (ps <= t1 && pe >= t0) {
        const cat = p["event.category"];
        values[cat] = (values[cat] || 0) + 1;
      }
    }
    out.push({ timestamp: t0, values });
  }
  return out;
}

/** Mirrors `useStuckProblemsByCategory` — ACTIVE in `cat`,
 *  `event.start < now - 4h`, ordered by start ASC (oldest first). */
export function getDemoStuckByCategory(category: string, limit: number): Problem[] {
  const now = nowBin();
  const cut = now - 4 * HOUR;
  return getDemoProblems()
    .filter((p) =>
      p["event.category"] === category &&
      p["event.status"]   === "ACTIVE" &&
      new Date(p["event.start"]).getTime() < cut,
    )
    .sort((a, b) => new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime())
    .slice(0, limit);
}

/** Mirrors `useRisingProblemsByCategory` — ACTIVE in `cat`,
 *  `event.start >= now - 1h`, newest first. */
export function getDemoRisingByCategory(category: string, limit: number): Problem[] {
  const now = nowBin();
  const cut = now - 1 * HOUR;
  return getDemoProblems()
    .filter((p) =>
      p["event.category"] === category &&
      p["event.status"]   === "ACTIVE" &&
      new Date(p["event.start"]).getTime() >= cut,
    )
    .sort((a, b) => new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime())
    .slice(0, limit);
}

/** Resolve a `timeframe` / `from` / `to` triple to a numeric window.
 *  Accepts the same Strato preset shapes the real parser does
 *  ("now()-7d", "now()-24h", "now()-1h", bare "-7d", absolute ISO
 *  in `from`/`to`). Falls back to last 7 d if unrecognised — same
 *  defence-in-depth the real builders apply. */
function resolveTimeframe(timeframe?: string, from?: string, to?: string): { from: number; to: number } {
  const now = Date.now();
  if (from && to) {
    return { from: Date.parse(from), to: Date.parse(to) };
  }
  if (timeframe) {
    const m = timeframe.match(/^(?:now\(\)-?)?-?(\d+)([mhdw])$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      const u = m[2].toLowerCase();
      const ms = u === "m" ? n * 60_000
               : u === "h" ? n * HOUR
               : u === "d" ? n * DAY
               :             n * 7 * DAY;
      return { from: now - ms, to: now };
    }
  }
  return { from: now - 7 * DAY, to: now };
}
