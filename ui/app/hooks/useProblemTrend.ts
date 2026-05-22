// Per-bucket count timeseries used by the chart. Wraps `useDql` for
// the same reasons as `useProblems` — see that file's header for the
// full rationale. Output stays the same shape the chart consumes
// (Strato's `convertQueryResultToTimeseries`), only the plumbing
// changes.
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { convertQueryResultToTimeseries } from "@dynatrace/strato-components-preview/charts";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildTrendQuery } from "../utils/dql-queries";

export function useProblemTrend(timeframe: string = "7d", status?: string) {
  const { segments } = useSegments();
  const segmentList = segments || [];
  const segmentIds  = segmentList.map((s) => s.id).join(",");

  const params = useMemo(() => ({
    // `status` flows from the FILTERS strip (`null` = both, `"ACTIVE"`
    // / `"CLOSED"` = single-state) so the histogram bars track the
    // same subset as the list and the category badges.
    query: buildTrendQuery(timeframe, status),
    requestTimeoutMilliseconds: 30_000,
    filterSegments: (segmentList as FilterSegment[]),
    dtClientContext: "problems-hub:trend",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [timeframe, status, segmentIds]);

  const { data, isLoading, error, forceRefetch } = useDql(params, {
    // Trend buckets change slowly — 2 min cache saves a query
    // when the user toggles view modes on the same timeframe.
    staleTime: 120_000,
  });

  // The SDK returns a `QueryResult`; the chart wants a timeseries
  // array, so we run the same conversion the previous implementation
  // did. `data?` covers loading state (no result yet).
  const timeseries = useMemo(() => {
    if (!data) return [] as ReturnType<typeof convertQueryResultToTimeseries>;
    // useDql's TypedQueryResult is shape-compatible with QueryResult
    // for the records/metadata fields the converter cares about, but
    // the SDK's UseDqlMetadata.grail.analysisTimeframe is widened to
    // `{ start?, end? }` instead of the canonical Timeframe. Cast for
    // the converter — it only reads the fields it understands.
    return convertQueryResultToTimeseries(data as unknown as Parameters<typeof convertQueryResultToTimeseries>[0]);
  }, [data]);

  return {
    data: timeseries,
    loading: isLoading,
    error: error || null,
    refetch: forceRefetch,
  };
}
