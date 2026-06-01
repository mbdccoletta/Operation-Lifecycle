// Thin wrapper around `useDql` from @dynatrace-sdk/react-hooks — the
// official Dynatrace pattern for executing DQL in React. Replaces the
// previous hand-rolled queryExecute / queryPoll loop and brings:
//   • Automatic in-flight cancellation when the tab loses focus.
//   • 60-second result cache + auto-retry on 429.
//   • A consistent `data / isLoading / error / refetch` contract.
// We keep our existing shape (problems / loading / error / refetch) so
// the rest of the app didn't need to change.
import { useCallback, useMemo, useState } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildFilteredQuery } from "../utils/dql-queries";
import { useDemoMode } from "../contexts/DemoModeContext";
import { getDemoFilteredProblems } from "../utils/demoData";

export interface Problem {
  /** Long composite identifier (e.g. `3024535536893773453_1779198660000V2`)
   *  used by the official Davis Problems app's `/problem/<id>` route.
   *  The human-friendly `display_id` (P-####) doesn't resolve there.
   *  Aliased from `event.id` in DQL via `| fieldsAdd` so the JS key
   *  is dot-free and unambiguous. */
  davis_problem_id?: string;
  "event.name": string;
  "event.status": "ACTIVE" | "CLOSED";
  // Dynatrace Intelligence problems use long category names (e.g.
  // "RESOURCE_CONTENTION", "CUSTOM_ALERT", "MONITORING_UNAVAILABLE")
  // — the component code uses the long names directly.
  "event.category": "AVAILABILITY" | "ERROR" | "SLOWDOWN" | "RESOURCE_CONTENTION" | "CUSTOM_ALERT" | "MONITORING_UNAVAILABLE";
  "event.start": string;
  "event.end"?: string;
  /** Davis severity 1..5 as a string. Higher = more critical. */
  "event.severity"?: string;
  affected_entity_ids: string[];
  /** Canonical names from `dt.davis.problems` — same field the official
   *  Problems app uses. Aligned 1:1 with `affected_entity_ids`. May
   *  contain null/empty entries when the entity has no human name. */
  affected_entity_names?: (string | null)[];
  /** Davis entity type names aligned with `affected_entity_ids`.
   *  No active consumer in the UI today; kept on the interface so
   *  the DQL projection can populate it for forensic debugging
   *  and future "Filter by entity type" features. */
  affected_entity_types?: string[];
  root_cause_entity_id: string;
  /** Canonical root-cause entity name (pair to root_cause_entity_id). */
  root_cause_entity_name?: string | null;
  display_id: string;
  /** Management-zone names. Kept on the interface (read by no UI
   *  surface today) so the DQL projection can carry it cheaply. */
  management_zones?: string[];
}

export interface ProblemFilters {
  status?: string;
  category?: string;
  /** Multi-value category filter — preferred path for the chip
   *  strip (which is multi-select). Pre-existing `category` is
   *  kept for legacy URL deep-links and only consulted when
   *  `categories` is empty / undefined. */
  categories?: string[];
  timeframe?: string;
  from?: string;
  to?: string;
  /** 0.0.279 — flip the server-side ordering from "newest first"
   *  to "oldest first". Set by the Overview page when the STUCK
   *  card is pinned so the 250-row sample lands on the long-
   *  running ACTIVE problems (the ones that match the
   *  `startTs < stuckCutoffMs` client filter) instead of an
   *  empty list of all-too-new rows. */
  sortAsc?: boolean;
}

export interface UseProblemsOptions {
  /** Cap for the first fetch — the rest is fetched on demand via
   *  `loadMore()`. Default 500: covers typical triage scans in one
   *  DQL pass while keeping payload + DQL cost ~5× smaller than the
   *  legacy "fetch everything up to 10k" path. */
  initialLimit?: number;
}

const HARD_CEILING = 10_000;
/* DPS Tier 3 bump — was 500. Most triage users scan the top
   20-50 problems before deciding. Loading 500 up front
   doubled the first-paint scan cost vs 250; users who roll
   past 250 hit the "Load more" affordance to ramp up. */
const DEFAULT_INITIAL = 250;

