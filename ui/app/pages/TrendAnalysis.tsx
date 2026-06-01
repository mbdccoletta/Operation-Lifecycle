// Analytics page — comprehensive operational briefing.
//   • Insights strip (auto-detected observations)
//   • KPI hero strip (4 metrics with sparklines, accurate per-bucket)
//   • Throughput chart (opened vs closed flow)
//   • Priority queue (top-8 active by composite urgency score)
//   • Pain entities + top root causes (where to look first)
//   • MTTR by category + aging distribution (operational pain shape)
// Header/filters/refresh mirror the Overview pattern.
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useProblems, type Problem } from "../hooks/useProblems";
import { useTimeRange } from "../hooks/useTimeRange";
import { useDevice } from "../hooks/useDevice";
import { SegmentSelector, TimeframeSelector } from "@dynatrace/strato-components-preview/filters";
import type { Timeframe } from "@dynatrace/strato-components-preview/core";
import { getCategoryLabel, formatDuration, formatStartedDate, getImpactLabel } from "../utils/formatters";
import { categoryColorFor } from "../utils/grouping";
import { useCategoryFilterOnly, useSetCategoryCounts } from "../contexts/CategoryFilterContext";
import { useTriggerRefresh } from "../contexts/RefreshSignalContext";
import { useCategoryCounts } from "../hooks/useCategoryCounts";
import { parseStratoTimeframe } from "../utils/timeframe";
import { DisplaySettingsPanel } from "../components/DisplaySettingsPanel";
import { CategoryFilterChips } from "../components/CategoryFilterChips";
import { Sparkline } from "../components/Sparkline";
import { usePageVisible, useDelayedLoading } from "../hooks/useUiUtils";
import { Skeleton, SkeletonText } from "@dynatrace/strato-components/content";
import { KPI_CATALOG } from "../utils/analyticsKpis";
import { TopRootCauses } from "../components/analytics/TopRootCauses";
import { PainEntities } from "../components/analytics/PainEntities";
import { MttrByCategory } from "../components/analytics/MttrByCategory";
import { TeamMetricsCard } from "../components/analytics/TeamMetricsCard";
import { useTeamMetrics } from "../hooks/useTeamMetrics";
import { AgingBuckets } from "../components/analytics/AgingBuckets";
// 0.0.121 — `TopSegmentsByCategory` import removed alongside the
// section that used it. The component file remains in
// `components/analytics/` for future re-enable.
// import { TopSegmentsByCategory } from "../components/analytics/TopSegmentsByCategory";
import { useFilterSegments } from "../hooks/useFilterSegments";
import { useSegmentMembership } from "../hooks/useSegmentMembership";

/** How many segments to probe for membership. The component itself
 *  shows only the top 8 by problem count, but we need to query a
 *  wider candidate pool so the ranking is meaningful. Matches the
 *  cap the Segments-grouped Overview uses. */
const MAX_SEGMENTS_TO_RANK = 20;

// ── Helpers ─────────────────────────────────────────────────────────

/** Composite urgency score — same intuition as the Incidents page's
 *  Show By "Criticality" mode, multiplied by age (longer = worse) and
 *  entity blast radius. Tweakable; documented as the contract for
 *  what "priority" means on this page. */
function priorityScore(p: Problem): number {
  if (p["event.status"] !== "ACTIVE") return 0;
  const sev   = Math.max(1, parseInt(String(p["event.severity"] || "1"), 10));
  const ageH  = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
  const ents  = Math.max(1, (p.affected_entity_ids || []).length);
  return sev * Math.max(0.5, ageH) * Math.sqrt(ents);
}

// (Sparkline was extracted into `components/Sparkline.tsx`.)

// ── Page ─────────────────────────────────────────────────────────────

