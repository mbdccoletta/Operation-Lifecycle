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
import { useEffect, useMemo, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { useDemoMode } from "../contexts/DemoModeContext";

// Query has to mirror the contract the rest of the app uses, or the
// tab-bar badge silently disagrees with what the user sees on the
// Incidents page (the original bug: 9 in the badge vs 6 in the
// constellation's ACTIVE ring). Three pieces matter here:
//
//   1. `from: now() - 7d` — DPS Tier 5 (0.0.198): validated
//      empirically against the BWM tenant that 7 d returns the
//      same ACTIVE count as 30 d while scanning 4× less data
//      (~120 MB vs ~540 MB per fire). Rationale: Davis re-emits a
//      state-change record on every status touch, plus
//      escalations, so the "quiet active problem" edge case that
//      motivated the 30 d window in v0.0.20-era code does not
//      materialise in practice — any active problem has at least
//      one record in the past week. The 7 d floor also matches
//      what `useTeamMetrics` could safely shrink to, but we leave
//      that one alone because MTBF/MTTF accuracy depends on
//      lifetime data. Re-validate if you ever see the badge drift
//      below the list count for week-long incidents.
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
//      DO NOT switch to `countDistinct(display_id)` — it skips
//      records where display_id is null, so the count drifts
//      below the sort+dedup approach (BWM validation: 6 vs 7).
const ACTIVE_PROBLEMS_COUNT_QUERY = `fetch dt.davis.problems, from: now() - 7d
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

/* 0.0.197 — DPS Tier 4: adaptive badge cadence.
 *
 * Once `count` crosses 999, the badge label collapses to the
 * "999+" cap (see <IncidentsTab>) and no longer tracks the exact
 * value. Polling at the baseline 120 s rate while the badge is
 * pegged at "999+" burns DPS without changing what the user
 * sees. The thresholds below bucket the next refetch interval
 * by the last observed count so the cadence matches the
 * information density the user can actually consume:
 *
 *   count <  100  →  120 s  (responsive feedback in the low band
 *                            where each unit matters during triage)
 *   count <  1000 →  300 s  (medium activity; small drifts still
 *                            land within the user's attention span)
 *   count >= 1000 →  600 s  ("999+" plateau; the badge is
 *                            visually constant, so we only need
 *                            to poll often enough to notice when
 *                            the count crosses back below 1000)
 *
 * `staleTime` stays at 120 s so the toolbar refresh button still
 * returns fresh data on demand. Only the AUTOMATIC poll cadence
 * adapts; manual refresh + page navigation are unaffected.
 * Visible behaviour: zero change. Cost reduction in the 999+
 * regime: ~80% fewer fires of this hook, which scales linearly
 * with concurrent users on busy tenants. */
function pickBadgeRefetchInterval(count: number): number {
  if (count >= 1000) return 600_000;
  if (count >= 100)  return 300_000;
  return 120_000;
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

  // 0.0.197 — DPS Tier 4 adaptive cadence. Initial value matches
  // the previous baseline so the very first poll cycle behaves
  // identically to the legacy 120 s pace; the effect below
  // bumps the interval up once the first response lands and
  // reveals the count band. Plain useState (not useRef) so the
  // SDK re-reads the option on the subsequent render.
  const [refetchIntervalMs, setRefetchIntervalMs] = useState(120_000);

  // 0.0.198 — DPS Tier 5 demo gate. Empirical measurement on the
  // BWM tenant showed `?demo=1` sessions accounted for ~41 % of
  // this hook's on_demand bytes (a real DPS leak the synthetic
  // data branch was supposed to prevent). Demo mode now
  // short-circuits the DQL entirely — the badge falls back to
  // `count = 0` (its loading default), which is the right thing
  // since demo data is synthesised in `getDemoFilteredProblems`
  // for the surfaces that visualise it.
  const demo = useDemoMode();

  const { data, isLoading, error } = useDql<CountRecord>(params, {
    // 60 s cache window — the badge doesn't need second-by-second
    // freshness; a one-minute drift matches what the Dynatrace
    // platform itself shows on its own menu badge.
    /* DPS Tier 3 bump — was 60_000. Badge updates 2× per minute
       is more than the user can notice during triage; lowered
       to 1× per 2 min. `staleTime` deliberately stays at 120 s
       even after Tier 4 — the toolbar refresh button must
       still return fresh data on demand; only the BACKGROUND
       polling cadence adapts. */
    staleTime: 120_000,
    // Auto-refresh in the background so the badge updates even
    // when the user is parked on a single page for a long time.
    // useDql already cancels in-flight queries when the tab loses
    // focus, so this doesn't burn budget on hidden tabs.
    /* DPS Tier 4 — adaptive: see pickBadgeRefetchInterval above
       for the rationale. The driving state is updated in the
       effect below once the response yields a count. */
    refetchInterval: refetchIntervalMs,
    /* 0.0.198 — DPS Tier 5: demo gate (see useDemoMode read above). */
    enabled: !demo.enabled,
  });

  const count = demo.enabled ? 0 : (data?.records?.[0]?.count ?? 0);

  // 0.0.197 — bucket the cadence by the latest count. Hot path
  // is a no-op (same bucket → identical reference → no setState
  // → no re-render), so this is free when count stays in band.
  useEffect(() => {
    const next = pickBadgeRefetchInterval(count);
    setRefetchIntervalMs((prev) => (prev === next ? prev : next));
  }, [count]);

  return { count, loading: isLoading, error: error || null };
}
