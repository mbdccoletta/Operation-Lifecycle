// Team reliability metrics for the Timeline page. Computes all four
// classic SRE KPIs from a single problems list:
//
//   • MTTA — Mean Time To Acknowledge.
//             event.start → first user comment.
//   • MTTR — Mean Time To Repair / Resolve.
//             event.start → event.end (closed problems only).
//   • MTBF — Mean Time Between Failures.
//             For each problem after the first, time since the
//             previous problem's start (anywhere across the tenant).
//             Interval includes both downtime and uptime.
//   • MTTF — Mean Time To Failure (uptime).
//             For each problem after the first, time since the
//             previous CLOSED problem's end. The "operational time"
//             half of the MTBF identity (MTBF ≈ MTTR + MTTF).
//
// One DQL fetch for comments runs in parallel — the rest is pure
// arithmetic against the problems list the caller already has.
//
// Reference: https://www.atlassian.com/incident-management/kpis/common-metrics

import { useCallback, useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import type { Problem } from "./useProblems";
import { useDemoMode } from "../contexts/DemoModeContext";
import {
  aggregateScalar,
  aggregateSeries,
  pickBucketMs,
  computeMttaPairs,
  computeMttrPairs,
  computeMtbfPairs,
  computeMttfPairs,
} from "./useTeamMetrics.helpers";

/** Look-back window for the comments stream. Matches the per-problem
 *  Timeline so a sensible 30d window is the default. */
const COMMENTS_WINDOW = "now() - 30d";

const BAR_FLOOR_MS = 60_000;
const DAY_MS       = 24 * 60 * 60_000;

interface AnnotationCommentRecord {
  "annotation.problem_ids"?: string[] | string | null;
  "event.start"?: string;
}

/** One row per bucket in the evolution chart. `count` is how many
 *  contributing problems the bucket averages over — surfaced so the
 *  chart's count-bars can warn about noisy single-sample buckets. */
export interface BucketStat {
  startMs: number;
  count: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
}

/** Per-metric output. `series` is the per-bucket evolution; the
 *  scalar fields are aggregates over the whole window. */
export interface PerMetricStats {
  avgMs:    number | null;
  medianMs: number | null;
  p95Ms:    number | null;
  count:    number;             // how many problems contributed
  series:   BucketStat[];
}

/** Single problem's contribution to each of the four metrics. Each
 *  value is in milliseconds; `null` means the metric isn't defined
 *  for that problem (e.g. MTTR on an ACTIVE problem, MTBF on the
 *  first problem in the window). */
export interface PerProblemMetrics {
  mttaMs: number | null;
  mttrMs: number | null;
  mtbfMs: number | null;
  mttfMs: number | null;
}

export interface UseTeamMetricsResult {
  mtta: PerMetricStats;
  mttr: PerMetricStats;
  mtbf: PerMetricStats;
  mttf: PerMetricStats;
  /** Per-bucket problem count, sharing the same bucket alignment as
   *  the four metric series. Used by the chart's count-bars. */
  problemCountSeries: BucketStat[];
  /** Per-problem map: davis_problem_id → individual MTTA/MTTR/MTBF/
   *  MTTF values. Powers the chip strip on each ProblemTimelineCard
   *  so users see how a single incident contributed to the tenant-
   *  wide averages. */
  perProblem: Map<string, PerProblemMetrics>;
  totalProblems: number;
  loading: boolean;
  error: Error | null;
  /** Force-refetch the comments stream. The page's main refresh
   *  button calls this alongside `useProblems.refetch()` so MTTA
   *  doesn't lag behind the other three metrics — they all depend
   *  on the problems list and update immediately, but MTTA also
   *  needs the comments DQL which has its own 5-min cache. */
  refetch: () => void;
}

export interface UseTeamMetricsOptions {
  /** Explicit chart-window override in ms. Without this the window
   *  is derived from min/max of `event.start` across the data —
   *  which silently stretches the X-axis way past the user's
   *  timeframe whenever the DQL's "active during" filter returns a
   *  long-running problem that started long ago but is still open.
   *  Hosts that have a clear "this is the timeframe the user picked"
   *  signal (TrendAnalysis: selectedRange || timeframe) should pass
   *  both numbers so the chart matches the user's mental model. */
  windowFromMs?: number;
  windowToMs?:   number;
  /** When `false`, the hook short-circuits and returns an empty
   *  result without firing the comments DQL or running the per-
   *  metric aggregations. Used by callers to defend against
   *  catastrophic input sizes (e.g. >10k problems) where the
   *  aggregate work would block the main thread for seconds.
   *  Default `true` preserves existing behaviour. */
  enabled?: boolean;
}

// Pure helpers (`percentile`, `pickBucketMs`, `floorToBucket`,
// `aggregateSeries`, `aggregateScalar`) live in
// `useTeamMetrics.helpers.ts` so they're independently testable
// without pulling in React. Imported at the top of this file.

// ── Hook ───────────────────────────────────────────────────────────

export function useTeamMetrics(
  problems: Problem[],
  opts: UseTeamMetricsOptions = {},
): UseTeamMetricsResult {
  const { windowFromMs, windowToMs, enabled = true } = opts;

  // When `enabled` is false, the hook short-circuits all expensive
  // work (DQL, aggregations, per-problem joins). The caller still
  // gets back a `UseTeamMetricsResult` with the same shape — just
  // with empty series + null scalars — so callers don't need
  // defensive `?.` chains. Used by Overview to bail out at
  // catastrophic problem counts (>10k) where the 4× sort over the
  // full list blocks the main thread for seconds.
  // Pass through to `useDql` below so even the comments query is
  // skipped when disabled — saves the DPS too.
  const effectivelyEnabled = enabled;

  // Honour the user's active filter segments so the comments stream
  // is scoped to the SAME cohort as the problems list. Without
  // this, MTTA would be averaged over comments on incidents the
  // user can't even see (or doesn't currently care about), and
  // their segment selection wouldn't tighten the team-metrics view.
  const { segments } = useSegments();
  const segmentList = useMemo(() => Array.from(segments || []), [segments]);

  const params = useMemo(() => ({
    query: [
      `fetch dt.davis.events.snapshots, from: ${COMMENTS_WINDOW}`,
      `| filter event.type == "CUSTOM_ANNOTATION"`,
      `      and annotation.source == "Problems App"`,
      `      and isNotNull(annotation.problem_ids)`,
      `      and isNotNull(event.start)`,
      `| sort event.start asc`,
      // 0.0.198 — DPS Tier 5 server-side dedup. The client only
      // needs the EARLIEST comment per problem id to compute
      // MTTA (`firstCommentByPid` below). Doing the dedup
      // server-side cuts payload ~95 % (BWM validation: 30 rows
      // → 15 unique) without changing the result of the loop in
      // `firstCommentByPid` (which already implements
      // first-wins semantics and is idempotent on duplicates).
      // Bytes-scanned is unchanged — Grail still walks the
      // 30 d window — so the DPS line item is steady; the win
      // is in network transfer, JSON parse time, and the JS
      // map size.
      `| dedup annotation.problem_ids, sort: { event.start asc }`,
      `| fields annotation.problem_ids, event.start`,
      `| limit 10000`,
    ].join("\n"),
    requestTimeoutMilliseconds: 30_000,
    filterSegments: segmentList as FilterSegment[],
    dtClientContext: "problems-hub:team-metrics:comments",
  }), [segmentList]);

  // 0.0.198 — DPS Tier 5 demo gate. Empirical measurement on the
  // BWM tenant showed that the comments query was firing in
  // `?demo=1` sessions and consuming on_demand bytes that the
  // synthetic Timeline UI never used. Gating here means demo
  // sessions get `firstCommentByPid = empty map`, the per-row
  // MTTA chips render their "—" fallback (`MetricChip` already
  // handles null), and the page-level KPI cards show the same
  // zeroed state as during cold-start before any data lands.
  const demo = useDemoMode();

  const query = useDql<AnnotationCommentRecord>(params, {
    /* DPS Tier 3 bump — was 300_000 (5 min). Team KPIs
       aggregate over hours/days of data; 10 min cache cuts
       repeat-visit cost in half without affecting accuracy. */
    staleTime: 600_000,
    enabled: effectivelyEnabled && !demo.enabled,
  });

  // First-comment per problem id — drives the MTTA stream.
  const firstCommentByPid = useMemo(() => {
    const map = new Map<string, string>();
    const records = query.data?.records || [];
    for (const r of records) {
      const ts = r["event.start"];
      if (!ts) continue;
      const raw = r["annotation.problem_ids"];
      const ids: string[] = Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string")
        : typeof raw === "string" ? [raw] : [];
      for (const pid of ids) {
        if (!map.has(pid)) map.set(pid, ts);
      }
    }
    return map;
  }, [query.data]);

  // All four metric pair arrays are computed by the pure helpers in
  // `useTeamMetrics.helpers.ts`. Each is independently unit-tested
  // against didactic worked examples + a real-data fixture from the
  // bwm98081 tenant (see `useTeamMetrics.helpers.test.ts`). The
  // helpers also document the exact formula each implements with a
  // reference to the Atlassian SRE KPI definitions.
  const mttaPairs = useMemo(
    () => computeMttaPairs(problems, firstCommentByPid),
    [problems, firstCommentByPid],
  );
  const mttrPairs = useMemo(() => computeMttrPairs(problems), [problems]);
  const mtbfPairs = useMemo(() => computeMtbfPairs(problems), [problems]);
  const mttfPairs = useMemo(() => computeMttfPairs(problems), [problems]);

  // Shared window + bucket size — both derived from the union of
  // problem starts so all four metric series line up exactly on the
  // X-axis. Without this, each metric would pick its own bucket
  // boundaries and the overlaid chart would jitter.
  //
  // EXPLICIT OVERRIDE: when the host passes `windowFromMs` +
  // `windowToMs` (typically derived from the page-level timeframe /
  // selectedRange), use that exact range instead of the data
  // extents. This is the right semantics most of the time — without
  // it the X-axis stretches whenever a long-running problem leaked
  // into the dataset via DQL's "active during" filter, pushing the
  // user's actual timeframe into a tiny sliver of the chart.
  const window = useMemo(() => {
    if (windowFromMs != null && windowToMs != null && windowToMs > windowFromMs) {
      const bucketMs = pickBucketMs(Math.max(BAR_FLOOR_MS, windowToMs - windowFromMs));
      return { minMs: windowFromMs, maxMs: windowToMs, bucketMs };
    }
    // Fallback: single-pass min/max + count over the data extents.
    // Avoids the `Math.min(...arr)` / `Math.max(...arr)` spread
    // (which allocates a fresh args array per call and is ~3× slower
    // on 10k-element arrays — see C4 in the perf audit).
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (let i = 0; i < problems.length; i++) {
      const t = new Date(problems[i]["event.start"]).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
      count++;
    }
    if (count === 0) return null;
    const bucketMs = pickBucketMs(Math.max(BAR_FLOOR_MS, max - min));
    return { minMs: min, maxMs: max, bucketMs };
  }, [problems, windowFromMs, windowToMs]);

  // Per-bucket problem count (independent of metric) — drives the
  // count-bars at the bottom of the chart. One row per problem,
  // bucketed by its `event.start`.
  const problemCountSeries = useMemo<BucketStat[]>(() => {
    if (!window) return [];
    const pairs = problems
      .map((p) => ({ ms: new Date(p["event.start"]).getTime(), valueMs: 1 }))
      .filter((p) => Number.isFinite(p.ms));
    return aggregateSeries(pairs, window.bucketMs, window.minMs, window.maxMs);
  }, [problems, window]);

  const emptyMetric: PerMetricStats = { avgMs: null, medianMs: null, p95Ms: null, count: 0, series: [] };

  const mtta = useMemo<PerMetricStats>(
    () => !window ? emptyMetric : {
      ...aggregateScalar(mttaPairs.map((p) => p.valueMs)),
      series: aggregateSeries(mttaPairs, window.bucketMs, window.minMs, window.maxMs),
    },
    [mttaPairs, window],
  );
  const mttr = useMemo<PerMetricStats>(
    () => !window ? emptyMetric : {
      ...aggregateScalar(mttrPairs.map((p) => p.valueMs)),
      series: aggregateSeries(mttrPairs, window.bucketMs, window.minMs, window.maxMs),
    },
    [mttrPairs, window],
  );
  const mtbf = useMemo<PerMetricStats>(
    () => !window ? emptyMetric : {
      ...aggregateScalar(mtbfPairs.map((p) => p.valueMs)),
      series: aggregateSeries(mtbfPairs, window.bucketMs, window.minMs, window.maxMs),
    },
    [mtbfPairs, window],
  );
  const mttf = useMemo<PerMetricStats>(
    () => !window ? emptyMetric : {
      ...aggregateScalar(mttfPairs.map((p) => p.valueMs)),
      series: aggregateSeries(mttfPairs, window.bucketMs, window.minMs, window.maxMs),
    },
    [mttfPairs, window],
  );

  // ── Per-problem map ──────────────────────────────────────────────
  // Walks the problems list in ascending start order and computes
  // each problem's individual contribution to the four metrics.
  // MTBF/MTTF only have values from the second problem onwards —
  // they describe "what happened BEFORE this incident", so the very
  // first one in the window has no predecessor to compare against.
  const perProblem = useMemo<Map<string, PerProblemMetrics>>(() => {
    const sortedAsc = [...problems].sort(
      (a, b) => new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime(),
    );
    const map = new Map<string, PerProblemMetrics>();
    let prevStartMs: number | null = null;
    let lastClosedEndMs: number | null = null;
    for (const p of sortedAsc) {
      const pid = (p as unknown as { davis_problem_id?: string }).davis_problem_id;
      if (!pid) continue;
      const startMs = new Date(p["event.start"]).getTime();
      if (!Number.isFinite(startMs)) continue;

      // MTTA: open → first user comment.
      let mttaMs: number | null = null;
      const firstAt = firstCommentByPid.get(pid);
      if (firstAt) {
        const ackMs = new Date(firstAt).getTime();
        if (Number.isFinite(ackMs) && ackMs >= startMs) mttaMs = ackMs - startMs;
      }

      // MTTR: open → close.
      let mttrMs: number | null = null;
      if (p["event.status"] === "CLOSED" && p["event.end"]) {
        const endMs = new Date(p["event.end"]).getTime();
        if (Number.isFinite(endMs) && endMs > startMs) mttrMs = endMs - startMs;
      }

      // MTBF: interval since the previous problem's start (any
      // status). Captures cadence of failures regardless of repair.
      let mtbfMs: number | null = null;
      if (prevStartMs !== null && startMs > prevStartMs) {
        mtbfMs = startMs - prevStartMs;
      }

      // MTTF: uptime since the last fully-closed problem's end.
      // Skipped when the previous problem was still ACTIVE (no
      // resolution to measure from).
      let mttfMs: number | null = null;
      if (lastClosedEndMs !== null && startMs > lastClosedEndMs) {
        mttfMs = startMs - lastClosedEndMs;
      }

      map.set(pid, { mttaMs, mttrMs, mtbfMs, mttfMs });

      // Advance cursors for the next iteration.
      prevStartMs = startMs;
      if (p["event.end"]) {
        const endMs = new Date(p["event.end"]).getTime();
        if (Number.isFinite(endMs) && (lastClosedEndMs === null || endMs > lastClosedEndMs)) {
          lastClosedEndMs = endMs;
        }
      }
    }
    return map;
  }, [problems, firstCommentByPid]);

  // Stable refetch identity — without `useCallback` here, a fresh
  // function reference was returned on every render. Page consumers
  // that include `refetch` in their `useEffect` deps (notably the
  // auto-refresh `setInterval` in ProblemTimeline) would tear down +
  // re-create the timer on every render, so the 30s tick never
  // actually fired. Capturing the `forceRefetch` callback (which IS
  // stable from useDql) lets us return a stable wrapper.
  const queryForceRefetch = query.forceRefetch;
  const stableRefetch = useCallback(() => {
    queryForceRefetch();
  }, [queryForceRefetch]);

  // When the caller flipped `enabled: false` (defensive cap on
  // catastrophic problem counts), return the empty-result shape so
  // downstream UI sees null KPIs and renders the "metrics disabled"
  // affordance instead of running aggregations over 50k items.
  if (!effectivelyEnabled) {
    return {
      mtta:  { avgMs: null, medianMs: null, p95Ms: null, count: 0, series: [] },
      mttr:  { avgMs: null, medianMs: null, p95Ms: null, count: 0, series: [] },
      mtbf:  { avgMs: null, medianMs: null, p95Ms: null, count: 0, series: [] },
      mttf:  { avgMs: null, medianMs: null, p95Ms: null, count: 0, series: [] },
      problemCountSeries: [],
      perProblem: new Map(),
      totalProblems: problems.length,
      loading: false,
      error:   null,
      refetch: stableRefetch,
    };
  }

  return {
    mtta,
    mttr,
    mtbf,
    mttf,
    /** Total problems per shared bucket — used by the chart's count
     *  bars. All metric series have the same length and bucket
     *  alignment, so this can be indexed in lock-step. */
    problemCountSeries,
    perProblem,
    totalProblems: problems.length,
    loading: query.isLoading,
    error:   query.error || null,
    // `forceRefetch` bypasses the 5-min cache window.
    refetch: stableRefetch,
  };
}
