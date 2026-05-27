// 0.0.169 — Fetches the top-N newest ACTIVE problems for a single
// category (started in the last 1 hour). Fires ONLY when the
// EnlargedQuadrantCard modal is open AND the user has the Rising
// pill selected — same gating pattern as useStuckProblemsByCategory.
//
// Why this hook exists:
//   The main `useProblems` query loads the 250 newest problems
//   GLOBALLY. For a tenant where a single category is busy (>250
//   active in window), the in-memory sample's per-category Rising
//   slice can be tiny (or empty), even though the count-query
//   reports a real Rising delta. This hook bridges that gap with a
//   focused query that scans only the relevant category.
//
// DPS cost (per modal-open with Rising selected):
//   - Server-side filter: ACTIVE + category + start >= now-1h
//   - Limit 10 rows × ~300 B = ~3 KB payload
//   - Bytes scanned: 1/6 of the fetch (single category) × timeframe
//     × the 1h window predicate, ~3-5 MB compressed on an xlarge
//     tenant. ≈ 0.05 DPS per modal open with Rising pill selected.
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildRisingProblemsByCategoryQuery } from "../utils/dql-queries";
import type { Problem } from "./useProblems";

export interface UseRisingProblemsByCategoryOptions {
  /** Davis category id (must match the ALLOWED_CATEGORIES whitelist
   *  in dql-queries.ts). */
  category: string;
  /** Timeframe string the rest of the app passes ("24h", "7d", …)
   *  or explicit from/to ISO. Matches useProblems' filter shape. */
  timeframe?: string;
  from?: string;
  to?: string;
  /** Defaults to 10 — matches the modal's TOP_N rendering cap. */
  limit?: number;
  /** Gate. When false the hook stays inert (no query fires, returns
   *  the empty sentinel). Used to delay the fetch until the user
   *  actually interacts with the Rising pill. */
  enabled: boolean;
}

export interface UseRisingProblemsByCategoryResult {
  problems: Problem[];
  loading: boolean;
  error: Error | null;
}

const EMPTY: Problem[] = [];

export function useRisingProblemsByCategory(
  opts: UseRisingProblemsByCategoryOptions,
): UseRisingProblemsByCategoryResult {
  const { segments } = useSegments();
  const segmentList = segments || [];
  const segmentIds = segmentList.map((s) => s.id).join(",");

  const query = useMemo(() => {
    if (!opts.enabled || !opts.category) return null;
    try {
      return buildRisingProblemsByCategoryQuery({
        category: opts.category,
        timeframe: opts.timeframe,
        from: opts.from,
        to: opts.to,
        limit: opts.limit ?? 10,
      });
    } catch {
      return null;
    }
  }, [opts.enabled, opts.category, opts.timeframe, opts.from, opts.to, opts.limit]);

  const params = useMemo(
    () =>
      query
        ? {
            query,
            maxResultRecords: opts.limit ?? 10,
            requestTimeoutMilliseconds: 15_000,
            filterSegments: segmentList as FilterSegment[],
            dtClientContext: "problems-hub:rising-by-category",
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, segmentIds, opts.limit],
  );

  const { data, isLoading, error } = useDql<Problem>(
    params ?? {
      query: "",
      filterSegments: [] as FilterSegment[],
      dtClientContext: "problems-hub:rising-by-category",
    },
    {
      // Rising is the most time-sensitive metric — keep cache short
      // so a refresh during triage actually returns fresh data.
      staleTime: 60_000,
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
