// 0.0.142 — Fetches the top-N oldest ACTIVE problems for a single
// category. Fires ONLY when the EnlargedQuadrantCard modal is open
// AND the user has the Stuck pill selected, so the DPS cost is paid
// on user interaction, not on every page refresh.
//
// Why this hook exists:
//   The main `useProblems` query loads the 250 newest problems
//   globally. For a busy category like ERROR with 1133 active where
//   most are <4h, the sample contains effectively zero Stuck rows
//   (active AND > 4h). The cell-level Stuck COUNT is already
//   authoritative (from useStatusCategoryCounts.STUCK), but the
//   modal can't render dots that aren't in the in-memory problems
//   list. This hook bridges that gap with a focused query.
//
// DPS cost (per modal-open with Stuck pill selected):
//   - Server-side filter: ACTIVE + category + age > 4h
//   - Limit 50 rows × ~300 B = ~15 KB payload
//   - Bytes scanned: ~1/6 of the unfiltered fetch (one of 6
//     categories) × the timeframe partition, ~3-5 MB compressed
//     for an xlarge tenant. ≈ 0.05 DPS per modal open.
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildStuckProblemsByCategoryQuery } from "../utils/dql-queries";
import type { Problem } from "./useProblems";

export interface UseStuckProblemsByCategoryOptions {
  /** Davis category id (must match the ALLOWED_CATEGORIES whitelist
   *  in dql-queries.ts). */
  category: string;
  /** Timeframe string the rest of the app passes ("24h", "7d", …)
   *  or explicit from/to ISO. Matches useProblems' filter shape. */
  timeframe?: string;
  from?: string;
  to?: string;
  /** Defaults to 50 — matches the modal's TOP_N rendering cap. */
  limit?: number;
  /** 0.0.148 — ISO timestamp passed through to the query builder
   *  so the modal drilldown agrees with the cell-level Stuck count
   *  (both derived from the user-selected timeframe). */
  stuckCutoff?: string;
  /** Gate. When false the hook stays inert (no query fires, returns
   *  the empty sentinel). Used to delay the fetch until the user
   *  actually interacts with the Stuck pill. */
  enabled: boolean;
}

export interface UseStuckProblemsByCategoryResult {
  problems: Problem[];
  loading: boolean;
  error: Error | null;
}

const EMPTY: Problem[] = [];

export function useStuckProblemsByCategory(
  opts: UseStuckProblemsByCategoryOptions,
): UseStuckProblemsByCategoryResult {
  const { segments } = useSegments();
  const segmentList = segments || [];
  const segmentIds = segmentList.map((s) => s.id).join(",");

  const query = useMemo(() => {
    if (!opts.enabled || !opts.category) return null;
    try {
      return buildStuckProblemsByCategoryQuery({
        category: opts.category,
        timeframe: opts.timeframe,
        from: opts.from,
        to: opts.to,
        limit: opts.limit ?? 50,
        stuckCutoff: opts.stuckCutoff,
      });
    } catch {
      // Invalid category — keep the hook inert rather than throwing
      // up the React tree.
      return null;
    }
  }, [opts.enabled, opts.category, opts.timeframe, opts.from, opts.to, opts.limit]);

  const params = useMemo(
    () =>
      query
        ? {
            query,
            maxResultRecords: opts.limit ?? 50,
            requestTimeoutMilliseconds: 15_000,
            filterSegments: segmentList as FilterSegment[],
            dtClientContext: "problems-hub:stuck-by-category",
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, segmentIds, opts.limit],
  );

  const { data, isLoading, error } = useDql<Problem>(
    params ?? {
      query: "",
      filterSegments: [] as FilterSegment[],
      dtClientContext: "problems-hub:stuck-by-category",
    },
    {
      // Modal opens are user-initiated, so a moderately long cache
      // smooths out closing/reopening within the same triage flow.
      staleTime: 60_000,
      // Don't fire when params is null (gate off).
      enabled: !!params,
    },
  );

  const problems = useMemo(() => data?.records ?? EMPTY, [data]);

  if (!params) {
    return { problems: EMPTY, loading: false, error: null };
  }
  return {
    problems,
    loading: !!isLoading,
    error: error || null,
  };
}
