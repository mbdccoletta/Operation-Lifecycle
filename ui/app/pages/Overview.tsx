import React, { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useProblems, Problem } from "../hooks/useProblems";
import { useProblemTrend } from "../hooks/useProblemTrend";
import { useTimeRange } from "../hooks/useTimeRange";
import { SegmentSelector, TimeframeSelector } from "@dynatrace/strato-components-preview/filters";
import type { Timeframe } from "@dynatrace/strato-components-preview/core";
import {
  getCategoryLabel,
  getCategoryIcon,
  formatDuration,
  formatStartedDate,
  formatRelativeTime,
  getImpactLabel,
  entityTypeOf,
  entityTypeLabel,
  shortEntityId,
} from "../utils/formatters";
import { buildOfficialProblemUrl, buildAppShareUrl } from "../utils/dynatrace-links";
import { ShareWhatsApp } from "../components/ShareWhatsApp";
import { ProblemActivityFeed } from "../components/ProblemActivityFeed";
import { MobileIncidentList } from "../components/MobileIncidentList";
import { DisplaySettingsPanel } from "../components/DisplaySettingsPanel";
import { useDevice } from "../hooks/useDevice";
import { useTeamMetrics } from "../hooks/useTeamMetrics";
import { CopyChip } from "../components/CopyChip";
import { CategoryFilterChips } from "../components/CategoryFilterChips";
import { RefreshStatus } from "../components/RefreshStatus";
import { LoadMoreFooter } from "../components/LoadMoreFooter";
import { ProblemSearch } from "../components/ProblemSearch";
import { useCategoryFilterOnly, useSetCategoryCounts } from "../contexts/CategoryFilterContext";
import { useTriggerRefresh } from "../contexts/RefreshSignalContext";
// IntensityContext is consumed by the global DisplaySettingsPanel
// (rendered in App.tsx); Overview no longer reads it directly.
import { useCategoryCounts } from "../hooks/useCategoryCounts";
import { useStatusCategoryCounts } from "../hooks/useStatusCategoryCounts";
import { parseStratoTimeframe, parseStratoTimeframeAsString } from "../utils/timeframe";
import { getStatusLabel } from "../utils/formatters";
import { usePageVisible, useDelayedLoading } from "../hooks/useUiUtils";
import { scoreOf, pickTopTier, TOP_TIER_THRESHOLD } from "../utils/scoring";
import {
  SEVERITY_COLORS,
  getSeverity as getSeverityLevel,
} from "../utils/filters";
import { ConstellationView } from "../components/ConstellationView";
import { PinnedBanners } from "../components/PinnedBanners";
import { PulseVisualizer } from "../components/PulseVisualizer";
import { QuadrantDetailPanel } from "../components/QuadrantDetailPanel";
import { EnlargedQuadrantCard } from "../components/EnlargedQuadrantCard";
import type { Grouping } from "../utils/grouping";
import {
  CATEGORY_GROUPINGS,
  UNASSIGNED_GROUPING,
  colorForName,
  resolveByCategory,
  resolveBySegmentMembership,
  segmentsToGroupings,
} from "../utils/grouping";
import { useFilterSegments } from "../hooks/useFilterSegments";
import { APP_VERSION_TAG } from "../utils/logger";
import { useSegmentMembership, clearSegmentMembershipCache } from "../hooks/useSegmentMembership";

type ViewMode = "neural" | "list";
export type OverviewGroupBy = "category" | "segment";

// How many top segments to show as quadrants when groupBy="segment".
// The Segments view drops the central hub and uses a denser grid
// (up to 3 rows × 4 cols) so 12 slots fit comfortably; the +N "more"
// chip surfaces anything beyond that.
const TOP_SEGMENTS_N = 12;
// Maximum segments to fetch membership for. We query each in parallel
// to learn its active count, then pick the top-N for the quadrants.
// Higher = more bandwidth but stable ranking; cap chosen to keep the
// total parallel-query count reasonable on slow connections.
const MAX_SEGMENTS_TO_RANK = 30;

function getUrgencyScore(p: Problem): number {
  if (p["event.status"] !== "ACTIVE") return 0;
  const hours = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
  return hours * (p.affected_entity_ids?.length || 1);
}