export function useProblems(
  filters: ProblemFilters = {},
  options: UseProblemsOptions = {},
) {
  const { segments } = useSegments();
  // Memoise the segment list reference based on its serialised IDs so
  // the useDql cache key only changes when the user's selection
  // actually changes (otherwise every render forces a refetch).
  const segmentList = segments || [];
  const segmentIds  = segmentList.map((s) => s.id).join(",");

  // ── Pagination ramp ─────────────────────────────────────────────
  // Filters change → start over at the initial cap. We do this with
  // "adjust state during rendering" (React 18-safe) so the query
  // string used THIS render already reflects the reset — otherwise
  // we'd briefly fire a stale query at the previous high limit
  // before the useEffect-reset kicked in (wasted DQL).
  const initialLimit = options.initialLimit ?? DEFAULT_INITIAL;
  // Serialise the multi-category array so its identity changes only
  // when the SET of selected chips actually changes — array
  // references re-create every render, which would otherwise reset
  // pagination on every parent re-render.
  const categoriesKey = (filters.categories ?? [])
    .slice()
    .sort()
    .join(",");
  const filterKey =
    `${filters.status ?? ""}|${filters.category ?? ""}|${categoriesKey}|` +
    `${filters.timeframe ?? ""}|${filters.from ?? ""}|${filters.to ?? ""}|` +
    `${initialLimit}|${segmentIds}|sortAsc=${filters.sortAsc ? "1" : "0"}`;

  const [paginationState, setPaginationState] = useState<{ filterKey: string; limit: number }>(
    () => ({ filterKey, limit: initialLimit }),
  );
  let activeLimit = paginationState.limit;
  if (paginationState.filterKey !== filterKey) {
    // Filter changed under us → snap back to the initial cap so the
    // next render fires the smaller query, not a stale 10k one.
    setPaginationState({ filterKey, limit: initialLimit });
    activeLimit = initialLimit;
  }

  const loadMore = useCallback(() => {
    setPaginationState((prev) => {
      const next = Math.min(prev.limit * 2, HARD_CEILING);
      if (next === prev.limit) return prev;
      return { ...prev, limit: next };
    });
  }, []);

  const query = useMemo(
    () => buildFilteredQuery({ ...filters, limit: activeLimit }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters.status, filters.category, categoriesKey, filters.timeframe, filters.from, filters.to, activeLimit, filters.sortAsc],
  );

  const params = useMemo(() => ({
    query,
    // Transport-level cap — stays at the hard ceiling so the SDK
    // doesn't clip valid responses on the way back. The DQL
    // `| limit` we just stamped is the actual cost lever.
    maxResultRecords: HARD_CEILING,
    requestTimeoutMilliseconds: 30_000,
    filterSegments: (segmentList as FilterSegment[]),
    // Tags the query in the tenant's query log so admins can spot
    // problems-hub when debugging slow DQL.
    dtClientContext: "problems-hub:problems",
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [query, segmentIds]);

  // 0.0.178 — demo-mode short-circuit. When `?demo=1` is on the URL,
  // useDql is disabled (so no DQL fires + no DPS spend) and we
  // synthesise the response from `demoData.ts`. The intercept is
  // RIGHT AT the SDK call site so every consumer of this hook
  // (list, constellation, modal) gets the same demo dataset — no
  // component-level branching, no drift.
  const demo = useDemoMode();
  const { data, isLoading, isFetching, error, forceRefetch } = useDql<Problem>(params, {
    // 90 s cache window — wide enough that round-tripping between
    // Incidents → Segments → Analytics (or constellation ↔ list)
    // reuses the same response instead of re-querying. Manual /
    // auto-refresh always bypasses the cache via `forceRefetch`
    // anyway, so this only saves redundant background queries.
    /* DPS Tier 3 bump — was 90_000. 2 min staleness matches the
       native Davis Problems list cadence; user-perceived
       freshness unchanged, ~25% fewer refetches. */
    staleTime: 120_000,
    enabled: !demo.enabled,
  });

  const demoProblems = useMemo(
    () => demo.enabled
      ? getDemoFilteredProblems({
          status:     filters.status,
          category:   filters.category,
          categories: filters.categories,
          timeframe:  filters.timeframe,
          from:       filters.from,
          to:         filters.to,
        }, activeLimit)
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demo.enabled, filters.status, filters.category, categoriesKey, filters.timeframe, filters.from, filters.to, activeLimit],
  );

  const problems = demo.enabled ? (demoProblems || []) : (data?.records || []);
  // Heuristic: if we got back exactly `activeLimit` records, the
  // DQL `| limit` clipped the result and there's probably more. If
  // we got back fewer, we've already loaded everything that
  // matches the current filter — no Load-more affordance needed.
  // Also gate on the hard ceiling: at 10k we stop offering more
  // because the next bump would have no effect.
  const hasMore = problems.length >= activeLimit && activeLimit < HARD_CEILING;
  return {
    problems,
    /** `true` ONLY on the first load of the query (no cached data
     *  yet). Stays `false` during refetches — use `fetching` for
     *  any UI that needs to reflect refresh activity. */
    loading: isLoading,
    /** `true` whenever a network call is in flight, INCLUDING
     *  refetches triggered by the refresh button or auto-refresh.
     *  This is the flag the spinner in the page toolbar should
     *  read so the user gets feedback on every refresh — the
     *  earlier code used `loading` which goes back to false after
     *  the first response, making subsequent clicks feel silent. */
    fetching: isFetching,
    error: error || null,
    // `forceRefetch` bypasses the cache — matches the old behaviour
    // where `refetch()` always hit the backend.
    refetch: forceRefetch,
    /** Currently-loaded count, mostly so callers can render
     *  "Showing N of many" alongside the Load-more button. */
    loadedCount: problems.length,
    /** Active DQL `| limit` — equal to `loadedCount` when there
     *  are more matches than the cap, smaller when the result set
     *  has been fully loaded. */
    currentLimit: activeLimit,
    /** `true` when the response hit the active limit and a bigger
     *  query could legitimately return more records. */
    hasMore,
    /** Double the active limit (capped at 10 000) and refetch. */
    loadMore,
  };
}
