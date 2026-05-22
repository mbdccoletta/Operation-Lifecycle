// Catalog of every filter-segment defined in the tenant (the "Segments"
// app's saved filters). Used by the Segments-grouped Overview to pick
// which segments to render as quadrants.
//
// Distinct from Strato's `useSegments()`, which returns the currently
// SELECTED filter segments (a UI state on the global filter bar).
// `useFilterSegments` returns the full catalog so the page can choose
// top-N segments by active-problem count regardless of selection.
import { useEffect, useState, useCallback } from "react";
import { filterSegmentsClient } from "@dynatrace-sdk/client-filter-segment-management";
import type { LeanFilterSegment } from "@dynatrace-sdk/client-filter-segment-management";

export interface FilterSegmentsState {
  segments: LeanFilterSegment[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useFilterSegments(): FilterSegmentsState {
  const [segments, setSegments] = useState<LeanFilterSegment[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<Error | null>(null);
  const [tick, setTick]         = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    filterSegmentsClient
      // `addFields: ["VARIABLES"]` is REQUIRED for the segment
      // catalog to carry the `variables` array on each record.
      // Without it the API returns `variables: undefined` for
      // every segment — including parameterised ones — which made
      // our `if (!s.variables)` skip-filter silently include them.
      // That triggered FILTER_SEGMENT_REQUIRES_VARIABLE 400s when
      // useSegmentMembership tried to apply them to dt.davis.problems.
      .getLeanFilterSegments({ addFields: ["VARIABLES"] })
      .then((resp) => {
        if (cancelled) return;
        setSegments(resp.filterSegments || []);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e as Error);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { segments, loading, error, refetch };
}