// Parse a Strato timeframe expression part — used for URL hydration.
// Accepts relative `-Xh` / `-Xd` (-> now-X) or full ISO timestamps.
// Returns null when unparseable; the caller falls back to the default.
function parseTfPart(value: string): Date | null {
  const rel = /^-(\d+)([hd])$/.exec(value);
  if (rel) {
    const n   = parseInt(rel[1], 10);
    const ms  = (rel[2] === "h" ? 3600 : 86400) * 1000 * n;
    return new Date(Date.now() - ms);
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

function getSeverity(start: string): "crit" | "warn" | "ok" {
  const hours = (Date.now() - new Date(start).getTime()) / 3600000;
  if (hours > 4) return "crit";
  if (hours > 1) return "warn";
  return "ok";
}

type SortMode = "urgency" | "newest" | "oldest" | "duration" | "impact" | "segment" | "entity";
type ConstellationMode = "rising" | "open_time" | "criticality" | "total";

// Picking a sort order in the list view also tells the constellation
// (above the chart) what "Show by" mode best matches that intent — so a
// user who sorts by "Newest first" sees the constellation rising-mode
// highlights, sorting by "Longest duration" highlights Open Time, etc.
// The list has 5 options vs the constellation's 4, so two sort modes
// (oldest / duration) both map to "open_time".
// `satisfies` (TS 4.9+) lets TypeScript verify exhaustiveness at
// compile time without widening the value types: adding a new
// `SortMode` and forgetting to extend this map is now a type error.
const SORT_TO_SHOW = {
  urgency:  "criticality",
  newest:   "rising",
  oldest:   "open_time",
  duration: "open_time",
  impact:   "total",
  // "segment" doesn't map to a constellation mode — it's a list-only
  // organising mode. Pick "total" as the safest default so the
  // canvas still has SOMETHING to render when the user picks
  // "Segment" while viewing the constellation in another tab.
  segment:  "total",
  // Same reasoning as "segment" — entity grouping is a list-only
  // concept (the constellation already bins by category quadrants,
  // there's no entity-level rendering).
  entity:   "total",
} as const satisfies Record<SortMode, ConstellationMode>;

// Mirrors the constellation's leader logic, parameterised by the
// active grouping list. The chart's pulse / highlight system uses this
// to know which grouping(s) are currently being emphasised so it can
// paint matching strip blocks above the bars.
function computeLeaderCats(
  problems: Problem[],
  mode: ConstellationMode,
  groupings: Grouping[],
  resolve: (p: Problem) => string | null,
): Set<string> {
  if (problems.length === 0) return new Set();

  const ALL_IDS = groupings.map((g) => g.id);

  // Per-grouping 1 h trend — also used by ConstellationView's isFalling
  // check. We replicate it here so the chart's leader set exactly
  // matches the quadrants that get a ★ TOP / ▲ UP / ▼ DOWN badge.
  const now = Date.now();
  const tCut = now - 3600000;
  const trend: Record<string, { recent: number; older: number }> = {};
  problems.forEach((p) => {
    const id  = resolve(p);
    if (!id) return;
    const b   = (trend[id] ||= { recent: 0, older: 0 });
    const startTs = new Date(p["event.start"]).getTime();
    const endTs   = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
    const activeNow      = p["event.status"] === "ACTIVE";
    const wasActiveAtCut = startTs <= tCut && (activeNow || (endTs !== null && endTs > tCut));
    if (activeNow)       b.recent++;
    if (wasActiveAtCut)  b.older++;
  });
  const isFalling = (id: string) => !!trend[id] && trend[id].recent < trend[id].older;

  // Rising mode — leaders are the groupings with the largest positive
  // (recent − older) delta. Falling groupings are zero by definition,
  // so the isFalling filter isn't needed separately here.
  if (mode === "rising") {
    const deltas = ALL_IDS.map((id) => ({ id, d: (trend[id]?.recent || 0) - (trend[id]?.older || 0) }));
    const max = Math.max(0, ...deltas.map((x) => x.d));
    if (max <= 0) return new Set();
    return new Set(deltas.filter((x) => x.d === max).map((x) => x.id));
  }

  // Other modes — aggregate over ACTIVE problems only. We prefer
  // non-falling groupings (a quadrant currently improving shouldn't
  // be highlighted as "the worst" under the active metric), but if
  // the falling filter would eliminate every candidate we fall back
  // to ALL groupings so the user always sees the quadrant with the
  // highest score — even when every group is trending downward.
  const agg: Record<string, number> = {};
  problems.filter((p) => p["event.status"] === "ACTIVE").forEach((p) => {
    const id   = resolve(p);
    if (!id) return;
    const ageH = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
    const sev  = parseInt(String(p["event.severity"] || "0"), 10);
    const cur  = agg[id] ?? 0;
    if (mode === "total")             agg[id] = cur + 1;
    else if (mode === "criticality")  agg[id] = Math.max(cur, sev);
    else /* open_time */              agg[id] = Math.max(cur, ageH);
  });
  const entries     = Object.entries(agg);
  const nonFalling  = entries.filter(([id]) => !isFalling(id));
  const candidates  = nonFalling.length > 0 && nonFalling.some(([, v]) => v > 0)
    ? nonFalling
    : entries;
  const max = Math.max(0, ...candidates.map(([, v]) => v));
  if (max <= 0) return new Set();
  return new Set(candidates.filter(([, v]) => v === max).map(([c]) => c));
}

/** Feature flag — hides the "View by" Category/Segment toggle in
 *  the header (and the underlying Segment-view surfaces it gates)
 *  until the Segment view is reactivated. Code paths stay intact
 *  so flipping this back to `true` restores the toggle plus the
 *  Segment column, segment ranking, and the `/segments` route
 *  navigation. Kept here (module scope, not state) so the dead
 *  surfaces are reachable for the codebase tour without any
 *  runtime cost. */
const SHOW_SEGMENT_VIEW = false;

/** Defensive ceiling on how many rows the list view will MOUNT. Real
 *  customer sessions never breach this — `useProblems.HARD_CEILING`
 *  already caps the source at 10 000 and the user has to click
 *  "Load more" all the way up to get there. The cap is here as
 *  belt-and-braces for a future regression that lifts the source
 *  cap, or an unusual deeplink state. Above this, the renderer slices
 *  + shows a "showing N of M" banner advising the user to refine
 *  filters. Without the slice the React reconciliation cost of 50k
 *  rows blocks the main thread for ~20 s on every state change. */
const MAX_RENDER_ROWS = 1_000;

/** Defensive ceiling on when `useTeamMetrics` runs its 4 aggregation
 *  passes. Above this, the hook short-circuits to empty KPIs (see
 *  `useTeamMetrics.ts` `enabled` option). KPIs over 10 k+ problems
 *  aren't actionable anyway — the user should filter first. */
const TEAM_METRICS_CAP = 10_000;

// TODO(strato): consider migrating this page to the Strato `Page` component
// with named regions (Header / Sidebar / Main / Detail) — gives consistent
// app structure as per design/patterns/app-structure.
// TODO(strato): replace the custom severity chips below with the Strato
// `FilterBar` component (design/patterns/filtering) — combines natively
// with `SegmentSelector` and `TimeframeSelector` already in use.
interface OverviewProps {
  /** How problems are bucketed into quadrants. "category" is the Davis
   *  problem-category default; "segment" reads the tenant's filter
   *  segments and groups problems by top-N segments. */
  groupBy?: OverviewGroupBy;
}

/** Trend chip rendered inside each mobile headline card.
 *
 *  Two modes, picked by `mode`:
 *
 *    • `"rate"` (TOTAL, RESOLVED) — both are CUMULATIVE counters
 *      whose underlying number can only go up. `value` is the count
 *      for the last hour (always ≥ 0); chip renders as `+N /1h` (no
 *      ▼ arrow ever — that would visually suggest the counter went
 *      down, which it can't). The arrow bob still plays so the chip
 *      reads as "active". Colour follows `risingIsBad` — red for
 *      TOTAL (new incidents = bad), green for RESOLVED (closures =
 *      good).
 *
 *    • `"delta"` (ACTIVE only) — this IS the one ring whose number
 *      genuinely moves both directions. Chip shows ▲/▼ with sign,
 *      colour flips on direction (ACTIVE rising = red, falling =
 *      green).
 *
 *  Both modes degrade to `— quiet` when the value is exactly 0 so
 *  the strip never shows a meaningless `+0 /1h` chip. */
function MobileRingTrend({
  mode,
  value,
  risingIsBad = true,
}: {
  mode: "rate" | "delta";
  value: number;
  /** Only consulted in `delta` mode. */
  risingIsBad?: boolean;
}) {
  if (value === 0) {
    return (
      <span className="neo-mobile-ring-trend neo-mobile-ring-trend-neutral">
        — quiet
      </span>
    );
  }
  if (mode === "rate") {
    // Always-up chip. `risingIsBad` here just decides the colour —
    // never the arrow direction.
    const cls = risingIsBad ? "neo-mobile-ring-trend-bad" : "neo-mobile-ring-trend-good";
    return (
      <span
        key={`rate-${value}`}
        className={`neo-mobile-ring-trend ${cls} neo-mobile-ring-trend-up`}
      >
        <span className="neo-mobile-ring-trend-arrow" aria-hidden="true">▲</span>
        +{value} /1h
      </span>
    );
  }
  // delta mode
  const isUp   = value > 0;
  const isGood = isUp ? !risingIsBad : risingIsBad;
  const cls = isGood ? "neo-mobile-ring-trend-good" : "neo-mobile-ring-trend-bad";
  const dirCls = isUp ? "neo-mobile-ring-trend-up" : "neo-mobile-ring-trend-down";
  return (
    <span
      key={`delta-${isUp}-${value}`}
      className={`neo-mobile-ring-trend ${cls} ${dirCls}`}
    >
      <span className="neo-mobile-ring-trend-arrow" aria-hidden="true">{isUp ? "▲" : "▼"}</span>
      {isUp ? "+" : ""}{value} /1h
    </span>
  );
}

export const Overview = ({ groupBy = "category" }: OverviewProps) => {
  const navigate = useNavigate();
  // URL-synced view + data mode — picks initial values from search
  // params so a shared URL like `/?view=list&mode=criticality` lands
  // the user in the same state the sender saw. The actual write-back
  // happens in an effect further down so React state stays the
  // single source of truth.
  // Initial viewMode: desktop defaults to constellation ("neural"),
  // mobile/tablet defaults to "list". The constellation view is
  // mouse-precision (apointing tiny dots) and its quadrant labels
  // overlap below ~640 px — the list view's card layout is the
  // right primary surface for touch / narrow viewports. URL
  // hydration further down still overrides this when a `?view=`
  // param is present, so deep-link sharing keeps working.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === "undefined") return "neural";
    // Mirror the same breakpoint useDevice uses (≤ 960 px = tablet
    // or mobile). Read synchronously so the first paint already has
    // the correct mode and we don't flash the constellation before
    // collapsing to the list.
    return window.innerWidth <= 960 ? "list" : "neural";
  });
  const [dataMode, setDataMode] = useState<"rising" | "open_time" | "criticality" | "total">("rising");
  /** Category whose quadrant the user clicked — shows the detail panel. */
  const [quadrantDetail, setQuadrantDetail] = useState<string | null>(null);
  /** 0.0.109: Show-By subset the user clicked on in a sub-bubble.
   *  Threaded through to EnlargedQuadrantCard so the modal pre-
   *  filters to that subset (Rising / Stuck / Critical / Total)
   *  instead of relying on the now-removed global Show By chip. */
  const [enlargedQuadrantMode, setEnlargedQuadrantMode] = useState<
    "rising" | "open_time" | "criticality" | "total" | undefined
  >(undefined);
  /** 0.0.109 follow-up: click on a legend chip (Rising / Stuck /
   *  Critical) highlights the matching sub-bubble across every
   *  cell. Single-select; click the same chip again to clear.
   *  Defaults to "rising" — the most actionable lens on a triage
   *  page (recent additions deserve attention first). */
  const [highlightedSubsetMode, setHighlightedSubsetMode] = useState<
    "rising" | "open_time" | "criticality" | null
  >(() => {
    // 0.0.128 — restore Rising pre-selection ONLY on desktop. On
    // mobile the list lands unfiltered so the user sees every row
    // first; on desktop the constellation has its full visual
    // language to express what "Rising" means, so pre-arming it is
    // helpful (and matches what 0.0.125 originally shipped).
    if (typeof window === "undefined") return "rising";
    return window.innerWidth <= 960 ? null : "rising";
  });
  /** Drives the centered HTML/SVG `<EnlargedQuadrantCard>` — a
   *  separate path from `quadrantDetail` (which opens the list-style
   *  drill-down) and from the canvas `expandedQuadrant` zoom (which
   *  the user explicitly rejected as "still zoom"). This one just
   *  shows the quadrant as a clean enlarged card. */
  const [enlargedQuadrant, setEnlargedQuadrant] = useState<string | null>(null);
  const closeEnlargedQuadrant = useCallback(() => {
    setEnlargedQuadrant(null);
    setEnlargedQuadrantMode(undefined);
  }, []);
  /** Double-clicking the Pulse chart expands it to take a much larger area. */
  const [pulseExpanded, setPulseExpanded] = useState(false);
  // Hoisted up so `handleEmptyClick` (defined further down) can call
  // `clearRange()` to wipe the chart's brushed range when the user clicks
  // anywhere on the page background.
  const { selectedRange, handleRangeSelect, clearRange } = useTimeRange();

  // Mobile/tablet detection — drives the conditional rendering of
  // <MobileIncidentList /> in place of the desktop wide-table.
  // Desktop layout above 960px is untouched.
  const { isMobileOrTablet } = useDevice();

  // Crossing the desktop→mobile breakpoint at runtime (resize,
  // device rotation, picking up a phone while a desktop session is
  // mid-flight) auto-flips out of constellation view. Without this
  // a user rotating from landscape (1024 px, constellation visible)
  // to portrait (640 px) would suddenly see the broken
  // constellation layout the audit flagged. Effect runs only when
  // we ENTER mobile from desktop — the reverse direction (mobile →
  // desktop) keeps the list view since that's still a valid choice.
  useEffect(() => {
    if (isMobileOrTablet && viewMode === "neural") {
      setViewMode("list");
    }
  }, [isMobileOrTablet, viewMode]);

  // 0.0.129 — useState init checks `window.innerWidth <= 960`, but
  // that's unreliable on first render (iOS Safari can report
  // pre-viewport-meta widths; touch tablets in landscape exceed 960
  // but still want the mobile "no pre-select" rule). Once useDevice
  // hydrates the canonical signal we re-evaluate: any mobile/tablet
  // user that arrived with Rising pre-armed gets it cleared. Desktop
  // users that manually selected Rising and then narrow the browser
  // also get reset — acceptable, they can re-pick.
  useEffect(() => {
    if (isMobileOrTablet && highlightedSubsetMode === "rising") {
      setHighlightedSubsetMode(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobileOrTablet]);

  // Broadcast the current view mode on <body> so the shared filter
  // strip (CategoryFilterChips, rendered in App.tsx outside this
  // component) can hide the Active/Closed status chips when the user
  // is on the Constellation view — those chips only narrow the LIST
  // rendering and have no visual meaning on the canvas (every dot is
  // already styled by its own status). Pages other than Incidents
  // don't set this attribute, so the chips remain visible there.
  useEffect(() => {
    document.body.dataset.appView = viewMode;
    return () => {
      delete document.body.dataset.appView;
    };
  }, [viewMode]);

  // ESC collapses the expanded pulse chart
  useEffect(() => {
    if (!pulseExpanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPulseExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pulseExpanded]);
  /** Timeframe — uses Strato's TimeframeSelector value shape so the
   *  picker exposes the same presets (Last 30m, 1h, 2h, Today,
   *  Yesterday, 7d, 30d…) + custom range + Recently used as the rest
   *  of Dynatrace. Default: **Today** — `from: "@d"` (start of UTC
   *  day), `to: "now()"`. Same preset the native Davis Problems app
   *  picks and the most common triage window. The relative-value
   *  strings mirror Strato's preset table at
   *  @dynatrace/strato-components/filters/timeframe-selector/constants/timeframe-presets.js. */
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

  // Convert the Timeframe to the legacy "Xh" / "Xd" string used by
  // useProblemTrend (which uses it in a DQL `now() - {X}` expression)
  // when the lower bound is a simple "-Xh" / "-Xd" relative; falls
  // back to a 24h default for custom ranges that don't map cleanly.
  // Single source of truth for Strato → DQL timeframe translation.
  // See utils/timeframe.ts for the preset coverage (the inline
  // parser this replaced missed `now()-Xd` because Strato's preset
  // file uses that exact shape — see commit "Parse Strato preset
  // format" / `5 vs 35` regression for context).
  const timeframeTrend = useMemo<string>(
    () => parseStratoTimeframeAsString(timeframe),
    [timeframe],
  );

  /** Manual + auto refresh — track when the data was last refetched
   *  so the header can show "refreshed N ago" (auto-refresh off) or
   *  "next refresh in Ns" (auto-refresh on). The live label is
   *  rendered by the `<RefreshStatus>` child, which owns its own
   *  tick so the parent page doesn't re-render every second. */
  const [lastRefreshAt, setLastRefreshAt] = useState<number>(() => Date.now());
  // Auto-refresh default: OFF (0). Audit decision documented in
  // the DPS analysis — turning auto-refresh on multiplies DQL
  // execution by 12× per hour for every open tab. Triage users
  // generally hit ↻ manually when they need fresh data; SREs
  // watching a live incident can opt in to 1m/5m/30m on demand.
  // Keeping the default Off lets a casual viewer open the app on
  // their phone and not silently burn DPS while they're not
  // looking. The dropdown still exposes every option.
  const [refreshIntervalSec, setRefreshIntervalSec] = useState<number>(0); // 0 = off
  const pageVisible = usePageVisible();
  // Selected-problem state removed — clicking a dot navigates directly
  // to /detail/{display_id} now (see onConstellationSelect below).
  const [search, setSearch] = useState("");
  // React 18 concurrent feature: the input updates urgently (keystroke
  // stays instant) while the filter pass against the problem list is
  // marked as non-urgent — React will skip intermediate values during
  // fast typing AND yield to higher-priority work (input echo, scroll,
  // canvas RAF) when the filter is expensive. This is the same pattern
  // the native Strato DataTable uses. Replaces the previous fixed 150 ms
  // debounce, which paid a fixed delay even when the machine could
  // afford to filter sooner.
  // We KEEP the legacy variable name `searchDebounced` (it's read from
  // ~3 places) so the change is local to this declaration.
  const searchDebounced = useDeferredValue(search);
  const [sortMode, setSortMode] = useState<SortMode>("urgency");
  /** Column-header sort. When set, takes precedence over `sortMode`.
   *  Clicking a column header cycles: asc → desc → null (back to the
   *  default Sort-by dropdown order). */
  type ColumnSortKey =
    | "id" | "name" | "status" | "category" | "segment" | "affected"
    | "entities" | "root" | "started" | "end" | "duration" | "impact"
    // "segments" (plural) sorts by the FIRST segment name a problem
    // belongs to, alphabetically. Distinct from "segment" (single)
    // which is the legacy sort for the hidden Segments page where
    // each row carried one canonical segment. Multi-membership cells
    // collapse to their alpha-first name for sort purposes.
    | "segments";
  const [colSort, setColSort] = useState<{ key: ColumnSortKey; dir: "asc" | "desc" } | null>(null);
  const handleColumnSort = useCallback((key: ColumnSortKey) => {
    setColSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  /** List filter — set of category names. Empty set = no filter (show
   *  every category). Multi-value so drill-downs from the constellation
   *  can carry multiple leader categories at once (★ TOP on more than
   *  one quadrant → both end up in the list). */
  const [catFilter, setCatFilter] = useState<Set<string>>(new Set());
  /** Segment-overflow dropdown — true when the "+N more segments" chip's
   *  popover is open. Only relevant in segment mode. */
  const [overflowOpen, setOverflowOpen] = useState(false);
  /** Davis-category filter — sourced from the global context so the
   *  same selection persists across Incidents / Segments / Analytics.
   *  Each page publishes its per-window counts via `setCounts` so the
   *  shared chip strip can show numbers relevant to the current view. */
  // Split-context hooks (M3 in the perf audit) — `useCategoryFilterOnly`
  // re-renders only when the user actually toggles a chip;
  // `useSetCategoryCounts` returns the stable setter so this page
  // can publish its own counts without re-rendering on every count
  // change cascading through the context tree.
  const {
    filter: categoryFilter,
    clear: clearCategoryFilter,
    set: setCategoryFilterCtx,
    status: statusFilter,
    setStatus: setStatusFilter,
  } = useCategoryFilterOnly();
  const setCategoryCounts = useSetCategoryCounts();
  // ESC closes the segment-overflow dropdown
  useEffect(() => {
    if (!overflowOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOverflowOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overflowOpen]);
  // (Status + Impact list filters were removed — the list is now driven
  // purely by drill-down actions from the main page: category click,
  // dot pin, chart brush, severity chips above the chart.)
  /** Row IDs the user has expanded inline. Clicking a row toggles its
   *  membership; expanded rows show the problem's details right below
   *  the row instead of navigating away. */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // Single-row expansion: clicking a closed row OPENS it and closes
  // any other open row in the same pass; clicking the already-open
  // row CLOSES it. Keeping the state shape as a Set (instead of a
  // simple `string | null`) means the existing consumers
  // (`expandedRows.has`, `expandedIds` prop on ConstellationView,
  // related-row banner, focus drilldown) don't need to be touched —
  // only the toggle behaviour changes. Users said long stacks of
  // simultaneously-open rows were hard to navigate on mobile, where
  // a single open card already fills the viewport.
  //
  // Scroll-to-top on open: when a NEW row opens (collapsing whatever
  // was open before), bring its top edge into view. Without this,
  // tapping a card lower on the page leaves the viewport parked
  // wherever it was — usually mid-card or above it — so the user
  // sees the new card's middle, not its header. We scroll BEFORE the
  // collapse-then-open layout shift settles (rAF) so the browser
  // measures the post-collapse position, not the stale pre-collapse
  // one. Both surfaces (desktop `<article>` and mobile `<div>`) carry
  // `data-display-id`, so one selector works on both.
  const toggleRow = useCallback((id: string) => {
    setExpandedRows((prev) => {
      const wasOpen = prev.has(id);
      if (wasOpen) return new Set();
      // Schedule scroll for AFTER the React commit + browser layout
      // pass. Two rAFs because the first fires before layout settles
      // when there's a sibling collapsing in the same tick — the
      // second one runs once heights are accurate.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            `[data-display-id="${CSS.escape(id)}"]`,
          );
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      return new Set([id]);
    });
  }, []);
  /** Activity-feed sort direction per problem id. Defaults to
   *  "asc" (chronological, oldest at top) — the natural reading
   *  order for an incident narrative. Owned at the page level so
   *  the toggle UI can live in the row's actions bar (same row
   *  as Copy ID / Share link / Open Problem App) instead of
   *  duplicating a header inside <ProblemActivityFeed>. */
  const [sortByProblem, setSortByProblem] = useState<Map<string, "asc" | "desc">>(() => new Map());
  const setActivitySort = useCallback((problemId: string, dir: "asc" | "desc") => {
    setSortByProblem((prev) => {
      const next = new Map(prev);
      next.set(problemId, dir);
      return next;
    });
  }, []);
  /** Group-By columns — the new explicit grouping control that
   *  replaced the "Has metric" filter strip (which lost its purpose
   *  when the per-problem Metrics column was removed in 0.0.81).
   *
   *  Array carries column keys in NESTING ORDER. e.g.:
   *    []                 → no grouping; flat list
   *    ["entity"]         → group by first affected entity (1 level)
   *    ["root"]           → group by root cause entity (1 level)
   *    ["entity", "root"] → group by entity, then nested by root cause (2 levels)
   *    ["root", "entity"] → reversed nesting
   *
   *  Initial value lazy-read from `?groupBy=entity,root` so a
   *  bookmarked URL hydrates the chip strip before first render. */
  type GroupByCol = "entity" | "root";
  const ALL_GROUPBY_COLS: ReadonlyArray<GroupByCol> = ["entity", "root"];
  const [groupByColumns, setGroupByColumns] = useState<GroupByCol[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("groupBy");
    if (!raw) return [];
    const parsed = raw.split(",").map((s) => s.trim()).filter((s): s is GroupByCol =>
      s === "entity" || s === "root",
    );
    // Deduplicate while preserving order.
    return Array.from(new Set(parsed));
  });
  /** Toggle a column in/out of the Group-By order. Click a chip
   *  that's already active to remove it; click an inactive one to
   *  append it as the next nesting level. Order matters and is
   *  preserved across toggles. */
  const toggleGroupByColumn = useCallback((col: GroupByCol) => {
    setGroupByColumns((prev) => {
      const idx = prev.indexOf(col);
      if (idx >= 0) return prev.filter((c) => c !== col);
      return [...prev, col];
    });
  }, []);
  /** Drilldown filter from the "At a glance" KPI cards on Trends:
   *  Active / MTTR / Resolution Rate / Stuck > 4h → land here with
   *  the cohort the KPI was computed from preselected.
   *    • `statusFilter`     = "ACTIVE" | "CLOSED" | null  (?status=)
   *    • `stuckHoursFilter` = number | null               (?stuck=)
   *  `statusFilter` now lives in CategoryFilterContext so the shared
   *  filter strip can render Active/Closed chips next to the
   *  category chips. Overview still owns URL hydration / writeback
   *  via the searchParams effects below — context just centralises
   *  the value for cross-component consumption. `stuckHoursFilter`
   *  stays local since no other surface drives it. */
  const [stuckHoursFilter, setStuckHoursFilter] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("stuck");
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  /** Drilldown filters from the WHERE TO LOOK section in Analytics
   *  (Top Affected Entities and Top Root Causes panels):
   *    • `entityFilter` — match problems whose `affected_entity_ids`
   *      includes this id. URL: `?entity=<id>`
   *    • `rceFilter`    — match problems whose `root_cause_entity_id`
   *      equals this id. URL: `?rce=<id>`
   *  Both initialise from URL via lazy useState so the filter applies
   *  before the first render, with no flicker of the unfiltered list. */
  const [entityFilter, setEntityFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("entity");
  });
  const [rceFilter, setRceFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("rce");
  });
  /** Segment drilldown from the Trends page Top Segments card OR
   *  from a chip click in the Incidents list's Segments column. Same
   *  pattern as `entityFilter`/`rceFilter`. URL: `?segment=<uid>`.
   *  Lazy-init from URL so the filter applies before first render. */
  const [segmentFilter, setSegmentFilter] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("segment");
  });
  /** When set, the list collapses to show ONLY this problem — driven by
   *  selecting a dot in the constellation. A banner at the top of the
   *  list lets the user clear it and see the full set again. */
  const [pinnedProblemId, setPinnedProblemId] = useState<string | null>(null);
  const clearPinnedProblem = useCallback(() => setPinnedProblemId(null), []);

  /** Page-level "back to neutral" — clears the pinned problem, every
   *  expanded card, the chart's brushed range selection, and the
   *  expanded-pulse state. Triggered by:
   *   • empty-canvas click in the constellation
   *   • clicks on the page background (not on any interactive element)
   *   • ESC key
   *  Constellation zoom collapse happens inside ConstellationView itself
   *  in response to the same empty click, so that's already handled. */
  const handleEmptyClick = useCallback(() => {
    setPinnedProblemId(null);
    setExpandedRows((prev) => (prev.size === 0 ? prev : new Set()));
    clearRange();
    setPulseExpanded(false);
  }, [clearRange]);

  // Document-level background-click clearing. Fires when the user clicks
  // anywhere on the page that is NOT an interactive element (button, row,
  // chip, input, the constellation canvas, the pulse chart, etc.). The
  // constellation has its own empty-click path via `onEmptyClick`, so we
  // exclude it here to avoid double-firing.
  //
  // Drag-to-select copying needs special handling: a text selection that
  // STARTS inside an expanded row and ENDS outside the row generates a
  // click event on the body — without guarding, that click collapses the
  // very row the user was copying from. We watch mousedown to remember
  // where the gesture began (so a drag's mouseup outside the row isn't
  // treated as a fresh background click) and additionally bail out when
  // the window has any active text selection.
  useEffect(() => {
    const interactiveSelector =
      'button, a, input, select, textarea, [role="button"], [role="row"], ' +
      '.neo-row, .neo-chip, .neo-pcard, .neo-rcard, .neo-row-act, ' +
      // Whole row card — covers the expanded body too, so clicks on
      // comments, stats, entity chips inside the open row don't get
      // treated as "background" and collapse the row.
      '.neo-tcard, .neo-row-body, .neo-row-comments, .neo-comments, ' +
      // Mobile card variants — the touch-form-factor counterpart to
      // `.neo-tcard` + `.neo-row-body`. Without these, tapping the
      // EventSwimlane chip (or any control inside the expanded body)
      // bubbles up to the document handler as an "empty click" and
      // collapses the row the user is interacting with.
      '.neo-mobile-card, .neo-mobile-card-body, .neo-mobile-card-head, ' +
      '.neo-constellation, .neo-pulse-container, .neo-pinned-banner, ' +
      '.neo-detail-card, .neo-qpanel-overlay, .neo-qpanel';
    let mousedownInsideInteractive = false;
    let mousedownX = 0, mousedownY = 0;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      mousedownInsideInteractive = !!(t && t.closest(interactiveSelector));
      mousedownX = e.clientX; mousedownY = e.clientY;
    };
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(interactiveSelector)) return;
      // Drag that started inside an interactive element (row, chip, etc.)
      // → user was likely text-selecting; don't collapse on the trailing
      // click that bubbles up to the body.
      if (mousedownInsideInteractive) return;
      // Cursor moved more than a tiny smudge between down and up → treat
      // as a drag, not a discrete click.
      const dx = e.clientX - mousedownX, dy = e.clientY - mousedownY;
      if (dx * dx + dy * dy > 25) return;     // ~5 px threshold
      // Active text selection anywhere → user is copying.
      const sel = window.getSelection?.();
      if (sel && sel.toString().length > 0) return;
      handleEmptyClick();
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", handler);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("click", handler);
    };
  }, [handleEmptyClick]);

  // ESC key — global "back to neutral" shortcut. Clears the pin and every
  // expanded card. Doesn't touch the pulse-expanded state (that already
  // has its own ESC handler above).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleEmptyClick();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleEmptyClick]);

  // Changing the timeframe dropdown should reset any manual range zoom from
  // the pulse chart — otherwise the manual range keeps overriding the new
  // timeframe and the dropdown appears to do nothing.
  const handleTimeframeChange = useCallback((value: Timeframe | null) => {
    setTimeframe(value);
    clearRange();
  }, [clearRange]);

  /** Convert the active Timeframe into the legacy ProblemFilters shape
   *  expected by useProblems / buildFilteredQuery. When the lower
   *  bound is a simple "-Xh" / "-Xd" and the upper bound is "now",
   *  we pass the short-form `timeframe: "Xh"` so DQL gets a fresh
   *  `now() - X` on each refetch (no client-side staleness). Anything
   *  else falls back to absolute ISO from/to.
   *
   *  We also forward the multi-select chip filter as `categories` so
   *  the server prunes the list before sending it over the wire
   *  (Fase B of the perf cleanup). Chip COUNTS are sourced from a
   *  separate `useCategoryCounts` query below — that keeps the
   *  badges showing real numbers even after chips are activated. */
  const categoriesArr = useMemo(() => Array.from(categoryFilter), [categoryFilter]);
  const timeframeFilter = useMemo(() => {
    // Drilldown chart brush — takes precedence over any picker
    // value because the user just clicked a specific slice on the
    // chart and wants the list narrowed to that exact window.
    if (selectedRange) {
      return {
        from: selectedRange.from.toISOString(),
        to:   selectedRange.to.toISOString(),
      } as { timeframe?: string; from?: string; to?: string };
    }
    // Otherwise translate Strato's value shape. The parser knows
    // about EVERY built-in preset (Today, Last 7 days, Last 30
    // minutes, …) plus the legacy compact form (`-7d`) plus
    // custom absolute ranges. See utils/timeframe.test.ts for the
    // exhaustive list; "5 vs 35 closed Availability problems" was
    // caused by the previous inline parser missing `now()-7d`.
    return parseStratoTimeframe(timeframe);
  }, [timeframe, selectedRange]);

  // 0.0.153 — "Stuck" = active for more than 4 hours. Reverted
  // 0.0.148's timeframe-aware semantic because it created inverted
  // intuition: the SAME problem was "stuck" in "Today" view (started
  // before midnight) but "not stuck" in "Last 7 days" (started this
  // week, after the 7d cutoff). User: "algo errado esta acontecendo
  // com os calculos dos grupos por categoria. Validar." "Stuck" is
  // a property of the problem itself (how long it's been alive),
  // not of the observation window. Threshold matches
  // `stuckHours: 4` used by TrendAnalysis + analyticsKpis. The
  // prop/param infrastructure stays in place so a future opt-in
  // (timeframe-aware via setting) is one line away.
  const stuckCutoffMs = useMemo(
    () => Date.now() - 4 * 3_600_000,
    // Recompute on every refresh so the rolling 4h cursor stays
    // current. Tied to `timeframe`/`selectedRange` so a timeframe
    // change still triggers a fresh memo even though the value
    // doesn't depend on them — keeps downstream consumers honest
    // about cache invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeframe, selectedRange, lastRefreshAt],
  );
  const stuckCutoffIso = useMemo(
    () => new Date(stuckCutoffMs).toISOString(),
    [stuckCutoffMs],
  );
  // Pass `statusFilter` through to the DQL so the list is filtered
  // server-side. Without this, the DQL returns up to DEFAULT_INITIAL
  // (250) records sorted by `event.start desc` — mostly recently-
  // opened CLOSED problems on busy tenants — and the client status
  // filter then narrows that biased sample, dropping ACTIVE problems
  // that started further back and didn't make the first 250.
  //
  // Concrete case the user caught: 7-day window, ACTIVE ring shows
  // 9, list shows only 5. The 4 missing actives were long-running
  // problems beyond the first 250 by start date. Server-side filter
  // fixes this — DQL returns all 9 actives directly.
  const problemsFilter = useMemo(() => ({
    status: statusFilter ?? "",
    category: "",
    categories: categoriesArr,
    ...timeframeFilter,
  }), [statusFilter, categoriesArr, timeframeFilter]);

  const {
    problems: tenantProblems,
    loading: rawLoading,
    fetching: rawFetching,
    refetch,
    hasMore,
    loadMore,
    loadedCount,
  } = useProblems(problemsFilter);
  // Delay the visible spinner so quick refetches (< 500 ms) don't
  // flash, and once shown keep it visible for at least 200 ms so it
  // doesn't flicker out the instant data arrives.
  const loading = useDelayedLoading(rawLoading, 500, 200);
  // Thread the FILTERS-strip status into the trend query so the
  // histogram tracks the same subset as the list + category
  // badges. `undefined` (no chip on) keeps both series so the user
  // still sees the ACTIVE-vs-CLOSED breakdown across the window.
  const { data: trendData, loading: trendLoading } = useProblemTrend(timeframeTrend, statusFilter ?? undefined);

  // Auto-refresh — fire `refetch()` on a fixed interval when the user
  // picks one (Off by default). Also bumps the global refresh tick
  // so per-row subscribers (CommentsSection, ProblemActivityFeed)
  // re-fetch their own data in lockstep — without this, the
  // problems LIST refreshed but the expanded rows' comments +
  // activity stayed stale (the original bug).
  const triggerRefresh = useTriggerRefresh();
  useEffect(() => {
    if (refreshIntervalSec <= 0) return;
    // Skip the interval entirely while the tab is hidden — no point
    // burning DQL budget on data the user can't see.
    if (!pageVisible) return;
    const t = window.setInterval(() => {
      refetch();
      triggerRefresh();
      setLastRefreshAt(Date.now());
    }, refreshIntervalSec * 1000);
    return () => window.clearInterval(t);
  }, [refreshIntervalSec, refetch, triggerRefresh, pageVisible]);

  // Reset the "refreshed ago" clock whenever an in-flight fetch
  // completes — using `rawFetching` (not `rawLoading`) so manual
  // refresh + auto-refresh both reset the counter, not just the
  // first load. `isLoading` is true only until the first response
  // arrives; subsequent refetches flip `isFetching` only.
  useEffect(() => {
    if (!rawFetching) setLastRefreshAt(Date.now());
  }, [rawFetching]);

  const handleManualRefresh = useCallback(() => {
    refetch();
    triggerRefresh();
  }, [refetch, triggerRefresh]);

  const rawProblems = tenantProblems;

  // Apply the global category-filter chip strip to the raw problems
  // list. With Fase B the server already filters by category when
  // chips are active, so this filter is normally a no-op (idempotent
  // re-application of the same predicate). Defence in depth — if a
  // future server-side filter bug ever returns out-of-set records,
  // the UI stays consistent.
  const problems = useMemo(() => {
    if (categoryFilter.size === 0) return rawProblems;
    return rawProblems.filter((p) => categoryFilter.has(p["event.category"]));
  }, [rawProblems, categoryFilter]);

  // Team metrics — exposes per-problem MTTA/MTTR/MTBF/MTTF so each
  // row's Metrics cell can show the same 4 chips the Analytics
  // page already aggregates. Fires one extra DQL (the team-metrics
  // comments stream); cached + reused via the shared hook so it
  // doesn't fan out per-row.
  // Defensive cap: skip the 4× O(N log N) aggregation when the list
  // is large enough that the work would block the main thread. Hook
  // returns empty KPIs in that mode and the UI advises the user to
  // filter (see the large-dataset banner below).
  const teamMetricsEnabled = problems.length < TEAM_METRICS_CAP;
  const teamMetrics = useTeamMetrics(problems, {
    enabled: teamMetricsEnabled,
  });
  const perProblem  = teamMetrics.perProblem;

  // Per-category counts for the shared chip strip — sourced from a
  // SEPARATE light DQL aggregation so the badges keep showing real
  // numbers even when the user has activated chips (which filters
  // the main list server-side and would otherwise drop unselected
  // chips to zero).
  //
  // The status dimension follows the FILTERS strip:
  //   • Status chip ACTIVE  → badges count ACTIVE problems
  //   • Status chip CLOSED  → badges count CLOSED problems
  //   • No status chip      → defaults to ACTIVE (the actionable
  //     subset — matches what users care about when triaging an
  //     unfiltered view).
  const countsStatus = statusFilter ?? "ACTIVE";
  // 0.0.157 — kept useCategoryCounts as a fallback source (still
  // pings the Grail count for status=Active or Closed under the
  // current timeframe) but the chip badges now PREFER the
  // constellationCountOverrides values when available. Reason:
  // constellationCountOverrides is timeframe-aware in lockstep with
  // the rings/cells.
  const { counts: activeCountsByCategoryFallback } = useCategoryCounts({
    status: countsStatus,
    ...timeframeFilter,
  });
  // The setCategoryCounts effect lives a bit further down, AFTER
  // constellationCountOverrides is declared — that's the source it
  // prefers. Keeps the data flow easy to follow without a forward
  // reference.

  // Authoritative counts for the constellation's central rings + per-
  // category panels. A single DQL `summarize by {status, category}`
  // returns ≤12 rows — far cheaper than relying on the trimmed
  // `useProblems` payload (which DPS Tier 3 caps at 250 records).
  //
  // Without this hook, the central ACTIVE ring under-counted when the
  // window held more problems than the page-level limit — verified
  // against tenant bwm98081 HAR (native: 5 active / 889 total, ours
  // pre-fix: 1 active / 250 total, despite chip badges correctly
  // showing 5 active because they share THIS data path).
  const {
    counts: statusCategoryCounts,
    totals: statusCategoryTotals,
    loading: statusCategoryLoading,
  } = useStatusCategoryCounts({ ...timeframeFilter, stuckCutoff: stuckCutoffIso });

  // Constellation prop — `undefined` while loading so ConstellationView
  // falls back to list-derived counts (avoids first-paint flicker
  // showing zero). The count query is already timeframe-bounded
  // server-side via from/to in buildStatusCategoryCountsQuery.
  const constellationCountOverrides = useMemo(() => {
    if (statusCategoryLoading) return undefined;
    // 0.0.150 — Rising bubble used to derive from the 250-row
    // sample (`recent - older` computed client-side over the
    // loaded problems). For busy tenants where the sample is
    // truncated, the delta collapsed regardless of timeframe.
    // Now compute it from the server-side `OLDER` count instead:
    // risingDelta = max(0, ACTIVE - OLDER) per category.
    const risingDeltaByCategory: Record<string, number> = {};
    for (const cat of Object.keys(statusCategoryCounts.ACTIVE)) {
      const a = statusCategoryCounts.ACTIVE[cat] || 0;
      const o = statusCategoryCounts.OLDER[cat] || 0;
      const d = a - o;
      if (d > 0) risingDeltaByCategory[cat] = d;
    }
    return {
      total: statusCategoryTotals.total,
      active: statusCategoryTotals.active,
      resolved: statusCategoryTotals.closed,
      activeByCategory: statusCategoryCounts.ACTIVE,
      resolvedByCategory: statusCategoryCounts.CLOSED,
      // 0.0.137 — authoritative Stuck count per category, server-
      // side. Now timeframe-aware (0.0.148).
      stuckByCategory: statusCategoryCounts.STUCK,
      risingDeltaByCategory,
      // 0.0.173 — expose the raw `older_count` per category too so
      // the constellation badge (`▲+N/1h` / `▼-N`) and the modal
      // headline trend can compute the SIGNED delta from server
      // data. Without this they fell back to the sample-derived
      // `catTrends` and disagreed with the Rising bubble (which
      // uses risingDeltaByCategory). User: "Rising esta discrepante."
      olderByCategory: statusCategoryCounts.OLDER,
    };
  }, [statusCategoryLoading, statusCategoryTotals, statusCategoryCounts]);

  // 0.0.160 — chip badges feed from constellationCountOverrides
  // (timeframe-aware) so they stay in lockstep with the list's
  // visible row count below.
  //   • no status chip pinned → chip count = ACTIVE + CLOSED per
  //     category. Mirrors what the list shows (the list shows
  //     active + closed for the timeframe by default). User: "o
  //     filtro e grupo Total do overview mostram 1, porem o
  //     correto seria 59."
  //   • Active chip pinned → chip count = ACTIVE only.
  //   • Closed chip pinned → chip count = CLOSED only.
  // Fallback to useCategoryCounts during first paint while the
  // override is still loading.
  useEffect(() => {
    let fromOverride: Record<string, number> | undefined;
    if (constellationCountOverrides) {
      if (statusFilter === "ACTIVE") {
        fromOverride = constellationCountOverrides.activeByCategory;
      } else if (statusFilter === "CLOSED") {
        fromOverride = constellationCountOverrides.resolvedByCategory;
      } else {
        // No chip pinned → sum active + closed per category so the
        // chip matches the unfiltered list's per-category row count.
        const activeBy = constellationCountOverrides.activeByCategory ?? {};
        const closedBy = constellationCountOverrides.resolvedByCategory ?? {};
        const combined: Record<string, number> = {};
        for (const cat of new Set([...Object.keys(activeBy), ...Object.keys(closedBy)])) {
          combined[cat] = (activeBy[cat] || 0) + (closedBy[cat] || 0);
        }
        fromOverride = combined;
      }
    }
    setCategoryCounts(fromOverride ?? activeCountsByCategoryFallback);
  }, [constellationCountOverrides, statusFilter, activeCountsByCategoryFallback, setCategoryCounts]);

  // 0.0.172 — authoritative count of problems matching the current
  // category + status filter, from the count query. The list loads
  // in 250-row batches via useProblems pagination (`hasMore` /
  // `loadMore`); this value tells the user the TRUE size of the
  // matching set so the "250 problems" badge doesn't look like a
  // hard cap. Client-side narrowing (search, pinned problem,
  // Rising/Stuck chip, brush) is NOT included here — by design,
  // since those add ad-hoc filters on top of the server-side query.
  // User: "deixar claro que a list renderiza de 250 em 250, mas
  // conta todos os problemas."
  const expectedListTotal = useMemo<number | null>(() => {
    if (!constellationCountOverrides) return null;
    const cats = Array.from(catFilter);
    const activeBy = constellationCountOverrides.activeByCategory ?? {};
    const closedBy = constellationCountOverrides.resolvedByCategory ?? {};
    const sum = (m: Record<string, number>): number => {
      if (cats.length === 0) {
        return Object.values(m).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
      }
      return cats.reduce((acc, c) => acc + (m[c] || 0), 0);
    };
    if (statusFilter === "ACTIVE") return sum(activeBy);
    if (statusFilter === "CLOSED") return sum(closedBy);
    return sum(activeBy) + sum(closedBy);
  }, [constellationCountOverrides, catFilter, statusFilter]);

  // Hour-over-hour trend figures for the mobile headline strip.
  //
  // Two semantics, deliberately different:
  //
  //   • TOTAL / RESOLVED → RATE in the last hour. Both are cumulative
  //     counters (a problem started yesterday stays counted in TOTAL;
  //     a closed problem stays counted in RESOLVED). They CANNOT
  //     decrease, so a ▼ arrow on either is visually misleading even
  //     when the recent-vs-previous DELTA happens to be negative
  //     (which just means "the rate slowed down"). User feedback was
  //     emphatic on this — show `+N /1h` (count this hour) or
  //     `— quiet` (zero), nothing else.
  //
  //   • ACTIVE → DELTA. This is the only ring whose underlying number
  //     genuinely moves both directions (new problems open, existing
  //     problems close). Same `recent − older` math the desktop ring
  //     uses, so the mobile and desktop trend chips agree.
  //
  // Derived from the loaded `rawProblems` list. The list (sorted
  // `event.start desc`, ramping from 250 records up) always covers
  // the last 2h window even on tenants with thousands of historical
  // problems — no extra DQL needed.
  const mobileRingTrends = useMemo(() => {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    let totalRate    = 0;
    let activeRecent = 0, activeOlder = 0;
    let resolvedRate = 0;
    for (const p of rawProblems) {
      const startTs = new Date(p["event.start"]).getTime();
      const endTs   = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
      // TOTAL: how many NEW problems started in the last hour.
      if (startTs >= oneHourAgo) totalRate++;
      // ACTIVE: now vs 1h ago. "Was active at cutoff" = started
      // before 1h ago AND (still active OR closed after the cutoff).
      const isActiveNow = p["event.status"] === "ACTIVE";
      const wasActiveAt1hAgo = startTs <= oneHourAgo
        && (isActiveNow || (endTs !== null && endTs > oneHourAgo));
      if (isActiveNow)      activeRecent++;
      if (wasActiveAt1hAgo) activeOlder++;
      // RESOLVED: how many problems closed in the last hour.
      if (p["event.status"] === "CLOSED" && endTs !== null && endTs >= oneHourAgo) {
        resolvedRate++;
      }
    }
    return {
      totalRate,
      activeDelta: activeRecent - activeOlder,
      resolvedRate,
    };
  }, [rawProblems]);

  // Memoised list-derived fallback for the mobile rings. Used ONLY
  // when `constellationCountOverrides` is undefined — i.e. while the
  // count query is still loading. In real customer use, the override
  // is populated almost immediately and this fallback is never read,
  // so the memo is essentially free.
  //
  // Was previously inline `problems.filter(...).length` in the JSX,
  // which ran O(N) twice on EVERY render of the page. The memo
  // collapses it to a single pair of walks per `problems` change.
  const mobileRingFallbackCounts = useMemo(() => {
    let active = 0;
    let closed = 0;
    for (let i = 0; i < problems.length; i++) {
      const s = problems[i]["event.status"];
      if (s === "ACTIVE") active++;
      else if (s === "CLOSED") closed++;
    }
    return { active, closed };
  }, [problems]);

  // ── Grouping resolution (category vs segment mode) ────────────────
  // In "category" mode the 6 Davis categories are the quadrants and
  // every problem has a known category — `groupings` and
  // `resolveGrouping` are constants.
  //
  // In "segment" mode we:
  //   1. Pull the tenant's filter-segment catalog (cheap, cached).
  //   2. Query membership for up to MAX_SEGMENTS_TO_RANK segments in
  //      parallel (each query returns "which problems are in segment X
  //      under the current filter window").
  //   3. Rank by active-problem count, take the top N for the quadrants.
  //   4. Bucket the rest (and any problems matching none) into the
  //      synthetic UNASSIGNED grouping so every dot lands somewhere.
  const { segments: realSegCatalog, loading: realSegCatalogLoading } = useFilterSegments();
  const segCatalog        = realSegCatalog;
  const segCatalogLoading = realSegCatalogLoading;
  // uid → display name lookup, used by the list's Segment column.
  const segNameByUid: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of segCatalog) m[s.uid] = s.name;
    return m;
  }, [segCatalog]);

  const segmentUidsToQuery = useMemo(() => {
    // We always probe the top-N segments (capped at
    // MAX_SEGMENTS_TO_RANK = 30) so the Incidents list can render a
    // Segments column AND honour `?segment=<uid>` drilldowns from
    // the Trends page. Earlier this was gated behind
    // `groupBy === "segment"` to save DPS, but downstream features
    // (Segments column, Top Segments drilldown) need membership data
    // regardless of grouping mode.
    //
    // Skip parameterised segments — those that declare required
    // variables can't be applied without bindings the user must
    // supply, so DQL rejects the auto-membership probe with
    // FILTER_SEGMENT_REQUIRES_VARIABLE. Only include "static"
    // segments (no `variables` field on the lean record).
    //
    // Cost: ≤30 cheap queries with 5-min cache (DPS Tier 2). Adds
    // ~150 ms to first load on cold cache; near-zero on warm.
    return segCatalog
      .filter((s) => !(s as { variables?: unknown }).variables)
      .slice(0, MAX_SEGMENTS_TO_RANK)
      .map((s) => s.uid);
  }, [segCatalog]);
  // 0.0.119 — DPS-killer optimisation. `useSegmentMembership` fires
  // up to 30 parallel DQL queries per refresh cycle (≤30 segments,
  // each scanning the full problem set under the current filters).
  // At 1000 concurrent users on a 1-min refresh, this single hook
  // accounts for ~83 % of the monthly DPS budget (~$2.5 M/mo on
  // the xlarge-tenant pricing analysis). Since `SHOW_SEGMENT_VIEW
  // = false` and the user authorised dropping the side-features
  // it powers (Segments column drilldown + Top Segments card),
  // we gate the fetch behind that same flag.
  const { membership: realSegMembership, loading: realSegMembershipLoading } =
    useSegmentMembership(
      !SHOW_SEGMENT_VIEW ? [] : segmentUidsToQuery,
      problemsFilter,
    );
  const segMembership        = realSegMembership;
  const segMembershipLoading = realSegMembershipLoading;

  // Full ranked segment list (only populated in segment mode). Exposed
  // separately so the overflow chip's dropdown can show every queried
  // segment with its count, not just the top-N drawn as quadrants.
  interface RankedSegment { uid: string; name: string; count: number; }
  const segmentRanking = useMemo<RankedSegment[]>(() => {
    if (groupBy !== "segment") return [];
    const activeCounts = new Map<string, number>();
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      const segs = segMembership.get(p.display_id);
      if (!segs) continue;
      for (const uid of segs) {
        activeCounts.set(uid, (activeCounts.get(uid) || 0) + 1);
      }
    }
    const queriedSet = new Set(segmentUidsToQuery);
    const ranked = segCatalog
      .filter((s) => queriedSet.has(s.uid))
      .map((s) => ({ uid: s.uid, name: s.name, count: activeCounts.get(s.uid) || 0 }));
    ranked.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
    return ranked;
  }, [groupBy, problems, segCatalog, segMembership, segmentUidsToQuery]);

  const { groupings, resolveGrouping, segmentOverflowCount } = useMemo<{
    groupings: Grouping[];
    resolveGrouping: (p: Problem) => string | null;
    segmentOverflowCount: number;
  }>(() => {
    if (groupBy !== "segment") {
      return {
        groupings: CATEGORY_GROUPINGS,
        resolveGrouping: resolveByCategory,
        segmentOverflowCount: 0,
      };
    }
    // Quadrant grid seats exactly TOP_SEGMENTS_N (6). We start by taking
    // the top-6 segments. If any active problem doesn't belong to any of
    // those 6 (either it matches no segment at all, or only matches
    // segments outside the top), we displace the lowest-ranked of the 6
    // and reserve that final slot for UNASSIGNED — that way the dot
    // actually has somewhere to land.
    let top = segmentRanking.slice(0, TOP_SEGMENTS_N);
    let topUidSet = new Set(top.map((s) => s.uid));
    let needsUnassigned = false;
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      const segs = segMembership.get(p.display_id);
      if (!segs || segs.size === 0) { needsUnassigned = true; break; }
      let inTop = false;
      for (const uid of segs) if (topUidSet.has(uid)) { inTop = true; break; }
      if (!inTop) { needsUnassigned = true; break; }
    }
    if (needsUnassigned) {
      top = segmentRanking.slice(0, TOP_SEGMENTS_N - 1);
      topUidSet = new Set(top.map((s) => s.uid));
    }
    const segGroupings: Grouping[] = [
      ...segmentsToGroupings(top.map((s) => ({ uid: s.uid, name: s.name }))),
      ...(needsUnassigned ? [UNASSIGNED_GROUPING] : []),
    ];
    const inner = resolveBySegmentMembership(segMembership, topUidSet);
    const resolve = (p: Problem): string | null => {
      const id = inner(p);
      if (id) return id;
      return needsUnassigned ? UNASSIGNED_GROUPING.id : null;
    };
    return {
      groupings: segGroupings,
      resolveGrouping: resolve,
      segmentOverflowCount: Math.max(0, segmentRanking.length - top.length),
    };
  }, [groupBy, problems, segMembership, segmentRanking]);

  const colorForGrouping = useCallback(
    (id: string | null | undefined): string =>
      (id && groupings.find((g) => g.id === id)?.color) || "#6366f1",
    [groupings],
  );

  // 0.0.115 / 0.0.117 — leader-cell highlight for the legend chips.
  // Whichever chip is selected (Rising / Stuck / Total), find the
  // cell(s) tied at the highest count for that subset and feed the
  // set to ConstellationView for emphasis. User feedback after the
  // first cut ("apenas o Total esta destacando as categorias"):
  // Rising and Stuck were dimming the non-matching bubbles but
  // weren't framing the leader CELL. The same Total-leader frame
  // pattern now extends to all three modes — predicate changes per
  // mode, frame style stays identical.
  //
  // 0.0.175 — all three modes now read from
  // `constellationCountOverrides` (the server-authoritative count
  // query), not the 250-row sample. Previously only `criticality`
  // had the override path; `rising` and `open_time` counted
  // sample-resident actives, which on busy tenants disagreed with
  // the visible bubble numbers. User screenshot: 7d timeframe in
  // Stuck mode showed ERROR + SLOWDOWN with corner brackets even
  // though AVAILABILITY had 4 stuck (max) — the sample had ~0
  // AVAILABILITY rows (18 totals lost in a sample of 250 dominated
  // by ERROR/CUSTOM_ALERT each with ~770 totals) but 1 ERROR and 1
  // SLOWDOWN active+old, so those tied at max and got the frame.
  // Switching to the override unifies highlight with bubble count.
  //
  // Counting logic per mode (source of truth):
  //   rising      — `risingDeltaByCategory` (max(0, ACTIVE - OLDER)
  //                 from count query — same number the cell ▲+N
  //                 badge reads).
  //   open_time   — `stuckByCategory` (ACTIVE & event.start < now-4h
  //                 from count query — same number the cell "Stuck"
  //                 bubble reads). Note: this is 4 h, not 1 h, so
  //                 the highlight now matches the bubble label.
  //   criticality — `activeByCategory` (every ACTIVE — same number
  //                 the cell's `N active` heading reads).
  //
  // Falls back to the sample-derived path only when the override
  // hasn't loaded yet (initial paint).
  const subsetLeaderCells = useMemo<ReadonlySet<string> | undefined>(() => {
    if (highlightedSubsetMode === null) return undefined;
    const counts: Record<string, number> = {};
    let overrideMap: Record<string, number> | undefined;
    if (highlightedSubsetMode === "criticality") {
      overrideMap = constellationCountOverrides?.activeByCategory;
    } else if (highlightedSubsetMode === "open_time") {
      overrideMap = constellationCountOverrides?.stuckByCategory;
    } else if (highlightedSubsetMode === "rising") {
      overrideMap = constellationCountOverrides?.risingDeltaByCategory;
    }
    if (overrideMap) {
      for (const id of Object.keys(overrideMap)) counts[id] = overrideMap[id];
    } else {
      // Fallback while count query is in flight — sample-derived,
      // intentionally narrower than the override so a stale paint
      // doesn't outlive the override's arrival by much.
      const now = Date.now();
      const RISING_WINDOW_MS = 3_600_000;
      for (const p of problems) {
        if (p["event.status"] !== "ACTIVE") continue;
        if (highlightedSubsetMode === "rising") {
          const ts = new Date(p["event.start"]).getTime();
          if (!(ts >= now - RISING_WINDOW_MS)) continue;
        } else if (highlightedSubsetMode === "open_time") {
          const ts = new Date(p["event.start"]).getTime();
          if (!(ts < now - RISING_WINDOW_MS)) continue;
        }
        const id = resolveGrouping(p);
        if (!id) continue;
        counts[id] = (counts[id] || 0) + 1;
      }
    }
    let max = 0;
    for (const v of Object.values(counts)) if (v > max) max = v;
    if (max <= 0) return new Set();
    const out = new Set<string>();
    for (const [id, v] of Object.entries(counts)) if (v === max) out.add(id);
    return out;
  }, [highlightedSubsetMode, constellationCountOverrides, problems, resolveGrouping]);
  // Display label for a grouping id — for category mode this is the
  // legacy `getCategoryLabel` mapping; for segment mode it's the
  // segment's name (which getCategoryLabel doesn't know about).
  const labelForGrouping = useCallback(
    (id: string | null | undefined): string => {
      if (!id) return "";
      const found = groupings.find((g) => g.id === id);
      if (found) return found.label;
      return getCategoryLabel(id);
    },
    [groupings],
  );

  // ── Cross-link the pulse chart to the constellation's leader ──────────
  // Whichever category the constellation is currently highlighting (the
  // "★ TOP" / "▲ UP" quadrant for the active Show by mode) also gets its
  // problems painted on the pulse chart with a matching glow — so the
  // user instantly sees WHEN those incidents happened.

  // 0.0.158 — transform the trendData so the CLOSED series is
  // cumulative (count of problems resolved by bucket time). The
  // DQL returns per-bucket "alive during bucket" via `spread:`; we
  // convert to cumulative anchored to the RESOLVED ring total so
  // the rightmost bar reads RESOLVED exactly. ACTIVE series stays
  // as the snapshot (already correct semantic). User: "valores
  // deveriam ser 7 ativos, 14 fechados e 21 total, como representato
  // nos circulos centrais."
  const trendDataCumulative = useMemo(() => {
    const total = constellationCountOverrides?.resolved;
    if (!trendData || typeof total !== "number") return trendData;
    return trendData.map((s: any) => {
      const dim = s?.dimensions?.["event.status"] ?? s?.dimensionValues?.["event.status"] ?? s?.name;
      const isClosed = String(dim ?? "").toUpperCase().includes("CLOSED")
        || String(dim ?? "").toUpperCase().includes("RESOLVED");
      if (!isClosed) return s;
      const dps = s.datapoints || [];
      // cumulative_at_i = total - alive_at_end_of_bucket_i. Use the
      // NEXT bucket's alive count as a proxy for "alive at end of i"
      // — those are the closed problems that hadn't ended yet by
      // the boundary. For the latest bucket no successor exists, so
      // the cumulative lands exactly on `total` (= RESOLVED ring).
      const newDps = dps.map((dp: any, i: number) => {
        const aliveAfter = i + 1 < dps.length ? Number(dps[i + 1]?.value ?? 0) : 0;
        return { ...dp, value: Math.max(0, total - aliveAfter) };
      });
      return { ...s, datapoints: newDps };
    });
  }, [trendData, constellationCountOverrides]);

  /** Highlight payload shared between the pulse chart and the list table.
   *  Same set of problems (the constellation's top-tier dots) so the
   *  three surfaces stay coherent: focus ring in the quadrant ⇔ box on
   *  the chart ⇔ accent row in the list. */
  const chartHighlight = useMemo(() => {
    // LEADER markers are derived from ACTIVE problems only (see the
    // `event.status !== "ACTIVE"` skip in the loop below), so when
    // the FILTERS strip narrows the surface to CLOSED the markers
    // describe a set the user can no longer see in the list — the
    // orange highlight band ends up disconnected from any visible
    // bar. Short-circuit to an empty payload so the chart and the
    // LEADERS strip both go quiet under the Closed chip. The Active
    // and the unfiltered views keep behaving exactly as before.
    if (statusFilter === "CLOSED") {
      return {
        markers:      [] as Array<{ ts: number; tsEnd?: number; color: string }>,
        byId:         new Map<string, string>(),
        leaderColors: [] as string[],
      };
    }
    const leaders = computeLeaderCats(problems, dataMode, groupings, resolveGrouping);
    if (leaders.size === 0) {
      return {
        markers:      [] as Array<{ ts: number; tsEnd?: number; color: string }>,
        byId:         new Map<string, string>(),
        leaderColors: [] as string[],
      };
    }
    // Lock the leader-colour list independently of marker generation so
    // the chart's "LEADERS:" strip can never miss a grouping even if
    // per-problem marker emission encounters an edge case.
    const leaderColors = Array.from(leaders).map((id) => colorForGrouping(id));

    // Mirror the constellation's top-tier scoring so the chart and list
    // highlight EXACTLY the dots that get the focus ring in the
    // quadrant. The actual maths lives in utils/scoring — anything
    // that ranks problems under the current Show By mode goes through
    // the same helper.
    const scoreFn = (p: Problem): number => scoreOf(p, dataMode);

    const byCat: Record<string, Problem[]> = {};
    for (const p of problems) {
      const id = resolveGrouping(p);
      if (!id || !leaders.has(id)) continue;
      if (p["event.status"] !== "ACTIVE") continue;
      (byCat[id] ||= []).push(p);
    }

    const markers: Array<{ ts: number; tsEnd?: number; color: string }> = [];
    const byId    = new Map<string, string>();
    const nowTs   = Date.now();
    for (const [cat, list] of Object.entries(byCat)) {
      if (list.length === 0) continue;
      // Score and rank. Don't drop zero-score entries until AFTER we know
      // whether any positive-score problem exists — that way a leader
      // category whose problems all have sev=0 (real-world edge case)
      // still contributes at least one marker, so the chart can never
      // miss a category the constellation is highlighting.
      const scored = list
        .map((p) => ({ p, s: scoreFn(p) }))
        .sort((a, b) => b.s - a.s);
      const positive = scored.filter(({ s }) => s > 0);
      let tier: typeof scored;
      if (positive.length > 0) {
        const maxS = positive[0].s;
        tier = positive.filter(({ s }) => s >= maxS * TOP_TIER_THRESHOLD);
      } else {
        // No positive scores — fall back to the most recent active so
        // the leader cell on the constellation has at least one matching
        // marker in the chart.
        const mostRecent = [...list].sort(
          (a, b) => new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime(),
        )[0];
        tier = [{ p: mostRecent, s: 0 }];
      }
      const color = colorForGrouping(cat);
      for (const { p } of tier) {
        const ts = new Date(p["event.start"]).getTime();
        if (!Number.isFinite(ts)) continue;
        // ACTIVE problems run until now; CLOSED problems use their
        // recorded end. The chart paints a horizontal band across every
        // bar that falls inside [ts, tsEnd] so long-running incidents
        // remain visible even when their start is older than the chart's
        // left edge.
        const tsEnd = p["event.end"] && p["event.status"] !== "ACTIVE"
          ? new Date(p["event.end"] as string).getTime()
          : nowTs;
        markers.push({ ts, tsEnd, color });
        if (p.display_id) byId.set(p.display_id, color);
      }
    }
    return { markers, byId, leaderColors };
  }, [problems, dataMode, groupings, resolveGrouping, colorForGrouping, statusFilter]);

  const active = useMemo(() => problems.filter((p) => p["event.status"] === "ACTIVE"), [problems]);
  const resolved = useMemo(() => problems.filter((p) => p["event.status"] === "CLOSED"), [problems]);

  const sorted = useMemo(() => {
    // Column-header sort takes precedence: applies one comparator across
    // BOTH active and resolved (so ascending = oldest first regardless
    // of status). The Sort-by dropdown still keeps active-before-resolved
    // ordering for the dashboard-level urgency view.
    if (colSort) {
      const sign = colSort.dir === "asc" ? 1 : -1;
      const dur = (p: Problem) => {
        const start = new Date(p["event.start"]).getTime();
        const end   = p["event.end"] ? new Date(p["event.end"]).getTime() : Date.now();
        return Math.max(0, end - start);
      };
      const colCmp = (a: Problem, b: Problem) => {
        switch (colSort.key) {
          case "id":         return a.display_id.localeCompare(b.display_id) * sign;
          case "name":       return a["event.name"].localeCompare(b["event.name"]) * sign;
          case "status":     return (a["event.status"] === b["event.status"] ? 0 : a["event.status"] === "ACTIVE" ? -1 : 1) * sign;
          case "category":   return a["event.category"].localeCompare(b["event.category"]) * sign;
          // "segment" (legacy, groupBy=segment single-segment column) and
          // "segments" (plural, the new multi-chip column at the table's
          // right edge) share the same sort semantics: order by the
          // alphabetically-first segment name a problem belongs to.
          // Problems with no segment membership sort to the end asc, to
          // the front desc.
          case "segment":
          case "segments": {
            const av = (() => {
              const s = segMembership.get(a.display_id);
              if (!s || s.size === 0) return null;
              const names = Array.from(s).map((uid) => segNameByUid[uid] || uid).sort();
              return names[0];
            })();
            const bv = (() => {
              const s = segMembership.get(b.display_id);
              if (!s || s.size === 0) return null;
              const names = Array.from(s).map((uid) => segNameByUid[uid] || uid).sort();
              return names[0];
            })();
            if (av === null && bv === null) return 0;
            if (av === null) return 1 * sign;
            if (bv === null) return -1 * sign;
            return av.localeCompare(bv) * sign;
          }
          case "affected":   return ((a.affected_entity_ids?.length || 0) - (b.affected_entity_ids?.length || 0)) * sign;
          case "entities": {
            const av = (a.affected_entity_ids?.[0]) || "";
            const bv = (b.affected_entity_ids?.[0]) || "";
            return av.localeCompare(bv) * sign;
          }
          case "root":       return (a.root_cause_entity_id || "").localeCompare(b.root_cause_entity_id || "") * sign;
          case "started":    return (new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime()) * sign;
          case "end": {
            // ACTIVE problems (event.end == null) sort to the BOTTOM
            // in asc order (no end yet → "after" any closed problem)
            // and to the TOP in desc order. Treating them as
            // ±Infinity rather than 0 keeps the ordering intuitive
            // when the column header is clicked toggling asc/desc.
            const ae = a["event.end"] ? new Date(a["event.end"]).getTime() : (sign > 0 ?  Infinity : -Infinity);
            const be = b["event.end"] ? new Date(b["event.end"]).getTime() : (sign > 0 ?  Infinity : -Infinity);
            return (ae - be) * sign;
          }
          case "duration":   return (dur(a) - dur(b)) * sign;
          case "impact": {
            const ai = getImpactLabel(a.affected_entity_ids)?.label || "";
            const bi = getImpactLabel(b.affected_entity_ids)?.label || "";
            return ai.localeCompare(bi) * sign;
          }
          default:           return 0;
        }
      };
      return [...problems].sort(colCmp);
    }
    // Dropdown sort: keeps active-before-resolved separation.
    // "segment" mode is the exception — it groups by segment first
    // (mixing actives + resolved within each segment) so the user
    // sees per-segment cohorts together. Section dividers in the
    // render step rely on this contiguous ordering.
    const cmp = (a: Problem, b: Problem) => {
      switch (sortMode) {
        case "newest":   return new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime();
        case "oldest":   return new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime();
        case "duration": return new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime();
        case "impact":   return (b.affected_entity_ids?.length || 0) - (a.affected_entity_ids?.length || 0);
        case "segment": {
          // Alphabetical by first segment name; problems with no
          // membership sink to the bottom.
          const firstSeg = (p: Problem) => {
            const s = segMembership.get(p.display_id);
            if (!s || s.size === 0) return null;
            const names = Array.from(s).map((uid) => segNameByUid[uid] || uid).sort();
            return names[0];
          };
          const av = firstSeg(a);
          const bv = firstSeg(b);
          if (av === null && bv === null) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          return av.localeCompare(bv);
        }
        case "entity": {
          // Alphabetical by first affected-entity name (falling back
          // to the entity id when the name lookup is null). Rows
          // with no affected entities sink to the bottom — they
          // can't usefully participate in entity-grouped triage.
          const firstEntName = (p: Problem) => {
            const ids = p.affected_entity_ids;
            if (!ids || ids.length === 0) return null;
            const names = p.affected_entity_names || [];
            return (names[0] || ids[0] || "").toLowerCase();
          };
          const av = firstEntName(a);
          const bv = firstEntName(b);
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return av.localeCompare(bv);
        }
        case "urgency":
        default:         return getUrgencyScore(b) - getUrgencyScore(a);
      }
    };
    // 0.0.126 — wrap the comparator with a category prefix when the
    // Total chip is active in list view. Same intent as sortMode
    // "segment"/"entity": cluster rows by their grouping field so
    // the dividers from the multi-level renderer emit clean
    // section breaks instead of fragmenting across the table.
    // Within each category cohort the existing comparator still
    // decides order (so URGENCY default keeps actives-first inside
    // each cohort, etc.).
    const wrappedCmp = (viewMode === "list" && highlightedSubsetMode === "criticality")
      ? (a: Problem, b: Problem) => {
          const ca = a["event.category"] || "";
          const cb = b["event.category"] || "";
          const catCmp = ca.localeCompare(cb);
          if (catCmp !== 0) return catCmp;
          return cmp(a, b);
        }
      : cmp;
    // Grouping modes (segment / entity / category-via-Total) mix
    // actives + resolved together so the per-group cohorts are
    // contiguous. Other modes keep the canonical active-first split
    // for at-a-glance triage.
    const groupingActive = sortMode === "segment" || sortMode === "entity"
      || (viewMode === "list" && highlightedSubsetMode === "criticality");
    if (groupingActive) {
      return [...problems].sort(wrappedCmp);
    }
    const a = [...active].sort(wrappedCmp);
    const r = [...resolved].sort(wrappedCmp);
    return [...a, ...r];
  }, [problems, active, resolved, sortMode, colSort, segMembership, segNameByUid, viewMode, highlightedSubsetMode]);

  const filtered = useMemo(() => {
    let out = sorted;
    // Pinned single-problem view — takes precedence over every other
    // filter so the user always sees the specific dot they selected.
    if (pinnedProblemId) {
      return out.filter((p) => p.display_id === pinnedProblemId);
    }
    if (catFilter.size > 0) {
      if (groupBy === "segment") {
        // Segment mode: match against direct segment membership rather
        // than event.category. Handles drill-downs on overflow segments
        // (those outside the top-N drawn on the constellation) and the
        // synthetic UNASSIGNED bucket.
        out = out.filter((p) => {
          const segs = segMembership.get(p.display_id);
          for (const f of catFilter) {
            if (f === UNASSIGNED_GROUPING.id) {
              if (!segs || segs.size === 0) return true;
              if (resolveGrouping(p) === UNASSIGNED_GROUPING.id) return true;
            } else if (segs && segs.has(f)) {
              return true;
            }
          }
          return false;
        });
      } else {
        out = out.filter((p) => catFilter.has(p["event.category"]));
      }
    }
    if (searchDebounced) {
      const q = searchDebounced.toLowerCase();
      // Special shortcuts: "ACTIVE" / "CLOSED" filter by status
      if (q === "active" || q === "closed") {
        out = out.filter((p) => p["event.status"] === q.toUpperCase());
      } else {
        // Match name + display_id ONLY. Category is intentionally
        // excluded — the chip strip above already filters by
        // category, and including it here caused false positives
        // like searching "Low" matching every Slowdown problem
        // (because "slowdown".includes("low")).
        out = out.filter((p) =>
          p["event.name"].toLowerCase().includes(q) ||
          p.display_id.toLowerCase().includes(q)
        );
      }
    }
    // AT A GLANCE drilldown — status + "stuck" (age > X hours) filters
    // come in via URL from the KPI cards on the Trends page so the
    // user lands on the cohort the headline number was computed from.
    if (statusFilter) {
      out = out.filter((p) => p["event.status"] === statusFilter);
    }
    // 0.0.123 — Rising / Stuck / Total chips from the list's Group-by
    // strip filter the visible rows. The same `highlightedSubsetMode`
    // state drives the constellation's bubble emphasis on the
    // neural view, so toggling the chip on one view persists on the
    // other. "criticality" (Total) narrows to ACTIVE-only since
    // that's the parent set the Rising / Stuck subsets share.
    if (highlightedSubsetMode) {
      const RISING_MS = 3_600_000;     // 1h
      const now = Date.now();
      out = out.filter((p) => {
        if (p["event.status"] !== "ACTIVE") return false;
        if (highlightedSubsetMode === "criticality") return true;
        const startTs = new Date(p["event.start"]).getTime();
        if (highlightedSubsetMode === "rising")    return startTs >= now - RISING_MS;
        // 0.0.148 — Stuck list filter now uses the same timeframe-
        // aware cutoff every other Stuck surface uses (count query,
        // cell bubble, modal pill). User: "Stucks devem respeitar
        // timeframe e nao janela utilizada para os risings."
        if (highlightedSubsetMode === "open_time") return startTs < stuckCutoffMs;
        return true;
      });
    }
    if (stuckHoursFilter != null) {
      // "Stuck" = ACTIVE problems older than the configured threshold.
      // Combined with statusFilter above (which the KPI card also
      // passes) the filter becomes the AND of both conditions.
      const threshMs = stuckHoursFilter * 3600 * 1000;
      const now = Date.now();
      out = out.filter((p) => {
        if (p["event.status"] !== "ACTIVE") return false;
        const startMs = new Date(p["event.start"]).getTime();
        return Number.isFinite(startMs) && (now - startMs) > threshMs;
      });
    }
    // WHERE TO LOOK drilldown — entity-level and root-cause-level
    // filters from the Analytics page's leaderboards. Composable
    // (a user can drill into a root-cause AND an entity at the same
    // time, surfacing the intersection). Both come in via URL
    // params so they survive page reloads and deep-link sharing.
    if (entityFilter) {
      out = out.filter((p) => {
        const ids = p.affected_entity_ids;
        return Array.isArray(ids) && ids.includes(entityFilter);
      });
    }
    if (rceFilter) {
      out = out.filter((p) => p.root_cause_entity_id === rceFilter);
    }
    // Segment drilldown — narrow to problems whose membership map
    // contains the selected segment uid. Driven from the Top
    // Segments card on the Trends page OR a chip click in the
    // Incidents list's Segments column. The membership data comes
    // from useSegmentMembership (already loaded above for the new
    // Segments column). When membership is empty (loading) the
    // filter returns empty list — same UX as other drilldowns.
    if (segmentFilter) {
      out = out.filter((p) => {
        const segs = segMembership.get(p.display_id);
        return segs ? segs.has(segmentFilter) : false;
      });
    }
    // Drilldown range filter — when `selectedRange` is set (chart
    // bucket-click, metric-dot-click, or pulse-chart brush), narrow
    // the list to problems that were ACTIVE DURING that window —
    // i.e. their open interval [event.start, event.end] intersects
    // [from, to]. Matches the chart's `activeAtT` semantic (line
    // ~1238) so a bar showing "5 active" drills into 5 problems.
    //
    // Previous behaviour (kept here as context for the regression
    // that motivated the change): filter by `event.start` IN range.
    // That made the bucket's number ("5 active at 05:30") and the
    // drilled list ("1 started between 05:18-05:38") disagree —
    // confusing for users brushing a recent window to inspect what
    // was happening at that moment. Long-running active problems
    // are the legitimate answer here, not noise.
    if (selectedRange) {
      const fromMs = selectedRange.from.getTime();
      const toMs   = selectedRange.to.getTime();
      out = out.filter((p) => {
        const startMs = new Date(p["event.start"]).getTime();
        if (!Number.isFinite(startMs)) return false;
        // Open problems (no end) are still active now — represent
        // their close time as +∞ so the intersect test always
        // succeeds for ranges newer than their start.
        const endMs = p["event.end"]
          ? new Date(p["event.end"]).getTime()
          : Number.POSITIVE_INFINITY;
        // Open interval [start, end] intersects [from, to] iff
        //   start < to  AND  end > from
        return startMs < toMs && endMs > fromMs;
      });
    }
    // 0.0.125 — Rising / Stuck chip strip filters rows when in
    // LIST view. Total chip is excluded from the list strip (no
    // semantic — Total = all active = no filter). In constellation
    // mode the same chip drives bubble highlight only, NOT row
    // filtering, so the gate keys off viewMode.
    if (viewMode === "list" && (highlightedSubsetMode === "rising" || highlightedSubsetMode === "open_time")) {
      const now = Date.now();
      const RISING_WINDOW = 3_600_000;     // < 1 h
      out = out.filter((p) => {
        if (p["event.status"] !== "ACTIVE") return false;
        const startTs = new Date(p["event.start"]).getTime();
        if (highlightedSubsetMode === "rising") {
          return startTs >= now - RISING_WINDOW;
        }
        return startTs < now - RISING_WINDOW;  // Stuck
      });
    }
    return out;
  }, [sorted, searchDebounced, catFilter, pinnedProblemId, groupBy, segMembership, resolveGrouping, selectedRange, entityFilter, rceFilter, segmentFilter, statusFilter, stuckHoursFilter, highlightedSubsetMode, viewMode, stuckCutoffMs]);

  const entityCount = useMemo(() => {
    const set = new Set<string>();
    active.forEach((p) => p.affected_entity_ids?.forEach((id) => set.add(id)));
    return set.size;
  }, [active]);

  /** Top-tier problems WITHIN the currently filtered list, scored by
   *  the active `dataMode`. Used to highlight rows in the table the
   *  same way the constellation highlights top-tier dots — so picking
   *  Rising / Oldest Open / Criticality has a visible effect on the
   *  table, not just the chart strip. Total mode → no highlight. */
  const listTopIds = useMemo<Set<string>>(() => {
    return pickTopTier(filtered.filter((p) => p["event.status"] === "ACTIVE"), dataMode);
  }, [filtered, dataMode]);

  /** The accent colour that the list-mode highlight uses. Chosen to
   *  match the semantic of each visualisation mode. */
  const listModeAccent = useMemo<string>(() => {
    switch (dataMode) {
      case "rising":      return "#ff4d6a"; // red — count climbing
      case "criticality": return "#ff4d6a"; // red — high severity
      case "open_time":   return "#f59e0b"; // amber — stuck/old
      default:            return "#94a3b8"; // neutral (unused — total mode skips highlight)
    }
  }, [dataMode]);

  const healthScore = useMemo(() => {
    if (problems.length === 0) return 100;
    const critCount = active.filter((p) => getSeverity(p["event.start"]) === "crit").length;
    return Math.max(0, Math.min(100, 100 - critCount * 15 - active.length * 5));
  }, [problems, active]);

  // Clicking a dot in the constellation pins that problem in the list:
  // it switches to the list view, filters to show only that one card,
  // and auto-expands it so every detail is visible without an extra
  // click. The user can clear the pin from the banner at the top of
  // the list.
  const onConstellationSelect = useCallback((p: Problem) => {
    setPinnedProblemId(p.display_id);
    setExpandedRows(new Set([p.display_id]));
    setViewMode("list");
  }, []);

  // Clicking on a quadrant (not on a dot) opens an in-place detail panel
  // listing every incident in that quadrant — the user can scan and pick.
  const onQuadrantClick = useCallback((category: string) => {
    setQuadrantDetail(category);
  }, []);

  /** Clears every LIST-specific filter so the list returns to its
   *  default unfiltered state. Leaves the chart's brushed range
   *  alone (that's not list-only). */
  // 0.0.168 — mirror local catFilter → context.categoryFilter so
  // the server-side DQL `event.category` clause reflects every
  // drilldown that set the local state (resolved tile, hub ring,
  // modal Total pill, URL hydration). Without this the server
  // returned the 250 newest problems globally and the user lost
  // older categories. User: "ainda nao consigo ver os dois
  // problemas reportados nos ultimos 365 dias na list."
  useEffect(() => {
    const sameSize = categoryFilter.size === catFilter.size;
    const same = sameSize && Array.from(catFilter).every((c) => categoryFilter.has(c));
    if (!same) setCategoryFilterCtx(catFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catFilter]);

  const resetListFilters = useCallback(() => {
    setSearch("");
    setCatFilter(new Set());
    setPinnedProblemId(null);
    // 0.0.167 — also clear the drilldown-style filters that the URL
    // carries (entity, rce, segment, stuck-hours). Without this a
    // previous deep-link or AT A GLANCE drilldown can leave a
    // filter that silently narrows the list to 0 rows on the
    // NEXT drilldown. User: "vejo 2 problemas aqui mas ao fazer
    // drilldown, nao vejo eles na lista" — caused by a stuck-hours
    // filter that survived a previous navigation and excluded all
    // CLOSED problems (the filter gates on ACTIVE).
    setEntityFilter(null);
    setRceFilter(null);
    setSegmentFilter(null);
    setStuckHoursFilter(null);
  }, []);

  // When the user navigates between /  (categories) and /segments,
  // wipe any drill-down state from the previous page. The same
  // <Overview> instance re-renders with a new `groupBy` prop, so
  // local state otherwise persists — and IDs that meant something
  // on the previous page (e.g. a segment uid, or the synthetic
  // UNASSIGNED bucket) don't map to anything on the new page,
  // which is what produced the "0 problems found · filtered by
  // __UNASSIGNED__" state when switching tabs while on the list.
  useEffect(() => {
    setSearch("");
    setCatFilter(new Set());
    setPinnedProblemId(null);
    clearCategoryFilter();
    setColSort(null);
    // Always land on the constellation when switching tabs — the
    // user just navigated to a different "page" and expects to see
    // its main view, not the list view they were last on.
    setViewMode("neural");
  }, [groupBy]);

  // Deep-link drill: any in-app navigation can append `?focus=<id>`
  // to land on the list with that problem expanded and scrolled into
  // view. Replaces the previous /detail/:id route — the same effect
  // lets old bookmarked URLs (now redirected) still work.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  useEffect(() => {
    if (!focusId) return;
    setViewMode("list");
    setPinnedProblemId(focusId);
    // Single-row expansion (same rule as toggleRow) — collapse any
    // currently-open row, then open the focused one.
    setExpandedRows(new Set([focusId]));
    requestAnimationFrame(() => {
      const el = document.getElementById(`row-body-${focusId}`)
              || document.querySelector(`[data-display-id="${focusId}"]`);
      if (el && "scrollIntoView" in el) {
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    // Strip the query param so refreshing the page doesn't keep
    // forcing the same drill (the user may have moved on).
    const next = new URLSearchParams(searchParams);
    next.delete("focus");
    setSearchParams(next, { replace: true });
  }, [focusId, searchParams, setSearchParams]);

  // On mount, hydrate viewMode + dataMode + timeframe + categories from
  // URL search params so a shared link like
  // `/?view=list&mode=criticality&tf=-7d...now&cat=ERROR,SLOWDOWN`
  // lands the user in the right state. Subsequent React-driven changes
  // write back to the URL below.
  const didHydrateUrlState = useRef(false);
  useEffect(() => {
    if (didHydrateUrlState.current) return;
    didHydrateUrlState.current = true;
    const v = searchParams.get("view");
    const m = searchParams.get("mode");
    if (v === "list" || v === "neural") {
      // Mobile / tablet guard — even if the URL says `view=neural`
      // (a desktop user shared the link) we force list view because
      // Constellation doesn't render usably below 960 px. This
      // matters most for deep-link sharing from desktop to phone.
      setViewMode(isMobileOrTablet && v === "neural" ? "list" : v);
    }
    if (m === "rising" || m === "open_time" || m === "criticality" || m === "total") setDataMode(m);
    // Timeframe — encoded as `<from>...<to>` using the same expression
    // strings the Strato selector emits (e.g. `-7d...now`). Absolute
    // ranges round-trip too via ISO dates.
    const tf = searchParams.get("tf");
    if (tf) {
      const [fromVal, toVal] = tf.split("...");
      if (fromVal && toVal) {
        const fromDate = fromVal === "now" ? new Date() : parseTfPart(fromVal);
        const toDate   = toVal   === "now" ? new Date() : parseTfPart(toVal);
        if (fromDate && toDate) {
          setTimeframe({
            from: { absoluteDate: fromDate.toISOString(), value: fromVal, type: "expression" },
            to:   { absoluteDate: toDate.toISOString(),   value: toVal,   type: "expression" },
          });
        }
      }
    }
    // Category filter — comma-separated list of category names.
    const cat = searchParams.get("cat");
    if (cat) {
      const cats = cat.split(",").map((s) => s.trim()).filter(Boolean);
      if (cats.length > 0) setCatFilter(new Set(cats));
    }
    // Metric filter — extended wire format that also carries the
    // Group-By columns — order matters and is preserved.
    //   ?groupBy=entity        → 1 level (Affected entity)
    //   ?groupBy=entity,root   → 2 levels (Affected entity → Root cause)
    //   ?groupBy=root          → 1 level (Root cause only)
    // Unknown tokens are silently ignored so old / typo'd links don't
    // break the page. The previous `?metric=` filter param is also
    // silently ignored for the same reason — bookmarks that included
    // it from the 0.0.80 release won't error, they'll just lose the
    // metric filter (which no longer exists).
    const groupByParam = searchParams.get("groupBy");
    if (groupByParam != null) {
      const cols = groupByParam
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is GroupByCol => s === "entity" || s === "root");
      setGroupByColumns(Array.from(new Set(cols)));
    } else {
      setGroupByColumns([]);
    }
    // WHERE TO LOOK drilldowns. Always overwrite from URL (including
    // clearing when absent) so back/forward navigation reflects the
    // intended state — without `else setEntityFilter(null)` the
    // filter would stick across history pops.
    setEntityFilter(searchParams.get("entity"));
    setRceFilter(searchParams.get("rce"));
    // AT A GLANCE drilldowns (status + stuck > Nh).
    // `setStatusFilter` here resolves to the context's idempotent
    // setter (NOT toggleStatus) — URL → state must always assign
    // exactly the URL value, never toggle.
    const statusRaw = searchParams.get("status");
    setStatusFilter(statusRaw === "ACTIVE" || statusRaw === "CLOSED" ? statusRaw : null);
    const stuckRaw = searchParams.get("stuck");
    const stuckNum = stuckRaw ? Number(stuckRaw) : null;
    setStuckHoursFilter(stuckNum != null && Number.isFinite(stuckNum) && stuckNum > 0 ? stuckNum : null);
  }, [searchParams]);

  // Write viewMode + dataMode + tf + cat back to URL whenever they
  // change. Use `replace: true` to avoid spamming history with every
  // toggle.
  useEffect(() => {
    if (!didHydrateUrlState.current) return;
    const next = new URLSearchParams(searchParams);
    // Only include params that differ from the default — keeps the
    // canonical URL clean.
    if (viewMode === "neural") next.delete("view");
    else next.set("view", viewMode);
    if (dataMode === "rising") next.delete("mode");
    else next.set("mode", dataMode);
    // Timeframe — write only when it differs from the default 72h window.
    const tfFrom = timeframe?.from.value || "";
    const tfTo   = timeframe?.to.value   || "";
    if (tfFrom === "-72h" && tfTo === "now") next.delete("tf");
    else if (tfFrom && tfTo) next.set("tf", `${tfFrom}...${tfTo}`);
    // Category filter — comma-joined; omit when empty.
    if (catFilter.size === 0) next.delete("cat");
    else next.set("cat", Array.from(catFilter).join(","));
    // Group-By columns — comma-joined. Dropped from URL when no
    // grouping is active to keep canonical URL clean.
    if (groupByColumns.length === 0) next.delete("groupBy");
    else next.set("groupBy", groupByColumns.join(","));
    // Strip legacy `?metric=` / `?metricm=` from the URL if present.
    // The "Has metric" filter strip was removed when the per-problem
    // Metrics column was retired (0.0.81 → 0.0.82).
    next.delete("metric");
    next.delete("metricm");
    // WHERE TO LOOK drilldown filters — propagate state changes
    // (e.g. clicking the clear button in the banner) back to the URL
    // so refresh / share keeps the visible filter.
    if (entityFilter) next.set("entity", entityFilter); else next.delete("entity");
    if (rceFilter)    next.set("rce",    rceFilter);    else next.delete("rce");
    // Segment drilldown — same propagation pattern.
    if (segmentFilter) next.set("segment", segmentFilter); else next.delete("segment");
    // AT A GLANCE drilldown filters — same propagation pattern.
    if (statusFilter)        next.set("status", statusFilter);            else next.delete("status");
    if (stuckHoursFilter !== null) next.set("stuck", String(stuckHoursFilter)); else next.delete("stuck");
    // Avoid an effect loop: only call setSearchParams if something
    // actually changed.
    const a = next.toString();
    const b = searchParams.toString();
    if (a !== b) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, dataMode, timeframe, catFilter, groupByColumns, entityFilter, rceFilter, segmentFilter, statusFilter, stuckHoursFilter]);

  // 0.0.111 — Clicking a quadrant's HEADER opens the enlarged
  // modal (same as clicking the count bubble). User asked: "ao
  // clicar no nome da categoria, expandir". Previously the
  // header click switched to LIST view; that path is still
  // reachable via the INCIDENTS tab + filter strip, but the
  // header click now matches the bubble + dbl-click affordance
  // and stays in the constellation context. Mode follows the
  // current legend selection so the modal opens focused on the
  // same Rising/Stuck/Critical subset the user is highlighting.
  const onCategoryLabelClick = useCallback((category: string) => {
    setEnlargedQuadrant(category);
    setEnlargedQuadrantMode(highlightedSubsetMode ?? undefined);
  }, [highlightedSubsetMode]);

  // Wrap setViewMode so switching BACK to the constellation (the default
  // dashboard) wipes the list filters — next time the user opens the
  // list it starts fresh, not with whatever they last filtered to.
  //
  // Also drops the FILTERS-strip Active/Closed pin: the constellation
  // visually doesn't expose a status switcher, so leaving the pin on
  // makes the chart + lists agree with an invisible state (e.g. the
  // pulse-chart goes all-green under "Closed" with no obvious cue
  // why). Clearing on the way back to constellation matches the
  // user's mental model that "constellation = unfiltered overview".
  const switchView = useCallback((mode: ViewMode) => {
    if (mode === "neural") {
      resetListFilters();
      setStatusFilter(null);
      // 0.0.170 — re-arm Rising on switch-back to neural (desktop
      // only — mobile keeps the unset default per v0.0.129).
      // Without this, the constellation's bubble-pass animations
      // (the dashed rotating ring on the selected sub-bubble)
      // never fire because `highlightedSubsetMode` was cleared when
      // entering the list view. User: "ao alterar do modo
      // constelation para o list e retornar, a animaçao dos
      // grupos dentros das categorias param."
      if (!isMobileOrTablet) setHighlightedSubsetMode("rising");
    }
    // 0.0.125 follow-up — user: "ao abrir a list, nao pre carregar
    // filtro de Rising. Apenas a tela de overview deve fazer isso."
    // The Rising chip is the Overview's natural default (most
    // actionable lens for triage on a canvas). In list view it
    // doubles as a row filter (v0.0.125), so leaving it pre-set
    // would mean the list opens already narrowed — surprising
    // when the user clicks ≡ expecting "all problems". Clear the
    // subset mode on switch-to-list. User can still click the
    // chip in list to apply it; the chip is just no longer
    // pre-selected when entering the view.
    if (mode === "list") {
      setHighlightedSubsetMode(null);
    }
    setViewMode(mode);
  }, [resetListFilters, setStatusFilter, isMobileOrTablet]);

  const closeQuadrantDetail = useCallback(() => setQuadrantDetail(null), []);

  // Picking a problem inside any quadrant-level surface (the list
  // panel OR the enlarged HTML card) pins it inline in the list —
  // matches every other drill-down (no separate triage page).
  // Closing both `quadrantDetail` and `enlargedQuadrant` keeps the
  // selection mutually exclusive: the user never lands on the list
  // with a stale overlay still painted on top.
  const onQuadrantProblemSelect = useCallback((p: Problem) => {
    setQuadrantDetail(null);
    setEnlargedQuadrant(null);
    setPinnedProblemId(p.display_id);
    setExpandedRows(new Set([p.display_id]));
    setViewMode("list");
  }, []);

  // Manual refresh — re-runs the same DQL query the page is already using.
  // Mirrors the "manual refresh" button in the official Davis Problems app.
  // Also flushes the segment-membership cache so the next render
  // re-queries each segment (the cache has a 60 s TTL that survives
  // navigation; "Refresh" should bypass it).
  const handleRefresh = useCallback(() => {
    clearSegmentMembershipCache();
    refetch();
    triggerRefresh();
  }, [refetch, triggerRefresh]);

  // CSV export of the currently filtered list (after every chip / search
  // applied). Matches the "Export to CSV" capability in the Davis app.
  const handleExportCsv = useCallback(() => {
    if (filtered.length === 0) return;
    const cols: Array<{ header: string; get: (p: Problem) => string }> = [
      { header: "ID",         get: (p) => p.display_id || "" },
      { header: "Name",       get: (p) => p["event.name"] || "" },
      { header: "Status",     get: (p) => p["event.status"] === "ACTIVE" ? "Active" : "Closed" },
      { header: "Category",   get: (p) => getCategoryLabel(p["event.category"]) },
      ...(groupBy === "segment" ? [{
        header: "Segment",
        get: (p: Problem) => {
          const s = segMembership.get(p.display_id);
          if (!s || s.size === 0) return "";
          return Array.from(s).map((uid) => segNameByUid[uid] || uid).sort().join(" | ");
        },
      }] : []),
      { header: "Severity",   get: (p) => getSeverityLevel(p) },
      { header: "Affected",   get: (p) => String((p.affected_entity_ids || []).length) },
      { header: "Root cause", get: (p) => p.root_cause_entity_id || "" },
      { header: "Started",    get: (p) => formatStartedDate(p["event.start"]) },
      { header: "Duration",   get: (p) => formatDuration(p["event.start"], p["event.end"]) },
      { header: "Impact",     get: (p) => getImpactLabel(p.affected_entity_ids)?.label || "" },
    ];
    const escape = (v: string) => {
      if (v == null) return "";
      const needs = /[",\n\r]/.test(v);
      return needs ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const lines = [
      cols.map((c) => c.header).join(","),
      ...filtered.map((p) => cols.map((c) => escape(c.get(p))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `problems-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="neo-page">
      {/* ═══ CONSOLIDATED TOOLBAR — segment + view + timeframe ═══ */}
      <header className="neo-header">
        <div className="neo-header-left">
          {/* SegmentSelector lives on the LEFT on desktop but
              moves to the RIGHT (next to the TimeframeSelector)
              on mobile/tablet — the user reported the segment
              chip felt orphaned over there with no related
              control beside it. */}
          {!isMobileOrTablet && <SegmentSelector />}
          {/* Display settings chip — sits immediately to the right
              of the SegmentSelector. Lets the user adjust font
              scale without leaving the header. */}
          <DisplaySettingsPanel inline />
          {/* Constellation/List toggle — sits immediately next to
              the SegmentSelector so the two compact controls form
              one visual cluster at the left edge of the header.
              Hidden on mobile/tablet (constellation is mouse-only
              precision; mobile users stay on the list). */}
          {!isMobileOrTablet && (
            <div className="neo-view-toggle">
              <button className={`neo-toggle-btn${viewMode === "neural" ? " active" : ""}`} onClick={() => switchView("neural")} title="Constellation">◉</button>
              <button className={`neo-toggle-btn${viewMode === "list" ? " active" : ""}`} onClick={() => switchView("list")} title="List">≡</button>
            </div>
          )}
        </div>
        <div className="neo-header-right">
          {/* Mobile-only: SegmentSelector follows here, immediately
              before TimeframeSelector, so segments + timeframe form
              a related cluster on small screens. On desktop the
              segment chip lives on the left next to view toggles. */}
          {isMobileOrTablet && <SegmentSelector />}
          {/* Visualization mode + View-by grouping toggles — both
              are constellation-view affordances:
                • `dataMode` (Rising/Oldest/Crit/Total) drives how
                  quadrant dots are sized + ranked in the constellation
                • `groupBy` (Category/Segment) flips the constellation
                  partitioning between Davis category and tenant segment
              On mobile the constellation is hidden (list-only), so
              both controls are dead weight that just consume header
              real estate. Skip the entire block in mobile/tablet. */}
          {!isMobileOrTablet && (
            <>
              {/* Show By segmented control (Rising / Oldest Open /
                  Criticality / Total) — REMOVED in 0.0.109. Every
                  dense cell now exposes its own per-mode sub-bubbles
                  (▲ Rising, ⏱ Stuck, ⚡ Critical, Σ Total) so the
                  global chip is redundant. The `dataMode` state is
                  preserved as a fallback for the modal when no
                  bubble click sets a subset; default "rising" stays
                  reasonable. */}
              {false && (
              <div className="neo-segctrl" role="group" aria-label="Visualization mode">
                {[
                  { id: "rising",      label: "Rising",      hint: "Quadrants gaining new incidents in the last hour" },
                  { id: "open_time",   label: "Oldest Open", hint: "Highlights the longest-running active incidents" },
                  { id: "criticality", label: "Criticality", hint: "Size based on severity (1-5)" },
                  { id: "total",       label: "Total",       hint: "Uniform size, count per category" },
                ].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`neo-segctrl-btn${dataMode === opt.id ? " neo-segctrl-btn-active" : ""}`}
                    onClick={() => setDataMode(opt.id as typeof dataMode)}
                    aria-pressed={dataMode === opt.id}
                    title={opt.hint}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              )}
              {/* "View by" dimension toggle. Backed by `navigate()` so
                  the URL stays the source of truth (deeplinks to `/`
                  and `/segments` continue to work).
                  Gated behind SHOW_SEGMENT_VIEW because Segment view
                  isn't being used right now — with only "Category"
                  left, a single-button toggle looks broken. The whole
                  block is hidden until the Segment surface is back.
                  Flip the flag at the top of this file to restore. */}
              {SHOW_SEGMENT_VIEW && (
                <div className="neo-view-toggle neo-view-toggle-by" role="tablist" aria-label="View by dimension">
                  <span className="neo-view-toggle-label" aria-hidden="true">View by</span>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={groupBy === "category"}
                    className={`neo-toggle-btn${groupBy === "category" ? " active" : ""}`}
                    onClick={() => { if (groupBy !== "category") navigate("/"); }}
                    title="Group by Davis category"
                  >Category</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={groupBy === "segment"}
                    className={`neo-toggle-btn${groupBy === "segment" ? " active" : ""}`}
                    onClick={() => { if (groupBy !== "segment") navigate("/segments"); }}
                    title="Group by tenant segment"
                  >Segment</button>
                </div>
              )}
            </>
          )}
          {/* Strato TimeframeSelector — exposes the official preset
              list (Last 30 min, 1h, 2h, Today, Yesterday, 24h, 7d,
              custom range, recently used). Bound to local state and
              translated to ProblemFilters above. */}
          <TimeframeSelector
            value={timeframe}
            onChange={handleTimeframeChange}
            clearable={false}
          />
          {/* Manual refresh + freshness indicator + auto-refresh
              interval picker — matches the Dynatrace pattern at the
              top-right of analysis screens. */}
          <div className="neo-refresh-group" role="group" aria-label="Refresh controls">
            <button
              type="button"
              className="neo-refresh-btn"
              onClick={handleManualRefresh}
              disabled={rawFetching}
              title="Refresh now"
              aria-label="Refresh now"
            >
              <span className={`neo-refresh-icon${rawFetching ? " neo-refresh-icon-spinning" : ""}`} aria-hidden="true">↻</span>
            </button>
            {/* 0.0.119 — DPS guardrail. Removed the 30 s and 1 min
                auto-refresh options after the cost analysis showed
                that 1 min refresh × 1000 users = ~$3 M/mo. The
                shortest interval users can now pick is 5 min,
                which together with the 120-600 s staleTimes brings
                the sustained DPS down to a sustainable regime. The
                manual ↻ button is right there for "I need fresh
                NOW" cases. */}
            <select
              className="neo-refresh-interval"
              value={refreshIntervalSec}
              onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
              title="Auto refresh interval (min 5m to control DPS)"
              aria-label="Auto refresh interval"
            >
              <option value={0}>Auto-refresh: Off</option>
              <option value={300}>Every 5m</option>
              <option value={900}>Every 15m</option>
              <option value={1800}>Every 30m</option>
              <option value={3600}>Every 1h</option>
            </select>
            {/* Visual intensity + font-scale controls moved out of
                this header into a globally-rendered floating panel
                (see `<DisplaySettingsPanel>` in App.tsx). The
                panel is reachable from every page, and the
                preferences persist via IntensityContext. */}
            <RefreshStatus lastRefreshAt={lastRefreshAt} intervalSec={refreshIntervalSec} />
            {/* 0.0.135 — surface app version next to the refresh
                stamp so support / users can match a screenshot to
                an exact build without opening DevTools. Subtle
                styling (smaller, muted, monospaced) so it reads as
                metadata, not a primary UI element. */}
            <span
              className="neo-app-version"
              title={`Problem Lifecycle ${APP_VERSION_TAG}`}
              style={{
                marginLeft: 8,
                font: '500 11px/1 "SF Mono","JetBrains Mono",monospace',
                color: "var(--neo-text-3)",
                letterSpacing: "0.02em",
                userSelect: "all",
              }}
            >
              v{APP_VERSION_TAG}
            </span>
          </div>
        </div>
      </header>

      {/* Shared category-filter chip strip. Lives right below the
          page header (where the user expects it visually) but state
          comes from a global context so the selection persists when
          switching between Incidents / Segments / Analytics. The
          sticky wrapper keeps the strip pinned to the top of the
          viewport once the user scrolls past the header. */}
      <div className="neo-sticky-filter">
        <CategoryFilterChips />
      </div>

      {/* Mobile headline strip — TOTAL / ACTIVE / RESOLVED, sourced from
          the same count-query override that feeds the desktop's central
          rings. Placed BEFORE the chart so it reads as the page's
          headline summary (matches the visual hierarchy native Davis
          uses for "N active / M total"). Each cell carries the same
          /1h trend delta the desktop draws under its rings — see
          `mobileRingTrends` above for the derivation. */}
      {isMobileOrTablet && (
        <div className="neo-mobile-rings" role="group" aria-label="Headline counts">
          <div className="neo-mobile-ring neo-mobile-ring-total">
            <span className="neo-mobile-ring-label">TOTAL</span>
            <span className="neo-mobile-ring-value">
              {constellationCountOverrides?.total ?? problems.length}
            </span>
            {/* TOTAL is cumulative — show last-hour ARRIVAL rate
                (never decreases), red because new incidents are bad. */}
            <MobileRingTrend mode="rate" value={mobileRingTrends.totalRate} risingIsBad />
          </div>
          <button
            type="button"
            className={`neo-mobile-ring neo-mobile-ring-active${statusFilter === "ACTIVE" ? " is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "ACTIVE" ? null : "ACTIVE")}
            aria-pressed={statusFilter === "ACTIVE"}
            title="Filter list to Active problems"
          >
            <span className="neo-mobile-ring-label">ACTIVE</span>
            <span className="neo-mobile-ring-value">
              {constellationCountOverrides?.active ?? mobileRingFallbackCounts.active}
            </span>
            {/* ACTIVE genuinely moves both ways — bidirectional delta. */}
            <MobileRingTrend mode="delta" value={mobileRingTrends.activeDelta} risingIsBad />
          </button>
          <button
            type="button"
            className={`neo-mobile-ring neo-mobile-ring-resolved${statusFilter === "CLOSED" ? " is-active" : ""}`}
            onClick={() => setStatusFilter(statusFilter === "CLOSED" ? null : "CLOSED")}
            aria-pressed={statusFilter === "CLOSED"}
            title="Filter list to Resolved problems"
          >
            <span className="neo-mobile-ring-label">RESOLVED</span>
            <span className="neo-mobile-ring-value">
              {constellationCountOverrides?.resolved ?? mobileRingFallbackCounts.closed}
            </span>
            {/* RESOLVED is cumulative — show last-hour CLOSURE rate
                (never decreases), green because resolutions are good. */}
            <MobileRingTrend mode="rate" value={mobileRingTrends.resolvedRate} risingIsBad={false} />
          </button>
        </div>
      )}

      {/* ═══ PULSE SEISMOGRAPH ═══ */}
      <div
        className={`neo-pulse-container${pulseExpanded ? " neo-pulse-container-expanded" : ""}`}
        onDoubleClick={() => setPulseExpanded((v) => !v)}
      >
        <PulseVisualizer
          /* 0.0.144 — switched from a client-side sweep-line (which
             only saw the first-paint sample of 250 problems) to the
             server's `trendData` from useProblemTrend. The DQL query
             carries `spread: timeframe(...)` so each bucket counts
             every problem alive during that window — matches the
             native Davis chart's bar heights for any tenant size.
             User: "a quantidade total por barra esta diferente." */
          data={trendDataCumulative}
          loading={trendLoading && rawProblems.length === 0}
          /* Brush-to-zoom kept on every form factor. The earlier
             mobile gate was wrong — the user DID want to brush on
             touch. The canvas now has `touch-action: pan-y` (see
             theme.css), so horizontal drag stays inside JS while
             vertical scroll remains native. `getSnappedRange` rounds
             the drag to the nearest bucket so finger precision is
             enough for a useful selection. */
          onRangeSelect={handleRangeSelect}
          onClearRange={clearRange}
          selectedRange={selectedRange}
          highlightMarkers={chartHighlight.markers}
          leaderColors={chartHighlight.leaderColors}
          onBarClick={(from, to) => {
            handleRangeSelect(from, to);
            setViewMode("list");
          }}
          problems={rawProblems}
        />
        {selectedRange && (
          /* UTC display matches the rest of the app (see TIMEZONE
             CONVENTION in utils/formatters.ts). The chart axis is
             already UTC; rendering this drilldown label in local
             would shift the displayed range by the user's offset
             and confuse the brush relationship. */
          <div className="neo-pulse-label">
            {selectedRange.from.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}
            {" → "}
            {selectedRange.to.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}
          </div>
        )}
        {pulseExpanded && (
          <button
            className="neo-pulse-exit"
            onClick={(e) => { e.stopPropagation(); setPulseExpanded(false); }}
            title="Exit zoom (Esc)"
          >
            ✕ Exit zoom
          </button>
        )}
      </div>

      {/* (Filter-by-category chip strip has been lifted to App.tsx
          as a sticky global header — see <CategoryFilterChips />.
          This page publishes its per-category active counts via the
          CategoryFilterContext effect below so the shared strip
          shows numbers relevant to this view.) */}

      {/* 0.0.125 — Chip strip lifted out of the constellation branch.
          User: "permitir estes group by no modo list e no mobile view"
          + "remover agrupamento por Total da visao mobile. nao faz
          sentido em lista." Shows on every view and device, with the
          chip list filtered by context:
            • Constellation view (any device) → Rising + Stuck + Total
            • List view (any device)         → Rising + Stuck only
              (Total = "highlight categories" doesn't apply to a flat
               row list — semantically empty there.)
          When in list view the Rising/Stuck chip ALSO acts as a row
          filter (see the `filtered` useMemo below). */}
      {(() => {
        const inList = viewMode === "list";
        // 0.0.127 follow-up — the previous attempt hid this strip
        // entirely on mobile, but the user actually wanted it
        // visible (the "embedded into GROUP BY" duplicate strip
        // was the real complaint, which is now removed below).
        // Strip is back on mobile + desktop, both views.
        // 0.0.127 — Total chip removed from the lifted strip in both
        // views. Drilldown to the "all active" list is still available
        // via the central TOTAL hub ring and the enlarged-quadrant
        // Total pill (which carries a category filter). The strip is
        // now strictly a Rising / Stuck triage lens.
        const chips: Array<{ mode: typeof highlightedSubsetMode; label: string; hint: string }> = [
          { mode: "rising"    as const, label: "Rising", hint: "Net increase in active count in the last hour" },
          { mode: "open_time" as const, label: "Stuck",  hint: "Problems active for more than 4 hours" },
        ];
        return (
          <div
            role="note"
            aria-label="Cell sub-bubble legend"
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 12,
              padding: "8px 14px",
              margin: "0 0 10px",
              borderRadius: 8,
              background: "var(--neo-surface-2)",
              border: "1px solid var(--neo-border)",
              color: "var(--neo-text-2)",
              font: '500 11px/1.3 "Inter", system-ui, sans-serif',
              userSelect: "none",
            }}
          >
            <span style={{ fontWeight: 700, color: "var(--neo-text)", letterSpacing: "0.04em" }}>
              {inList ? "Filter by:" : "Each cell groups by:"}
            </span>
            {chips.map((m) => {
              const isActive = highlightedSubsetMode === m.mode;
              return (
                <button
                  key={m.label}
                  type="button"
                  title={`${m.hint}${isActive ? " — click to clear" : (inList ? " — click to filter" : " — click to highlight in every cell")}`}
                  onClick={() => setHighlightedSubsetMode((prev) => (prev === m.mode ? null : m.mode))}
                  aria-pressed={isActive}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "3px 10px",
                    borderRadius: 999,
                    background: isActive ? "rgba(99,102,241,0.20)" : "var(--neo-surface)",
                    border: `1px solid ${isActive ? "#6366f1" : "var(--neo-border)"}`,
                    color: isActive ? "#a5b4fc" : "var(--neo-text)",
                    fontWeight: 600,
                    font: 'inherit',
                    cursor: "pointer",
                    transition: "background 120ms, border-color 120ms, color 120ms",
                  }}
                >
                  {m.label}
                  <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.6, fontWeight: 500 }}>{m.hint}</span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ═══ MAIN CONTENT ═══ */}
      {viewMode === "neural" ? (
        <div className="neo-neural-section">
          {/* (Show-by selector moved to the top of the page —
              see .neo-show-by-bar above the chart.) */}
          <div className="neo-active-titlebar">
            <h2 className="neo-active-title">Problems</h2>
            {groupBy === "segment" && (
              <>
                <span
                  className="neo-info-pill"
                  title="A problem can match more than one segment. The same problem may contribute to multiple quadrant counts on this page."
                  aria-label="A problem can match more than one segment"
                >
                  ⓘ multi-segment
                </span>
                {segmentOverflowCount > 0 && (
                  <div className="neo-overflow-anchor">
                    <button
                      type="button"
                      className="neo-overflow-chip"
                      aria-expanded={overflowOpen}
                      aria-haspopup="menu"
                      onClick={() => setOverflowOpen((v) => !v)}
                      title="Show all segments ranked by active count"
                    >
                      +{segmentOverflowCount} more segments
                    </button>
                    {overflowOpen && (
                      <>
                        <div
                          className="neo-overflow-backdrop"
                          onClick={() => setOverflowOpen(false)}
                          aria-hidden="true"
                        />
                        <div className="neo-overflow-popover" role="menu">
                          <div className="neo-overflow-popover-header">
                            <span>All segments · {segmentRanking.length}</span>
                            <span className="neo-overflow-popover-sub">ranked by active problems</span>
                          </div>
                          <div className="neo-overflow-popover-list">
                            {segmentRanking.map((s) => {
                              const inTop = groupings.some((g) => g.id === s.uid);
                              return (
                                <button
                                  key={s.uid}
                                  type="button"
                                  className={`neo-overflow-popover-item${inTop ? " neo-overflow-popover-item-top" : ""}`}
                                  onClick={() => {
                                    setOverflowOpen(false);
                                    resetListFilters();
                                    setCatFilter(new Set([s.uid]));
                                    setViewMode("list");
                                  }}
                                >
                                  <span
                                    className="neo-overflow-popover-dot"
                                    style={{ background: colorForName(s.name) }}
                                    aria-hidden="true"
                                  />
                                  <span className="neo-overflow-popover-name">{s.name}</span>
                                  {inTop && (
                                    <span className="neo-overflow-popover-tag" aria-label="Shown as a quadrant">
                                      on grid
                                    </span>
                                  )}
                                  <span className="neo-overflow-popover-count">{s.count}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          {groupBy === "segment" && !segCatalogLoading && segCatalog.length === 0 && (
            <div className="neo-empty-segments" role="status">
              <div className="neo-empty-segments-icon" aria-hidden="true">◇</div>
              <div className="neo-empty-segments-body">
                <div className="neo-empty-segments-title">No filter segments configured</div>
                <div className="neo-empty-segments-hint">
                  Create segments in the Segments app to organise problems by team, environment,
                  or service group. Until then, switch to <strong>Incidents</strong> to see
                  problems grouped by Davis category.
                </div>
              </div>
            </div>
          )}
          {/* 0.0.125 — chip strip moved up above the viewMode ternary
              so it shows in both constellation AND list. The old
              inline strip used to live here (constellation-only,
              desktop-only). See the new strip above the main-content
              block. */}
          <ConstellationView
            problems={problems}
            onSelect={onConstellationSelect}
            dataMode={dataMode}
            /* 0.0.127 — drilldown via category-name click AND via
               cell-area click both removed. User: "remover opcao
               de drill down na tela overview pelo nome da categoria
               ou na area sem dados. Permitir drilldown apenas nos
               circulos de agrupamentos." The only entry points to
               the enlarged modal now are the sub-bubbles (Rising /
               Stuck / Total) inside each cell — `onQuadrantEnlarge`
               below. The dot click still pins an individual
               problem (its own path, not a category drilldown).
               `onQuadrantClick` and `onCategoryLabelClick` props
               intentionally left undefined so the canvas hit-tests
               for the cell-body / label-strip become no-ops. */
            onHubRingClick={(kind) => {
              // 0.0.118 — central rings drill to the LIST view
              // with the matching status filter. Same intent as
              // the FILTERS strip's status chips:
              //   total    → no status filter (TOTAL ring)
              //   active   → status = "ACTIVE"
              //   resolved → status = "CLOSED"
              //
              // 0.0.143 — also clear the Rising/Stuck chip on the
              // way out. User: "Ao fazer drilldown dos circulos
              // centrais e sessao resolved, nao levar filtro de
              // rising ou stuck para a list." The hub rings express
              // a status-only intent (all of TOTAL / ACTIVE /
              // RESOLVED); carrying an age-window narrowing on top
              // would silently under-count the list vs the ring.
              resetListFilters();
              setHighlightedSubsetMode(null);
              if (kind === "active")   setStatusFilter("ACTIVE");
              else if (kind === "resolved") setStatusFilter("CLOSED");
              else                     setStatusFilter(null);
              setViewMode("list");
            }}
            onResolvedTileClick={(groupingId) => {
              // 0.0.118 — per-category tile in the RESOLVED zone
              // drills into LIST filtered by category + CLOSED.
              // 0.0.143 — also clear Rising/Stuck chip (the tiles
              // are about CLOSED problems, so an ACTIVE-only chip
              // would collapse the list to zero).
              resetListFilters();
              setHighlightedSubsetMode(null);
              setCatFilter(new Set([groupingId]));
              setStatusFilter("CLOSED");
              setViewMode("list");
            }}
            onQuadrantEnlarge={(cellId, mode) => {
              setEnlargedQuadrant(cellId);
              setEnlargedQuadrantMode(mode);
            }}
            // 0.0.164 — Total bubble bypasses the modal and lands
            // on the LIST view filtered ONLY by category. User: "o
            // drilldown do grupo Total deve apenas direcionar o
            // usuario para a list levando apenas o filtro de
            // categoria." Same closure the modal Total pill uses.
            onCellTotalDrilldown={(groupingId) => {
              resetListFilters();
              setStatusFilter(null);
              setHighlightedSubsetMode(null);
              setCatFilter(new Set([groupingId]));
              setViewMode("list");
            }}
            onEmptyClick={handleEmptyClick}
            groupings={groupings}
            resolveGrouping={resolveGrouping}
            showHub={groupBy === "category"}
            countOverrides={constellationCountOverrides}
            highlightedSubsetMode={highlightedSubsetMode}
            leaderCellIds={subsetLeaderCells}
            stuckCutoffMs={stuckCutoffMs}
          />
        </div>
      ) : (
        <div className="neo-list-section">
          {/* Large-dataset advisory — surfaces when the filtered set is
              big enough that the list and KPIs degrade. Real customer
              tenants stay below this cap because `useProblems.HARD_CEILING`
              limits the source to 10k. Belt-and-braces in case a future
              regression lifts the source cap.
              0.0.172 — also surfaces when more matches exist server-
              side than the current batch (`hasMore`). Tells the user
              the list paginates 250 at a time and points at the
              "Load more" affordance at the bottom. */}
          {(filtered.length > MAX_RENDER_ROWS || !teamMetricsEnabled || (hasMore && expectedListTotal !== null && expectedListTotal > filtered.length)) && (
            <div className="neo-large-dataset-banner" role="status">
              {filtered.length > MAX_RENDER_ROWS ? (
                <>
                  <strong>Large dataset detected</strong>{" "}
                  ({filtered.length.toLocaleString()} problems matched).{" "}
                  Showing the first {MAX_RENDER_ROWS.toLocaleString()} rows — refine the filter / search / timeframe to narrow.
                </>
              ) : (hasMore && expectedListTotal !== null && expectedListTotal > filtered.length) ? (
                <>
                  <strong>Showing {filtered.length.toLocaleString()} of {expectedListTotal.toLocaleString()}</strong>{" "}
                  matching problems. The list loads in batches of 250 —
                  use <strong>Load more</strong> at the bottom of the list to fetch the next batch,
                  or refine the timeframe / filters to narrow.
                </>
              ) : null}
              {!teamMetricsEnabled && (
                <> Team-metrics KPIs are paused above {TEAM_METRICS_CAP.toLocaleString()} problems — they re-enable automatically once you filter down.</>
              )}
            </div>
          )}
          {/* Pinned-filter banners — extracted in audit Step 3 into a
              dedicated `<PinnedBanners>` component (one renderer per
              filter variant: pinned problem, affected entity, root
              cause, status, stuck > Nh). All state stays here; the
              component is a dumb renderer. */}
          <PinnedBanners
            problems={sorted}
            pinnedProblemId={pinnedProblemId}
            onClearPinnedProblem={clearPinnedProblem}
            entityFilter={entityFilter}
            onClearEntityFilter={() => setEntityFilter(null)}
            rceFilter={rceFilter}
            onClearRceFilter={() => setRceFilter(null)}
            statusFilter={statusFilter}
            onClearStatusFilter={() => setStatusFilter(null)}
            stuckHoursFilter={stuckHoursFilter}
            onClearStuckHoursFilter={() => setStuckHoursFilter(null)}
            segmentFilter={segmentFilter}
            segmentName={segmentFilter ? (segNameByUid[segmentFilter] || segmentFilter) : null}
            onClearSegmentFilter={() => setSegmentFilter(null)}
          />
          {/* ── Row 1: search · actions · sort · count ── */}
          <div className="neo-list-actions">
            <ProblemSearch
              value={search}
              onChange={setSearch}
              inline
              ariaLabel="Search incidents"
            />
            <button
              type="button"
              className={`neo-icon-btn${loading ? " neo-icon-btn-spinning" : ""}`}
              onClick={handleRefresh}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh problems list"
            >⟳</button>
            <button
              type="button"
              className="neo-icon-btn"
              onClick={handleExportCsv}
              disabled={filtered.length === 0}
              title={`Export ${filtered.length} problem${filtered.length === 1 ? "" : "s"} to CSV`}
              aria-label="Export to CSV"
            >⤓</button>
            <select
              className="neo-sort-select"
              value={sortMode}
              onChange={(e) => {
                const next = e.target.value as SortMode;
                setSortMode(next);
                // Keep the constellation's "Show by" in sync with the
                // list's Sort by — same user intent, two surfaces.
                setDataMode(SORT_TO_SHOW[next]);
              }}
              aria-label="Sort"
              title="Sort"
            >
              <option value="urgency">Urgency</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="duration">Longest duration</option>
              <option value="impact">Highest impact</option>
              <option value="segment">Segment (grouped)</option>
              <option value="entity">Affected entity (grouped)</option>
            </select>
            {/* 0.0.172 — show "X of Y problems" when the loaded
                subset is smaller than the authoritative total. Y
                comes from the count query, so it reflects every
                problem matching the current category / status
                filter — not just the 250-row batch the list
                currently renders. Hover tooltip explains the
                pagination + the Load more affordance. */}
            <span
              className="neo-list-count"
              aria-live="polite"
              title={
                expectedListTotal !== null && expectedListTotal > filtered.length
                  ? `Showing the first ${filtered.length.toLocaleString()} of ${expectedListTotal.toLocaleString()} problems matching the current filters. Use "Load more" at the bottom of the list to fetch the next batch.`
                  : undefined
              }
            >
              <strong>{filtered.length.toLocaleString()}</strong>
              {expectedListTotal !== null && expectedListTotal > filtered.length && (
                <span style={{ opacity: 0.75 }}>
                  {" "}of <strong>{expectedListTotal.toLocaleString()}</strong>
                </span>
              )}
              <span> {(expectedListTotal ?? filtered.length) === 1 ? "problem" : "problems"}</span>
            </span>
          </div>

          {/* Drill-down filter banner — shows the active CATEGORY filter
              that came from clicking a quadrant header on the main page.
              Pinned-problem state has its own banner above; severity sits
              in the global header bar; time range lives on the chart.
              When more than one leader category was drilled into, all of
              them appear here, each in its own colour, mirroring what
              was highlighted on the dashboard. */}
          {catFilter.size > 0 && (() => {
            const cats = Array.from(catFilter);
            const primaryColor = colorForGrouping(cats[0]);
            return (
              <div className="neo-pinned-banner" role="status" style={{ borderLeftColor: primaryColor }}>
                <span
                  className="neo-pinned-dot"
                  aria-hidden="true"
                  style={{ background: primaryColor, boxShadow: `0 0 10px ${primaryColor}` }}
                />
                <span className="neo-pinned-label">
                  {cats.length === 1 ? "Filtered by category" : `Filtered by ${cats.length} categories`}
                </span>
                <span className="neo-pinned-id neo-pinned-cats">
                  {cats.map((cat, i) => (
                    <React.Fragment key={cat}>
                      {i > 0 && <span className="neo-pinned-sep">·</span>}
                      <span style={{ color: colorForGrouping(cat) }}>{labelForGrouping(cat)}</span>
                    </React.Fragment>
                  ))}
                </span>
                <button
                  type="button"
                  className="neo-pinned-clear"
                  onClick={() => setCatFilter(new Set())}
                  title="Show every category"
                >✕ Show all</button>
              </div>
            );
          })()}

          {/* Metric-availability filter — each chip carries its own
              value/range bound via the popover anchored to the chip.
              Click the body to activate / open the picker; click "Off"
              inside the popover to deactivate; pick a preset or type
              a custom range to refine. Composes with category chips +
              search. Composition between chips is FIXED to AND
              (intersection) — "show only incidents matching every
              active criterion". The previous ALL/ANY toggle was
              removed: users couldn't tell what it did, and the OR
              semantic almost never fits a "narrow down" triage
              flow. */}
          {/* Group-By chip strip — replaces the previous "Has metric"
              filter (0.0.81 retired the per-problem Metrics column, so
              the filter lost its accompanying visual).
              Clicking a chip toggles that column in/out of the
              grouping order. Active chips show a badge with their
              nesting level (1 = outer, 2 = inner). Up to two chips
              can be active at once; nesting renders in click-order. */}
          <div className="neo-groupby">
            <span className="neo-groupby-label">Group by</span>
            {ALL_GROUPBY_COLS.map((col) => {
              const idx = groupByColumns.indexOf(col);
              const isActive = idx >= 0;
              const label = col === "entity" ? "Affected entity" : "Root cause";
              return (
                <button
                  key={col}
                  type="button"
                  className={`neo-groupby-chip${isActive ? " neo-groupby-chip-active" : ""}`}
                  onClick={() => toggleGroupByColumn(col)}
                  title={isActive
                    ? `Stop grouping by ${label}`
                    : `Group rows by ${label}${groupByColumns.length === 0 ? "" : ` (nested inside ${groupByColumns.map((c) => c === "entity" ? "Affected entity" : "Root cause").join(" → ")})`}`}
                  aria-pressed={isActive}
                >
                  <span className="neo-groupby-chip-glyph" aria-hidden="true">
                    {isActive ? idx + 1 : "⊕"}
                  </span>
                  <span className="neo-groupby-chip-label">{label}</span>
                </button>
              );
            })}
            {groupByColumns.length > 0 && (
              <button
                type="button"
                className="neo-groupby-chip neo-groupby-clear"
                onClick={() => setGroupByColumns([])}
                title="Clear grouping"
                aria-label="Clear grouping"
              >✕</button>
            )}
            {/* 0.0.123 — subset chips imported from the constellation
                page. */}
            {/* 0.0.127 follow-up — embedded Rising/Stuck/Total chip
                strip removed from the GROUP BY row. User: "vc removeu
                errado os filtros da versao mobile de Rising e
                Stuck...era apenas para remover as opcoes no group
                by." The chips mixed into the GROUP BY strip read as
                "another way to group rows", which contradicts their
                actual semantic (subset highlight + row filter). The
                v0.0.125 lifted strip above the viewMode ternary
                ("Filter by:" label) is the canonical home and is
                visible in both views + both devices again. */}
          </div>

          {loading ? (
            <div className="neo-loading-list">
              {[1, 2, 3, 4].map((i) => <div key={i} className="neo-skeleton" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="neo-empty">No incidents found</div>
          ) : isMobileOrTablet ? (
            /* Mobile / tablet variant — cards stacked vertically.
               Desktop layout (the .neo-ttable block below) is
               unreachable on small viewports but kept intact so
               nothing changes for desktop users.
               Apply the SAME MAX_RENDER_ROWS slice the desktop list
               uses (line 2518 below). Without it, a future regression
               that lifts the source cap could push the entire array
               into MobileIncidentList → hundreds of thousands of DOM
               nodes → mobile tab unresponsive. Real customer flows
               never breach the cap because useProblems.HARD_CEILING
               limits the source to 10 k. */
            <MobileIncidentList
              problems={filtered.slice(0, MAX_RENDER_ROWS)}
              perProblem={perProblem}
              expandedIds={expandedRows}
              onToggleExpand={toggleRow}
              sortByProblem={sortByProblem}
              setActivitySort={setActivitySort}
              groupByColumns={groupByColumns}
            />
          ) : (
            <div className={`neo-ttable${groupBy === "segment" ? " neo-ttable-segments" : ""}`} aria-label="Problems list">
              {/* Sticky column header — each label is clickable to sort
                  the table by that column. Click cycles: asc → desc →
                  back to the default Sort-by dropdown order. */}
              <div className="neo-thead" role="row">
                {([
                  ["id",       "ID",                ""],
                  ["name",     "Name",              ""],
                  ["status",   "Status",            ""],
                  ["category", "Category",          ""],
                  ...(groupBy === "segment" ? [["segment", "Segment", ""] as [ColumnSortKey, string, string]] : []),
                  ["affected", "Affected",          "neo-tcell-num"],
                  ["entities", "Affected entities", ""],
                  ["root",     "Root cause",        ""],
                  ["started",  "Started",           ""],
                  ["end",      "End",               ""],
                  ["duration", "Duration",          ""],
                  ["impact",   "Impact",            ""],
                ] as Array<[ColumnSortKey, string, string]>).map(([key, label, extra]) => {
                  const isActive = colSort?.key === key;
                  const arrow = !isActive ? "" : colSort?.dir === "asc" ? "↑" : "↓";
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`neo-tcell neo-th-sort${extra ? " " + extra : ""}${isActive ? " neo-th-sort-active" : ""}`}
                      role="columnheader"
                      aria-sort={!isActive ? "none" : colSort?.dir === "asc" ? "ascending" : "descending"}
                      onClick={() => handleColumnSort(key)}
                      title={`Sort by ${label}${isActive && colSort?.dir === "desc" ? " — click to clear" : ""}`}
                    >
                      <span className="neo-th-label">{label}</span>
                      {arrow && <span className="neo-th-arrow" aria-hidden="true">{arrow}</span>}
                    </button>
                  );
                })}
                {/* 0.0.120 — Segments column removed from the list.
                    The data source (`useSegmentMembership`) was the
                    DPS-killer flagged in the cost analysis (~83 % of
                    the per-user budget); already gated behind
                    `SHOW_SEGMENT_VIEW = false`, but the column was
                    still showing "—" everywhere. Drilldown by
                    segment (?segment=<uid>) still works via deep-
                    link / Top-Segments card on Trends; the user
                    just can't pick it from a row chip any more. */}
              </div>

              {(() => {
                /* Multi-level group-by renderer. The grouping ORDER is
                   the concatenation of (a) the implicit segment-grouping
                   trigger ("Sort by segment" / Segments-column header
                   click) and (b) the explicit `groupByColumns` chip
                   strip. Both can be active simultaneously; in that
                   case segment is the OUTER level and groupByColumns
                   nest inside.

                   For each row we resolve a label per level. When ANY
                   level's label differs from the previous row's, we
                   emit a divider (or stack of dividers, one per level
                   that changed). The prevLabels closure tracks the
                   running label per level across renderRow calls.

                   levels[i].kind identifies the lookup type:
                     • "segment"  → first alpha segment name (via
                                    segMembership + segNameByUid)
                     • "entity"   → first affected-entity name (or id)
                     • "root"     → root cause entity name (or id)
                     • "category" → Davis problem category (added
                                    v0.0.126 — driven by the "Total"
                                    chip in list mode). */
                type LevelKind = "segment" | "entity" | "root" | "category";
                const levels: { kind: LevelKind; label: string }[] = [];
                // 0.0.126 — Total chip in list view = group by
                // category. Outermost level (above entity / root)
                // so category sections wrap the other groupings.
                if (viewMode === "list" && highlightedSubsetMode === "criticality") {
                  levels.push({ kind: "category", label: "Category" });
                }
                if (sortMode === "segment" || colSort?.key === "segments") {
                  levels.push({ kind: "segment", label: "Segment" });
                }
                for (const col of groupByColumns) {
                  levels.push({
                    kind: col === "entity" ? "entity" : "root",
                    label: col === "entity" ? "Affected entity" : "Root cause",
                  });
                }

                const labelFor = (p: Problem, kind: LevelKind): string => {
                  if (kind === "segment") {
                    const s = segMembership.get(p.display_id);
                    if (!s || s.size === 0) return "(no segment)";
                    const names = Array.from(s).map((uid) => segNameByUid[uid] || uid).sort();
                    return names[0];
                  }
                  if (kind === "entity") {
                    const ids = p.affected_entity_ids;
                    if (!ids || ids.length === 0) return "(no affected entity)";
                    const names = p.affected_entity_names || [];
                    return names[0] || ids[0] || "(unknown)";
                  }
                  if (kind === "root") {
                    const rcName = p.root_cause_entity_name?.trim();
                    const rcId   = p.root_cause_entity_id?.trim();
                    if (rcName) return rcName;
                    if (rcId)   return rcId;
                    return "(no root cause)";
                  }
                  // category — Davis category id, lifted via the
                  // page's grouping resolver so segment-mode users
                  // also see meaningful labels.
                  const cat = p["event.category"];
                  return labelForGrouping(cat) || cat || "(no category)";
                };

                // Running labels per level — first row triggers ALL
                // dividers because every "prev" starts as null.
                const prevLabels: (string | null)[] = levels.map(() => null);

                const renderRow = (problem: Problem) => {
                // Resolve labels for every active level for this row,
                // then find the FIRST level whose label changed. All
                // levels from that index onward need a divider emitted
                // (because changing an outer group resets the inner
                // grouping too). prevLabels are advanced for emitted
                // levels.
                const curLabels = levels.map((lvl) => labelFor(problem, lvl.kind));
                let changedFrom = -1;
                for (let i = 0; i < levels.length; i++) {
                  if (curLabels[i] !== prevLabels[i]) { changedFrom = i; break; }
                }
                const dividerLevels: { idx: number; label: string; kind: LevelKind; depth: number }[] = [];
                if (changedFrom >= 0) {
                  for (let i = changedFrom; i < levels.length; i++) {
                    dividerLevels.push({
                      idx: i,
                      label: curLabels[i],
                      kind: levels[i].kind,
                      depth: i,
                    });
                    prevLabels[i] = curLabels[i];
                  }
                }
                const isActive   = problem["event.status"] === "ACTIVE";
                const catColor   = colorForGrouping(resolveGrouping(problem));
                const sevLabel   = getSeverityLevel(problem);
                const sevColor   = SEVERITY_COLORS[sevLabel];
                const entities   = problem.affected_entity_ids || [];
                const duration   = formatDuration(problem["event.start"], problem["event.end"]);
                const isExpanded = expandedRows.has(problem.display_id);
                const impact     = getImpactLabel(problem.affected_entity_ids);
                const firstEnt   = entities[0];
                // Highlight bumps the row's accent edge + adds a glow.
                // Two sources can trigger it:
                //   • chartHighlight.byId — the leader category's top
                //     problems (so the row matches the chart strip).
                //   • listTopIds — the top-tier UNDER THE ACTIVE
                //     dataMode within the currently-filtered list
                //     (so switching Rising / Oldest Open / Criticality
                //     visibly affects the table).
                // Chart highlight wins when both apply (its colour is
                // the leader category's colour, which carries more info).
                const highlightColor = chartHighlight.byId.get(problem.display_id);
                const isListTop = listTopIds.has(problem.display_id);
                const showHighlight = !!highlightColor || isListTop;
                const accent = highlightColor || (isListTop ? listModeAccent : catColor);
                return (
                  <React.Fragment key={problem.display_id}>
                    {/* Section dividers — one per level that changed
                        between the previous row and this row. Outer
                        levels (lower depth) render before inner ones.
                        Depth controls left indentation via the
                        `--neo-tgroup-depth` CSS custom property. */}
                    {dividerLevels.map((d) => {
                      const icon = d.kind === "segment" ? "◆"
                                 : d.kind === "entity"  ? "◉"
                                 :                        "✺"; /* root */
                      const aria = `${d.kind === "segment" ? "Segment"
                                    : d.kind === "entity"  ? "Affected entity"
                                    :                        "Root cause"} ${d.label}`;
                      return (
                        <div
                          key={`gh-${d.idx}-${d.label}`}
                          className={`neo-tgroup neo-tgroup-depth-${d.depth} neo-tgroup-kind-${d.kind}`}
                          role="rowgroup"
                          aria-label={aria}
                          style={{ ["--neo-tgroup-depth" as string]: d.depth }}
                        >
                          <span className="neo-tgroup-icon" aria-hidden="true">{icon}</span>
                          <span className="neo-tgroup-label">{d.label}</span>
                        </div>
                      );
                    })}
                  <article
                    data-display-id={problem.display_id}
                    className={`neo-tcard${isExpanded ? " neo-tcard-open" : ""}${isActive ? "" : " neo-tcard-resolved"}${showHighlight ? " neo-tcard-highlighted" : ""}`}
                    style={{ "--neo-row-accent": accent } as React.CSSProperties}
                  >
                    <div
                      className="neo-trow"
                      role="row"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      aria-controls={`row-body-${problem.display_id}`}
                      onClick={(e) => {
                        // Don't toggle if the user is in the middle of a
                        // text selection (drag-to-copy) — the trailing
                        // mouseup fires this click but they're not trying
                        // to expand/collapse.
                        const sel = window.getSelection?.();
                        if (sel && sel.toString().length > 0) return;
                        toggleRow(problem.display_id);
                      }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleRow(problem.display_id); } }}
                    >
                      <span className="neo-tedge" aria-hidden="true" />
                      <span className="neo-tcell neo-tcell-id" role="cell">{problem.display_id}</span>
                      <span className="neo-tcell neo-tcell-name" role="cell">{problem["event.name"]}</span>
                      <span className="neo-tcell" role="cell">
                        <span className={`neo-tstatus${isActive ? " neo-tstatus-active" : " neo-tstatus-closed"}`}>
                          {isActive && <span className="neo-tstatus-glyph" aria-hidden="true">◆</span>}
                          {isActive ? "Active" : "Closed"}
                        </span>
                      </span>
                      <span className="neo-tcell neo-tcell-cat" role="cell">
                        <span className="neo-tcell-icon" style={{ color: catColor }} aria-hidden="true">{getCategoryIcon(problem["event.category"])}</span>
                        <span className="neo-tcell-text">{getCategoryLabel(problem["event.category"])}</span>
                      </span>
                      {groupBy === "segment" && (() => {
                        const segs = segMembership.get(problem.display_id);
                        const segList = segs ? Array.from(segs) : [];
                        const firstSeg = segList[0];
                        return (
                          <span className="neo-tcell" role="cell">
                            {firstSeg ? (
                              <span className="neo-tchip">
                                <span className="neo-tchip-icon" aria-hidden="true">◇</span>
                                <span className="neo-tchip-text">
                                  <span className="neo-tchip-name">{segNameByUid[firstSeg] || firstSeg}</span>
                                </span>
                                {segList.length > 1 && (
                                  <span className="neo-tchip-more">+{segList.length - 1}</span>
                                )}
                              </span>
                            ) : (
                              <span className="neo-tempty">—</span>
                            )}
                          </span>
                        );
                      })()}
                      <span className="neo-tcell neo-tcell-num" role="cell">{entities.length}</span>
                      <span className="neo-tcell" role="cell">
                        {firstEnt ? (() => {
                          // Canonical name from dt.davis.problems (same
                          // field the official Problems app uses). Falls
                          // back to the Type · short-id format.
                          const firstName = problem.affected_entity_names?.[0] || null;
                          return (
                            <span className="neo-tchip">
                              <span className="neo-tchip-icon" aria-hidden="true">⌬</span>
                              <span className="neo-tchip-text">
                                {firstName
                                  ? <span className="neo-tchip-name">{firstName}</span>
                                  : <>
                                      <span className="neo-tchip-type">{entityTypeLabel(entityTypeOf(firstEnt))}</span>
                                      <span className="neo-tchip-sep"> · </span>
                                      <span className="neo-tchip-uid">{shortEntityId(firstEnt)}</span>
                                    </>
                                }
                              </span>
                              {entities.length > 1 && <span className="neo-tchip-more">+{entities.length - 1}</span>}
                            </span>
                          );
                        })() : <span className="neo-tempty">—</span>}
                      </span>
                      <span className="neo-tcell" role="cell">
                        {problem.root_cause_entity_id ? (() => {
                          const rootName = problem.root_cause_entity_name || null;
                          return (
                            <span className="neo-tchip neo-tchip-root">
                              <span className="neo-tchip-icon" aria-hidden="true">◉</span>
                              <span className="neo-tchip-text">
                                {rootName
                                  ? <span className="neo-tchip-name">{rootName}</span>
                                  : <>
                                      <span className="neo-tchip-type">{entityTypeLabel(entityTypeOf(problem.root_cause_entity_id))}</span>
                                      <span className="neo-tchip-sep"> · </span>
                                      <span className="neo-tchip-uid">{shortEntityId(problem.root_cause_entity_id)}</span>
                                    </>
                                }
                              </span>
                            </span>
                          );
                        })() : <span className="neo-tempty">—</span>}
                      </span>
                      <span className="neo-tcell neo-tcell-time" role="cell">
                        {formatStartedDate(problem["event.start"])}
                      </span>
                      {/* End column — ACTIVE problems have no end yet
                          so they render an em-dash placeholder. Same
                          formatter as Started keeps the column visually
                          aligned (day + month + year + 24-h clock). */}
                      <span className="neo-tcell neo-tcell-time" role="cell">
                        {problem["event.end"]
                          ? formatStartedDate(problem["event.end"])
                          : <span className="neo-tempty">—</span>}
                      </span>
                      <span className="neo-tcell neo-tcell-dur" role="cell">{duration}</span>
                      <span className="neo-tcell" role="cell">
                        {impact ? (
                          <span className={`neo-tchip neo-tchip-impact neo-tchip-impact-${impact.label.toLowerCase()}`}>
                            <span className="neo-tchip-icon" aria-hidden="true">{impact.icon}</span>
                            <span className="neo-tchip-text">{impact.label}</span>
                            {impact.extra > 0 && <span className="neo-tchip-more">+{impact.extra}</span>}
                          </span>
                        ) : <span className="neo-tempty">—</span>}
                      </span>
                      {/* 0.0.120 — Segments column cell removed in
                          lockstep with the header. See header
                          comment above for rationale. */}
                    </div>

                    {isExpanded && (
                      <div className="neo-row-body" id={`row-body-${problem.display_id}`}>
                        {/* Stats grid removed — every value
                            (severity, category, duration, affected,
                            started, impact) is already shown in the
                            row header above, so the grid was 90 px
                            of pure duplication. */}

                        {/* Root cause used to live here as a standalone
                            callout card. It was moved into the
                            `neo-row-top-left` flex row below, side-by-
                            side with the Affected entities chip strip,
                            so the two facets of the problem read as a
                            parallel pair instead of stacking. The old
                            `.neo-row-rootcause*` callout CSS was
                            removed in the same change. */}

                        {/* Entities (left) + actions (right) in a
                            two-column grid so they share one vertical
                            slot instead of stacking. The right column
                            always renders the action chips even when
                            there are no affected entities. */}
                        <div className="neo-row-top-grid">
                          {/* Left column hosts BOTH the affected-entities
                              chip strip AND the root-cause chip. They
                              share the same visual treatment (uppercase
                              mono label + chip) so the eye reads them
                              as parallel facets of the problem. Wrapped
                              in a flex row that wraps to a column when
                              the available width can't hold both
                              side-by-side. */}
                          <div className="neo-row-top-left">
                            {entities.length > 0 && (
                              <div className="neo-row-entities">
                                <span className="neo-row-entities-label">Affected entities · {entities.length}</span>
                                <div className="neo-row-entities-chips">
                                  {entities.slice(0, 12).map((eid, i) => {
                                    const nm = problem.affected_entity_names?.[i] || null;
                                    return (
                                      <span key={i} className="neo-row-entity-chip">
                                        <span className="neo-row-entity-chip-icon" aria-hidden="true">⌬</span>
                                        {nm
                                          ? <span className="neo-row-entity-chip-name">{nm}</span>
                                          : <span className="neo-row-entity-chip-id">{eid}</span>}
                                      </span>
                                    );
                                  })}
                                  {entities.length > 12 && (
                                    <span className="neo-row-entity-more">+{entities.length - 12} more</span>
                                  )}
                                </div>
                              </div>
                            )}
                            {problem.root_cause_entity_id && (
                              <div className="neo-row-rootcause">
                                <span className="neo-row-entities-label">Root cause</span>
                                <div className="neo-row-entities-chips">
                                  <span
                                    className="neo-row-entity-chip neo-row-entity-chip-rc"
                                    title={problem.root_cause_entity_name
                                      ? `${problem.root_cause_entity_name} (${problem.root_cause_entity_id})`
                                      : problem.root_cause_entity_id}
                                  >
                                    {/* Different glyph (▲) than the affected-
                                        entities octagon (⌬) so the eye can
                                        spot which chip is the root cause at
                                        a glance even when names overlap. */}
                                    <span className="neo-row-entity-chip-icon" aria-hidden="true">▲</span>
                                    {problem.root_cause_entity_name
                                      ? <span className="neo-row-entity-chip-name">{problem.root_cause_entity_name}</span>
                                      : <span className="neo-row-entity-chip-id">{problem.root_cause_entity_id}</span>}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="neo-row-actions">
                            <CopyChip
                              text={problem.display_id}
                              label="Copy ID"
                              icon="⎘"
                              title="Copy problem ID"
                            />
                            <span
                              className="neo-row-act-share"
                              onClick={(e) => e.stopPropagation()}
                              title="Share via WhatsApp"
                            >
                              <ShareWhatsApp problem={problem} />
                            </span>
                            {/* Share link — same per-problem deep-link the
                                mobile ProblemActions.tsx variant uses
                                (`${tenant}/ui/apps/my.problems.hub?focus=
                                P-####`). The duplicate inline rendering
                                here (instead of <ProblemActions/>) is
                                legacy from before ProblemActions was
                                extracted; the 0.0.97 fix to switch from
                                window.location.href to buildAppShareUrl
                                landed on ProblemActions only, missing
                                this Overview-inline copy. 0.0.98 brings
                                this site in line with the shared helper
                                so both surfaces stop drifting. */}
                            <CopyChip
                              text={
                                buildAppShareUrl(problem.display_id)
                                || window.location.href
                              }
                              label="Share link"
                              icon="⛓"
                              title="Copy a deep-link to this problem inside Problem Lifecycle"
                            />
                            {/* "Timeline" link removed in A3 of the
                                UX consolidation — the activity feed
                                (with the same content) is already
                                rendered inline below as part of
                                <ProblemActivityFeed>. The button
                                would just scroll back to where the
                                user already is. */}
                            {(() => {
                              const href = buildOfficialProblemUrl(problem);
                              return href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="neo-row-act"
                                  onClick={(e) => e.stopPropagation()}
                                  title="Open this problem in the official Davis Problems app"
                                >
                                  <span className="neo-row-act-icon" aria-hidden="true">↗</span>
                                  <span>Open Problem App</span>
                                </a>
                              ) : null;
                            })()}
                            {/* Per-row refresh — fires the global refresh
                                signal so this row's CommentsSection +
                                ProblemActivityFeed re-fetch in place.
                                Lets the user pick up new comments /
                                automation runs without scrolling back
                                to the page-level refresh in the
                                header (the original "sem sair do
                                ponto" ask). */}
                            <button
                              type="button"
                              className="neo-row-act neo-row-act-refresh"
                              onClick={(e) => {
                                e.stopPropagation();
                                triggerRefresh();
                              }}
                              title="Refresh comments + activity feed without leaving this row"
                              aria-label="Refresh activity"
                            >
                              <span className="neo-row-act-icon" aria-hidden="true">↻</span>
                              <span>Refresh</span>
                            </button>
                            {/* Activity-feed sort toggle — sits at
                                the right end of the actions row so
                                both control bars live on one line.
                                Only affects the day-grouped event
                                feed below; the comment composer +
                                swimlane stay anchored at the top. */}
                            {(() => {
                              const currentSort = sortByProblem.get(problem.display_id) ?? "asc";
                              return (
                                <div
                                  className="neo-row-act-sort"
                                  onClick={(e) => e.stopPropagation()}
                                  role="group"
                                  aria-label="Activity sort order"
                                >
                                  <span className="ptl-activity-sort-label">Sort</span>
                                  <div className="neo-segctrl" role="tablist">
                                    <button
                                      type="button"
                                      role="tab"
                                      aria-selected={currentSort === "asc"}
                                      className={`neo-segctrl-btn${currentSort === "asc" ? " neo-segctrl-btn-active" : ""}`}
                                      onClick={() => setActivitySort(problem.display_id, "asc")}
                                      title="Show oldest event at the top (chronological narrative)"
                                    >Oldest first</button>
                                    <button
                                      type="button"
                                      role="tab"
                                      aria-selected={currentSort === "desc"}
                                      className={`neo-segctrl-btn${currentSort === "desc" ? " neo-segctrl-btn-active" : ""}`}
                                      onClick={() => setActivitySort(problem.display_id, "desc")}
                                      title="Show newest event at the top (latest-update feed)"
                                    >Newest first</button>
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        </div>

                        {/* Related incidents — other problems sharing
                            the same root cause. Click to jump straight
                            to that row (we open the row instead of
                            routing away, keeping the user in context). */}
                        {(() => {
                          if (!problem.root_cause_entity_id) return null;
                          const related = problems.filter((q) =>
                            q.root_cause_entity_id === problem.root_cause_entity_id
                            && q.display_id !== problem.display_id,
                          ).slice(0, 6);
                          if (related.length === 0) return null;
                          return (
                            <div className="neo-row-related">
                              <span className="neo-row-related-label">
                                Related incidents · {related.length}
                              </span>
                              <div className="neo-row-related-list">
                                {related.map((r) => {
                                  const rActive = r["event.status"] === "ACTIVE";
                                  const rColor = colorForGrouping(resolveGrouping(r));
                                  return (
                                    <button
                                      key={r.display_id}
                                      type="button"
                                      className={`neo-row-related-chip${rActive ? " neo-row-related-chip-active" : ""}`}
                                      title={`${r["event.name"]} · ${rActive ? "Active" : "Resolved"} · click to expand`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleRow(r.display_id);
                                        requestAnimationFrame(() => {
                                          const el = document.getElementById(`row-body-${r.display_id}`);
                                          if (el && "scrollIntoView" in el) {
                                            (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "nearest" });
                                          }
                                        });
                                      }}
                                      style={{ ["--rel-accent" as string]: rColor }}
                                    >
                                      <span
                                        className="neo-row-related-dot"
                                        aria-hidden="true"
                                        title={rActive ? "Active" : "Resolved"}
                                      />
                                      <span className="neo-row-related-id">{r.display_id}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}

                        {/* Rich activity feed — same body the Timeline
                            page rendered (Comments composer + 3-lane
                            EventSwimlane + day-grouped activity feed
                            with Davis annotations and workflow
                            executions). Consolidated here in A2 of
                            the UX cleanup so triage and post-mortem
                            share one drill-down surface. */}
                        <div className="neo-row-comments">
                          <ProblemActivityFeed
                            problem={problem}
                            sortDir={sortByProblem.get(problem.display_id) ?? "asc"}
                          />
                        </div>
                      </div>
                    )}
                  </article>
                  </React.Fragment>
                );
                };
                return filtered.slice(0, MAX_RENDER_ROWS).map(renderRow);
              })()}
            </div>
          )}
          {/* Pagination — visible only in list mode, only when the DQL
              `| limit` clipped the result. Hidden in constellation
              mode (dots already render whatever's loaded) and when
              the current filter has already returned everything. */}
          {viewMode === "list" && hasMore && filtered.length > 0 && (
            <LoadMoreFooter
              loadedCount={loadedCount}
              fetching={rawFetching}
              onLoadMore={loadMore}
            />
          )}
        </div>
      )}

      {/* Stats footer removed — counts now shown in the ConstellationView hub area
          (TOTAL on the left, ACTIVE in the center, RESOLVED on the right). */}

      {/* Quadrant detail panel — opens when the user clicks a quadrant cell */}
      {quadrantDetail && (
        <QuadrantDetailPanel
          category={quadrantDetail}
          problems={problems}
          onClose={closeQuadrantDetail}
          onSelectProblem={onQuadrantProblemSelect}
        />
      )}

      {/* Enlarged quadrant card — opens when the user clicks the
          per-cell expand button (the corners-out icon in the
          constellation). Pure HTML/SVG, no canvas zoom transform —
          this is the path that addresses the "ainda vejo um zoom"
          feedback. */}
      {enlargedQuadrant && (
        <EnlargedQuadrantCard
          quadrantId={enlargedQuadrant}
          problems={problems}
          groupings={groupings}
          resolveGrouping={resolveGrouping}
          dataMode={enlargedQuadrantMode ?? dataMode}
          onClose={closeEnlargedQuadrant}
          onSelectProblem={onQuadrantProblemSelect}
          // 0.0.130 — pass the count-query override so the modal
          // headline + Total pill agree with the canvas cell. Without
          // this the modal would derive counts from the first-paint
          // `problems` sample (capped at 250) and a 1 574-active
          // category would show "6 active" in the header.
          categoryCounts={
            constellationCountOverrides
              ? {
                  active: constellationCountOverrides.activeByCategory?.[enlargedQuadrant] ?? 0,
                  closed: constellationCountOverrides.resolvedByCategory?.[enlargedQuadrant] ?? 0,
                  // 0.0.137 — pass authoritative Stuck count too so
                  // the modal pill agrees with the cell bubble.
                  stuck: constellationCountOverrides.stuckByCategory?.[enlargedQuadrant],
                  // 0.0.169 — same for Rising. ACTIVE - OLDER from
                  // the count query, computed once in Overview's
                  // constellationCountOverrides and reused by the
                  // cell bubble + modal pill.
                  rising: constellationCountOverrides.risingDeltaByCategory?.[enlargedQuadrant],
                }
              : undefined
          }
          // 0.0.142 — timeframe for the on-demand stuck-by-category
          // fetch (fires only when modal is on Stuck mode).
          stuckFetch={{ ...timeframeFilter, stuckCutoff: stuckCutoffIso }}
          // 0.0.169 — same for the on-demand rising-by-category
          // fetch (fires only when modal is on Rising mode).
          risingFetch={timeframeFilter}
          stuckCutoffMs={stuckCutoffMs}
          // 0.0.127 — Total pill in the modal jumps to LIST
          // filtered by the modal's category. User: "o total da
          // area expandida dele levar o filtro de categoria para a
          // list." Clears other narrowing filters (status, stuck,
          // entity, root-cause, segment, pinned-problem) so the
          // user sees every problem of that category, no other
          // narrowing — Rising/Stuck split is dropped in favour of
          // the full category view.
          onDrilldownToList={(groupingId) => {
            closeEnlargedQuadrant();
            resetListFilters();
            setStatusFilter(null);
            setHighlightedSubsetMode(null);
            setCatFilter(new Set([groupingId]));
            setViewMode("list");
          }}
        />
      )}
    </div>
  );
};

