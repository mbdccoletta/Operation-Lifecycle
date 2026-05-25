// Pure-function helpers extracted out of `useTeamMetrics.ts` so
// they're independently testable. No React imports — these are
// just math + bucket algebra, exercised heavily on every refresh.
//
// Anything in this file SHOULD have a corresponding test in
// `useTeamMetrics.helpers.test.ts`. The reverse isn't true:
// React-bound logic (the hook itself, useMemo/useState wiring)
// is intentionally NOT under test here — it'll get its own
// integration spec once we have @testing-library/react wired.

import type { BucketStat, PerMetricStats } from "./useTeamMetrics";

const DAY_MS = 24 * 60 * 60_000;

/** Linear-interpolated percentile over a PRE-SORTED ascending
 *  array. Caller is responsible for sorting; this keeps the
 *  function pure and lets the same sorted array be reused for
 *  multiple percentile queries without paying for re-sort. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Maps a visible time window (range in ms) to a bucket granularity.
 *  Targets ~8-30 buckets across the chart regardless of zoom level
 *  so a 6h window doesn't collapse to a single bar and a 90d
 *  window doesn't render 2 000 of them. */
export function pickBucketMs(rangeMs: number): number {
  const HOUR_MS = 60 * 60 * 1000;
  if (rangeMs <=  4 * HOUR_MS) return 15 * 60 * 1000;  // 15 min
  if (rangeMs <= 12 * HOUR_MS) return 30 * 60 * 1000;  // 30 min
  if (rangeMs <= 24 * HOUR_MS) return HOUR_MS;          // 1 hour
  if (rangeMs <=  3 * DAY_MS)  return 4 * HOUR_MS;      // 4 hours
  if (rangeMs <= 14 * DAY_MS)  return DAY_MS;           // 1 day
  if (rangeMs <= 60 * DAY_MS)  return 3 * DAY_MS;       // 3 days
  return 7 * DAY_MS;                                    // 1 week
}

/** Anchors a timestamp to the start of its bucket. Used to group
 *  events under identical bucket keys. */
export function floorToBucket(ms: number, bucketMs: number): number {
  return Math.floor(ms / bucketMs) * bucketMs;
}

/** Aggregates an array of (timestamp, value) pairs into a contiguous
 *  bucket series over [windowStartMs, windowEndMs]. Empty buckets
 *  appear as zero-count placeholders so the chart can render a
 *  smooth axis without holes. */
export function aggregateSeries(
  pairs: Array<{ ms: number; valueMs: number }>,
  bucketMs: number,
  windowStartMs: number,
  windowEndMs: number,
): BucketStat[] {
  const groups = new Map<number, number[]>();
  for (const p of pairs) {
    if (p.ms < windowStartMs || p.ms > windowEndMs) continue;
    const b = floorToBucket(p.ms, bucketMs);
    const arr = groups.get(b) || [];
    arr.push(p.valueMs);
    groups.set(b, arr);
  }
  const startB = floorToBucket(windowStartMs, bucketMs);
  const endB   = floorToBucket(windowEndMs, bucketMs);
  const out: BucketStat[] = [];
  for (let b = startB; b <= endB; b += bucketMs) {
    const arr = groups.get(b);
    if (!arr || arr.length === 0) {
      out.push({ startMs: b, count: 0, avgMs: 0, medianMs: 0, p95Ms: 0 });
      continue;
    }
    const asc = [...arr].sort((a, b) => a - b);
    const sum = asc.reduce((acc, v) => acc + v, 0);
    out.push({
      startMs:  b,
      count:    asc.length,
      avgMs:    sum / asc.length,
      medianMs: percentile(asc, 50),
      p95Ms:    percentile(asc, 95),
    });
  }
  return out;
}

