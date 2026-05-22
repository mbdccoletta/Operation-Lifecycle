// Lightweight aggregation hook that feeds the category chip badges.
//
// Why a SEPARATE query from `useProblems`?
//
// Once we filter the main problems query server-side by category
// (so the list payload shrinks dramatically when chips are active),
// the chip BADGES can no longer be derived from the list — they
// would all collapse to "0" for unselected categories. We need a
// view that always reflects the FULL tenant within the current
// window/segments, regardless of what chips are active.
//
// This query is cheap (≤ 6 rows × ~30 bytes after dedup), so
// running it alongside the main list adds essentially zero
// latency. It's cached at the same `staleTime` and refetches on
// the same manual/auto-refresh ticks as `useProblems` so the
// numbers stay coherent.
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildCategoryCountsQuery } from "../utils/dql-queries";

export interface CategoryCountsFilters {
  status?: string;
  timeframe?: string;
  from?: string;
  to?: string;
}

interface Row {
  "event.category": string;
  count: number;
}

export interface CategoryCounts {
  /** Map from Davis category (e.g. "AVAILABILITY") to integer count
   *  of unique problems in the window. Categories with zero
   *  problems are omitted — callers should default missing keys
   *  to 0 themselves. */
  counts: Record<string, number>;
  loading: boolean;
  error: Error | null;
}

export function useCategoryCounts(filters: CategoryCountsFilters = {}): CategoryCounts {
  const { segments } = useSegments();
  const segmentList = segments || [];
  const segmentIds = segmentList.map((s) => s.id).join(",");

  const query = useMemo(
    () => buildCategoryCountsQuery(filters),
    [filters.status, filters.timeframe, filters.from, filters.to],
  );

  const params = useMemo(() => ({
    query,
    /* DPS Tier 3 — was 100. Davis emits 6 canonical category
       values; even with future additions, 10 is a comfortable
       cap and avoids any chance of the SDK reserving payload
       for rows that can't exist. */
    maxResultRecords: 10,
    requestTimeoutMilliseconds: 15_000,
    filterSegments: segmentList as FilterSegment[],
    dtClientContext: "problems-hub:category-counts",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query, segmentIds]);

  const { data, isLoading, error } = useDql<Row>(params, {
    /* DPS Tier 3 bump — was 90_000. Paired with `useProblems`
       so the chip badges and the list refetch at the same
       cadence (2 min). Keeps headline counts coherent. */
    staleTime: 120_000,
  });

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const r of data?.records ?? []) {
      const cat = r["event.category"];
      const n = typeof r.count === "number" ? r.count : Number(r.count);
      if (cat && Number.isFinite(n)) out[cat] = n;
    }
    return out;
  }, [data]);

  return { counts, loading: isLoading, error: error || null };
}
