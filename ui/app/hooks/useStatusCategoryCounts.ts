// Single-query aggregation that feeds the constellation hub rings
// (TOTAL / ACTIVE / RESOLVED) AND the per-category "Active Problems"
// + "RESOLVED" panels. Replaces the previous list-derived math
// (`problems.length`, `problems.filter(...)`) which broke parity
// with native Davis once `DEFAULT_INITIAL = 250` was applied as
// part of DPS Tier 3.
//
// Why a SEPARATE query from `useCategoryCounts`?
//
// `useCategoryCounts` is single-status (filters by one of ACTIVE /
// CLOSED). The constellation needs BOTH statuses simultaneously,
// AND across-status totals. Calling `useCategoryCounts` twice would
// work but doubles the DQL spend and risks the two responses
// landing on either side of a Davis state-change (e.g. ACTIVE
// snapshot at T0 vs CLOSED snapshot at T+30s → one problem counted
// in both, or in neither). One combined query stays internally
// coherent.
//
// Payload is ≤ 2 × 6 = 12 rows × ~50 bytes — cheaper than the
// chip-badge query (which we keep, because it's the data already
// memoised by the CategoryFilterContext and shared with the strip).
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { useDemoMode } from "../contexts/DemoModeContext";
import { getDemoStatusCategoryCounts } from "../utils/demoData";
import { buildStatusCategoryCountsQuery } from "../utils/dql-queries";

export interface StatusCategoryCountsFilters {
  timeframe?: string;
  from?: string;
  to?: string;
  /** 0.0.148 — ISO timestamp passed through to the query builder.
   *  Lets the host derive Stuck from the user-selected timeframe
   *  instead of the hardcoded `now() - 4h` cutoff. */
  stuckCutoff?: string;
}

interface Row {
  "event.status": string;
  "event.category": string;
  count: number;
  stuck_count?: number; // 0.0.137 — sum of ACTIVE & start < now-4h
  older_count?: number; // 0.0.150 — sum of "was active 1h ago" rows
}

export interface StatusCategoryCounts {
  /** counts.ACTIVE[<category>] = N    — missing categories default to 0. */
  counts: {
    ACTIVE: Record<string, number>;
    CLOSED: Record<string, number>;
    /** 0.0.137 — authoritative count of ACTIVE problems older than
     *  4 h per category. Feeds the constellation Stuck bubble +
     *  modal Stuck pill so they no longer depend on the
     *  first-paint sample (which biases toward newest and
     *  underestimates Stuck for busy cells). */
    STUCK: Record<string, number>;
    /** 0.0.150 — number of problems per category that were alive
     *  1 h ago (ACTIVE now AND started ≥ 1h ago, plus CLOSED
     *  whose end is after the 1h cutoff). Lets the Rising bubble
     *  read `max(0, ACTIVE - OLDER)` from server data instead of
     *  the 250-row sample. */
    OLDER: Record<string, number>;
  };
  /** Aggregate totals derived from the same response so the rings
   *  and the per-category panels can never disagree. */
  totals: {
    active: number;
    closed: number;
    /** 0.0.137 — total Stuck across all categories (active > 4h). */
    stuck: number;
    /** ACTIVE + CLOSED. Matches the native Davis Problems list
     *  header (`N active / M total`). */
    total: number;
  };
  /** `true` until the first response arrives. Callers should fall
   *  back to list-derived math while this is `true` so the rings
   *  don't blip to zero on initial paint. */
  loading: boolean;
  error: Error | null;
}

const EMPTY_COUNTS = { ACTIVE: {}, CLOSED: {}, STUCK: {}, OLDER: {} } as const;