export const TrendAnalysis = () => {
  const navigate = useNavigate();
  // Mobile/tablet detection — used to relocate the SegmentSelector
  // from the header's left cluster to the right cluster (next to
  // the TimeframeSelector) on small viewports.
  const { isMobileOrTablet } = useDevice();

  // ── Filter / timeframe / refresh — mirror the Overview pattern ──
  // Default: **Today** (UTC start-of-day → now). Mirrors Overview's
  // default so navigating between Incidents and Trends doesn't
  // silently widen the window on the user.
  const initialTimeframe = useMemo<Timeframe>(() => {
    const now = new Date();
    const startOfDayUtc = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0,
    ));
    return {
      from: { absoluteDate: startOfDayUtc.toISOString(), value: "@d",    type: "expression" },
      to:   { absoluteDate: now.toISOString(),           value: "now()", type: "expression" },
    };
  }, []);
  const [timeframe, setTimeframe] = useState<Timeframe | null>(initialTimeframe);
  const { selectedRange, clearRange, handleRangeSelect } = useTimeRange();

  // Clear any leftover brush range on mount. Drilldowns FROM this
  // page (chart bucket-click / metric-line-click) set
  // `selectedRange` so the destination Incidents list filters to
  // the right window. But that same range used to leak BACK when
  // the user returned to Analytics — the chart then re-rendered
  // for the narrower window (showing the drilldown timeframe
  // instead of the page's own 30 d default). Mount-time clear
  // means: returning to Analytics always shows the full timeframe
  // view; drilldowns are one-shot.
  useEffect(() => {
    clearRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTimeframeChange = useCallback((v: Timeframe | null) => {
    setTimeframe(v);
    clearRange();
  }, [clearRange]);

  // Davis-category filter — read EARLY so it can be forwarded to
  // `useProblems` as a server-side filter (Fase B). Falls back to
  // a client-side filter below for defence-in-depth.
  const { filter: categoryFilter, status: statusFilter } = useCategoryFilterOnly();
  const setCategoryCounts = useSetCategoryCounts();
  const categoriesArr = useMemo(() => Array.from(categoryFilter), [categoryFilter]);

  const timeframeOnlyFilter = useMemo(() => {
    // Drilldown chart brush wins over the picker (same precedence
    // rule as Overview.tsx).
    if (selectedRange) {
      return {
        from: selectedRange.from.toISOString(),
        to:   selectedRange.to.toISOString(),
      } as { timeframe?: string; from?: string; to?: string };
    }
    // Use the shared parser so every Strato preset shape
    // (`now()-Xunit`, `@d`, custom ISO, …) is honoured. See
    // utils/timeframe.test.ts for exhaustive coverage.
    return parseStratoTimeframe(timeframe);
  }, [timeframe, selectedRange]);
  const problemsFilter = useMemo(() => ({
    categories: categoriesArr,
    ...timeframeOnlyFilter,
  }), [categoriesArr, timeframeOnlyFilter]);

  // Opt-out of the Load-more pagination cap: every widget on this
  // page is an AGGREGATION over the full problem set (MTTR by
  // category, top root causes, aging buckets, …). A 500-record cap
  // would silently bias all those KPIs. Setting the limit to the
  // hard ceiling restores legacy "fetch up to 10 000" behaviour
  // without needing a separate hook.
  const {
    problems: tenantProblems,
    loading: rawLoading,
    fetching: rawFetching,
    refetch,
  } = useProblems(problemsFilter, { initialLimit: 10_000 });
  const loading = useDelayedLoading(rawLoading, 500, 200);

  // With Fase B the server already filtered the main query by
  // category when chips are active, so the filter below is normally
  // an idempotent no-op. Kept as defence in depth if the server-side
  // filter ever returns extra records.
  const problems = useMemo(() => {
    if (categoryFilter.size === 0) return tenantProblems;
    return tenantProblems.filter((p) => categoryFilter.has(p["event.category"]));
  }, [tenantProblems, categoryFilter]);

  // ── Team metrics (MTTA / MTTR / MTBF / MTTF) ─────────────────────
  // Lives here in Analytics so the page is the single home for
  // "how is the team performing?". Previously this card sat on the
  // Timeline page; A3 of the UX consolidation retires that page and
  // promotes the card to its natural analytical home.
  //
  // Chart window override: pin the X-axis to the user's effective
  // timeframe (selectedRange || timeframe → ms). Without this the
  // chart silently re-derives the window from the data, and any
  // long-running problem that leaked into the dataset via DQL's
  // "active during" filter would stretch the axis way past the
  // user's intended range — making the actual timeframe look like
  // a sliver of dead space.
  const teamMetricsWindow = useMemo(() => {
    const now = Date.now();
    if (selectedRange) {
      return { from: selectedRange.from.getTime(), to: Math.min(now, selectedRange.to.getTime()) };
    }
    if (!timeframe) {
      return { from: now - 72 * 3600 * 1000, to: now };
    }
    const m = /^-?(\d+)([hd])$/.exec(timeframe.from.value || "");
    if (m && (timeframe.to.value === "now" || timeframe.to.value === "now()")) {
      const n = parseInt(m[1], 10);
      const unit = m[2] === "h" ? 3600 * 1000 : 86_400 * 1000;
      return { from: now - n * unit, to: now };
    }
    // Absolute pickers fall back to the explicit ISO strings.
    const from = timeframe.from.absoluteDate ? new Date(timeframe.from.absoluteDate).getTime() : now - 72 * 3600 * 1000;
    const to   = timeframe.to.absoluteDate   ? new Date(timeframe.to.absoluteDate).getTime()   : now;
    return { from, to };
  }, [timeframe, selectedRange]);
  const teamMetrics = useTeamMetrics(problems, {
    windowFromMs: teamMetricsWindow.from,
    windowToMs:   teamMetricsWindow.to,
  });

  // Per-category counts for the shared chip strip — sourced from a
  // SEPARATE light DQL aggregation so the badges keep showing real
  // numbers even when the chip filter has narrowed the main query
  // to a single category. Status follows the FILTERS strip's Active/
  // Closed chip (ACTIVE if no chip is selected). Matches the same
  // behaviour as Overview.tsx.
  const { counts: activeCountsByCategory } = useCategoryCounts({
    status: statusFilter ?? "ACTIVE",
    ...timeframeOnlyFilter,
  });
  useEffect(() => {
    setCategoryCounts(activeCountsByCategory);
  }, [activeCountsByCategory, setCategoryCounts]);

  // ── Segments + membership for the "Top segments by category"
  // section. Reads the tenant's filter-segment catalog, drops
  // parameterised segments (they require variables the user must
  // supply — DQL otherwise rejects them with
  // FILTER_SEGMENT_REQUIRES_VARIABLE), and fetches the per-segment
  // problem-id membership map. The hook caches by (uid + filterKey)
  // for 60 s so navigation between Analytics ↔ Segments-grouped
  // Overview is essentially free.
  const { segments: realSegCatalog, loading: realSegCatalogLoading } = useFilterSegments();
  const segCatalog        = realSegCatalog;
  const segCatalogLoading = realSegCatalogLoading;
  const segmentUidsToQuery = useMemo(
    () => segCatalog
      .filter((s) => !(s as { variables?: unknown }).variables)
      .slice(0, MAX_SEGMENTS_TO_RANK)
      .map((s) => s.uid),
    [segCatalog],
  );
  const { membership: realSegMembership, loading: realSegMembershipLoading } =
    useSegmentMembership(segmentUidsToQuery, problemsFilter);
  const segMembership        = realSegMembership;
  const segMembershipLoading = realSegMembershipLoading;
  const segSectionLoading = segCatalogLoading || segMembershipLoading;

  const [lastRefreshAt, setLastRefreshAt] = useState<number>(() => Date.now());
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<number>(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const pageVisible = usePageVisible();
  useEffect(() => {
    if (!pageVisible) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [pageVisible]);
  const triggerRefresh = useTriggerRefresh();
  useEffect(() => {
    if (refreshIntervalSec <= 0 || !pageVisible) return;
    const t = window.setInterval(() => {
      refetch();
      triggerRefresh();
      setLastRefreshAt(Date.now());
    }, refreshIntervalSec * 1000);
    return () => window.clearInterval(t);
  }, [refreshIntervalSec, refetch, triggerRefresh, pageVisible]);
  // Reset the "refreshed ago" clock when an in-flight fetch
  // completes — `rawFetching` (not `rawLoading`) so manual refresh
  // + auto-refresh both reset the counter, not just the first load.
  useEffect(() => { if (!rawFetching) setLastRefreshAt(Date.now()); }, [rawFetching]);
  const refreshedAgoLabel = useMemo(() => {
    const sec = Math.max(0, Math.floor((nowTick - lastRefreshAt) / 1000));
    if (sec < 60)    return `${sec}s ago`;
    if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }, [lastRefreshAt, nowTick]);

  // ── Derived window range (ms) for sparklines ───────────────────────
  const windowRange = useMemo<{ from: number; to: number }>(() => {
    const now = Date.now();
    if (selectedRange) return { from: selectedRange.from.getTime(), to: Math.min(now, selectedRange.to.getTime()) };
    const fromIso = timeframe?.from.absoluteDate;
    const toIso   = timeframe?.to.absoluteDate;
    return {
      from: fromIso ? Date.parse(fromIso) : now - 72 * 3600_000,
      to:   toIso   ? Math.min(now, Date.parse(toIso)) : now,
    };
  }, [timeframe, selectedRange]);

  // ── KPI values — sourced from the shared catalog. Each catalog
  // entry returns { value, series, delta } using accurate per-bucket
  // computations + a stable rolling delta (last 25 % vs prior 25 %).
  const kpis = useMemo(() => {
    const opts = { stuckHours: 4 };
    return {
      active:  KPI_CATALOG.active .compute(problems, windowRange, opts),
      mttr:    KPI_CATALOG.mttr   .compute(problems, windowRange, opts),
      resRate: KPI_CATALOG.resRate.compute(problems, windowRange, opts),
      stuck:   KPI_CATALOG.stuck  .compute(problems, windowRange, opts),
    };
  }, [problems, windowRange]);

  // ── Priority queue ─────────────────────────────────────────────────
  const priorityQueue = useMemo(() => {
    return [...problems]
      .filter((p) => p["event.status"] === "ACTIVE")
      .map((p) => ({ p, score: priorityScore(p) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }, [problems]);

  // ── Render ─────────────────────────────────────────────────────────
  const openProblem = (p: Problem) => navigate(`/?focus=${p.display_id}`);

  return (
    <div className="neo-analytics-page">
      <header className="neo-header">
        <div className="neo-header-left">
          {/* SegmentSelector lives on the LEFT on desktop; on
              mobile it relocates next to TimeframeSelector below. */}
          {!isMobileOrTablet && <SegmentSelector />}
          <DisplaySettingsPanel inline />
        </div>
        <div className="neo-header-right">
          {isMobileOrTablet && (
            <div className="neo-seg-slot">
              <SegmentSelector />
            </div>
          )}
          {/* 0.0.261 — Wrapped in `.neo-tf-slot` so the narrow-
              viewport CSS in theme.css can force the timeframe
              row to span both grid columns. Without this the
              "Today" label clipped to "T..." on Z Fold cover
              when clicking into Trends (Overview already had
              the wrapper from v0.0.240). */}
          <div className="neo-tf-slot">
            <TimeframeSelector value={timeframe} onChange={handleTimeframeChange} clearable={false} />
          </div>
          <div className="neo-refresh-group" role="group" aria-label="Refresh controls">
            <button
              type="button"
              className="neo-refresh-btn"
              onClick={() => { refetch(); triggerRefresh(); }}
              disabled={rawFetching}
              title="Refresh now"
              aria-label="Refresh now"
            >
              <span className={`neo-refresh-icon${rawFetching ? " neo-refresh-icon-spinning" : ""}`} aria-hidden="true">↻</span>
            </button>
            <select
              className="neo-refresh-interval"
              value={refreshIntervalSec}
              onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
              title="Auto refresh interval"
            >
              <option value={0}>Auto-refresh: Off</option>
              <option value={30}>Every 30s</option>
              <option value={60}>Every 1m</option>
              <option value={300}>Every 5m</option>
              <option value={1800}>Every 30m</option>
            </select>
            <span className="neo-refresh-status">refreshed {refreshedAgoLabel}</span>
          </div>
        </div>
      </header>

      {/* Shared category-filter chip strip — same instance used on
          Incidents / Segments. State lives in the global context so
          the user's selection survives page navigation. */}
      <div className="neo-sticky-filter">
        <CategoryFilterChips />
      </div>

      {/* ═══ TEAM METRICS — MTTA / MTTR / MTBF / MTTF + evolution ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">Team performance</div>
        <TeamMetricsCard
          problems={problems}
          teamMetrics={teamMetrics}
          /* Card drilldown — clicking any of the 4 KPI cards
             (MTTA / MTTR / MTBF / MTTF) navigates to the Incidents
             list filtered to "has metric: <key>" so the user can see
             the actual problems that contributed to the figure.
             Mirrors the AT A GLANCE drilldown pattern below — same
             URL contract (`?metric=<key>`), parsed by Overview.tsx
             at mount. */
          onCardDrillDown={(metric) => navigate(`/?view=list&metric=${metric}`)}
          /* Brush-to-zoom: writes the selected window into the
             shared `selectedRange` (same context the drilldowns
             already use). `useTeamMetrics` re-runs through the
             page-level `timeframeOnlyFilter` memo above with the
             narrower window, so the next render gets finer bucket
             sizing (see `pickBucketMs` in useTeamMetrics) and the
             overlapping dots fan out naturally. */
          onZoomRangeSelect={(fromMs, toMs) => {
            handleRangeSelect(new Date(fromMs), new Date(toMs));
          }}
          zoomed={!!selectedRange}
          onResetZoom={clearRange}
          onBucketClick={(startMs, endMs) => {
            // Drill into Incidents pre-filtered to this bucket's
            // [start, end] window. `handleRangeSelect` writes to the
            // shared `useTimeRange` context — Overview reads it on
            // mount and builds its `problemsFilter` from it, so the
            // list shows only problems whose `event.start` falls in
            // this bucket. Navigation preserves the user's category
            // chip selection (also in shared context).
            handleRangeSelect(new Date(startMs), new Date(endMs));
            navigate("/?view=list");
          }}
          onMetricClick={(metric, startMs, endMs) => {
            // Drill into Incidents filtered to problems that
            // contributed to THIS data point on the metric line —
            // i.e. problems whose `event.start` falls inside the
            // bucket the cursor was over AND that have this
            // metric defined.
            // When the click happens off-bucket (no hover state)
            // we fall back to "any problem with this metric
            // defined" across the current timeframe.
            if (startMs !== null && endMs !== null) {
              handleRangeSelect(new Date(startMs), new Date(endMs));
            }
            navigate(`/?view=list&metric=${metric}`);
          }}
        />
      </section>

      {/* ═══ KPI HERO STRIP ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">At a glance</div>
        <div className="neo-kpi-strip">
          <KpiCard
            label={KPI_CATALOG.active.label}
            value={kpis.active.value}
            color={KPI_CATALOG.active.color}
            series={kpis.active.series}
            delta={kpis.active.delta}
            deltaSuffix={KPI_CATALOG.active.deltaSuffix}
            deltaInverse={KPI_CATALOG.active.deltaInverse}
            tooltip={KPI_CATALOG.active.tooltip}
            range={windowRange}
            onDrillDown={() => navigate("/?view=list&status=ACTIVE")}
            drilldownLabel="Click to see the active problems"
          />
          <KpiCard
            label={KPI_CATALOG.mttr.label}
            value={kpis.mttr.value}
            color={KPI_CATALOG.mttr.color}
            series={kpis.mttr.series}
            delta={kpis.mttr.delta}
            deltaSuffix={KPI_CATALOG.mttr.deltaSuffix}
            deltaInverse={KPI_CATALOG.mttr.deltaInverse}
            tooltip={KPI_CATALOG.mttr.tooltip}
            range={windowRange}
            /* MTTR was computed from CLOSED problems in the window —
               drill into that exact cohort so users can see WHICH
               problems produced the average. */
            onDrillDown={() => navigate("/?view=list&status=CLOSED")}
            drilldownLabel="Click to see the resolved cohort behind this average"
          />
          <KpiCard
            label={KPI_CATALOG.resRate.label}
            value={kpis.resRate.value}
            color={KPI_CATALOG.resRate.color}
            series={kpis.resRate.series}
            delta={kpis.resRate.delta}
            deltaSuffix={KPI_CATALOG.resRate.deltaSuffix}
            deltaInverse={KPI_CATALOG.resRate.deltaInverse}
            tooltip={KPI_CATALOG.resRate.tooltip}
            range={windowRange}
            /* Resolution rate = closed/opened — same cohort as MTTR
               for the click target. */
            onDrillDown={() => navigate("/?view=list&status=CLOSED")}
            drilldownLabel="Click to see the resolved problems"
          />
          <KpiCard
            label={`Stuck > 4h`}
            value={kpis.stuck.value}
            color={KPI_CATALOG.stuck.color}
            series={kpis.stuck.series}
            delta={kpis.stuck.delta}
            deltaSuffix={KPI_CATALOG.stuck.deltaSuffix}
            deltaInverse={KPI_CATALOG.stuck.deltaInverse}
            tooltip={KPI_CATALOG.stuck.tooltip}
            range={windowRange}
            /* Stuck = ACTIVE problems older than the threshold —
               the dedicated `stuck` URL param combines both
               conditions in Overview's filter predicate. */
            onDrillDown={() => navigate("/?view=list&status=ACTIVE&stuck=4")}
            drilldownLabel="Click to see the stuck problems"
          />
        </div>
      </section>

      {/* ═══ PRIORITY QUEUE ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">
          Priority queue
          <span className="neo-analytics-section-sub" title="severity × age × √entities">
            top {priorityQueue.length} active · severity × age × blast radius
          </span>
        </div>
        {loading && problems.length === 0 ? (
          <div className="neo-priority-list" role="list" aria-busy="true" aria-label="Loading priority queue">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="neo-priority-row" role="listitem">
                <Skeleton width="2.5rem" height="2.5rem" variant="rounded" />
                <div style={{ flex: 1, marginLeft: 12 }}>
                  <SkeletonText lines={2} />
                </div>
              </div>
            ))}
          </div>
        ) : priorityQueue.length === 0 ? (
          <div className="neo-analytics-empty">No active problems in this window — nothing to prioritise.</div>
        ) : (
          <div className="neo-priority-list" role="list">
            {priorityQueue.map(({ p, score }, idx) => {
              const cat = p["event.category"];
              const color = categoryColorFor(p);
              const sev = parseInt(String(p["event.severity"] || "0"), 10);
              const ents = (p.affected_entity_ids || []).length;
              const entFirst = p.affected_entity_names?.[0] || p.affected_entity_ids?.[0] || "";
              const root = p.root_cause_entity_name || p.root_cause_entity_id || "";
              const dur  = formatDuration(p["event.start"], p["event.end"]);
              const impact = getImpactLabel(p.affected_entity_ids);
              return (
                <button
                  key={p.display_id}
                  type="button"
                  className="neo-priority-row"
                  role="listitem"
                  onClick={() => openProblem(p)}
                  style={{ ["--prio-accent" as string]: color }}
                >
                  <span className="neo-priority-rank">{idx + 1}</span>
                  <span className="neo-priority-accent" aria-hidden="true" />
                  <span className="neo-priority-id">{p.display_id}</span>
                  <span className="neo-priority-name" title={p["event.name"]}>{p["event.name"]}</span>
                  <span className="neo-priority-cat" style={{ color }}>{getCategoryLabel(cat)}</span>
                  <span className={`neo-priority-sev neo-priority-sev-${sev}`}>sev {sev || "?"}</span>
                  <span className="neo-priority-dur">{dur}</span>
                  <span className="neo-priority-ents">
                    {ents} {ents === 1 ? "entity" : "entities"}
                    {entFirst && <span className="neo-priority-ents-first">{` · ${entFirst}`}</span>}
                  </span>
                  <span className="neo-priority-root" title={root || ""}>{root ? `↳ ${root}` : ""}</span>
                  <span className="neo-priority-started">{formatStartedDate(p["event.start"])}</span>
                  <span className="neo-priority-impact" title={impact?.label || ""}>
                    {impact?.label || "—"}
                  </span>
                  <span className="neo-priority-score" title={`Priority score ${score.toFixed(1)}`}>
                    {Math.round(score)}
                  </span>
                  <span className="neo-priority-cta" aria-hidden="true">→</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ═══ WHERE TO LOOK ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">
          Where to look
          <span className="neo-analytics-section-sub">entities + root causes with the most problems in the window</span>
        </div>
        <div className="neo-analytics-grid-2">
          <div className="neo-analytics-subsection">
            <div className="neo-analytics-subsection-title">Top affected entities</div>
            <PainEntities problems={problems} />
          </div>
          <div className="neo-analytics-subsection">
            <div className="neo-analytics-subsection-title">Top root causes (Davis)</div>
            <TopRootCauses problems={problems} />
          </div>
        </div>
      </section>

      {/* ═══ OPERATIONAL PAIN SHAPE ═══ */}
      <section className="neo-analytics-section">
        <div className="neo-analytics-section-title">
          Operational pain
          <span className="neo-analytics-section-sub">where resolution time grows and how active problems age</span>
        </div>
        <div className="neo-analytics-grid-2">
          <div className="neo-analytics-subsection">
            <div className="neo-analytics-subsection-title">MTTR by category</div>
            <MttrByCategory problems={problems} />
          </div>
          <div className="neo-analytics-subsection">
            <div className="neo-analytics-subsection-title">Aging of active problems</div>
            <AgingBuckets problems={problems} />
          </div>
        </div>
      </section>

      {/* 0.0.121 — Top Segments section removed. User asked to drop
          it in lockstep with the v0.0.120 / v0.0.121 segment
          cleanup (DPS gate on useSegmentMembership + removal of
          the Segments column on the incidents list). With those
          two changes the membership map is empty in production,
          so this section would render an empty card anyway. The
          underlying `<TopSegmentsByCategory>` component stays in
          the repo for future re-enable when segments are wired
          back through a leaner data path. */}
    </div>
  );
};

// ── KPI card ────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  color: string;
  series: number[];
  delta: number;
  deltaSuffix: string;
  /** When true, an INCREASE is "bad" (red) and a decrease is "good"
   *  (green) — true for Active, MTTR, Stuck. False for Resolution
   *  rate where higher is better. */
  deltaInverse: boolean;
  tooltip?: string;
  /** Drilldown handler — when wired, the card becomes a button that
   *  navigates to the Incidents list filtered to the cohort this
   *  KPI was computed from. When omitted, the card stays a static
   *  div (matches the old read-only behaviour). */
  onDrillDown?: () => void;
  /** Optional CTA label appended to the title hint when drilldown
   *  is wired — e.g. "Click to see active problems". */
  drilldownLabel?: string;
  /** Window the sparkline series spans (ms timestamps). Threaded
   *  through to the Sparkline so its hover tooltip can label each
   *  bucket with its timestamp. */
  range?: { from: number; to: number };
}

const KpiCard: React.FC<KpiCardProps> = ({ label, value, color, series, delta, deltaSuffix, deltaInverse, tooltip, onDrillDown, drilldownLabel, range }) => {
  const sign = delta > 0 ? "▲" : delta < 0 ? "▼" : "•";
  const goodChange = deltaInverse ? delta < 0 : delta > 0;
  const badChange  = deltaInverse ? delta > 0 : delta < 0;
  const deltaColor = goodChange ? "#22d3a0" : badChange ? "#ff4d6a" : "#94a3b8";
  const absDelta   = Math.abs(delta);
  const deltaText = deltaSuffix === "h"
    ? absDelta.toFixed(1)
    : Math.round(absDelta).toString();
  const combinedTitle = onDrillDown && drilldownLabel
    ? (tooltip ? `${tooltip}\n\n${drilldownLabel}` : drilldownLabel)
    : tooltip;

  // While the cursor sits over the sparkline, suppress the host
  // card's native `title=` tooltip — otherwise the browser's slow
  // native bubble pops up after ~1.5 s and covers the inline
  // sparkline value tooltip. Restored on mouseleave so the card-
  // level description still appears when hovering elsewhere on
  // the card (label / value / delta chip).
  const [sparkHovered, setSparkHovered] = React.useState(false);
  const effectiveTitle = sparkHovered ? undefined : combinedTitle;

  // Choose element by whether drilldown is wired so the read-only
  // branch stays semantically a `<div>` (skipped by tab focus +
  // screen readers) and the interactive branch is a proper
  // `<button>` with keyboard activation + ARIA semantics for free.
  const inner = (
    <>
      <div className="neo-kpi-card-label">{label}</div>
      <div className="neo-kpi-card-value-row">
        <span className="neo-kpi-card-value" style={{ color }}>{value}</span>
        <span
          /* `key` re-mounts the chip whenever the trend direction
             flips so the CSS pulse-in animation runs fresh — same
             pattern the mobile rings strip uses. Without this, going
             from ▲ +5 to ▼ -3 would mutate in place without any
             visual cue that the direction changed. */
          key={`${sign}-${delta}`}
          className={`neo-kpi-card-delta neo-kpi-card-delta-${
            delta > 0 ? "up" : delta < 0 ? "down" : "flat"
          }`}
          style={{ color: deltaColor }}
          title="last 25% vs prior 25% of the window"
        >
          <span className="neo-kpi-card-delta-arrow" aria-hidden="true">{sign}</span>
          {" "}{deltaText}{deltaSuffix}
        </span>
      </div>
      <div
        className="neo-kpi-card-spark"
        onMouseEnter={() => setSparkHovered(true)}
        onMouseLeave={() => setSparkHovered(false)}
      >
        {/* `valueSuffix={deltaSuffix}` re-uses the card's existing
            unit hint (h / % / "") so the tooltip prints e.g.
            "0.3h · May 21, 14:00" without an extra prop wiring. */}
        <Sparkline
          values={series}
          color={color}
          height={48}
          width={200}
          range={range}
          valueSuffix={deltaSuffix}
        />
      </div>
      {onDrillDown && (
        <span className="neo-kpi-card-cta" aria-hidden="true">→</span>
      )}
    </>
  );
  if (onDrillDown) {
    return (
      <button
        type="button"
        className="neo-kpi-card neo-kpi-card-interactive"
        title={effectiveTitle}
        style={{ ["--neo-kpi-accent" as string]: color }}
        onClick={onDrillDown}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      className="neo-kpi-card neo-kpi-card-static"
      title={sparkHovered ? undefined : tooltip}
      style={{ ["--neo-kpi-accent" as string]: color }}
    >
      {inner}
    </div>
  );
};
