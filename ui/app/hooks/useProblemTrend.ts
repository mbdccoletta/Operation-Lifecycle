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
import { useDemoMode } from "../contexts/DemoModeContext";

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

  // 0.0.178 — demo-mode skip. The chart's bucket shape comes from
  // Strato's `convertQueryResultToTimeseries`; rather than fabricate
  // a synthetic query-result and risk shape drift, demo simply
  // returns an empty timeseries and the chart renders an empty
  // canvas. The page's other surfaces (constellation, list, modal)
  // are the demo's main attraction — the chart is a follow-up.
  const demo = useDemoMode();
  const { data, isLoading, error, forceRefetch } = useDql(params, {
    // Trend buckets change slowly — 2 min cache saves a query
    // when the user toggles view modes on the same timeframe.
    /* DPS Tier 3 bump — was 120_000. Histogram bars aggregate
       hours of data per bucket; 3 min staleness is invisible to
       the user. ~33% fewer trend refetches. */
    staleTime: 180_000,
    enabled: !demo.enabled,
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
    data: demo.enabled ? [] as typeof timeseries : timeseries,
    loading: demo.enabled ? false : isLoading,
    error: demo.enabled ? null : (error || null),
    refetch: forceRefetch,
  };
}