export function useStatusCategoryCounts(
  filters: StatusCategoryCountsFilters = {},
): StatusCategoryCounts {
  const { segments } = useSegments();
  const segmentList = segments || [];
  const segmentIds = segmentList.map((s) => s.id).join(",");

  const query = useMemo(
    () => buildStatusCategoryCountsQuery(filters),
    [filters.timeframe, filters.from, filters.to, filters.stuckCutoff],
  );

  const params = useMemo(() => ({
    query,
    /* 2 statuses × 6 canonical categories = 12 max rows. 16 gives
       headroom for any future category Davis might add without
       silently truncating. */
    maxResultRecords: 16,
    requestTimeoutMilliseconds: 15_000,
    filterSegments: segmentList as FilterSegment[],
    dtClientContext: "problems-hub:status-category-counts",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query, segmentIds]);

  // 0.0.178 — demo-mode short-circuit. Same intercept pattern as
  // useProblems: skip the DQL, return the demo-derived counts. See
  // utils/demoData.ts for the derivation rules (same thresholds as
  // the real DQL: 4 h Stuck, 1 h OLDER).
  const demo = useDemoMode();
  const { data, isLoading, error } = useDql<Row>(params, {
    /* Same cadence as `useCategoryCounts` — these two queries
       feed adjacent surfaces and need to refresh together to stay
       coherent. 2 min matches the native Davis Problems list
       cadence. */
    staleTime: 120_000,
    enabled: !demo.enabled,
  });

  const demoResult = useMemo<StatusCategoryCounts | null>(() => {
    if (!demo.enabled) return null;
    const r = getDemoStatusCategoryCounts({
      timeframe: filters.timeframe,
      from:      filters.from,
      to:        filters.to,
    });
    return { ...r, loading: false, error: null };
  }, [demo.enabled, filters.timeframe, filters.from, filters.to]);

  const result = useMemo<StatusCategoryCounts>(() => {
    const counts: {
      ACTIVE: Record<string, number>;
      CLOSED: Record<string, number>;
      STUCK: Record<string, number>;
      OLDER: Record<string, number>;
    } = {
      ACTIVE: {},
      CLOSED: {},
      STUCK: {},
      OLDER: {},
    };
    let active = 0;
    let closed = 0;
    let stuck = 0;
    for (const r of data?.records ?? []) {
      const status = r["event.status"];
      const cat = r["event.category"];
      const n = typeof r.count === "number" ? r.count : Number(r.count);
      if (!cat || !Number.isFinite(n)) continue;
      if (status === "ACTIVE") {
        counts.ACTIVE[cat] = n;
        active += n;
        const sRaw = r.stuck_count;
        const s = typeof sRaw === "number" ? sRaw : Number(sRaw ?? 0);
        if (Number.isFinite(s) && s > 0) {
          counts.STUCK[cat] = s;
          stuck += s;
        }
      } else if (status === "CLOSED") {
        counts.CLOSED[cat] = n;
        closed += n;
      }
      // 0.0.150 — OLDER counts both statuses: ACTIVE problems that
      // started ≥1h ago AND CLOSED problems whose end is after the
      // 1h cutoff. Add per category across status rows so the final
      // OLDER[cat] is the number of problems alive 1h ago.
      const oRaw = r.older_count;
      const o = typeof oRaw === "number" ? oRaw : Number(oRaw ?? 0);
      if (Number.isFinite(o) && o > 0) {
        counts.OLDER[cat] = (counts.OLDER[cat] || 0) + o;
      }
    }
    return {
      counts,
      totals: { active, closed, stuck, total: active + closed },
      loading: isLoading,
      error: error || null,
    };
  }, [data, isLoading, error]);

  // 0.0.178 — demo branch takes priority. Stable result, no loading
  // state since data is synchronous in demo.
  if (demoResult) return demoResult;
  // While loading and the response hasn't arrived yet, return a
  // sentinel with empty maps. Callers detect this via `loading`
  // and substitute list-derived math.
  if (isLoading && !data) {
    return {
      counts: EMPTY_COUNTS as {
        ACTIVE: Record<string, number>;
        CLOSED: Record<string, number>;
        STUCK: Record<string, number>;
        OLDER: Record<string, number>;
      },
      totals: { active: 0, closed: 0, stuck: 0, total: 0 },
      loading: true,
      error: error || null,
    };
  }
  return result;
}
