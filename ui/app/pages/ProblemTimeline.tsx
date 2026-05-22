// Timeline page — tenant-wide reliability dashboard.
//
// Layout follows the same skeleton as Incidents / Segments /
// Analytics so the whole app reads as one product:
//   • `neo-header` toolbar with SegmentSelector (left),
//     TimeframeSelector + refresh group (right).
//   • Sticky CategoryFilterChips strip below the header.
//   • Section blocks for the content (`neo-analytics-section`).
//
// The page itself anchors on the FULL problems list inside the
// selected timeframe — not a single problem. Top section surfaces
// the team-level KPIs (MTTA/MTTR/MTBF/MTTF) with their evolution
// chart; bottom section stacks every problem in the window as a
// collapsible card so users can drill into individual activity
// feeds without leaving the page.
//
// Deep-link contract: `?id=<davisId>` (or `?id=P-####`) auto-
// expands the matching card and scrolls it into view.

import React, { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { SegmentSelector, TimeframeSelector } from "@dynatrace/strato-components-preview/filters";
import type { Timeframe } from "@dynatrace/strato-components-preview/core";
import { EmptyState } from "@dynatrace/strato-components-preview/content";
import {
  isDavisProblemId,
  isDisplayId,
} from "../utils/problem-timeline-queries";
import { useProblems } from "../hooks/useProblems";
import { useTeamMetrics } from "../hooks/useTeamMetrics";
import { usePageVisible, useDebouncedValue } from "../hooks/useUiUtils";
import { TeamMetricsCard } from "../components/analytics/TeamMetricsCard";
import { ProblemTimelineCard } from "../components/ProblemTimelineCard";
import { CategoryFilterChips } from "../components/CategoryFilterChips";
import { RefreshStatus } from "../components/RefreshStatus";
import { LoadMoreFooter } from "../components/LoadMoreFooter";
import { ProblemSearch } from "../components/ProblemSearch";
import { useCategoryFilterOnly, useSetCategoryCounts } from "../contexts/CategoryFilterContext";
import { useCategoryCounts } from "../hooks/useCategoryCounts";
import {
  useScenario,
  getSimulatedProblems,
  getSimulatedMttaMap,
  getSimulatedProblemTimelines,
  isMttaScenario,
} from "../utils/debugScenario";

export const ProblemTimeline: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("id") || "";

  // ── Timeframe selector ──────────────────────────────────────────
  // Default 30d so first-load shows enough data to compute the four
  // metrics meaningfully. `clearable={false}` matches Incidents /
  // Analytics — there's always a valid window selected.
  const initialTimeframe = useMemo<Timeframe>(() => {
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    return {
      from: { absoluteDate: from.toISOString(), value: "-30d", type: "expression" },
      to:   { absoluteDate: now.toISOString(),  value: "now",  type: "expression" },
    };
  }, []);
  const [timeframe, setTimeframe] = useState<Timeframe | null>(initialTimeframe);

  // ── Shared category filter (read EARLY so `teamFilters` can
  //    forward chip selections to DQL as a server-side filter). ─
  const { filter: categoryFilter, isFiltering } = useCategoryFilterOnly();
  const setCounts = useSetCategoryCounts();
  const categoriesArr = useMemo(() => Array.from(categoryFilter), [categoryFilter]);

  const timeframeOnlyFilter = useMemo(() => {
    if (!timeframe) return { timeframe: "30d" } as { timeframe?: string; from?: string; to?: string };
    return {
      from: timeframe.from.absoluteDate,
      to:   timeframe.to.absoluteDate,
    };
  }, [timeframe]);
  const teamFilters = useMemo(() => ({
    categories: categoriesArr,
    ...timeframeOnlyFilter,
  }), [categoriesArr, timeframeOnlyFilter]);
  const {
    problems: tenantProblems,
    loading: tenantLoading,
    fetching: tenantFetching,
    error: tenantError,
    refetch,
    hasMore,
    loadMore,
    loadedCount,
  } = useProblems(teamFilters);

  // ── Debug-panel sim overrides ───────────────────────────────────
  // Declared above the refresh handlers so they can call
  // `teamMetrics.refetch` (the comments stream) alongside
  // `useProblems.refetch` — without that pairing, the comments DQL
  // sits behind a 5-min cache and MTTA lags up to 5 min behind the
  // other three metrics on every refresh tick.
  const [scenario] = useScenario();
  const teamProblems = useMemo(
    () => getSimulatedProblems(scenario, tenantProblems),
    [scenario, tenantProblems],
  );
  const isSim = isMttaScenario(scenario);
  const simMttaMap = useMemo(
    () => getSimulatedMttaMap(scenario, teamProblems),
    [scenario, teamProblems],
  );
  const simTimelinesByPid = useMemo(
    () => getSimulatedProblemTimelines(scenario, teamProblems),
    [scenario, teamProblems],
  );

  // Category-filtered problems — drives the team metrics card +
  // status button counts. With Fase B the server already filtered
  // by category when chips are active, so on real data this is a
  // no-op idempotent re-application. We keep the client filter as
  // defence (debug-scenario data + safety net). MTTR / MTBF / MTTF
  // need both ACTIVE and CLOSED so we explicitly DON'T fold the
  // local `statusFilter` in here — MBTF is interval between
  // starts, MTTF needs a CLOSED predecessor, etc.
  const metricsProblems = useMemo(() => {
    if (!isFiltering) return teamProblems;
    return teamProblems.filter((p) => categoryFilter.has(p["event.category"]));
  }, [teamProblems, isFiltering, categoryFilter]);

  // ── Team metrics + per-problem map ──────────────────────────────
  const teamMetrics = useTeamMetrics(metricsProblems, { simulatedFirstComments: simMttaMap });
  const perProblem  = teamMetrics.perProblem;
  const refetchComments = teamMetrics.refetch;

  // ── Auto-refresh (matches Incidents / Analytics pattern) ────────
  // Each tick refetches BOTH the problems list AND the comments
  // stream so all four metrics (MTTA included) update together.
  // The live "refreshed Xs ago" / "next refresh in Xs" label is
  // rendered by the `<RefreshStatus>` child, which owns its own
  // tick so this page doesn't re-render every second.
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(() => Date.now());
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<number>(0); // 0 = off
  const pageVisible = usePageVisible();
  const handleManualRefresh = useCallback(() => {
    refetch();
    refetchComments();
    setLastRefreshAt(Date.now());
  }, [refetch, refetchComments]);
  useEffect(() => {
    if (!pageVisible) return;
    if (refreshIntervalSec <= 0) return;
    const t = window.setInterval(() => {
      refetch();
      refetchComments();
      setLastRefreshAt(Date.now());
    }, refreshIntervalSec * 1000);
    return () => window.clearInterval(t);
  }, [refreshIntervalSec, refetch, refetchComments, pageVisible]);

  // Per-category ACTIVE counts for the shared chip strip — sourced
  // from a SEPARATE light DQL aggregation (`useCategoryCounts`) so
  // the badges keep showing real numbers even when chips have
  // server-side filtered the main list to a single category.
  const { counts: activeCountsByCategory } = useCategoryCounts({
    status: "ACTIVE",
    ...timeframeOnlyFilter,
  });
  useEffect(() => { setCounts(activeCountsByCategory); }, [activeCountsByCategory, setCounts]);

  // ── Local UI state (sort + status + text search) ───────────────
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc"); // newest first by default
  const [statusFilter, setStatusFilter] = useState<"all" | "ACTIVE" | "CLOSED">("all");
  // Text search across name + category + display_id (same surface
  // the Incidents list searches). Debounced so refiltering doesn't
  // chase every keystroke.
  const [search, setSearch] = useState("");
  const searchDebounced = useDebouncedValue(search, 150);

  // Sort + filter the visible problems. Four layers stack here:
  // global category filter → local status filter → text search →
  // sort direction.
  const visibleProblems = useMemo(() => {
    let out = metricsProblems;
    if (statusFilter !== "all") {
      out = out.filter((p) => p["event.status"] === statusFilter);
    }
    if (searchDebounced) {
      const q = searchDebounced.toLowerCase();
      // "active" / "closed" magic words mirror the Incidents list
      // — type-then-Enter feels like the natural shortcut.
      if (q === "active" || q === "closed") {
        out = out.filter((p) => p["event.status"] === q.toUpperCase());
      } else {
        // Match name + display_id ONLY (no category). See the
        // matching comment in Overview.tsx — category substring
        // matches caused false positives like "Low" matching
        // every Slowdown problem.
        out = out.filter((p) =>
          p["event.name"].toLowerCase().includes(q) ||
          p.display_id.toLowerCase().includes(q),
        );
      }
    }
    return [...out].sort((a, b) => {
      const ta = new Date(a["event.start"]).getTime();
      const tb = new Date(b["event.start"]).getTime();
      return sortDir === "asc" ? ta - tb : tb - ta;
    });
  }, [metricsProblems, statusFilter, searchDebounced, sortDir]);

  // Active / closed counts are derived from the category-filtered
  // set so the status-filter buttons stay consistent with the cards
  // list and the team-metrics subtitle.
  const activeCount = useMemo(
    () => metricsProblems.filter((p) => p["event.status"] === "ACTIVE").length,
    [metricsProblems],
  );
  const closedCount = metricsProblems.length - activeCount;

  const isFocused = (p: { display_id: string; davis_problem_id?: string }): boolean => {
    if (!focusId) return false;
    if (isDavisProblemId(focusId) && p.davis_problem_id === focusId) return true;
    if (isDisplayId(focusId)      && p.display_id === focusId)        return true;
    return false;
  };

  // ── Virtualization (C3 in the perf audit) ───────────────────────
  // Unbounded card lists used to mount every card in the DOM. With
  // 1000+ problems that was 3000+ nodes and a sluggish scroll. The
  // window virtualizer renders only visible cards (+ overscan) and
  // dynamically measures their height as they expand/collapse, so
  // memory + layout cost stays roughly constant regardless of the
  // total problem count.
  const cardListRef = useRef<HTMLDivElement>(null);
  const focusIndex = useMemo(() => {
    if (!focusId) return -1;
    return visibleProblems.findIndex(isFocused);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleProblems, focusId]);
  const virtualizer = useWindowVirtualizer({
    count: visibleProblems.length,
    // Collapsed-card baseline. Expanded cards are remeasured via
    // `measureElement` below so the virtualizer always knows the
    // real layout for what it has rendered.
    estimateSize: () => 64,
    overscan: 6,
    // The offset of the card list inside the page — without this
    // the virtualizer doesn't know where the first card starts
    // relative to the page scroll position.
    scrollMargin: cardListRef.current?.offsetTop ?? 0,
    getItemKey: (i) => {
      const p = visibleProblems[i];
      return (p as unknown as { davis_problem_id?: string }).davis_problem_id || p.display_id;
    },
  });

  // ── Deep-link focus: scroll the matching card into view ─────────
  // With the virtualizer in place we can no longer `querySelector`
  // the card (it may not be in the DOM yet); use scrollToIndex so
  // the virtualizer mounts + scrolls in one pass.
  useEffect(() => {
    if (focusIndex < 0) return;
    const handle = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(focusIndex, { align: "start", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(handle);
  }, [focusIndex, virtualizer]);

  const clearFocus = () => {
    const sp = new URLSearchParams(searchParams);
    sp.delete("id");
    setSearchParams(sp, { replace: true });
  };

  return (
    <div className="neo-page">
      {/* ═══ TOOLBAR — segment + timeframe + refresh ═══ */}
      <header className="neo-header">
        <div className="neo-header-left">
          <SegmentSelector />
        </div>
        <div className="neo-header-right">
          <TimeframeSelector
            value={timeframe}
            onChange={setTimeframe}
            clearable={false}
          />
          {/* Refresh group — same markup the Incidents / Analytics
              toolbars use: native `title=` for the hover hint (the
              earlier Strato `<Tooltip>` wrap was intercepting the
              button's onClick on some platform builds). The
              `neo-refresh-btn` / `neo-refresh-interval` /
              `neo-refresh-status` classes carry the styled look. */}
          <div className="neo-refresh-group" role="group" aria-label="Refresh controls">
            <button
              type="button"
              className="neo-refresh-btn"
              onClick={handleManualRefresh}
              disabled={tenantFetching}
              title="Refresh now"
              aria-label="Refresh now"
            >
              {/* Spin on `tenantFetching` (true during EVERY fetch
                  incl. manual + auto refetches), not `tenantLoading`
                  (true only on first mount). Without this, the
                  refresh button looked broken — the click triggered
                  the DQL but the icon never rotated. */}
              <span className={`neo-refresh-icon${tenantFetching ? " neo-refresh-icon-spinning" : ""}`} aria-hidden="true">↻</span>
            </button>
            <select
              className="neo-refresh-interval"
              value={refreshIntervalSec}
              onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
              title="Auto refresh interval"
              aria-label="Auto refresh interval"
            >
              <option value={0}>Auto-refresh: Off</option>
              <option value={30}>Every 30s</option>
              <option value={60}>Every 1m</option>
              <option value={300}>Every 5m</option>
              <option value={1800}>Every 30m</option>
            </select>
            <RefreshStatus lastRefreshAt={lastRefreshAt} intervalSec={refreshIntervalSec} />
          </div>
        </div>
      </header>

      {/* Shared category filter — same instance as Incidents /
          Analytics. State lives in the global context so the
          selection persists when switching pages. */}
      <div className="neo-sticky-filter">
        <CategoryFilterChips />
      </div>

      {/* Sim-mode notice (replaces the old header banner — kept
          subtle, sits inline above the team-metrics section). */}
      {isSim && (
        <div className="ptl-sim-notice">
          <span className="ptl-sim-dot" aria-hidden="true">◆</span>
          <span className="ptl-sim-label">SIMULATION · {scenario}</span>
          <span className="ptl-sim-hint">
            {teamProblems.length} synthetic problems · clear via Debug panel → Real
          </span>
        </div>
      )}

      {/* Deep-link focus banner. */}
      {focusId && (
        <div className="ptl-focus-notice">
          <span>Focused on <code>{focusId}</code> — the matching card opens automatically.</span>
          <button type="button" onClick={clearFocus}>Clear focus</button>
        </div>
      )}

      {/* ═══ TEAM METRICS ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">
          Team metrics
          <span className="neo-analytics-section-sub">
            MTTA · MTTR · MTBF · MTTF — calculadas sobre {metricsProblems.length} problema{metricsProblems.length === 1 ? "" : "s"} · {activeCount} ativos · {closedCount} fechados
            {isFiltering && (
              <span className="ptl-mtta-filter-pill"> · filtrado por {Array.from(categoryFilter).join(", ").toLowerCase()}</span>
            )}
          </span>
        </div>
        {/* Pass the already-computed metrics down so TeamMetricsCard
            doesn't fire its own DQL. Halves DQL + CPU on every
            refresh of this page (C1 in the perf audit). */}
        <TeamMetricsCard problems={metricsProblems} teamMetrics={teamMetrics} />
      </section>

      {/* ═══ PROBLEMS LIST ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">
          Problems
          <span className="neo-analytics-section-sub">
            cada card mostra MTTA / MTTR / MTBF / MTTF e a timeline de atividade — click pra expandir
          </span>
        </div>

        {/* Sub-controls: search + sort direction + status filter. */}
        <div className="ptl-controls">
          <ProblemSearch
            value={search}
            onChange={setSearch}
            inline
            ariaLabel="Search problems"
          />
          <div className="neo-segctrl" role="group" aria-label="Sort direction">
            <button
              type="button"
              className={`neo-segctrl-btn${sortDir === "desc" ? " neo-segctrl-btn-active" : ""}`}
              onClick={() => setSortDir("desc")}
            >Newest first</button>
            <button
              type="button"
              className={`neo-segctrl-btn${sortDir === "asc" ? " neo-segctrl-btn-active" : ""}`}
              onClick={() => setSortDir("asc")}
            >Oldest first</button>
          </div>
          <div className="neo-segctrl" role="group" aria-label="Status filter">
            <button
              type="button"
              className={`neo-segctrl-btn${statusFilter === "all"    ? " neo-segctrl-btn-active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >All ({metricsProblems.length})</button>
            <button
              type="button"
              className={`neo-segctrl-btn${statusFilter === "ACTIVE" ? " neo-segctrl-btn-active" : ""}`}
              onClick={() => setStatusFilter("ACTIVE")}
            >Active ({activeCount})</button>
            <button
              type="button"
              className={`neo-segctrl-btn${statusFilter === "CLOSED" ? " neo-segctrl-btn-active" : ""}`}
              onClick={() => setStatusFilter("CLOSED")}
            >Closed ({closedCount})</button>
          </div>
          <span className="ptl-controls-count">
            showing {visibleProblems.length} of {metricsProblems.length}
          </span>
        </div>

        {tenantError ? (
          <EmptyState>
            <EmptyState.Title>Couldn't load problems</EmptyState.Title>
            <EmptyState.Details>
              {tenantError.message || "DQL query failed. Check the browser console for details."}
            </EmptyState.Details>
          </EmptyState>
        ) : tenantLoading && teamProblems.length === 0 ? (
          <SkeletonList />
        ) : visibleProblems.length === 0 ? (
          <EmptyState>
            <EmptyState.Title>No problems match the current filters</EmptyState.Title>
            <EmptyState.Details>
              Widen the timeframe picker above, clear the segment / category filter,
              or drop the status filter.
            </EmptyState.Details>
          </EmptyState>
        ) : (
          // Virtualized cards stack. Outer wrapper provides the
          // total scroll height so the page scrollbar reflects the
          // full list size; inner items are absolutely positioned
          // by the virtualizer so only ~12 cards live in the DOM
          // at any time.
          <div
            className="ptl-cards"
            ref={cardListRef}
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const p = visibleProblems[virtualItem.index];
              const davisId = (p as unknown as { davis_problem_id?: string }).davis_problem_id || "";
              const sim = isSim ? (simTimelinesByPid?.get(davisId) || { comments: [], automations: [] }) : null;
              const focused = isFocused(p);
              return (
                <div
                  key={virtualItem.key}
                  data-davis-id={davisId}
                  data-display-id={p.display_id}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualItem.start - virtualizer.options.scrollMargin}px)`,
                  }}
                >
                  <ProblemTimelineCard
                    problem={p}
                    simulated={sim}
                    sortDir={sortDir}
                    filter="all"
                    defaultExpanded={focused}
                    hideOpenLink={false}
                    allowComposer={!isSim}
                    metrics={davisId ? perProblem.get(davisId) : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
        {/* Pagination — visible only when the DQL `| limit` clipped
            the result. The Timeline page legitimately wants long
            windows (30d default) so this is the page most likely
            to hit it on busy tenants. */}
        {hasMore && visibleProblems.length > 0 && (
          <LoadMoreFooter
            loadedCount={loadedCount}
            fetching={tenantFetching}
            onLoadMore={loadMore}
          />
        )}
      </section>
    </div>
  );
};

// ── Sub-components ────────────────────────────────────────────────────

const SkeletonList: React.FC = () => (
  <div className="ptl-cards" aria-busy="true">
    {[0, 1, 2, 3].map((i) => (
      <div key={i} className="ptl-card">
        <div className="ptl-card-head">
          <div className="neo-skeleton" style={{ height: 14, width: 100 }} />
          <div className="neo-skeleton" style={{ height: 14, flex: 1 }} />
        </div>
      </div>
    ))}
  </div>
);