/** Compute the MTBF (Mean Time Between Failures) interval pairs from
 *  a set of problems.
 *
 *  Formula (worked example):
 *
 *    Given N problem starts t₁ ≤ t₂ ≤ … ≤ tₙ sorted ascending,
 *    the N-1 intervals are:
 *
 *      I[i] = t[i+1] − t[i],   for i in 1..N-1
 *
 *    MTBF = (Σ I[i]) / (N − 1)
 *
 *    Equivalent telescoping form (sum collapses):
 *
 *      MTBF = (t[N] − t[1]) / (N − 1)
 *
 *  Each output pair anchors the interval to t[i+1] so the bucketing
 *  step in `aggregateSeries` lands the value in the bucket
 *  containing the SECOND problem of the pair (the one whose start
 *  the interval "ended at"). N=0 or N=1 yields an empty array
 *  (`aggregateScalar` will return `count: 0`, `avgMs: null` for
 *  the KPI card display).
 *
 *  The previous problem's status doesn't matter — MTBF measures
 *  the cadence of FAILURES (starts), not resolutions. ACTIVE and
 *  CLOSED problems both contribute. */
export function computeMtbfPairs(
  problems: Array<{ "event.start": string }>,
): Array<{ ms: number; valueMs: number }> {
  const starts = problems
    .map((p) => new Date(p["event.start"]).getTime())
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: Array<{ ms: number; valueMs: number }> = [];
  for (let i = 1; i < starts.length; i++) {
    const interval = starts[i] - starts[i - 1];
    // Defensively skip zero / negative intervals — they shouldn't
    // happen after the ascending sort but two problems can start
    // at the exact same ms (we saw P-26053266/67/68 in real data),
    // in which case the interval is 0 and we drop it so it doesn't
    // pull the average artificially toward zero.
    if (interval > 0) out.push({ ms: starts[i], valueMs: interval });
  }
  return out;
}

/** Compute MTTA (Mean Time To Acknowledge) interval pairs.
 *
 *  Atlassian definition:
 *    MTTA = average time between alert generated and operator
 *           acknowledging it.
 *    https://www.atlassian.com/incident-management/kpis/common-metrics
 *
 *  Davis Problems doesn't expose an explicit "acknowledged at"
 *  timestamp. The closest proxy we have is the FIRST user comment
 *  (CUSTOM_ANNOTATION event) against the problem — the moment an
 *  engineer engaged with the incident in the Problems app stream.
 *
 *    MTTA_i = firstComment[i] − event.start[i]
 *
 *  Problems WITHOUT any comment are silently skipped (yield no pair)
 *  so they don't pollute the average — but they DO reduce the
 *  effective sample size. Auto-resolved incidents that nobody had to
 *  comment on therefore don't appear in the MTTA mean.
 *
 *  `firstCommentByDavisId` maps the long composite `davis_problem_id`
 *  (`event.id` from DQL) to the ISO timestamp of the first comment.
 *  We use the davis id (not display_id) because that's what
 *  CUSTOM_ANNOTATION's `annotation.problem_ids` field carries. */
export function computeMttaPairs(
  problems: Array<{
    davis_problem_id?: string;
    "event.start": string;
  }>,
  firstCommentByDavisId: Map<string, string>,
): Array<{ ms: number; valueMs: number }> {
  const out: Array<{ ms: number; valueMs: number }> = [];
  for (const p of problems) {
    if (!p.davis_problem_id) continue;
    const firstAt = firstCommentByDavisId.get(p.davis_problem_id);
    if (!firstAt) continue;
    const start = new Date(p["event.start"]).getTime();
    const ack   = new Date(firstAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(ack)) continue;
    const v = ack - start;
    // Skip negative values: a comment timestamped BEFORE the problem
    // start is data corruption (clock skew, manual import) — silently
    // drop it rather than show a meaningless negative MTTA.
    if (v < 0) continue;
    out.push({ ms: start, valueMs: v });
  }
  return out;
}

/** Compute MTTR (Mean Time To Repair / Resolve) interval pairs.
 *
 *  Atlassian definition:
 *    MTTR = average wall-clock time from incident detection to
 *           system fully functional. Same as "Mean Time to Resolve"
 *           in most SRE practice; Atlassian's diagram differentiates
 *           "Repair" (repairs begin → fully functional) from
 *           "Resolve" (alert → fully functional) but the industry
 *           uses the terms interchangeably.
 *
 *  We compute:
 *
 *    MTTR_i = event.end[i] − event.start[i]
 *
 *  ONLY for CLOSED problems. ACTIVE problems have no `event.end` so
 *  we can't measure their resolution time — they're excluded entirely
 *  (otherwise they'd contribute partial / open-ended values that
 *  drift the average toward whatever Date.now() happens to be).
 *
 *  Skips zero / negative durations defensively. Same rationale as
 *  the MTBF skip: data anomalies where end < start shouldn't pull
 *  the mean toward zero. */
