// Lightweight count-only DQL query for the global "Incidents" tab
// badge. Honours the user's currently selected filter segments
// from the global Strato SegmentSelector so the badge tracks the
// SAME cohort the user is looking at on the list pages — e.g. if
// they're filtered to "Production servers only", the badge counts
// only active problems within that segment scope.
//
// Cost vs `useProblems`: this returns ONE row (`{ count: N }`)
// instead of up to 10 000 problem records, so it stays cheap to poll
// on a 60s cadence regardless of how busy the tenant is.
import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";

// Query has to mirror the contract the rest of the app uses, or the
// tab-bar badge silently disagrees with what the user sees on the
// Incidents page (the original bug: 9 in the badge vs 6 in the
// constellation's ACTIVE ring). Three pieces matter here:
//
//   1. `from: now() - 30d` — without it Davis falls back to a ~2h
//      implicit window and the badge under- or over-counts depending
//      on flap rate. 30d is wide enough to catch any long-running
//      ACTIVE problem (state-change records get re-emitted on
//      escalations, but a quiet active problem may only have its
//      start record; 30d is the worst-case retention for that).
//
//   2. NULL-tolerant `is_duplicate` filter — same expression the
//      native Davis Problems app uses (`isNull OR not(...)`). The
//      previous query was implicitly counting duplicates because no
//      filter was applied at all, so a flap that Davis grouped into
//      one parent + N children counted N+1 in the badge but 1 in
//      the list.
//
//   3. `sort + dedup display_id` BEFORE summarize — Davis emits one
//      record per problem STATE CHANGE, so a single problem that
//      went OPEN → INVESTIGATING → OPEN over its lifetime emits 3
//      records all with event.status == "ACTIVE". Deduping by the
//      stable problem id collapses them to one row per problem.
const ACTIVE_PROBLEMS_COUNT_QUERY = `fetch dt.davis.problems, from: now() - 30d
| filter (isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate)) and event.status == "ACTIVE"
| sort event.start desc
| dedup display_id
| summarize count = count()`;

interface CountRecord {
  count: number;
}

export interface ActiveProblemsCount {
  /** Number of ACTIVE problems in the tenant right now, narrowed
   *  to the user's segment selection. `0` while the first query is
   *  loading or if the response is empty. */
  count: number;
  loading: boolean;
  error: Error | null;
}

export function useActiveProblemsCount(): ActiveProblemsCount {
  // Read the user's currently active filter segments from Strato's
  // context. This is the SAME selection that's applied to the
  // problems list query — keeping the badge in sync prevents the
  // disorienting "list shows 3 but badge says 11" mismatch.
  const { segments } = useSegments();
  const segmentList = useMemo(() => Array.from(segments || []), [segments]);
  const params = useMemo(() => ({
    query: ACTIVE_PROBLEMS_COUNT_QUERY,
    maxResultRecords: 1,
    requestTimeoutMilliseconds: 15_000,
    filterSegments: segmentList as FilterSegment[],
    dtClientContext: "problems-hub:active-count",
  }), [segmentList]);

  const { data, isLoading, error } = useDql<CountRecord>(params, {
    // 60 s cache window — the badge doesn't need second-by-second
    // freshness; a one-minute drift matches what the Dynatrace
    // platform itself shows on its own menu badge.
    /* DPS Tier 3 bump — was 60_000. Badge updates 2× per minute
       is more than the user can notice during triage; lowered
       to 1× per 2 min. Paired with `refetchInterval` below. */
    staleTime: 120_000,
    // Auto-refresh in the background so the badge updates even
    // when the user is parked on a single page for a long time.
    // useDql already cancels in-flight queries when the tab loses
    // focus, so this doesn't burn budget on hidden tabs.
    /* DPS Tier 3 bump — was 60_000. 50% fewer global polls for
       the badge across the whole app. A 2-min staleness matches
       the cadence the native Davis Problems menu badge uses. */
    refetchInterval: 120_000,
  });

  const count = data?.records?.[0]?.count ?? 0;
  return { count, loading: isLoading, error: error || null };
}
