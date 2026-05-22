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