export function computeMttrPairs(
  problems: Array<{
    "event.start": string;
    "event.end"?: string | null;
    "event.status": string;
  }>,
): Array<{ ms: number; valueMs: number }> {
  const out: Array<{ ms: number; valueMs: number }> = [];
  for (const p of problems) {
    if (p["event.status"] !== "CLOSED") continue;
    const endIso = p["event.end"];
    if (!endIso) continue;
    const start = new Date(p["event.start"]).getTime();
    const end   = new Date(endIso).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const v = end - start;
    if (v <= 0) continue;
    out.push({ ms: start, valueMs: v });
  }
  return out;
}

/** Compute MTTF (Mean Time To Failure / uptime) interval pairs.
 *
 *  Atlassian definition (from the diagram + doc):
 *    MTTF = average operational time between failures. The "system
 *           up" half of the reliability identity:
 *
 *           MTBF  =  MTTR  +  MTTF
 *           (cycle)  (down)  (up)
 *
 *           — per-pair, not per-aggregate. Holds when consecutive
 *           problems are non-overlapping and the previous one closed
 *           before the next one started.
 *
 *  We compute, for each problem after the first, the gap from the
 *  most recent CLOSED end timestamp BEFORE the current problem's
 *  start:
 *
 *    MTTF_i = event.start[i] − max{ event.end[j] : j < i, j CLOSED }
 *
 *  Why the running maximum (rather than just previous-problem end):
 *  Davis problems can overlap. If P1 is still ACTIVE when P2 starts,
 *  P1's end (when it eventually closes) might be LATER than P2's
 *  start — using "previous problem's end" would yield a negative
 *  uptime. We instead track the latest end we've seen so far, and
 *  measure from THAT to the current start. If the current start
 *  predates the running latest-end (concurrent failures), we skip
 *  the pair entirely.
 *
 *  The first problem in the timeline has no MTTF (no previous end
 *  to subtract from) → silently skipped, same as MTBF.
 *
 *  ACTIVE problems contribute their START to the calc (we can
 *  measure MTTF UP TO an active problem), but their unknown END
 *  doesn't advance the running latest-end cursor. */
export function computeMttfPairs(
  problems: Array<{
    "event.start": string;
    "event.end"?: string | null;
  }>,
): Array<{ ms: number; valueMs: number }> {
  const sorted = [...problems].sort(
    (a, b) => new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime(),
  );
  const out: Array<{ ms: number; valueMs: number }> = [];
  let lastEndMs: number | null = null;
  for (const p of sorted) {
    const start = new Date(p["event.start"]).getTime();
    if (!Number.isFinite(start)) continue;
    if (lastEndMs !== null && start > lastEndMs) {
      out.push({ ms: start, valueMs: start - lastEndMs });
    }
    // Advance the latest-end cursor with whichever previous problem
    // closed most recently before the next start.
    const endIso = p["event.end"];
    if (endIso) {
      const end = new Date(endIso).getTime();
      if (Number.isFinite(end) && (lastEndMs === null || end > lastEndMs)) {
        lastEndMs = end;
      }
    }
  }
  return out;
}

/** Scalar aggregate (avg / median / p95 / count) over a flat values
 *  array — the "all problems collapsed into one number" form that
 *  feeds the KPI cards above the chart. */
export function aggregateScalar(values: number[]): Omit<PerMetricStats, "series"> {
  if (values.length === 0) {
    return { avgMs: null, medianMs: null, p95Ms: null, count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    avgMs:    sum / sorted.length,
    medianMs: percentile(sorted, 50),
    p95Ms:    percentile(sorted, 95),
    count:    sorted.length,
  };
}
