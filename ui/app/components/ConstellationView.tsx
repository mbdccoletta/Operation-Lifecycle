import React, { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { useCurrentTheme } from "@dynatrace/strato-components/core";
import type { Problem } from "../hooks/useProblems";
import { useDevice } from "../hooks/useDevice";
import { usePageVisible } from "../hooks/useUiUtils";
import type { Grouping, QuadrantSlot } from "../utils/grouping";
import {
  CATEGORY_GROUPINGS,
  categoryColorFor,
  computeQuadrantLayout,
  hexToRgb,
  resolveByCategory,
  detectQuadrantAt as detectQuadrantAtLayout,
  detectLabelAt as detectLabelAtLayout,
} from "../utils/grouping";
import { getCategoryLabel } from "../utils/formatters";
import { scoreOf, TOP_TIER_THRESHOLD } from "../utils/scoring";
import { useIntensity } from "../contexts/IntensityContext";

/** Multiplier the canvas text uses when the user picks a non-default
 *  font scale via the Display panel. Canvas-rendered text doesn't
 *  inherit CSS variables, so we mirror the same percentages defined
 *  in theme.css here. */
const CANVAS_FS_MULT: Record<string, number> = {
  small:  0.92,
  normal: 1,
  large:  1.16,
};

export type ConstellationDataMode = "rising" | "open_time" | "criticality" | "total";

interface ConstellationViewProps {
  problems: Problem[];
  onSelect: (problem: Problem) => void;
  selectedId?: string;
  dataMode?: ConstellationDataMode;
  /** Clicking on a quadrant background (not on a dot) fires this with the grouping id. */
  onQuadrantClick?: (groupingId: string) => void;
  /** Clicking on the header strip of a quadrant (where the grouping name is
   *  drawn) fires this. Used to drill down to the filtered list view. */
  onCategoryLabelClick?: (groupingId: string) => void;
  /** Clicking the small "expand" button anchored at each quadrant's
   *  top-left fires this. When provided, the button DOES NOT trigger
   *  the internal canvas zoom — the host page is expected to render
   *  an enlarged HTML/SVG version of the quadrant in its own modal
   *  (no canvas transformations, the dots stay at their natural
   *  visual size). Falls back to the internal `setExpandedQuadrant`
   *  zoom only when no consumer wires this prop. */
  /** 0.0.109: second arg carries the subset mode the user clicked on
   *  (Rising / Oldest Open / Criticality / Total). The modal uses
   *  that to pre-filter to the matching subset instead of relying on
   *  a global Show By chip. Omitted when the enlarge was triggered
   *  by a non-bubble path (cell label, double-click). */
  onQuadrantEnlarge?: (groupingId: string, subsetMode?: ConstellationDataMode) => void;
  /** Clicking on EMPTY canvas (no dot, no label) fires this so the parent
   *  can clear page-level state — pinned problem, expanded cards, etc. */
  onEmptyClick?: () => void;
  /** Which groupings to render (one per quadrant). Defaults to the six
   *  Davis problem categories. */
  groupings?: Grouping[];
  /** Resolves which grouping a problem belongs to. Defaults to reading
   *  `event.category`. */
  resolveGrouping?: (problem: Problem) => string | null;
  /** When false the central hub band (TOTAL / ACTIVE / RESOLVED
   *  satellites + connecting spokes + dividing lines) is dropped and
   *  quadrants expand to fill the freed vertical space. Used by the
   *  Segments page to make room for up to 12 groupings. Defaults to
   *  true so the categories page renders unchanged. */
  showHub?: boolean;
  /** When false the bottom RESOLVED zone (per-grouping CLOSED
   *  counters) is dropped and the active quadrant area expands to
   *  fill the whole canvas. Used by the enlarged-quadrant modal
   *  which shows ACTIVE only and doesn't need the historical
   *  summary panel. Defaults to true so the categories page +
   *  segments page render unchanged. */
  showResolvedZone?: boolean;
  /** When true the canvas-drawn magnifier lens cursor AND the
   *  proximity-based dot scaling are both disabled. Used by the
   *  enlarged-quadrant modal — the dots are already at a
   *  comfortable size in that view (one quadrant fills the
   *  canvas), so an extra lens just adds visual noise. Defaults
   *  to false so the page-level constellation keeps its cursor
   *  magnifier behaviour. */
  disableMagnifierLens?: boolean;
  /** Multiplier applied to the final drawn dot radius (and
   *  derivatives — glow, halo, rings). Defaults to 1 so the
   *  page-level constellation is unchanged. The modal sets this
   *  to a larger value (≈ 2.5×) so dots look "naturally bigger"
   *  inside the enlarged canvas without needing a magnifier lens
   *  to bring them up to scale. */
  dotScale?: number;
  /** When true, the per-cell aggregation rules (bubble + dot cap) are
   *  bypassed entirely — `isCellAggregated` returns false for every
   *  cell, the bubble pass is skipped, and every individual dot
   *  renders. Used by `EnlargedQuadrantCard` where the modal already
   *  shows ONE cell on a wide canvas: the user expanded explicitly to
   *  see individual dots, so the aggregation safety net would just
   *  hide the data they came to see. */
  disableAggregation?: boolean;
  /** Pre-sets the internal `expandedQuadrant` state on mount so the
   *  canvas opens already zoomed into a specific quadrant. The user
   *  can still click "Exit zoom" / press ESC to leave the zoom; from
   *  there the normal multi-quadrant view kicks in. */
  initialExpandedQuadrant?: string;
  /** Pin the canvas in `expandedQuadrant` mode — no Exit-zoom button,
   *  no ESC/double-click exit, and the zoom math drops its safety
   *  padding so the cell fills the entire canvas. Used by
   *  EnlargedQuadrantCard where the host modal IS the expanded view:
   *  exiting the zoom would just reveal an empty multi-quadrant grid
   *  with one cell, which adds no value over the modal-already-open
   *  state. The modal's ✕ button stays the only way out. */
  lockExpandedQuadrant?: boolean;
  /** Authoritative TOTAL / ACTIVE / RESOLVED counts derived from a
   *  dedicated count query (`useStatusCategoryCounts`) — covers the
   *  ENTIRE tenant window even when the page-level `problems` prop is
   *  trimmed to `DEFAULT_INITIAL` (the Tier 3 DPS knob).
   *
   *  When omitted (loading, or callers that don't use the hook) we
   *  fall back to deriving counts from `problems` — same behaviour as
   *  before this prop existed. Preserves the constellation in
   *  scenarios like the enlarged-quadrant modal or debug scenarios
   *  where the count query isn't meaningful. */
  countOverrides?: {
    total?: number;
    active?: number;
    resolved?: number;
    /** Per-category `event.status == "ACTIVE"` counts. Key is the
     *  Davis category id ("AVAILABILITY", "ERROR", …). Missing keys
     *  fall back to the list-derived filter. */
    activeByCategory?: Record<string, number>;
    /** Per-category `event.status == "CLOSED"` counts. Same shape +
     *  semantics as `activeByCategory`. */
    resolvedByCategory?: Record<string, number>;
  };
}

interface Star {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  pulse: number;
  cluster: string;
  problem: Problem;
  vx: number;
  vy: number;
  targetX: number;
  targetY: number;
  /** Raw mode score (0..1) — driven by Open Time / Criticality / Total. */
  score: number;
  /** Rank within its category for the current mode (0=lowest, 1=top). */
  scoreNorm: number;
  /** True when this is the highest-scoring active problem in its category. */
  isTopOfCategory: boolean;
  /** 0..1 — smoothly animates toward 1 when hovered, 0 otherwise. Drives zoom. */
  hoverAnim: number;
}

// Constants moved to ui/app/utils/grouping.ts — the layout / colour /
// label maps are now derived from the `groupings` prop so a future
// Segments page can supply its own list without touching this file.

const ConstellationViewImpl: React.FC<ConstellationViewProps> = ({
  problems: realProblems,
  onSelect,
  selectedId,
  dataMode = "rising",
  onQuadrantClick,
  onCategoryLabelClick,
  onQuadrantEnlarge,
  onEmptyClick,
  groupings = CATEGORY_GROUPINGS,
  resolveGrouping = resolveByCategory,
  showHub = true,
  showResolvedZone = true,
  disableMagnifierLens = false,
  countOverrides,
  dotScale = 1,
  disableAggregation = false,
  initialExpandedQuadrant,
  lockExpandedQuadrant = false,
}) => {
  // Read the user's font-scale pick so the canvas-rendered text
  // (TOTAL / ACTIVE / RESOLVED circles, per-category counts at
  // the bottom, swim labels, etc.) responds to the Display panel.
  // Closed over by the `draw` callback; redraw fires on the next
  // RAF tick after the value changes.
  const { fontScale } = useIntensity();

  // Layout + per-grouping lookup tables, derived from the props once
  // per render. All the old CATEGORY_COLORS / QUADRANT_BOUNDS /
  // CAT_CENTERS_ACTIVE reads below now go through these.
  const layout: QuadrantSlot[] = useMemo(
    () => computeQuadrantLayout(groupings, { reserveHubBand: showHub }),
    [groupings, showHub],
  );
  const slotById: Record<string, QuadrantSlot> = useMemo(() => {
    const m: Record<string, QuadrantSlot> = {};
    for (const s of layout) m[s.id] = s;
    return m;
  }, [layout]);
  /** Normalised y of each slot's cell-rect top — the midpoint between
   *  this row and the previous row, or 0 for the first row. Mirrors
   *  the hub-band clamping that `cellRects` does (so on the categories
   *  page bottom-row cells start at hubBandBottom, not the gap mid-
   *  point). The HTML expand-button uses this to line up with the
   *  canvas-drawn label. */
  const cellTopNById: Record<string, number> = useMemo(() => {
    const yMins = Array.from(new Set(layout.map((s) => s.bounds.yMin))).sort((a, b) => a - b);
    const yMaxs = Array.from(new Set(layout.map((s) => s.bounds.yMax))).sort((a, b) => a - b);
    const hubBotN = 0.50; // matches the constant in the draw function
    const m: Record<string, number> = {};
    for (const s of layout) {
      const ri = yMins.indexOf(s.bounds.yMin);
      let yMinN = ri === 0 ? 0 : (yMaxs[ri - 1] + yMins[ri]) / 2;
      // Same clamp as cellRects in hub mode: bottom-band rows start
      // at hubBandBottom so the icon doesn't float in the hub gap.
      if (showHub && s.bounds.yMin >= hubBotN) {
        yMinN = Math.max(yMinN, hubBotN);
      }
      m[s.id] = yMinN;
    }
    return m;
  }, [layout, showHub]);
  const colorById: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groupings) m[g.id] = g.color;
    return m;
  }, [groupings]);
  const labelById: Record<string, string> = useMemo(() => {
    const m: Record<string, string> = {};
    for (const g of groupings) m[g.id] = g.label;
    return m;
  }, [groupings]);
  const colorOf = useCallback((id: string | null | undefined): string =>
    (id && colorById[id]) || "#6ee7b7", [colorById]);
  const detectQuadrantAt = useCallback(
    (xN: number, yN: number) => detectQuadrantAtLayout(xN, yN, layout),
    [layout],
  );
  const detectLabelAt = useCallback(
    (xN: number, yN: number) => detectLabelAtLayout(xN, yN, layout),
    [layout],
  );

  // Sorted unique column/row boundaries — used by draw() to position
  // quadrant labels + frame the canvas grid. Hoisting them into a
  // useMemo keyed on `layout` cuts ~8 sort + Set allocations PER
  // FRAME (the constellation runs at 30 fps so that's 240 wasted
  // ops/sec on data that never changes between frames). See M9 in
  // the perf audit. */
  const layoutBounds = useMemo(() => {
    const colXMins = Array.from(new Set(layout.map((s) => s.bounds.xMin))).sort((a, b) => a - b);
    const colXMaxs = Array.from(new Set(layout.map((s) => s.bounds.xMax))).sort((a, b) => a - b);
    const rowYMins = Array.from(new Set(layout.map((s) => s.bounds.yMin))).sort((a, b) => a - b);
    const rowYMaxs = Array.from(new Set(layout.map((s) => s.bounds.yMax))).sort((a, b) => a - b);
    return { colXMins, colXMaxs, rowYMins, rowYMaxs };
  }, [layout]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const starsRef = useRef<Star[]>([]);
  const animRef = useRef(0);
  const dk = (useCurrentTheme() || "dark") === "dark";
  const { isTouch, isMobileOrTablet } = useDevice();
  const [size, setSize] = useState({ w: 400, h: 320 });
  const [hover, setHover] = useState<{ star: Star; mx: number; my: number } | null>(null);
  /** Set when the pointer is over a clickable quadrant label strip — drives
   *  the pointer cursor so users discover the drilldown affordance. */
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  /** True when the cursor is currently inside one of the per-cell
   *  sub-bubble hit areas — flips the OS cursor to `pointer` to
   *  signal clickability (0.0.109 follow-up). */
  const [hoveredBubble, setHoveredBubble] = useState(false);
  /** Set when the pointer is hovering empty space INSIDE a quadrant body
   *  (i.e. not on a dot, not on a label). Drives a floating "double-click
   *  to zoom" hint so the gesture is discoverable, and signals that the
   *  user is just exploring — not aiming at a specific incident. */
  const [zoomHint, setZoomHint] = useState<{ x: number; y: number } | null>(null);
  // Tracks which quadrant the pointer is currently over (or null). Stars in
  // that quadrant stop drifting so the user can click precisely on a dot.
  const hoveredQuadrantRef = useRef<string | null>(null);
  // Current pointer position in NORMALIZED coords (0..1). Drives a fisheye
  // zoom — dots near the cursor scale up smoothly, easing dense selection.
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  // When set, that quadrant is rendered to fill the full canvas — double
  // click on a quadrant zooms in, ESC or close button exits.
  // 0.0.108: `initialExpandedQuadrant` lets the host pre-set this state
  // on mount (EnlargedQuadrantCard uses it so the modal opens already
  // zoomed into the single cell, no extra click required).
  const [expandedQuadrant, setExpandedQuadrant] = useState<string | null>(
    initialExpandedQuadrant ?? null,
  );
  /** Per-cell aggregation toggle. By default any cell whose problem
   *  count exceeds CROWD_THRESHOLD and spans more than one Davis
   *  category is shown AGGREGATED — one bubble per category with the
   *  count inside. Clicking the cell's "+" button puts the cell in
   *  this set, switching it to the expanded (individual-dot) view. */
  // (Cell-level expand/collapse state removed — crowded cells stay
  // aggregated until the user drills into a specific category via a
  // bubble click. This is now the only way to reveal individual dots.)

  /** When the user clicks a category bubble inside an aggregated cell,
   *  we drill into that single category — only its dots are rendered
   *  in the cell and a per-category top-tier highlight (based on the
   *  active Show By mode) is applied. Clicking the cell background
   *  while in this state collapses back to the bubble view. */
  const [expandedCellCategory, setExpandedCellCategory] = useState<Record<string, string>>({});
  /** Bubble positions captured during the canvas draw so the HTML
   *  click handler can hit-test them. Each entry stores the bubble's
   *  PIXEL position + radius. */
  const bubbleHitsRef = useRef<Array<{ cellId: string; subsetMode: ConstellationDataMode; cx: number; cy: number; r: number }>>([]);
  // Tracks the previous tap time/quadrant so we can detect a double-tap on
  // touch devices (where the synthetic dblclick event is unreliable).
  const lastTapRef = useRef<{ t: number; cat: string | null }>({ t: 0, cat: null });

  // Scenario override is now handled UP in Overview so every surface
  // (chart, list, list highlights) sees the same problems. The parent
  // already passed us scenario-swapped data, so we just rename for
  // backward-compat with the rest of this file.
  const problems = realProblems;

  useEffect(() => {
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: Math.max(r.height, 320) });
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ESC exits the expanded quadrant view (no-op when the host has
  // pinned the zoom — modal-mode users dismiss via the modal's own
  // close affordance).
  useEffect(() => {
    if (!expandedQuadrant || lockExpandedQuadrant) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedQuadrant(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedQuadrant, lockExpandedQuadrant]);

  // Build star positions — cluster by category (each category gets its own quadrant).
  // NOTE: only ACTIVE problems become stars. Falling state is visualized via a
  // continuous particle-rain effect drawn in the canvas loop, not via dots.
  const stars = useMemo(() => {
    const active = problems.filter((p) => p["event.status"] === "ACTIVE");
    const all = active;

    // ── Pre-pass: compute score per problem and identify the TOP-TIER per
    // category — every problem whose score is within 95% of the category
    // max. With realistic severity distribution this naturally yields 1-6
    // highlights per quadrant (e.g. all critical incidents during an outage).
    // Each top-tier dot gets a reserved anchor along a row near the category
    // center, with a guard radius pushing other dots away.
    // Note: in Total mode the constellation wants a zero score (no
    // top-tier rings to draw), while the shared scoreOf returns 1 so
    // every problem ties. Map "total" → 0 here to preserve the
    // existing behaviour without forking the shared helper.
    const scoreFn = (p: Problem): number =>
      dataMode === "total" ? 0 : scoreOf(p, dataMode);

    const MAX_TIER_PER_CAT   = 10;

    // In Rising mode the per-quadrant trend badge uses a count delta
    // (recent vs older). If a quadrant is FALLING (recent < older) or
    // NEUTRAL, the user sees ▼ or no arrow — so it would be confusing to
    // still draw a ★ focus ring on a single recent dot inside that
    // quadrant. We pre-compute the rising set here and only allow top-tier
    // highlights for categories that are actually trending up.
    let risingCats: Set<string> | null = null;
    if (dataMode === "rising") {
      const now2 = Date.now();
      const tCut2 = now2 - 3600000; // 1h window — matches the draw() trend math
      const trend: Record<string, { recent: number; older: number }> = {};
      problems.forEach((p) => {
        const cat = resolveGrouping(p);
        if (!cat) return;
        const b   = (trend[cat] ||= { recent: 0, older: 0 });
        const startTs        = new Date(p["event.start"]).getTime();
        const endTs          = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
        const isActiveNow    = p["event.status"] === "ACTIVE";
        const wasActiveAtCut = startTs <= tCut2 && (isActiveNow || (endTs !== null && endTs > tCut2));
        if (isActiveNow)    b.recent++;
        if (wasActiveAtCut) b.older++;
      });
      risingCats = new Set(
        Object.entries(trend)
          .filter(([, t]) => t.recent > t.older)
          .map(([cat]) => cat),
      );
    }

    // For each category, the ordered list of top-tier display_ids, and a
    // map from display_id → its index within the tier (used for layout).
    const topListByCat: Record<string, string[]> = {};
    const tierIndexById: Record<string, number>  = {};
    if (dataMode !== "total") {
      const byCat: Record<string, Problem[]> = {};
      all.forEach((p) => { const cat = resolveGrouping(p); if (cat) (byCat[cat] ||= []).push(p); });
      Object.entries(byCat).forEach(([cat, probs]) => {
        // Rising mode: skip categories that aren't actually rising at the
        // quadrant level, otherwise the ★ on a single recent dot would
        // contradict the ▼ / neutral badge on the quadrant itself.
        if (dataMode === "rising" && risingCats && !risingCats.has(cat)) return;
        const scored = probs
          .map((p) => ({ p, s: scoreFn(p) }))
          .filter(({ s }) => s > 0)                      // skip zero-score dots
          .sort((a, b) => b.s - a.s);
        if (scored.length === 0) return;
        const maxS = scored[0].s;
        const tier = scored
          .filter(({ s }) => s >= maxS * TOP_TIER_THRESHOLD)
          .slice(0, MAX_TIER_PER_CAT);
        const ids = tier.map(({ p }) => p.display_id);
        topListByCat[cat] = ids;
        ids.forEach((id, i) => { tierIndexById[id] = i; });
      });
    }

    // Guard radius (normalized) around the top-tier row — other dots stay
    // outside so they never overlap with the focus rings. Scaled with
    // `dotScale` so when the host inflates the dots (enlarged-quadrant
    // modal uses 2.5×) the keep-out region grows proportionally and
    // dots/rings still don't collide.
    const GUARD = (isMobileOrTablet ? 0.055 : 0.045) * dotScale;

    // Dot sizing — three clean tiers instead of a score-based continuous scale:
    //   • UNIFORM_R  → used when there are no highlights anywhere. Every dot
    //                  gets the same size so the constellation looks tidy.
    //   • BASE_R     → minimum size for non-highlighted dots when highlights
    //                  exist. Slightly smaller than UNIFORM_R so the ★ dots
    //                  stand out, but still big enough to spot and click.
    //   • TOP_R      → highlighted (top-tier) dots. Clearly bigger than BASE.
    const BASE_R    = isMobileOrTablet ? 7   : 5.5;   // minimum — easy to see/click
    const TOP_R     = isMobileOrTablet ? 11.5 : 10;   // highlighted dots
    const UNIFORM_R = isMobileOrTablet ? 8   : 6.5;   // when nothing is highlighted
    const hasAnyTopTier = Object.keys(topListByCat).length > 0;

    // Per-cell stats — count + set of Davis categories present in that
    // cell. When a cell is BOTH crowded AND multi-category (i.e. on
    // the Segments page where one segment can contain many problems
    // of different categories), random scatter becomes unreadable. We
    // switch to category-grouped placement: each Davis category gets
    // its own vertical column inside the cell, so users can see the
    // category breakdown of a segment at a glance.
    const CROWD_THRESHOLD = 30;
    const cellMeta: Record<string, { count: number; categories: Set<string> }> = {};
    for (const p of all) {
      const c = resolveGrouping(p) || "";
      let m = cellMeta[c];
      if (!m) {
        m = { count: 0, categories: new Set<string>() };
        cellMeta[c] = m;
      }
      m.count++;
      m.categories.add(p["event.category"]);
    }

    const built: Star[] = all.map((p, i): Star => {
      const cat = resolveGrouping(p) || "";
      const slot = slotById[cat];
      const activeOrigin = slot?.center || { x: 0.5, y: 0.35 };
      const center = activeOrigin;
      const hours = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
      const entities = p.affected_entity_ids?.length || 1;
      const tierIdx   = tierIndexById[p.display_id];
      const isTop     = tierIdx !== undefined;
      const tierList  = topListByCat[cat] || [];
      const tierCount = tierList.length;

      const bounds = slot?.bounds;

      let targetX: number;
      let targetY: number;

      if (isTop) {
        // TOP-TIER dots: arranged in a horizontal row centered on the
        // category center. With 1 top → still at center. With N tops →
        // spread along an axis so each is independently clickable.
        if (tierCount <= 1) {
          targetX = center.x;
          targetY = center.y;
        } else {
          const maxSpread = bounds
            ? (bounds.xMax - bounds.xMin) * 0.78
            : 0.22;
          // Per-dot spacing scales with dotScale so the modal's
          // 2.5× dots don't overlap each other. Capped at
          // maxSpread so the row never exceeds the cell width.
          const spread = Math.min(tierCount * 0.034 * dotScale, maxSpread);
          const startX = center.x - spread / 2;
          const stepX  = spread / (tierCount - 1);
          targetX = startX + tierIdx * stepX;
          targetY = center.y;
        }
      } else if (bounds) {
        const meta = cellMeta[cat];
        const groupByCategory = !!meta
          && meta.count > CROWD_THRESHOLD
          && meta.categories.size > 1;
        const probCatIdx = groupByCategory
          ? CATEGORY_GROUPINGS.findIndex((g) => g.id === p["event.category"])
          : -1;

        if (groupByCategory && probCatIdx >= 0) {
          // Category-grouped placement: each Davis category occupies
          // its own vertical column inside this cell, so a 450-dot
          // UNASSIGNED segment becomes readable as N vertical clusters
          // (one per category) instead of a chaotic blob.
          const cols   = CATEGORY_GROUPINGS.length;
          const colW   = (bounds.xMax - bounds.xMin) / cols;
          const colCx  = bounds.xMin + (probCatIdx + 0.5) * colW;
          // Random jitter within the column's middle 85 % so dots
          // don't touch the column's vertical neighbours.
          targetX = colCx + (Math.random() - 0.5) * colW * 0.85;
          targetY = bounds.yMin + Math.random() * (bounds.yMax - bounds.yMin);
        } else {
          // Other dots: uniform random scatter across the WHOLE quadrant cell,
          // with rejection sampling to keep them outside the GUARD radius
          // around any of the top-tier dots. Spreads naturally even with 100+
          // dots/quadrant.
          let rx = 0, ry = 0;
          for (let tries = 0; tries < 16; tries++) {
            rx = bounds.xMin + Math.random() * (bounds.xMax - bounds.xMin);
            ry = bounds.yMin + Math.random() * (bounds.yMax - bounds.yMin);
            // Reject if too close to ANY top-tier anchor (not just the center).
            let tooClose = false;
            if (tierCount <= 1) {
              tooClose = Math.hypot(rx - center.x, ry - center.y) < GUARD;
            } else {
              const maxSpread = (bounds.xMax - bounds.xMin) * 0.78;
              // Mirror the same `* dotScale` from the top-tier
              // placement above so the rejection geometry stays
              // in sync with where the tiers were actually drawn.
              const spread = Math.min(tierCount * 0.034 * dotScale, maxSpread);
              const startX = center.x - spread / 2;
              const stepX  = spread / (tierCount - 1);
              for (let k = 0; k < tierCount; k++) {
                if (Math.hypot(rx - (startX + k * stepX), ry - center.y) < GUARD) {
                  tooClose = true;
                  break;
                }
              }
            }
            if (!tooClose) break;
          }
          targetX = rx;
          targetY = ry;
        }
      } else {
        targetX = center.x + (Math.random() - 0.5) * 0.1;
        targetY = center.y + (Math.random() - 0.5) * 0.05;
      }

      const score = scoreFn(p);

      // Apply slight x/y jitter on initial position, but NOT for the top
      // anchor (which must stay pinned for predictable clicking).
      const initJitter = isTop ? 0 : (Math.random() - 0.5) * 0.02;
      const initX = bounds
        ? Math.max(bounds.xMin, Math.min(bounds.xMax, targetX + initJitter))
        : targetX + initJitter;
      const initY = bounds
        ? Math.max(bounds.yMin, Math.min(bounds.yMax, targetY + initJitter))
        : targetY + initJitter;

      return {
        id: p.display_id,
        x: initX,
        y: initY,
        targetX,
        targetY,
        // Radius: three-tier system for a clean, predictable look.
        //   - Total mode OR no highlights present → UNIFORM_R (everyone same)
        //   - Highlighted dots                    → TOP_R (clearly bigger)
        //   - Non-highlighted dots                → BASE_R (minimum, still
        //                                          easily identifiable)
        radius:
          dataMode === "total" || !hasAnyTopTier
            ? UNIFORM_R
            : isTop
              ? TOP_R
              : BASE_R,
        // Always color dots by the problem's Davis category so the user
        // can read category mix at a glance — even when grouped by
        // segment (where each quadrant becomes a colour mosaic). In
        // category mode this is identical to the quadrant accent
        // colour, so no visible change.
        color: categoryColorFor(p),
        // Pulse: minimal in total mode, scales with score in other modes.
        // Top dot's pulse is dampened — it's already visually emphasized.
        pulse:  dataMode === "total" ? 0.3 : (isTop ? 0.5 : 0.4 + score * 0.9),
        cluster: cat,
        problem: p,
        vx: 0,
        vy: 0,
        score,
        scoreNorm: 0,
        isTopOfCategory: false, // assigned below
        hoverAnim: 0,
      };
    });

    // Compute per-category rank so the rendering can dim low-rank dots and
    // highlight the top-tier set. In "total" mode there's no meaningful
    // ranking — leave everything at 1 so all dots stay full opacity.
    if (dataMode === "total") {
      built.forEach((s) => { s.scoreNorm = 1; s.isTopOfCategory = false; });
    } else {
      const byCat: Record<string, Star[]> = {};
      built.forEach((s) => { (byCat[s.cluster] ||= []).push(s); });
      Object.values(byCat).forEach((arr) => {
        if (arr.length === 0) return;
        // Single-pass min/max over per-category scores — avoids the
        // `Math.min/max(...arr.map(...))` pattern which allocates an
        // intermediate mapped array AND spreads it into the args
        // list. In xlarge sims a category can hold thousands of
        // stars (C4 in the perf audit).
        let maxS = -Infinity;
        let minS = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i].score;
          if (v > maxS) maxS = v;
          if (v < minS) minS = v;
        }
        const span = Math.max(1e-6, maxS - minS);
        arr.forEach((s) => {
          s.scoreNorm = (s.score - minS) / span;
        });
      });
      // Top-tier membership was already computed in the pre-pass — apply it.
      built.forEach((s) => {
        s.isTopOfCategory = tierIndexById[s.id] !== undefined;
      });
    }

    return built;
  }, [problems, dataMode, isMobileOrTablet, slotById, colorOf, resolveGrouping]);

  /** Per-cell aggregation data — for each cell, the count of
   *  non-top-tier ACTIVE problems broken down by Davis category. Used
   *  to render category bubbles when the cell is crowded enough to be
   *  unreadable as individual dots (and not user-expanded). */
  const cellAggregations: Record<string, Array<{ id: string; count: number; color: string; label: string }>> = useMemo(() => {
    const topIds = new Set(stars.filter((s) => s.isTopOfCategory).map((s) => s.id));
    const counts: Record<string, Record<string, number>> = {};
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      if (topIds.has(p.display_id)) continue;
      const cell = resolveGrouping(p);
      if (!cell) continue;
      const cat = p["event.category"];
      if (!counts[cell]) counts[cell] = {};
      counts[cell][cat] = (counts[cell][cat] || 0) + 1;
    }
    const out: Record<string, Array<{ id: string; count: number; color: string; label: string }>> = {};
    for (const [cellId, catCounts] of Object.entries(counts)) {
      out[cellId] = CATEGORY_GROUPINGS
        .filter((g) => (catCounts[g.id] || 0) > 0)
        .map((g) => ({ id: g.id, count: catCounts[g.id], color: g.color, label: g.label }));
    }
    return out;
  }, [problems, stars, resolveGrouping]);

  /** Per-cell count of ALL active problems (including top-tier).
   *  `cellAggregations.count` deliberately excludes top-tier stars so
   *  they don't double-count visually (top-tier is drawn separately).
   *  But for the BUBBLE LABEL (the number inside the circle), we want
   *  the full cell total — anything less mismatches the cell header
   *  ("ERROR 1200 active" vs bubble "1190" — user-reported 0.0.108).
   *  Used as the fallback when no `countOverrides` is provided
   *  (demo scenarios). In real prd, `countOverrides.activeByCategory`
   *  carries the count-query value and takes priority. */
  const cellActiveTotalAll: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      const cell = resolveGrouping(p);
      if (!cell) continue;
      out[cell] = (out[cell] || 0) + 1;
    }
    return out;
  }, [problems, resolveGrouping]);

  /** Per-cell sub-bubbles — one per Show By mode. Replaces the old
   *  per-category bubble (0.0.109): each dense cell now exposes the
   *  same 4-way breakdown the global Show By chip used to expose,
   *  but locally + clickable. Each bubble click opens the modal with
   *  that subset filter pre-applied.
   *
   *  Counts come from the loaded `problems` (capped at first-paint
   *  ~250 in real prd). To stay honest when the cell has thousands
   *  of true active problems, we scale each subset count by the
   *  ratio of `realCellTotal / loadedCellTotal`, drawing the real
   *  total from `countOverrides.activeByCategory` when available.
   *  Stress 3K demo: 100 % of problems load → no scaling needed,
   *  counts are exact. */
  // Total dropped (0.0.109 follow-up — "remover total"): the cell
  // header already prints the active count, and the 3 remaining
  // modes are non-overlapping signals worth highlighting in their
  // own right. Problems that don't match any of the three (recent
  // but low-severity, mid-aged, etc.) still surface via the Σ-less
  // breakdown — the user can open the modal via the cell title to
  // see the full active list.
  const SUBSET_MODES = [
    { mode: "rising" as const,      label: "Rising",   icon: "▲" },     // ▲
    { mode: "open_time" as const,   label: "Stuck",    icon: "⏱" },     // ⏱
    { mode: "criticality" as const, label: "Critical", icon: "⚡" },     // ⚡
  ];
  type SubsetMode = (typeof SUBSET_MODES)[number]["mode"];
  const cellSubsetBubbles: Record<string, Array<{
    mode: SubsetMode;
    count: number;
    color: string;
    label: string;
    icon: string;
  }>> = useMemo(() => {
    const now = Date.now();
    const matches = (mode: SubsetMode, p: Problem): boolean => {
      if (p["event.status"] !== "ACTIVE") return false;
      switch (mode) {
        case "rising":
          return new Date(p["event.start"]).getTime() >= now - 3_600_000;
        case "open_time":
          return new Date(p["event.start"]).getTime() <= now - 4 * 3_600_000;
        case "criticality":
          return Number((p as { "event.severity_level"?: number | string })["event.severity_level"] ?? 0) >= 4;
        default:
          return false;
      }
    };
    // First pass: loaded-subset counts per (cell, mode). Also tally
    // the cell's TOTAL active so we can scale the per-mode counts
    // to match the real (count-query) cell total when the loaded
    // subset is truncated by the first-paint cap.
    const loaded: Record<string, Record<SubsetMode, number>> = {};
    const loadedActiveTotals: Record<string, number> = {};
    for (const p of problems) {
      const cell = resolveGrouping(p);
      if (!cell) continue;
      if (!loaded[cell]) {
        loaded[cell] = { rising: 0, open_time: 0, criticality: 0 };
      }
      if (p["event.status"] === "ACTIVE") {
        loadedActiveTotals[cell] = (loadedActiveTotals[cell] || 0) + 1;
      }
      for (const { mode } of SUBSET_MODES) {
        if (matches(mode, p)) loaded[cell][mode]++;
      }
    }
    // Second pass: scale to real cell totals where we have an override.
    const out: Record<string, Array<{ mode: SubsetMode; count: number; color: string; label: string; icon: string }>> = {};
    for (const [cellId, counts] of Object.entries(loaded)) {
      const loadedTotal = loadedActiveTotals[cellId] ?? 0;
      const realTotal = countOverrides?.activeByCategory?.[cellId] ?? loadedTotal;
      // Scale each subset count by realTotal / loadedTotal so the
      // sub-bubbles match the cell's true active count even when
      // the loaded subset is truncated by the first-paint cap.
      const scale = loadedTotal > 0 ? realTotal / loadedTotal : 1;
      const cellColor = colorOf(cellId);
      out[cellId] = SUBSET_MODES.map(({ mode, label, icon }) => ({
        mode,
        count: Math.max(0, Math.round(counts[mode] * scale)),
        color: cellColor,
        label,
        icon,
      }));
    }
    return out;
  }, [problems, resolveGrouping, countOverrides, colorOf]);

  /** Pixel area available per cell — derived from the layout's
   *  normalised bounds and the current canvas size. Drives the
   *  capacity-based aggregation rule below. */
  const cellPixelAreas: Record<string, number> = useMemo(() => {
    const out: Record<string, number> = {};
    for (const slot of layout) {
      const cellW = (slot.bounds.xMax - slot.bounds.xMin) * size.w;
      const cellH = (slot.bounds.yMax - slot.bounds.yMin) * size.h;
      out[slot.id] = Math.max(0, cellW * cellH);
    }
    return out;
  }, [layout, size]);

  /** True when a cell should be drawn as aggregated bubbles instead
   *  of individual dots. Two triggers, either one is enough:
   *    1. Hard count threshold (more than 100 active incidents, i.e.
   *       101+) — applies to single-category cells too (the Incidents
   *       page case, where each cell IS a category). Beyond 100, dots
   *       become unreadable regardless of cell size; bubble view
   *       communicates the volume cleanly.
   *    2. Capacity-based heuristic — for multi-category cells (the
   *       Segments page case), aggregate as soon as the dots wouldn't
   *       fit comfortably in the available pixel area.
   *  The per-dot allowance includes breathing room so dots aren't
   *  packed shoulder-to-shoulder.
   *
   *  IMPORTANT — source of truth for the count check:
   *  `cellAggregations` is built from the LOADED problems array
   *  (which is capped at ~250 by the first-paint budget). When the
   *  real count for a cell exceeds that cap, the loaded subset
   *  understates how busy the cell actually is — and the dots
   *  drawn for it look like a sparse set, even though the
   *  category-counts query knows it's actually 1000+.
   *
   *  Fix: prefer `countOverrides.activeByCategory[cellId]` (the
   *  count-query value — what the user SEES in the cell header)
   *  over the loaded-subset sum. Fall back to the subset only when
   *  no override is available (debug / loading states). This makes
   *  the 100-threshold gate the actual cell volume, not whatever
   *  fraction of it happens to have loaded yet. */
  const AGG_COUNT_THRESHOLD = 100;
  const isCellAggregated = useCallback((cellId: string): boolean => {
    // 0.0.108: short-circuit when the host explicitly opts out
    // (EnlargedQuadrantCard modal — render every dot, no bubble).
    if (disableAggregation) return false;
    const agg = cellAggregations[cellId];
    const overrideCount = countOverrides?.activeByCategory?.[cellId];
    const loadedTotal = agg ? agg.reduce((s, c) => s + c.count, 0) : 0;
    // Prefer the count-query value. `overrideCount` is the cell's
    // ACTUAL active count (matches the header label); `loadedTotal`
    // is only the subset that fits inside the first-paint budget.
    const total = overrideCount ?? loadedTotal;
    if (total <= 0) return false;
    if (total > AGG_COUNT_THRESHOLD) return true;
    // Capacity fallback — only useful for multi-category cells.
    // Single-category cells under the count threshold render their
    // dots; collapsing them to one bubble adds no extra information.
    if (!agg || agg.length <= 1) return false;
    const area  = cellPixelAreas[cellId] || 0;
    const PER_DOT_AREA = isMobileOrTablet ? 520 : 400;
    const capacity = Math.max(20, Math.floor(area / PER_DOT_AREA));
    return total > capacity;
  }, [cellAggregations, cellPixelAreas, isMobileOrTablet, countOverrides, disableAggregation]);

  /** Per-drilled-cell subset-top info. For each cell that the user has
   *  drilled into a single category, compute the top-tier ordered list
   *  of that subset under the active dataMode (same 95 % threshold the
   *  Incidents page uses). The position-update loop pulls these stars
   *  toward the cell centre so the drilled view mirrors the centred
   *  top-tier layout on the Incidents page. */
  const drilledSubsets: Record<string, { topIds: Set<string>; topOrdered: string[] }> = useMemo(() => {
    const out: Record<string, { topIds: Set<string>; topOrdered: string[] }> = {};
    for (const [cellId, catId] of Object.entries(expandedCellCategory)) {
      const subset = stars.filter(
        (s) => s.cluster === cellId && s.problem["event.category"] === catId,
      );
      if (subset.length === 0) continue;
      const scored = [...subset].sort((a, b) => b.score - a.score);
      const max = scored[0].score;
      let topOrdered: string[];
      if (max > 0) {
        topOrdered = scored.filter((s) => s.score >= max * 0.95).map((s) => s.id);
      } else {
        const recent = [...subset].sort(
          (a, b) =>
            new Date(b.problem["event.start"]).getTime() -
            new Date(a.problem["event.start"]).getTime(),
        )[0];
        topOrdered = [recent.id];
      }
      out[cellId] = { topIds: new Set(topOrdered), topOrdered };
    }
    return out;
  }, [stars, expandedCellCategory]);

  /** For every AGGREGATED cell, pre-compute the top N stars ranked by
   *  the active Show By mode's score. The dot pass + hit-test only
   *  let these stars through; the bubble pass shows a count for the
   *  rest. Applies whether the user has drilled or not — the cell
   *  is always "leaders + bubble" once aggregated.
   *
   *  Why this exists (0.0.105):
   *  0.0.104 capped the DRILLED-only case at top 30, but the user
   *  asked to push the same logic to the NON-DRILLED collapsed view
   *  as well. Rationale: in a tenant with thousands of active
   *  problems, the whole purpose of the Show By selector is to pick
   *  WHICH problems matter most under the current lens (rising vs
   *  oldest vs critical). Pre-filtering the canvas by that lens
   *  ("ja deixar pre-agrupado") gives the user a stable, readable
   *  set of dots from the moment the page loads — no need to click
   *  the bubble to see the leaders. The bubble continues to carry
   *  the cell's full count so the user knows how big the category
   *  actually is.
   *
   *  Cap rationale: 30 leaders fit comfortably in both inline cells
   *  and the modal. Below 30 starts to feel sparse; above 30 the
   *  overlap blur creeps back in (per the 0.0.104 report). */
  const DENSE_DRILL_CAP = 30;
  const aggregatedTopByCell: Record<string, Set<string>> = useMemo(() => {
    // Group all stars by their cluster, applying the drill filter
    // (when a cell is drilled, only stars of the chosen category
    // count toward its leader pool).
    const byCluster: Record<string, Star[]> = {};
    for (const star of stars) {
      if (!isCellAggregated(star.cluster)) continue;
      const drillCat = expandedCellCategory[star.cluster];
      if (drillCat && star.problem["event.category"] !== drillCat) continue;
      if (!byCluster[star.cluster]) byCluster[star.cluster] = [];
      byCluster[star.cluster].push(star);
    }
    const out: Record<string, Set<string>> = {};
    for (const [cluster, cellStars] of Object.entries(byCluster)) {
      // Sort by current Show By score (descending) — `star.score` is
      // already computed per active dataMode upstream, so this respects
      // the user's current lens (Rising / Oldest Open / Criticality /
      // Total) without re-computing anything.
      const sorted = [...cellStars].sort((a, b) => b.score - a.score);
      out[cluster] = new Set(sorted.slice(0, DENSE_DRILL_CAP).map((s) => s.id));
    }
    return out;
  }, [stars, isCellAggregated, expandedCellCategory]);

  /** Per-cell set of Davis category ids whose bubble should be
   *  emphasised in aggregated mode. Mirrors the cell-level top-tier
   *  computation that's already driven by the active Show By mode:
   *    - rising / open_time / criticality → categories that contain
   *      at least one star flagged `isTopOfCategory`.
   *    - total → no per-dot top exists, so we pick the highest-count
   *      category(ies) in the cell as the leader instead.
   *  The rendered bubble gets a pulsing dashed ring + small ★ glyph
   *  so the user immediately knows where the "winning" problems live
   *  without having to drill into every bubble. */
  const highlightedCategoriesPerCell: Record<string, Set<string>> = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    if (dataMode === "total") {
      for (const [cellId, cats] of Object.entries(cellAggregations)) {
        if (cats.length === 0) continue;
        const max = Math.max(...cats.map((c) => c.count));
        if (max <= 0) continue;
        out[cellId] = new Set(cats.filter((c) => c.count === max).map((c) => c.id));
      }
    } else {
      for (const s of stars) {
        if (!s.isTopOfCategory) continue;
        const cell = s.cluster;
        const cat  = s.problem["event.category"];
        if (!out[cell]) out[cell] = new Set();
        out[cell].add(cat);
      }
    }
    return out;
  }, [stars, cellAggregations, dataMode]);

  useEffect(() => {
    starsRef.current = stars;
  }, [stars]);

  /** Single source of truth for the zoom-into-quadrant canvas
   *  transform. Both the draw fn and `screenToWorld` (hit-test) read
   *  from this memo so they can't drift out of sync — the previous
   *  duplicated math caused tooltip leaks on empty areas (cursor on
   *  one place, hit-test thinking it was somewhere else).
   *
   *  Two scaling modes:
   *  • Locked (modal / EnlargedQuadrantCard): NON-UNIFORM scale —
   *    independent X and Y factors so the cell fills the canvas
   *    edge-to-edge regardless of aspect mismatch (cell ~1.4:1,
   *    modal canvas ~1.67:1 → uniform scaling left black bands).
   *  • Page (Overview): UNIFORM scale with 8 % safety padding so
   *    adjacent cells don't bleed back at the borders. */
  const viewTransform = useMemo<{ scaleX: number; scaleY: number; tx: number; ty: number } | null>(() => {
    if (!expandedQuadrant) return null;
    const QB = slotById[expandedQuadrant]?.bounds;
    if (!QB) return null;
    const MARGIN_X = 0.005;
    const MARGIN_Y = 0.04; // bigger Y margin includes the label strip above the dots
    const cellXMin = Math.max(0, QB.xMin - MARGIN_X);
    const cellXMax = Math.min(1, QB.xMax + MARGIN_X);
    const cellYMin = Math.max(0, QB.yMin - MARGIN_Y);
    const cellYMax = Math.min(1, QB.yMax + MARGIN_Y);
    const cellX = cellXMin * size.w;
    const cellY = cellYMin * size.h;
    const cellW = (cellXMax - cellXMin) * size.w;
    const cellH = (cellYMax - cellYMin) * size.h;
    if (lockExpandedQuadrant) {
      const scaleX = size.w / cellW;
      const scaleY = size.h / cellH;
      const tx = -cellX * scaleX;
      const ty = -cellY * scaleY;
      return { scaleX, scaleY, tx, ty };
    }
    const PADDING = 0.92;
    const scale = Math.min(size.w / cellW, size.h / cellH) * PADDING;
    const tx = size.w / 2 - (cellX + cellW / 2) * scale;
    const ty = size.h / 2 - (cellY + cellH / 2) * scale;
    return { scaleX: scale, scaleY: scale, tx, ty };
  }, [expandedQuadrant, slotById, size, lockExpandedQuadrant]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const { w, h } = size;
    // Canvas text doesn't inherit CSS variables — read the user's
    // font-scale pick from the Intensity context and multiply
    // every literal px size below. `fsMult` is closed over by all
    // `ctx.font = \`... ${N * fsMult}px ...\`` template literals,
    // so a single context read scales every text in this draw.
    const fsMult = CANVAS_FS_MULT[fontScale] ?? 1;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    c.style.width = w + "px";
    c.style.height = h + "px";
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = dk ? "#05080f" : "#f8f9fc";
    ctx.fillRect(0, 0, w, h);

    // Subtle grid
    ctx.strokeStyle = dk ? "rgba(99,102,241,0.04)" : "rgba(99,102,241,0.06)";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // ── Expanded-quadrant zoom: translate + scale so the chosen quadrant
    //    fills the active canvas area. Computed once via `viewTransform`
    //    (memo below the draw fn) so the canvas paint AND
    //    `screenToWorld` (hit-test) read the SAME numbers. Previously
    //    each had its own copy of the math and they drifted out of
    //    sync, producing tooltip leaks on empty areas (0.0.108 user
    //    report).
    if (viewTransform) {
      ctx.translate(viewTransform.tx, viewTransform.ty);
      ctx.scale(viewTransform.scaleX, viewTransform.scaleY);
    }

    // ═══ GRID DIVIDING LINES (dotted) + optional central hub band ═══
    // Active area height — leaves room for the RESOLVED HUD panel
    // at the bottom (32 % of canvas) when that panel is enabled.
    // When the host hides RESOLVED, the active area expands to the
    // full canvas so the quadrant fills everything visible.
    const activeAreaH = showResolvedZone ? h * 0.68 : h;
    // Hub band coordinates — only used when showHub is true. Kept at
    // module scope so trend / spoke / satellite code below can reference
    // them; guarded against rendering when the hub is hidden.
    // 0.0.109 follow-up — shifted slightly down from 0.18/0.50 to
    // 0.205/0.520 to stay clear of the new (taller) cell rows in
    // computeQuadrantLayout (rows now 0.040-0.195 / 0.530-0.685).
    const hubBandTop    = h * 0.205;
    const hubBandBottom = h * 0.520;
    const hubCx = w / 2;
    const hubCy = (hubBandTop + hubBandBottom) / 2;

    // Hub radius: bounded by BOTH the band height and the quadrant
    // bounds so the central circle never overlaps a dot region.
    const HUB_PAD = 14;
    let _maxR = (hubBandBottom - hubBandTop) / 2 - HUB_PAD;
    layout.forEach((s) => {
      const b = s.bounds;
      const nx = Math.max(b.xMin * w, Math.min(b.xMax * w, hubCx));
      const ny = Math.max(b.yMin * h, Math.min(b.yMax * h, hubCy));
      const d  = Math.hypot(hubCx - nx, hubCy - ny);
      if (d - HUB_PAD < _maxR) _maxR = d - HUB_PAD;
    });
    const hubRadius = Math.max(30, _maxR);

    if (showHub) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = dk ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 1;

      // Vertical dotted dividers — stop at the hub band (don't cross it)
      ctx.beginPath();
      ctx.moveTo(w / 3, 0);
      ctx.lineTo(w / 3, hubBandTop);
      ctx.moveTo(w / 3, hubBandBottom);
      ctx.lineTo(w / 3, activeAreaH);
      ctx.moveTo((w * 2) / 3, 0);
      ctx.lineTo((w * 2) / 3, hubBandTop);
      ctx.moveTo((w * 2) / 3, hubBandBottom);
      ctx.lineTo((w * 2) / 3, activeAreaH);
      ctx.stroke();

      // Horizontal dotted dividers — top and bottom of the hub band (full width)
      ctx.beginPath();
      ctx.moveTo(0, hubBandTop);
      ctx.lineTo(w, hubBandTop);
      ctx.moveTo(0, hubBandBottom);
      ctx.lineTo(w, hubBandBottom);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.restore();
    } else if (layout.length > 0) {
      // Hub-free layout (Segments page): draw dotted dividers between
      // every adjacent column and row, matching the category page style.
      // Positions are derived from the layout's slot bounds so they
      // adapt to whichever grid shape was picked (2×2, 2×3, 3×3, 3×4).
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = dk ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)";
      ctx.lineWidth = 1;

      // Memoised across renders — see `layoutBounds` above (M9).
      const xMins = layoutBounds.colXMins;
      const xMaxs = layoutBounds.colXMaxs;
      const yMins = layoutBounds.rowYMins;
      const yMaxs = layoutBounds.rowYMaxs;

      ctx.beginPath();
      // Vertical dividers — one per column gap, full active height.
      for (let i = 0; i < xMaxs.length - 1; i++) {
        const xLine = ((xMaxs[i] + xMins[i + 1]) / 2) * w;
        ctx.moveTo(xLine, 0);
        ctx.lineTo(xLine, activeAreaH);
      }
      // Horizontal dividers — one per row gap, full canvas width.
      for (let i = 0; i < yMaxs.length - 1; i++) {
        const yLine = ((yMaxs[i] + yMins[i + 1]) / 2) * h;
        ctx.moveTo(0, yLine);
        ctx.lineTo(w, yLine);
      }
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.restore();
    }

    // ═══ RESOLVED ZONE SEPARATOR ═══ (only painted when the RESOLVED
    //    HUD panel below it is going to be drawn)
    if (showResolvedZone) {
      ctx.strokeStyle = dk ? "rgba(52,211,153,0.3)" : "rgba(40,160,100,0.25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(0, activeAreaH);
      ctx.lineTo(w, activeAreaH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Quadrant labels + trend indicators
    ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    // Calculate ACTIVE-count delta per category over the last hour.
    // recent = number of active problems right now
    // older  = number of problems that were active 1h ago
    // delta  = recent - older   (positive = active count is rising)
    const now = Date.now();
    const h12 = 12 * 3600000; // kept for backward-compat references below
    const WINDOW_MS = 3600000; // 1 hour
    const tCut = now - WINDOW_MS;

    const catTrends: Record<string, { recent: number; older: number }> = {};
    for (const g of groupings) catTrends[g.id] = { recent: 0, older: 0 };
    problems.forEach((p) => {
      const cat = resolveGrouping(p);
      if (!cat) return;
      const b = catTrends[cat];
      if (!b) return;
      const startTs = new Date(p["event.start"]).getTime();
      const endTs   = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
      const isActiveNow      = p["event.status"] === "ACTIVE";
      const wasActiveAtCut   = startTs <= tCut && (isActiveNow || (endTs !== null && endTs > tCut));
      if (isActiveNow)    b.recent++;
      if (wasActiveAtCut) b.older++;
    });


    // ── Per-quadrant visuals based on trend ─────────────────────────────────
    // cellRects: a generous bounding rectangle per quadrant cell used
    // for BOTH the trend backgrounds (tint, ▼ DOWN seal) and the
    // leader-glow highlights (★ TOP, ▲ UP). Each cell spans from its
    // column's left gap-midpoint to its right gap-midpoint, and from
    // its row's top gap-midpoint to its bottom gap-midpoint — clipped
    // to the hub band when showHub is true. Works for any layout
    // (2×3 with hub, 2×3 no-hub, 3×3, 3×4).
    // Memoised across renders — see `layoutBounds` above (M9).
    const uniqColXMins = layoutBounds.colXMins;
    const uniqColXMaxs = layoutBounds.colXMaxs;
    const uniqRowYMins = layoutBounds.rowYMins;
    const uniqRowYMaxs = layoutBounds.rowYMaxs;
    const activeAreaYMaxN = activeAreaH / h;

    const cellRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const zoneColors: Record<string, string> = {};
    for (const s of layout) {
      const ci = uniqColXMins.indexOf(s.bounds.xMin);
      const ri = uniqRowYMins.indexOf(s.bounds.yMin);
      // X extent: midpoint between adjacent columns' gap, or 0 / 1 at edges.
      const xMinN = ci === 0 ? 0 : (uniqColXMaxs[ci - 1] + uniqColXMins[ci]) / 2;
      const xMaxN = ci === uniqColXMins.length - 1 ? 1
                  : (uniqColXMaxs[ci] + uniqColXMins[ci + 1]) / 2;
      // Y extent: same idea. In hub mode, top-band rows stop at
      // hubBandTop and bottom-band rows start at hubBandBottom so the
      // tint never bleeds across the central satellites.
      let yMinN = ri === 0 ? 0 : (uniqRowYMaxs[ri - 1] + uniqRowYMins[ri]) / 2;
      let yMaxN = ri === uniqRowYMins.length - 1 ? activeAreaYMaxN
                : (uniqRowYMaxs[ri] + uniqRowYMins[ri + 1]) / 2;
      if (showHub) {
        const hubTopN = hubBandTop / h;
        const hubBotN = hubBandBottom / h;
        if (s.bounds.yMax <= hubTopN) yMaxN = Math.min(yMaxN, hubTopN);
        if (s.bounds.yMin >= hubBotN) yMinN = Math.max(yMinN, hubBotN);
      }
      cellRects[s.id] = {
        x: xMinN * w,
        y: yMinN * h,
        w: (xMaxN - xMinN) * w,
        h: (yMaxN - yMinN) * h,
      };
      zoneColors[s.id] = colorOf(s.id);
    }
    // Legacy alias — keep callers that referenced zoneRects working.
    const zoneRects = cellRects;

    const tc = animRef.current; // animation clock

    // ── Highlight quadrant(s) relevant to the active Show By metric ──
    // Per-mode aggregate per quadrant:
    //   rising      → count of problems started in the last hour (only positive)
    //   open_time   → max hours open (any problem)
    //   criticality → max severity (any problem)
    //   total       → count of problems in the quadrant
    // RGB tuples for canvas rgba() — one per grouping, derived from each
    // grouping's hex color (e.g. "#a3e635" → "163,230,53").
    const HL_COLORS: Record<string, string> = {};
    for (const g of groupings) HL_COLORS[g.id] = hexToRgb(g.color);

    // Compute per-quadrant aggregate score for the active mode
    const catAgg: Record<string, number> = {};
    if (dataMode === "rising") {
      // Use the actual trend delta (recent - older) so the ▲ UP highlight
      // matches the trend indicator in the quadrant labels. Only positive
      // deltas qualify — neutral and falling categories score 0.
      Object.keys(catTrends).forEach((cat) => {
        const t = catTrends[cat];
        catAgg[cat] = Math.max(0, t.recent - t.older);
      });
    } else {
      stars.forEach((s) => {
        const cur = catAgg[s.cluster] ?? 0;
        const ageHours = (Date.now() - new Date(s.problem["event.start"]).getTime()) / 3600000;
        const v   =
          dataMode === "total"        ? cur + 1 :                          // running count
          dataMode === "criticality"  ? Math.max(cur, parseInt(String(s.problem["event.severity"] || "0"), 10)) :
          /* open_time */               Math.max(cur, ageHours);
        catAgg[s.cluster] = v;
      });
    }
    // A quadrant is FALLING when recent < older (overall problem count
    // shrinking in the last hour). Falling quadrants are NEVER leaders —
    // they get a "▼" seal instead so the user sees they're improving.
    const isFalling = (cat: string): boolean => {
      const t = catTrends[cat];
      return !!t && t.recent < t.older;
    };

    // Prefer non-falling quadrants — a quadrant currently improving
    // shouldn't be highlighted as "the worst" under the active metric.
    // But when every candidate is falling we fall back to including
    // them so the user always sees the highest-scoring quadrant under
    // the active Show By mode.
    const allEntries  = Object.entries(catAgg);
    const nonFalling  = allEntries.filter(([cat]) => !isFalling(cat));
    const useFallback = nonFalling.length === 0 || nonFalling.every(([, v]) => v <= 0);
    const candidates  = useFallback ? allEntries : nonFalling;
    const globalMax   = Math.max(0, ...candidates.map(([, v]) => v));
    // Tie tolerance — integer-valued modes (rising delta, total count,
    // severity 0-5) want EXACT equality, but open_time is a continuous
    // float (max hours-open) so "tied" quadrants will never be perfectly
    // equal. A 10% band catches the near-ties without picking up clearly
    // smaller quadrants.
    const tieEpsilon =
      dataMode === "open_time" ? Math.max(0.5, globalMax * 0.10) : 0;
    // ALL eligible quadrants tied (or within epsilon) at globalMax are leaders.
    const leaderCats = candidates
      .filter(([, v]) => v > 0 && v >= globalMax - tieEpsilon)
      .map(([k]) => k);

    // Falling quadrants: candidates for the ▼ seal regardless of catAgg score.
    const fallingCats = groupings.map((g) => g.id).filter((cat) => isFalling(cat));

    // highlightRects share the cellRects geometry computed earlier —
    // every quadrant cell knows its own bounding rectangle (with the
    // hub band already excluded when showHub is true), so the leader
    // glow works for category, segment, and any future layout.
    const highlightRects = cellRects;

    // Highlight ALL quadrants tied at globalMax — when multiple categories
    // are equally important under the active metric, all of them deserve
    // the visual emphasis.
    if (leaderCats.length > 0 && globalMax > 0) {
      const ringPulse = (Math.sin(tc * 1.6) + 1) / 2; // 0..1
      leaderCats.forEach((cat, idx) => {
        const z = highlightRects[cat];
        if (!z) return;
        const rgb = HL_COLORS[cat] || "180,210,255";

        // Strong diagonal gradient wash so the quadrant clearly "lights up"
        const grad = ctx.createLinearGradient(z.x, z.y, z.x + z.w, z.y + z.h);
        grad.addColorStop(0, `rgba(${rgb},${0.20 + ringPulse * 0.05})`);
        grad.addColorStop(1, `rgba(${rgb},0.04)`);
        ctx.fillStyle = grad;
        ctx.fillRect(z.x, z.y, z.w, z.h);

        // Solid glow border — distinct from the dashed grid dividers
        ctx.save();
        ctx.strokeStyle = `rgba(${rgb},${0.7 + ringPulse * 0.25})`;
        ctx.lineWidth = 2;
        ctx.shadowColor = `rgba(${rgb},0.65)`;
        ctx.shadowBlur = 10;
        ctx.strokeRect(z.x + 1.5, z.y + 1.5, z.w - 3, z.h - 3);
        ctx.restore();

        // ── Leader seal — semantics depend on the active Show By mode ──
        // Rising mode → "▲ UP" with directional motion (bobbing + rising sparks)
        // Other modes → "★ TOP" static, only breathing glow (it's a rank,
        // not a direction; no motion implied).
        const ta      = tc + idx * 0.45;
        const breath  = (Math.sin(ta * 1.3) + 1) / 2;
        const baseX   = z.x + z.w - 8;
        const baseY   = z.y + 6;
        const isRisingMode = dataMode === "rising";

        if (isRisingMode) {
          // Directional badge: ▲ UP with a bobbing arrow. The badge
          // always uses RED — rising problem counts are bad news, and
          // a consistent red across every quadrant makes the cue
          // instantly recognisable (whereas the per-category colour
          // made the cyan/blue/teal quadrants feel ambiguous).
          // (Rising "sparks" particle trail removed — was visually noisy.)
          const upRgb = "255,77,106";
          const arrowBob = -(Math.sin(ta * 2.0) * 1.5 + 0.5);
          ctx.save();
          ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
          ctx.textBaseline = "top";
          ctx.textAlign = "right";
          const upW = ctx.measureText("UP").width;
          ctx.shadowColor = `rgba(${upRgb},${0.40 + breath * 0.45})`;
          ctx.shadowBlur  = 4 + breath * 6;
          ctx.fillStyle   = `rgba(${upRgb},${0.65 + breath * 0.3})`;
          ctx.fillText("UP", baseX, baseY);
          ctx.textAlign = "left";
          const arrowX = baseX - upW - 12;
          ctx.fillText("▲", arrowX, baseY + arrowBob);
          ctx.restore();
        } else {
          // Ranking badge: ★ TOP with a non-directional "twinkle"
          //   — breathing alpha + glow (always on)
          //   — periodic shine flash (every ~3s) that ramps fast then decays
          //   — four faint sparkle rays radiating from the star at the peak
          // No bobbing / no directional particles — preserves "rank, not motion".
          const twinkleCycle = (ta % 3) / 3;                       // 0..1 every 3s
          const twinkleBurst = Math.max(0, 1 - twinkleCycle * 4);  // sharp peak at start of cycle
          const flashAlpha   = 0.7 + breath * 0.25 + twinkleBurst * 0.25;
          const flashBlur    = 4 + breath * 6 + twinkleBurst * 8;

          ctx.save();
          ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
          ctx.textAlign = "right";
          ctx.textBaseline = "top";
          ctx.shadowColor = `rgba(${rgb},${0.40 + breath * 0.45 + twinkleBurst * 0.35})`;
          ctx.shadowBlur  = flashBlur;
          ctx.fillStyle   = `rgba(${rgb},${Math.min(1, flashAlpha)})`;
          ctx.fillText("★ TOP", baseX, baseY);
          ctx.restore();

          // Sparkle rays — 4 short radial lines around the ★ glyph that
          // appear only during the twinkle burst, then vanish.
          if (twinkleBurst > 0.05) {
            ctx.save();
            ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
            const topW   = ctx.measureText("★ TOP").width;
            const starX  = baseX - topW + 4;     // approx center of "★"
            const starY  = baseY + 7;            // vertical mid
            const rayLen = 4 + twinkleBurst * 5; // 4..9 px
            const rayA   = twinkleBurst * 0.85;
            ctx.strokeStyle = `rgba(${rgb},${rayA})`;
            ctx.lineWidth = 1;
            ctx.shadowColor = `rgba(${rgb},${rayA})`;
            ctx.shadowBlur = 4;
            const gap = 2;
            ctx.beginPath();
            ctx.moveTo(starX, starY - gap);          ctx.lineTo(starX, starY - gap - rayLen);
            ctx.moveTo(starX, starY + gap);          ctx.lineTo(starX, starY + gap + rayLen);
            ctx.moveTo(starX - gap, starY);          ctx.lineTo(starX - gap - rayLen, starY);
            ctx.moveTo(starX + gap, starY);          ctx.lineTo(starX + gap + rayLen, starY);
            ctx.stroke();
            ctx.restore();
          }
        }
      });
    }

    // ── "▼ DOWN" seal for FALLING quadrants ─────────────────────────────
    // These categories had MORE problems an hour ago than now → things are
    // improving. No cell highlight (intentionally calm), just a discreet
    // animated green seal in the top-right corner so the user notices the
    // good news without it competing with the rising leaders.
    if (fallingCats.length > 0) {
      const FALLING_RGB = "34,197,94"; // Strato Ideal (green)
      fallingCats.forEach((cat, idx) => {
        const z = highlightRects[cat];
        if (!z) return;
        // Stagger per quadrant so badges don't pulse in sync
        const ta = tc + idx * 0.45;
        // Soft breathing (0..1) — slow, calm
        const breath = (Math.sin(ta * 1.3) + 1) / 2;
        // Arrow bobs down ~1.5px on a slightly faster cycle
        const arrowBob = Math.sin(ta * 2.0) * 1.5 + 0.5;

        const baseX = z.x + z.w - 8;  // right edge
        // If this cell already has a ★ TOP / ▲ UP seal anchored at the
        // same top-right corner, stack ▼ DOWN one line below so the two
        // don't overlap. Both glyphs are rendered at 12px with breath
        // glow → 14px stacks them cleanly.
        const sharesWithLeader = leaderCats.includes(cat);
        const baseY = z.y + 6 + (sharesWithLeader ? 14 : 0);

        ctx.save();
        ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
        ctx.textBaseline = "top";

        // Measure "DOWN" so we can position the bobbing arrow to its left
        ctx.textAlign = "right";
        const downW = ctx.measureText("DOWN").width;

        // Shared glow that pulses with breath
        ctx.shadowColor = `rgba(${FALLING_RGB},${0.40 + breath * 0.45})`;
        ctx.shadowBlur  = 4 + breath * 6;
        ctx.fillStyle   = `rgba(${FALLING_RGB},${0.65 + breath * 0.3})`;

        // DOWN text — anchored
        ctx.fillText("DOWN", baseX, baseY);

        // ▼ arrow — bobbing
        ctx.textAlign = "left";
        const arrowX = baseX - downW - 12; // 12 = arrow width + gap
        ctx.fillText("▼", arrowX, baseY + arrowBob);
        ctx.restore();
      });
    }

    // Compact single-row label: "CATEGORY  N active  ▲ +M /1h"
    // Frees up vertical space below it so dots don't overlap the text.
    // Returns the x position where the label finished, so callers
    // (like the rising-segment trail) can start drawing AFTER the text.
    const drawQuadrantLabel = (label: string, cat: string, color: string, x: number, y: number): number => {
      ctx.textAlign    = "left";
      ctx.textBaseline = "top";
      let cx = x;

      // Category name (bold colored). When the pointer is over this
      // quadrant's label strip, draw a glow + underline so the user
      // discovers that the name is a click target.
      const isLabelHover = hoveredLabel === cat;
      ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
      ctx.fillStyle = color;
      ctx.globalAlpha = dk ? 0.95 : 0.95;
      if (isLabelHover) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur  = 8;
        ctx.fillText(label, cx, y);
        ctx.restore();
      } else {
        ctx.fillText(label, cx, y);
      }
      const labelW = ctx.measureText(label).width;
      // Hover underline — short bar under the category name
      if (isLabelHover) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur  = 6;
        ctx.fillRect(cx, y + 13, labelW, 1.2);
        ctx.restore();
      }
      cx += labelW + 8;
      ctx.globalAlpha = 1;

      // Count number (bigger, white)
      /* Prefer the count-query override per-category — see the same
         rationale at the central hub. Missing keys (zero rows for that
         category in the response) correctly resolve to 0. Falls back
         to list-derived filter only when no override map is present
         (loading / debug scenarios). */
      const activeOverride = countOverrides?.activeByCategory;
      const activeCount = activeOverride
        ? (activeOverride[cat] ?? 0)
        : problems.filter((p) => resolveGrouping(p) === cat && p["event.status"] === "ACTIVE").length;
      ctx.font = `600 ${(14 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
      ctx.fillStyle = dk ? "#ffffff" : "#0f172a";
      ctx.textBaseline = "alphabetic"; // align big number with cap-height of small text above
      ctx.fillText(`${activeCount}`, cx, y + 11);
      const countW = ctx.measureText(`${activeCount}`).width;
      cx += countW + 4;
      ctx.textBaseline = "top";

      // "active" suffix
      ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
      ctx.fillStyle = dk ? "rgba(226,232,240,0.55)" : "rgba(30,41,59,0.55)";
      ctx.fillText("active", cx, y + 1);
      cx += ctx.measureText("active").width + 10;

      // Trend (▲ +M /1h | ▼ -M | ● neutral)
      const trend = catTrends[cat];
      if (trend) {
        const diff = trend.recent - trend.older;
        ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
        let tText: string;
        if (diff > 0) {
          tText = `▲ +${diff} /1h`;
          ctx.fillStyle = dk ? "rgba(255,77,106,0.95)" : "rgba(220,50,50,0.95)";
        } else if (diff < 0) {
          tText = `▼ ${diff}`;
          ctx.fillStyle = dk ? "rgba(52,211,153,0.95)" : "rgba(40,160,100,0.95)";
        } else {
          tText = `● neutral`;
          ctx.fillStyle = dk ? "rgba(148,163,184,0.5)" : "rgba(100,116,139,0.5)";
        }
        ctx.fillText(tText, cx, y + 1);
        cx += ctx.measureText(tText).width;
      }
      return cx;
    };

    // Each title is positioned INSIDE its cell, hugging the top-left
    // corner — only enough inset to clear the cell's outer border
    // and leave a sliver of room for the HTML expand-icon button.
    const LABEL_X_INSET = 24;
    const LABEL_Y_INSET = 3;
    // Per-slot rectangle of the rendered label text — used by the
    // rising-trail animation below so the comet starts AFTER the text.
    const labelEnd: Record<string, { x: number; y: number }> = {};
    for (const s of layout) {
      const cell   = cellRects[s.id];
      const labelX = s.bounds.xMin * w + LABEL_X_INSET;
      const labelY = (cell ? cell.y : s.bounds.yMin * h) + LABEL_Y_INSET;
      const endX   = drawQuadrantLabel(labelById[s.id] || s.id, s.id, colorOf(s.id), labelX, labelY);
      labelEnd[s.id] = { x: endX, y: labelY };
    }

    // ═══ RESOLVED ZONE — HUD stat panels ═══ (entire block gated
    //    on showResolvedZone; the host can drop it via prop for
    //    surfaces that only care about ACTIVE — e.g. the enlarged
    //    quadrant modal). The closing `}` lives a few hundred lines
    //    down, right after the per-grouping forEach.
    if (showResolvedZone) {
    const resolvedY = activeAreaH + 8;

    // Section header — bigger, with a subtle "▼" hint and thin accent line
    ctx.font = `600 ${(16 * fsMult).toFixed(2)}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = dk ? "rgba(52,211,153,0.95)" : "rgba(40,160,100,0.95)";
    ctx.fillText("RESOLVED", 12, resolvedY);

    // Zone background tint
    ctx.fillStyle = dk ? "rgba(52,211,153,0.03)" : "rgba(40,160,100,0.03)";
    ctx.fillRect(0, activeAreaH + 2, w, h - activeAreaH - 2);

    // Count resolved per grouping — total NOW and total 1h AGO. Iterates
    // the active groupings so the Resolved zone matches the Active zone
    // for any grouping list (categories today, segments tomorrow).
    const resolvedProbs = problems.filter((p) => p["event.status"] === "CLOSED");
    const ONE_HOUR_MS = 3600000;
    const cutoff1h    = Date.now() - ONE_HOUR_MS;
    const resolvedCats = groupings.map((g) => g.id);
    const colW = w / Math.max(resolvedCats.length, 1);
    // Show ALL groupings in the RESOLVED zone — even with zero count.
    resolvedCats.forEach((cat, idx) => {
      const catResolved = resolvedProbs.filter((p) => resolveGrouping(p) === cat);
      /* Headline count prefers the count-query override so the
         per-category RESOLVED hero number tracks the full window
         (matches native Davis). Delta still derives from the loaded
         list — it answers "how many resolved in the LAST HOUR", which
         the loaded list covers fully because the list is sorted
         `event.start desc` and an active problem closing in the last
         hour will be in the most-recent slice. If a future refactor
         needs delta over wider windows, it should move to its own
         count query rather than expanding the list. */
      const resolvedOverride = countOverrides?.resolvedByCategory;
      const count       = resolvedOverride
        ? (resolvedOverride[cat] ?? 0)
        : catResolved.length;
      // Count 1h ago: how many were already resolved before the 1h cutoff
      const countPrev   = catResolved.filter((p) => {
        const endStr = p["event.end"];
        if (!endStr) return false;
        return new Date(endStr).getTime() <= cutoff1h;
      }).length;
      // Delta = resolutions in the last hour. Uses the list-derived
      // count of CURRENTLY-resolved-in-window (`catResolved.length`)
      // minus those that were already resolved 1h ago, NOT the override
      // total. The override would inflate the delta with old resolutions
      // that the list doesn't carry, breaking the "/1h" semantic.
      const delta       = catResolved.length - countPrev;
      const isEmpty     = count === 0;
      const cx = colW * idx + colW * 0.5;
      const labelColor = colorOf(cat);

      const labelText = labelById[cat] || cat;

      // ── Row 1: dot + CATEGORY label (bigger, uppercase letter-spacing)
      ctx.font = `600 ${(13 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
      const labelW    = ctx.measureText(labelText.toUpperCase()).width;
      const dotR      = 5;
      const gap       = 8;
      const unitW     = dotR * 2 + gap + labelW;
      const unitStart = cx - unitW / 2;
      const dotX      = unitStart + dotR;
      const labelX    = unitStart + dotR * 2 + gap;
      const headerY   = resolvedY + 32;

      ctx.beginPath();
      ctx.arc(dotX, headerY, dotR, 0, Math.PI * 2);
      ctx.fillStyle = isEmpty
        ? labelColor + (dk ? "44" : "55")
        : labelColor;
      if (!isEmpty) {
        ctx.save();
        ctx.shadowColor = labelColor;
        ctx.shadowBlur  = 8;
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fill();
      }

      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = isEmpty
        ? labelColor + (dk ? "66" : "77")
        : labelColor + (dk ? "ee" : "ee");
      ctx.fillText(labelText.toUpperCase(), labelX, headerY);

      // ── Row 2: thin accent line in category color (HUD style)
      const accentY = headerY + 14;
      const accentW = 56;
      ctx.strokeStyle = isEmpty
        ? labelColor + (dk ? "22" : "33")
        : labelColor + (dk ? "88" : "aa");
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - accentW / 2, accentY);
      ctx.lineTo(cx + accentW / 2, accentY);
      ctx.stroke();

      // ── Row 3: hero number — big bold count, centered, with subtle glow
      const heroY = accentY + 10;
      ctx.font = `600 ${(32 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "top";
      if (!isEmpty) {
        ctx.save();
        ctx.shadowColor = dk ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.15)";
        ctx.shadowBlur  = 6;
        ctx.fillStyle = dk ? "#ffffff" : "#0f172a";
        ctx.fillText(`${count}`, cx, heroY);
        ctx.restore();
      } else {
        ctx.fillStyle = dk ? "rgba(148,163,184,0.30)" : "rgba(100,116,139,0.4)";
        ctx.fillText(`${count}`, cx, heroY);
      }

      // ── Row 4: delta /1h indicator — colored pill-style label
      if (!isEmpty) {
        const deltaY = heroY + 40;
        const arrow  = delta > 0 ? "▲" : delta < 0 ? "▼" : "●";
        const sign   = delta > 0 ? `+${delta}` : `${delta}`;
        const trendRgb =
          delta > 0 ? (dk ? "52,211,153" : "40,160,100") :
          delta < 0 ? (dk ? "255,77,106" : "220,50,50")   :
                      (dk ? "148,163,184" : "100,116,139");

        ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
        const deltaText = `${arrow} ${sign} /1h`;
        const dW = ctx.measureText(deltaText).width;
        // background pill
        const pillX = cx - dW / 2 - 8;
        const pillY = deltaY - 3;
        const pillW = dW + 16;
        const pillH = 18;
        ctx.fillStyle = `rgba(${trendRgb},${delta === 0 ? 0.08 : 0.16})`;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 9);
        ctx.fill();
        ctx.fillStyle = `rgba(${trendRgb},${delta === 0 ? 0.55 : 0.95})`;
        ctx.textBaseline = "middle";
        ctx.fillText(deltaText, cx, deltaY + pillH / 2 - 3);

        // ── Row 5: reference — "1h ago: N"
        ctx.font = `400 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
        ctx.textBaseline = "top";
        ctx.fillStyle = dk ? "rgba(148,163,184,0.55)" : "rgba(100,116,139,0.6)";
        ctx.fillText(`1h ago: ${countPrev}`, cx, deltaY + 22);
      }

      // Column separator — vertical thin dashed line for HUD look
      if (idx > 0) {
        ctx.beginPath();
        ctx.setLineDash([3, 5]);
        ctx.moveTo(colW * idx, activeAreaH + 12);
        ctx.lineTo(colW * idx, h - 12);
        ctx.strokeStyle = dk ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
        ctx.lineWidth = 0.6;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    } // end if (showResolvedZone)

    const t = animRef.current;

    // Grouping center pixel coords (used by hub spokes below). Derived
    // from the layout so a Segments page with N groupings produces N
    // spoke targets automatically.
    const catCenter: Record<string, { x: number; y: number }> = {};
    for (const s of layout) {
      catCenter[s.id] = { x: w * s.center.x, y: h * s.center.y };
    }
    // Gravity flow particles inside quadrants removed — they were leftover from
    // the old animation system and added visual noise. Trend signal now lives
    // exclusively in the hub spoke animation.

    const currentStars = starsRef.current;

    // Update positions (drift toward targets) — clamped to quadrant bounds
    const frozenQuadrant = hoveredQuadrantRef.current;
    const hoveredId = hover?.star.id;
    currentStars.forEach((star) => {
      // Animate the hover zoom value toward its target (1 when hovered, 0 not)
      const hoverTarget = star.id === hoveredId ? 1 : 0;
      star.hoverAnim += (hoverTarget - star.hoverAnim) * 0.22;

      // ── Drilled-category top-tier anchor ──────────────────────────
      // When the cell is drilled into a single category, that subset's
      // top problem(s) animate toward the cell centre so the layout
      // mirrors the Incidents-page centred top-tier. Checked BEFORE
      // the cell-level top check so a drilled-subset top wins when
      // both flags apply.
      {
        const drillCat = expandedCellCategory[star.cluster];
        const drillInfo = drilledSubsets[star.cluster];
        if (drillCat && drillInfo && star.problem["event.category"] === drillCat) {
          const tierIdx = drillInfo.topOrdered.indexOf(star.id);
          if (tierIdx >= 0) {
            const slot = slotById[star.cluster];
            if (slot) {
              const tierCount = drillInfo.topOrdered.length;
              const center    = slot.center;
              let tx: number;
              let ty: number;
              if (tierCount <= 1) {
                tx = center.x; ty = center.y;
              } else {
                const maxSpread = (slot.bounds.xMax - slot.bounds.xMin) * 0.78;
                const spread = Math.min(tierCount * 0.034, maxSpread);
                const startX = center.x - spread / 2;
                const stepX  = spread / (tierCount - 1);
                tx = startX + tierIdx * stepX;
                ty = center.y;
              }
              star.x += (tx - star.x) * 0.2;
              star.y += (ty - star.y) * 0.2;
              star.vx = 0; star.vy = 0;
              const rxN = star.radius / w;
              const ryN = star.radius / h;
              if (star.x < slot.bounds.xMin + rxN) star.x = slot.bounds.xMin + rxN;
              if (star.x > slot.bounds.xMax - rxN) star.x = slot.bounds.xMax - rxN;
              if (star.y < slot.bounds.yMin + ryN) star.y = slot.bounds.yMin + ryN;
              if (star.y > slot.bounds.yMax - ryN) star.y = slot.bounds.yMax - ryN;
              return;
            }
          }
        }
      }

      // Top-of-category dot is anchored — heavy attraction, no drift, no
      // jitter. Always findable in the same spot for easy clicking.
      // Clamp inside the slot too so a dense top-tier (wide spread)
      // can't push the edge dots across the divider lines.
      if (star.isTopOfCategory) {
        star.x += (star.targetX - star.x) * 0.2;
        star.y += (star.targetY - star.y) * 0.2;
        star.vx = 0;
        star.vy = 0;
        const tb = slotById[star.cluster]?.bounds;
        if (tb) {
          const rxN = star.radius / w;
          const ryN = star.radius / h;
          if (star.x < tb.xMin + rxN) star.x = tb.xMin + rxN;
          if (star.x > tb.xMax - rxN) star.x = tb.xMax - rxN;
          if (star.y < tb.yMin + ryN) star.y = tb.yMin + ryN;
          if (star.y > tb.yMax - ryN) star.y = tb.yMax - ryN;
        }
        return;
      }
      // When the cell is drilled into a single category, the
      // non-top-tier drilled dots fan out across the full cell using
      // deterministic per-star coordinates so the data uses all the
      // available space (instead of clustering wherever it sat in the
      // pre-drill layout). Other dots use their original target.
      let effTargetX = star.targetX;
      let effTargetY = star.targetY;
      {
        const drillCat = expandedCellCategory[star.cluster];
        if (drillCat && star.problem["event.category"] === drillCat) {
          const slot = slotById[star.cluster];
          if (slot) {
            // FNV-1a-ish hash of the star id for stable lanes.
            let h = 2166136261 >>> 0;
            for (let i = 0; i < star.id.length; i++) {
              h ^= star.id.charCodeAt(i);
              h = Math.imul(h, 16777619) >>> 0;
            }
            const rx = ((h >>> 0) % 10000) / 10000;
            const ry = ((Math.imul(h, 31) >>> 0) % 10000) / 10000;
            const cellW = slot.bounds.xMax - slot.bounds.xMin;
            const cellH = slot.bounds.yMax - slot.bounds.yMin;
            // Inset by 4 % on each side so dots don't sit on the grid
            // dividers, and leave the centre row open for the drilled
            // top-tier dots that anchor there.
            effTargetX = slot.bounds.xMin + 0.04 * cellW + rx * 0.92 * cellW;
            // Bias y away from the centre row to keep the top-tier
            // anchor area uncluttered — push non-top dots toward the
            // top or bottom strips of the cell.
            const yT = ry < 0.5 ? ry * 0.4 : 0.6 + (ry - 0.5) * 0.8;
            effTargetY = slot.bounds.yMin + 0.04 * cellH + yT * 0.92 * cellH;
          }
        }
      }
      const dx = effTargetX - star.x;
      const dy = effTargetY - star.y;
      star.vx += dx * 0.01;
      star.vy += dy * 0.01;
      star.vx *= 0.95;
      star.vy *= 0.95;
      // When the user is hovering over this quadrant, freeze the orbital
      // drift so they can click precisely on a specific problem. Stars still
      // settle gently toward their targets via the dx/dy attraction above.
      if (star.cluster !== frozenQuadrant) {
        // Slow orbital drift — calm futuristic motion (frequency ~3× slower)
        star.vx += Math.sin(t * star.pulse * 0.7) * 0.00018;
        star.vy += Math.cos(t * star.pulse * 0.7) * 0.00018;
      } else {
        // Extra damping so they settle quickly when hovered
        star.vx *= 0.7;
        star.vy *= 0.7;
      }
      star.x += star.vx;
      star.y += star.vy;

      // Strict quadrant clamping — stars never leave their quadrant.
      // Inset by the dot's radius (converted to normalised units) so
      // the visible DISC stays inside the bounds, not just the centre.
      // Without this the dot leaks half-way across the grid divider
      // when its centre sits at the edge of the slot.
      const bounds = slotById[star.cluster]?.bounds;
      if (bounds && star.problem["event.status"] === "ACTIVE") {
        const rxN = star.radius / w;
        const ryN = star.radius / h;
        const xMinClamp = bounds.xMin + rxN;
        const xMaxClamp = bounds.xMax - rxN;
        const yMinClamp = bounds.yMin + ryN;
        const yMaxClamp = bounds.yMax - ryN;
        if (star.x < xMinClamp) { star.x = xMinClamp; star.vx = 0; }
        if (star.x > xMaxClamp) { star.x = xMaxClamp; star.vx = 0; }
        if (star.y < yMinClamp) { star.y = yMinClamp; star.vy = 0; }
        if (star.y > yMaxClamp) { star.y = yMaxClamp; star.vy = 0; }
      }
    });

    // Electric arcs between stars removed — trend is now shown only via the hub spokes.

    // Same-cluster star connections removed — they were adding visual noise.

    // (Drilled-subset top-tier is precomputed at component scope —
    // see `drilledSubsets` memo. Used here for render-time top flag
    // and radius override.)
    const RADIUS_BASE_DRAW = isMobileOrTablet ? 7   : 5.5;
    const RADIUS_TOP_DRAW  = isMobileOrTablet ? 11.5 : 10;

    // Draw stars. Rendering modes (0.0.109 — bubbles own the page):
    //   • Main page (not in modal) — skip ALL individual dots. The
    //     per-cell sub-bubbles ARE the entry point now; floating
    //     dots competed with them visually ("remover bolinhas
    //     flutuantes" user report).
    //   • Drilled cell (drill state set on the host) → still render
    //     the top `DENSE_DRILL_CAP` stars ranked by Show By score —
    //     this path is only reachable when no enlarge handler is
    //     wired (legacy fallback).
    //   • Modal (disableAggregation=true) → render every dot of the
    //     filtered subset that EnlargedQuadrantCard passes in.
    currentStars.forEach((star) => {
      const drillCat = expandedCellCategory[star.cluster];
      if (drillCat && star.problem["event.category"] !== drillCat) return;
      if (!disableAggregation && !drillCat) {
        // Main page, no drill — bubbles handle this cell, no dots.
        return;
      }
      if (drillCat) {
        const allowed = aggregatedTopByCell[star.cluster];
        if (!allowed || !allowed.has(star.id)) return;
      }
      // Override the per-star radius + top flag when this dot is part
      // of a category-drilled subset (different top-tier than the cell-
      // level computation produced).
      let starRadius = star.radius;
      let isStarTop  = star.isTopOfCategory;
      if (drillCat) {
        isStarTop = !!drilledSubsets[star.cluster]?.topIds.has(star.id);
        starRadius = isStarTop ? RADIUS_TOP_DRAW : RADIUS_BASE_DRAW;
      }
      const sx = star.x * w;
      const sy = star.y * h;
      const isSelected = star.id === selectedId;

      // Slower, calmer pulse — frequency cut by ~60%
      const pulseScale = star.pulse > 0 ? 1 + Math.sin(t * 1.1 * star.pulse) * 0.12 : 1;

      // ── Magnifier lens area zoom ─────────────────────────────────────
      // REMOVED in 0.0.106 per user request ("remover opção de zoom").
      //
      // History: the lens scaled every dot in the cursor's quadrant by
      // 1.2–2.4×, intended to make aim easier in dense clusters. In
      // practice it stacked each dot's radial-gradient glow into a
      // bright halo on hover, and the user reported the effect made
      // dense cells unreadable. 0.0.102 added a density gate, 0.0.104
      // capped the drilled-dot count to 30, 0.0.105 extended the cap to
      // collapsed cells too. The flare PERSISTED at 30 dots because
      // each lens-scaled dot still painted its glow at the larger
      // radius, and 30 of those overlap into a bright row across the
      // cell. User asked again to "remove the zoom option" — so the
      // lens is now off everywhere; the `disableMagnifierLens` prop
      // still exists for the modal but is effectively a no-op.
      //
      // Dots stay at their baseline radius on hover; the tooltip + hit-
      // test handle aiming (the hit-test already widens via hoverAnim).
      const proximityScale = 1;
      const r = starRadius * pulseScale * proximityScale * dotScale;

      // Rank-based dimming: top problems are full-bright; lower-ranked dots
      // fade so the meaningful ones stand out. Active in "total" mode keeps
      // everyone at full alpha (scoreNorm is forced to 1 in that mode).
      const baseAlpha = 0.45 + star.scoreNorm * 0.55; // 0.45 → 1.0

      // Outer glow that "breathes" slowly out of phase with the pulse —
      // top-of-category gets a more prominent glow (extra +50% radius).
      if (star.pulse > 0 || isSelected || isStarTop) {
        const breath = (Math.sin(t * 0.7 * star.pulse + sx * 0.013) + 1) / 2; // 0..1, slow
        const baseGlowMult = isSelected ? 4 : 2.5 + breath * 1.2;
        const topBoost = isStarTop ? 1.5 : 1;
        const glowR = r * baseGlowMult * topBoost;
        const glow   = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
        const glowAlpha = Math.round((36 + breath * 30) * (0.5 + star.scoreNorm * 0.5));
        glow.addColorStop(0, star.color + Math.min(255, glowAlpha).toString(16).padStart(2, "0"));
        glow.addColorStop(1, star.color + "00");
        ctx.save();
        ctx.globalAlpha = baseAlpha;
        ctx.beginPath();
        ctx.arc(sx, sy, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.restore();
      }

      // Core
      ctx.save();
      ctx.globalAlpha = baseAlpha;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = star.color;
      ctx.fill();

      // Inner highlight
      ctx.beginPath();
      ctx.arc(sx - r * 0.25, sy - r * 0.25, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fill();
      ctx.restore();

      // Top-of-category focus ring — pulsing dashed ring that calls attention
      // to the leader of the active metric in each quadrant (or each
      // drilled (cell, category) subset).
      if (isStarTop) {
        const ringPulse = (Math.sin(t * 1.8) + 1) / 2; // 0..1
        const ringR = r + 5 + ringPulse * 2.5;
        ctx.save();
        ctx.strokeStyle = star.color;
        ctx.lineWidth = 1.3;
        ctx.globalAlpha = 0.55 + ringPulse * 0.35;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -t * 12;
        ctx.beginPath();
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Selection ring (manual click) — distinct from top-of-category ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(sx, sy, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = star.color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // ── Per-cell Show By sub-bubbles ───────────────────────────────
    // 0.0.109: replaces the single-aggregation-bubble model with one
    // sub-bubble PER Show By mode (Rising / Stuck / Critical / Total).
    // Each sub-bubble is clickable; the click opens the modal pre-
    // filtered to that subset. Drives the new design (no global Show
    // By chip needed — the bubbles ARE the chip, scoped to one cell).
    const bubbleHits: Array<{ cellId: string; subsetMode: ConstellationDataMode; cx: number; cy: number; r: number }> = [];
    for (const slot of layout) {
      // 0.0.109 follow-up: render sub-bubbles in EVERY cell that has at
      // least one ACTIVE problem (was gated on `isCellAggregated`, i.e.
      // > 100 active — but real-prd tenants are usually much quieter
      // than that and showed no bubbles at all). On sparse cells the
      // bubbles overlay the individual dots; on dense cells they
      // replace them (dot pass already early-returns when
      // `isCellAggregated`). Both surfaces stay clickable in either
      // state — dot for the individual problem, bubble for the filtered
      // modal.
      const subsets = cellSubsetBubbles[slot.id];
      if (!subsets || subsets.length === 0) continue;
      // Skip totally empty cells (every subset == 0 means no active).
      if (subsets.every((s) => s.count === 0)) continue;
      const cell = cellRects[slot.id];
      if (!cell) continue;

      const N = subsets.length;
      const usableW = Math.max(0, cell.w - 24);
      const spacing = usableW / N;
      // Bubble geometry — bumped up in 0.0.109 follow-up so the
      // bubbles read clearly without zooming the browser.
      const bubbleY = cell.y + cell.h * 0.5;
      const maxR = Math.min(36, Math.max(18, spacing * 0.42));
      const minR = 18;
      const maxCount = Math.max(1, ...subsets.map((s) => s.count));
      // Gentle breathing pulse — one cycle every ~3 s, ±6 % radius.
      // Adds a sense of liveness without distracting from the count
      // ("colocar animação nos agrupamentos" user request).
      const pulse = 1 + Math.sin(tc * 2.1) * 0.06;

      for (let i = 0; i < N; i++) {
        const s = subsets[i];
        const bubbleX = cell.x + 12 + spacing * (i + 0.5);
        // Log-based radius scaling — keeps small subsets readable
        // when one (usually Total) dominates the cell.
        const lr = Math.log10(Math.max(1, s.count)) / Math.max(1, Math.log10(maxCount));
        // Each bubble pulses slightly out of phase so the row feels
        // alive without the four bubbles moving in lock-step.
        const phaseOffset = i * 0.5;
        const r = (minR + lr * (maxR - minR))
          * (1 + Math.sin(tc * 2.1 + phaseOffset) * 0.06);

        // Hit area: use the AVERAGE radius (un-pulsed) so the click
        // target stays steady even when the bubble breathes.
        const rHit = minR + lr * (maxR - minR);
        bubbleHits.push({ cellId: slot.id, subsetMode: s.mode, cx: bubbleX, cy: bubbleY, r: rHit });

        // Soft glow halo — pulses with the bubble.
        ctx.save();
        const halo = ctx.createRadialGradient(bubbleX, bubbleY, 0, bubbleX, bubbleY, r * 2.2);
        halo.addColorStop(0, `${s.color}66`);
        halo.addColorStop(1, `${s.color}00`);
        ctx.fillStyle = halo;
        ctx.fillRect(bubbleX - r * 2.2, bubbleY - r * 2.2, r * 4.4, r * 4.4);
        ctx.restore();

        // Bubble body
        ctx.save();
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(bubbleX, bubbleY, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Inner darker disc to make the count more readable against
        // the saturated outer ring.
        ctx.save();
        ctx.fillStyle = "rgba(8,12,22,0.7)";
        ctx.beginPath();
        ctx.arc(bubbleX, bubbleY, r * 0.78, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Count text — sized to fit comfortably inside the bubble.
        ctx.save();
        const fontSize = Math.max(12, Math.min(20, r * 0.7)) * fsMult;
        ctx.font = `700 ${fontSize}px "Roboto Mono", "SF Mono", monospace`;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(s.count), bubbleX, bubbleY);
        ctx.restore();

        // Mode label BELOW the bubble — "Rising", "Stuck",
        // "Critical", "Total". 0.0.109 follow-up: the previous
        // ▲/⏱/⚡/Σ glyphs ABOVE the bubble were both unclear
        // ("não sei o que significam os emojis") and overlapping
        // the cell title strip. Plain English labels under the
        // bubble fix both.
        ctx.save();
        ctx.font = `600 ${(11 * fsMult).toFixed(2)}px "Inter", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 4;
        ctx.fillStyle = s.color;
        ctx.globalAlpha = 0.95;
        ctx.fillText(s.label, bubbleX, bubbleY + r + 4);
        ctx.restore();
      }
      // Silence unused-var warning for `pulse` — we now use the
      // per-bubble out-of-phase pulse inside the loop instead.
      void pulse;
    }
    bubbleHitsRef.current = bubbleHits;

    // ── Magnifier lens cursor REMOVED in 0.0.109 ────────────────────
    // The lens cursor was a circular "magnifier glyph" that followed
    // the pointer to advertise the dot-zoom feature. The dot-zoom
    // was already removed in 0.0.106 (user request) but the visual
    // cursor stayed. Removed now per user feedback: "remover icone
    // de lupa ao clicar". Click semantics unchanged — bubbles open
    // the modal, dots open the problem panel, empty space clears
    // selection.

    // ── CENTER BADGE: total active count + trend ─────────────────────────
    // Entire hub block (counts, spokes, satellites) is gated behind
    // showHub. Used by the Segments page to free up the central area
    // for more grouping quadrants.
    if (showHub) {
    const activeProblems = problems.filter((p) => p["event.status"] === "ACTIVE");
    /* Prefer the count-query override (covers the full window even
       when `problems` is trimmed by DPS Tier 3's `DEFAULT_INITIAL = 250`).
       Falls back to the list-derived length when the override isn't
       available — initial paint, debug scenarios, etc. */
    const totalActive    = countOverrides?.active ?? activeProblems.length;

    // Compute total trend: net change in ACTIVE problems over last 1h
    let recent = 0, older = 0;
    problems.forEach((p) => {
      const startTs = new Date(p["event.start"]).getTime();
      const endTs   = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
      const isActiveNow    = p["event.status"] === "ACTIVE";
      const wasActiveAtCut = startTs <= tCut && (isActiveNow || (endTs !== null && endTs > tCut));
      if (isActiveNow)    recent++;
      if (wasActiveAtCut) older++;
    });
    const totalDelta = recent - older;
    const trend: "rising" | "falling" | "stable" =
      totalDelta > 0 ? "rising" : totalDelta < 0 ? "falling" : "stable";

    const trendColor =
      trend === "rising"  ? "#ff4d6a" :
      trend === "falling" ? "#22d3a0" :
                            (dk ? "rgba(148,163,184,0.7)" : "rgba(100,116,139,0.7)");
    const trendRgb =
      trend === "rising"  ? "255,77,106" :
      trend === "falling" ? "34,211,160" :
                            "148,163,184";

    // Use the central hub geometry computed earlier (geometric center of the grid)
    const cx     = hubCx;
    const cy     = hubCy;
    const radius = hubRadius;
    const pulse  = (Math.sin(t * 1.2) + 1) / 2;

    // ── Connection spokes — curved Bezier paths, hub → quadrant ────────────
    // Pre-compute the longest straight-line spoke distance (used to normalize curves)
    let maxSpokeDist = 0;
    Object.values(catCenter).forEach((pos) => {
      const d = Math.hypot(pos.x - cx, pos.y - cy);
      if (d > maxSpokeDist) maxSpokeDist = d;
    });

    type SpokeCurve = { hubX: number; hubY: number; tx: number; ty: number; midX: number; midY: number; len: number };

    let spokeIdx = 0;
    Object.entries(catCenter).forEach(([cat, pos]) => {
      const dx   = pos.x - cx;
      const dy   = pos.y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) return;

      const trendData = catTrends[cat];
      const diff      = trendData ? trendData.recent - trendData.older : 0;
      const isRising  = diff > 0;
      const baseColor = colorOf(cat);
      const cR = parseInt(baseColor.slice(1,3),16);
      const cG = parseInt(baseColor.slice(3,5),16);
      const cB = parseInt(baseColor.slice(5,7),16);

      // Only animate spokes for rising quadrants AND only in the
      // Rising view mode — motion signals "count climbing", so it's
      // gated on the metric the user is actually looking at.
      if (!isRising || dataMode !== "rising") { spokeIdx++; return; }

      // Central column targets sit directly above/below the hub — a straight
      // spoke would plow through the quadrant's dots. Route a single spoke
      // from one side of the hub, curving outward to clear the dot cluster.
      // Top-center quadrant exits LEFT; bottom-center exits RIGHT — creates
      // a subtle rotational flow and keeps the two streams visually distinct.
      const isCentralCol = Math.abs(dx) < radius * 0.6;
      const spokes: SpokeCurve[] = [];

      if (isCentralCol) {
        const sgnY  = dy < 0 ? -1 : 1;
        const sideX = dy < 0 ? -1 : 1; // top → left, bottom → right
        const hubX  = cx + sideX * (radius + 1);
        const hubY  = cy;
        const tx    = pos.x;
        const ty    = pos.y - sgnY * 12;
        const sdist = Math.hypot(tx - hubX, ty - hubY);
        const curveAmount = Math.sqrt(Math.max(0, (3/8) * sdist * (maxSpokeDist - sdist))) * 0.75;
        const midX = (hubX + tx) / 2 + sideX * curveAmount * 0.55;
        const midY = (hubY + ty) / 2 + sgnY * curveAmount * 0.35;
        spokes.push({ hubX, hubY, tx, ty, midX, midY, len: sdist });
      } else {
        const ux = dx / dist, uy = dy / dist;
        const hubX = cx + ux * (radius + 1);
        const hubY = cy + uy * (radius + 1);
        const tx   = pos.x - ux * 12;
        const ty   = pos.y - uy * 12;
        const curveAmount = Math.sqrt(Math.max(0, (3/8) * dist * (maxSpokeDist - dist))) * 0.75;
        let perpX = -uy, perpY = ux;
        const wantPositiveY = pos.y > cy;
        const havePositiveY = perpY > 0;
        if (wantPositiveY !== havePositiveY) { perpX = -perpX; perpY = -perpY; }
        const midX = (hubX + tx) / 2 + perpX * curveAmount;
        const midY = (hubY + ty) / 2 + perpY * curveAmount;
        spokes.push({ hubX, hubY, tx, ty, midX, midY, len: dist });
      }

      // ── Single light packet sliding along an invisible curve ───────────
      // Cleaner / more futuristic than a multi-crest sine wave: one focused
      // "comet" per spoke. Speed/magnitude grows with delta but is capped
      // much lower so the eye can follow each packet calmly.
      const magC         = Math.min(diff, 8);
      const baseAlpha    = 0.06 + magC * 0.015;  // very subtle ambient trail
      const peakAlpha    = 0.70 + magC * 0.025;
      const wavesVisible = 1 + magC * 0.10;      // 1 → 1.8 crests (was up to 3.4)
      const waveSpeed    = 0.12 + magC * 0.018;  // max ~0.26 cyc/s (was ~0.83)
      const peakR        = 1.8 + magC * 0.15;    // max ~3.0 (was 4.2)
      const PEAK_SHARPNESS = 2.4;                // higher = narrower, comet-like

      const DOT_COUNT = 32;
      spokes.forEach((spoke, sIdx) => {
        const phaseOffset = sIdx * 0.08;
        for (let i = 0; i <= DOT_COUNT; i++) {
          const p = i / DOT_COUNT;
          const u1 = 1 - p;
          const px = u1 * u1 * spoke.hubX + 2 * u1 * p * spoke.midX + p * p * spoke.tx;
          const py = u1 * u1 * spoke.hubY + 2 * u1 * p * spoke.midY + p * p * spoke.ty;

          const phase = p - t * waveSpeed - phaseOffset;
          // Power curve sharpens the peak → looks like a single moving packet
          const raw   = Math.sin(phase * Math.PI * 2 * wavesVisible);
          const brightness = Math.pow(Math.max(0, raw), PEAK_SHARPNESS);

          const a = Math.min(1, baseAlpha + brightness * peakAlpha);
          const r = 0.9 + brightness * (peakR - 0.9);

          ctx.save();
          if (brightness > 0.12) {
            ctx.shadowColor = baseColor;
            ctx.shadowBlur  = 5 + 5 * brightness; // softer halo
          }
          ctx.fillStyle = `rgba(${cR},${cG},${cB},${a})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      spokeIdx++;
    });

    // ── Satellite hubs: TOTAL (left) | ACTIVE (center) | RESOLVED (right) ──
    /* Same override path as `totalActive` above — see that comment for
       the full rationale. TOTAL and RESOLVED both fell out of sync with
       native Davis once the list was capped at 250; the count-query
       override restores parity. */
    const satTotal    = countOverrides?.total ?? problems.length;
    const satResolved = countOverrides?.resolved ?? problems.filter((p) => p["event.status"] === "CLOSED").length;

    // Compute trends: rate now (last 1h) vs rate previously (1-2h ago)
    const oneHourAgo  = now - 3600000;
    const twoHoursAgo = now - 7200000;
    let totalRecent = 0, totalPrevious = 0;
    let resolvedRecent = 0, resolvedPrevious = 0;
    problems.forEach((p) => {
      const startTs = new Date(p["event.start"]).getTime();
      if (startTs >= oneHourAgo)       totalRecent++;
      else if (startTs >= twoHoursAgo) totalPrevious++;
      if (p["event.status"] === "CLOSED" && p["event.end"]) {
        const endTs = new Date(p["event.end"]).getTime();
        if (endTs >= oneHourAgo)       resolvedRecent++;
        else if (endTs >= twoHoursAgo) resolvedPrevious++;
      }
    });
    const totalTrend    = totalRecent - totalPrevious;
    const resolvedTrend = resolvedRecent - resolvedPrevious;

    // Uniform radius for all three circles — full hub radius (no scaling down)
    // so the circles appear significantly larger / dominate the band area.
    const satR = Math.max(40, radius);
    const satY = cy;
    const satLeftX   = w * 0.18;
    const satCenterX = cx;
    const satRightX  = w * 0.82;

    // All three circles drawn without halo (no light emanating from any).
    // TOTAL: rising rate is BAD (more new incidents) → red ▲ / green ▼
    drawSatellite(ctx, satLeftX,   satY, satR, satTotal,    "TOTAL",    "#94a3b8", "148,163,184", dk, totalTrend,    false, true, fsMult);
    // ACTIVE: red ring — represents active/critical problems.
    drawSatellite(ctx, satCenterX, satY, satR, totalActive, "ACTIVE",   "#ff4d6a", "255,77,106",  dk, totalDelta,    false, true, fsMult);
    // RESOLVED: rising rate is GOOD (resolving faster) → green ▲ / red ▼
    drawSatellite(ctx, satRightX,  satY, satR, satResolved, "RESOLVED", "#22d3a0", "34,211,160",  dk, resolvedTrend, true,  true, fsMult);
    } // ← end of if (showHub)

    // ── Rising-segment trail (Segments page only) ─────────────────
    // Comet packet flowing horizontally along the title row, starting
    // a bit AFTER the rendered label text and running to the right
    // edge of the cell. Uses the same wave / brightness formula as
    // the categories-page hub spokes (single bright "head" with a
    // soft trail) and runs at roughly HALF the speed for a calmer
    // signal — the segments page already has a lot of motion.
    // Only fires when the user is in the Rising view mode, since the
    // motion specifically signals "the count is climbing" — showing
    // it under Open Time / Criticality / Total would conflate signals.
    if (!showHub && dataMode === "rising") {
      const upRgb = "255,77,106";
      for (const slot of layout) {
        const tr = catTrends[slot.id];
        if (!tr) continue;
        const diff = tr.recent - tr.older;
        if (diff <= 0) continue;
        const cell = cellRects[slot.id];
        if (!cell || cell.w < 80 || cell.h < 50) continue;

        const lab = labelEnd[slot.id];
        if (!lab) continue;
        // Start the trail ~12 px after the trend text. The right
        // inset depends on whether the ▲ UP badge is currently drawn
        // in this cell: in Rising mode every leader cell gets a
        // "▲ UP" seal at the top-right (≈ 60 px wide). When that's
        // present we shorten the track so the comet head doesn't run
        // under the badge.
        const isRisingLeader = dataMode === "rising" && leaderCats.includes(slot.id);
        const trackY      = lab.y + 7; // baseline-ish vertical centre of the label row
        const trackXMin   = lab.x + 12;
        const rightInset  = isRisingLeader ? 64 : 12;
        const trackXMax   = cell.x + cell.w - rightInset;
        const trackW      = trackXMax - trackXMin;
        if (trackW < 40) continue;

        // Match the main-page spoke parameters except waveSpeed (half).
        const magC           = Math.min(diff, 8);
        const baseAlpha      = 0.06 + magC * 0.015;
        const peakAlpha      = 0.70 + magC * 0.025;
        const wavesVisible   = 1 + magC * 0.10;
        const waveSpeed      = 0.06 + magC * 0.009; // ~½ the categories-page speed
        const peakR          = 1.8 + magC * 0.15;
        const PEAK_SHARPNESS = 2.4;
        const DOT_COUNT      = 32;

        for (let i = 0; i <= DOT_COUNT; i++) {
          const p   = i / DOT_COUNT;
          const px  = trackXMin + p * trackW;
          const py  = trackY;
          const ph  = p - tc * waveSpeed;
          const raw = Math.sin(ph * Math.PI * 2 * wavesVisible);
          const brightness = Math.pow(Math.max(0, raw), PEAK_SHARPNESS);
          const a = Math.min(1, baseAlpha + brightness * peakAlpha);
          const r = 0.9 + brightness * (peakR - 0.9);
          ctx.save();
          if (brightness > 0.12) {
            ctx.shadowColor = `rgba(${upRgb},1)`;
            ctx.shadowBlur  = 5 + 5 * brightness;
          }
          ctx.fillStyle = `rgba(${upRgb},${a})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    // Scanning line removed — was sweeping across the canvas background.

  }, [size, dk, selectedId, problems, dataMode, stars, expandedQuadrant, hoveredLabel,
      groupings, resolveGrouping, layout, layoutBounds, slotById, colorOf, labelById, detectQuadrantAt, detectLabelAt, showHub,
      cellAggregations, cellActiveTotalAll, cellSubsetBubbles, isCellAggregated, expandedCellCategory, isMobileOrTablet,
      highlightedCategoriesPerCell, drilledSubsets, aggregatedTopByCell, viewTransform,
      // `fontScale` drives `fsMult` inside the draw fn — re-bind so
      // a change in the Display panel triggers a fresh closure on
      // the very next render.
      fontScale,
      // `countOverrides` feeds the central rings (TOTAL/ACTIVE/RESOLVED)
      // AND the per-category Active Problems + RESOLVED panels. Without
      // this dep the draw fn captures `undefined` on first paint and
      // never picks up the count-query response — rings stay locked to
      // the trimmed list math (e.g. ACTIVE=1 from list while the
      // actual tenant has 5 active beyond the DEFAULT_INITIAL cap).
      countOverrides]);

  // Animation loop. Two changes vs the naïve "60 FPS + restart on
  // every draw-deps change" version:
  //   1. Throttled to ~30 FPS. The ambient effects (sweep, breath,
  //      glow, sparkle) are visually indistinguishable from 60 FPS
  //      but the draw cost is halved.
  //   2. The `draw` callback is held in a ref so the RAF setup
  //      doesn't tear down + restart every time the function
  //      reference changes (which is on every render because of the
  //      huge dep array). The loop body always reads the latest fn.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // Skip the expensive draw when the tab is hidden / occluded —
  // see C5 in the perf audit. The RAF reschedule itself is cheap,
  // so we keep that running so the animation resumes instantly
  // when the user returns to the tab.
  const pageVisible = usePageVisible();
  const pageVisibleRef = useRef(pageVisible);
  pageVisibleRef.current = pageVisible;
  useEffect(() => {
    const FRAME_INTERVAL = 1000 / 30;
    // Cap a single dt at 200 ms so the anim clock doesn't teleport
    // when the tab returns from hidden — see PulseVisualizer for the
    // same trick.
    const DT_CAP = 200;
    let raf = 0;
    let lastDraw = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - lastDraw, DT_CAP);
      if (dt >= FRAME_INTERVAL) {
        animRef.current += dt / 1000;
        lastDraw = now;
        if (pageVisibleRef.current) drawRef.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const findStarAt = useCallback((mxNorm: number, myNorm: number): Star | null => {
    let closest: Star | null = null;
    let minDist = Infinity;
    // Tap targets need ≥ 44px (WCAG 2.5.5 / Apple HIG) on touch devices.
    // We translate this to a normalized hit radius based on canvas width.
    const minTouchHitPx = isTouch ? 22 : 12;
    starsRef.current.forEach((star) => {
      // Mirror the draw-loop skip rules so hover / click don't latch
      // onto invisible dots.
      // 0.0.109: main page renders NO individual dots — only the
      // per-cell sub-bubbles. Hit-test mirrors that: dots are only
      // interactive when in the modal or when drilled.
      const drillCat = expandedCellCategory[star.cluster];
      if (drillCat && star.problem["event.category"] !== drillCat) return;
      if (!disableAggregation && !drillCat) return;
      if (drillCat) {
        const allowed = aggregatedTopByCell[star.cluster];
        if (!allowed || !allowed.has(star.id)) return;
      }
      const dx = mxNorm - star.x;
      const dy = myNorm - star.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // Hit area grows with hover zoom so the hover stays "sticky" — once
      // the cursor enters the dot, the bigger hit window keeps it engaged
      // even if it nudges slightly off-center.
      const dotHitPx  = star.radius * 4 * (1 + star.hoverAnim * 0.8);
      const hitPx     = Math.max(minTouchHitPx, dotHitPx);
      const hitRadius = hitPx / size.w;
      if (dist < hitRadius && dist < minDist) {
        minDist = dist;
        closest = star;
      }
    });
    return closest;
  }, [size, isTouch, expandedCellCategory, isCellAggregated, aggregatedTopByCell, disableAggregation]);

  // Maps screen-normalized coords (0..1) to world coords, inverting the
  // expanded-quadrant view transform when active. Used so click/hover work
  // correctly when zoomed. Reads `viewTransform` defined above the
  // draw fn so both share one source of truth.
  const screenToWorld = useCallback((mxN: number, myN: number): { x: number; y: number } => {
    if (!viewTransform) return { x: mxN, y: myN };
    return {
      x: ((mxN * size.w) - viewTransform.tx) / viewTransform.scaleX / size.w,
      y: ((myN * size.h) - viewTransform.ty) / viewTransform.scaleY / size.h,
    };
  }, [viewTransform, size]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mxPx = e.clientX - rect.left;
    const myPx = e.clientY - rect.top;
    const mx = mxPx / size.w;
    const my = myPx / size.h;
    const world = screenToWorld(mx, my);
    // Priority: aggregated bubble > dot > label strip > quadrant background.
    //
    // 0.0.108: bubble click now OPENS THE ENLARGED MODAL via
    // `onQuadrantEnlarge` instead of drilling inline. The modal has
    // room to render the individual problems matching the current
    // Show By mode (e.g. the +264 newly-opened in last hour) without
    // overcrowding the tiny inline cell — see EnlargedQuadrantCard
    // for the per-mode filter logic. Falls back to the inline drill
    // when no enlarge handler is wired (defensive).
    for (const b of bubbleHitsRef.current) {
      if (Math.hypot(mxPx - b.cx, myPx - b.cy) <= b.r) {
        if (onQuadrantEnlarge) {
          onQuadrantEnlarge(b.cellId, b.subsetMode);
        } else {
          // Fallback: drill inline. We don't have a per-mode inline
          // representation any more, so just record the cell as
          // drilled (no per-category narrowing).
          setExpandedCellCategory((prev) => ({ ...prev, [b.cellId]: b.cellId }));
        }
        return;
      }
    }
    const found = findStarAt(world.x, world.y);
    if (found) {
      onSelect((found as Star).problem);
      return;
    }
    if (onCategoryLabelClick) {
      const labelCat = detectLabelAt(world.x, world.y);
      if (labelCat) {
        onCategoryLabelClick(labelCat);
        return;
      }
    }
    // Empty-cell click — if any cell is currently drilled into a single
    // category, exit that mode first (close the drill before bubbling
    // up to the parent's own clear-selection logic).
    const clickedQuad = detectQuadrantAt(world.x, world.y);
    if (clickedQuad && expandedCellCategory[clickedQuad]) {
      setExpandedCellCategory((prev) => {
        const next = { ...prev };
        delete next[clickedQuad];
        return next;
      });
      return;
    }
    // Empty-area click — collapse any zoomed quadrant and bubble up to
    // the parent so it can clear its own selection / expansion state.
    // No-op for `lockExpandedQuadrant` hosts (the modal owns dismissal).
    if (expandedQuadrant && !lockExpandedQuadrant) setExpandedQuadrant(null);
    onEmptyClick?.();
  }, [size, onSelect, findStarAt, screenToWorld, onCategoryLabelClick, expandedQuadrant, onEmptyClick, detectQuadrantAt, detectLabelAt, expandedCellCategory, onQuadrantEnlarge, lockExpandedQuadrant]);

  const handleDoubleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    // Pinned-zoom mode (modal): swallow the double-click — we don't
    // want a stray double-tap inside the modal to drop the zoom and
    // reveal the empty multi-quadrant grid behind it.
    if (lockExpandedQuadrant) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / size.w;
    const my = (e.clientY - rect.top) / size.h;
    // If already expanded inline (no host modal wired), double-click
    // anywhere collapses back.
    if (expandedQuadrant) { setExpandedQuadrant(null); return; }
    const world = screenToWorld(mx, my);
    const cat = detectQuadrantAt(world.x, world.y);
    if (!cat) return;
    // Prefer the host-driven enlarged modal so double-click matches
    // the explicit "Expand" button path. Only fall back to the
    // internal canvas zoom when no consumer is listening.
    if (onQuadrantEnlarge) {
      onQuadrantEnlarge(cat);
    } else {
      setExpandedQuadrant(cat);
    }
  }, [size, expandedQuadrant, screenToWorld, onQuadrantEnlarge, detectQuadrantAt, lockExpandedQuadrant]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mxPx  = e.clientX - rect.left;
    const myPx  = e.clientY - rect.top;
    const mxN   = mxPx / size.w;
    const myN   = myPx / size.h;
    // Update cursor position for the fisheye zoom & which quadrant is
    // being hovered (used by the animation loop to pause drift).
    const world = screenToWorld(mxN, myN);
    cursorRef.current = { x: world.x, y: world.y };
    const quadCat = detectQuadrantAt(world.x, world.y);
    hoveredQuadrantRef.current = quadCat;
    const found = findStarAt(world.x, world.y);
    if (found) {
      setHover({ star: found, mx: mxPx, my: myPx });
    } else if (hover) {
      setHover(null);
    }
    // Track whether the cursor is over a clickable label strip so the
    // cursor changes to "pointer" — signals the drilldown affordance.
    const labelCat = onCategoryLabelClick ? detectLabelAt(world.x, world.y) : null;
    if (labelCat !== hoveredLabel) setHoveredLabel(labelCat);
    // Same for the per-cell sub-bubbles — pointer cursor when hovering
    // any of them so the click affordance is obvious. The cursor used
    // to disappear here (the now-removed magnifier-lens code set
    // cursor:none over empty quadrant area, which included bubble
    // areas because bubbles aren't dots).
    let overBubble = false;
    for (const b of bubbleHitsRef.current) {
      if (Math.hypot(mxPx - b.cx, myPx - b.cy) <= b.r) { overBubble = true; break; }
    }
    if (overBubble !== hoveredBubble) setHoveredBubble(overBubble);
    // Show the floating "zoom" hint only when the cursor is inside a
    // quadrant body — NOT over a dot (then the intent is select) and NOT
    // over the label strip (then the intent is drilldown to list).
    // This signals that exploring inside the quadrant gives zoom, not
    // selection.
    const showHint = quadCat !== null && !found && !labelCat && !expandedQuadrant;
    if (showHint) {
      setZoomHint({ x: mxPx, y: myPx });
    } else if (zoomHint) {
      setZoomHint(null);
    }
  }, [size, findStarAt, hover, hoveredLabel, hoveredBubble, onCategoryLabelClick, screenToWorld, expandedQuadrant, zoomHint]);

  // ── Touch support — fingers don't fire mouse events, so we translate
  //    touchstart → click + hover (so a tap selects & shows the tooltip).


  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    const t = e.touches[0];
    if (!t) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mxPx = t.clientX - rect.left;
    const myPx = t.clientY - rect.top;
    const mxN  = mxPx / size.w;
    const myN  = myPx / size.h;
    const world = screenToWorld(mxN, myN);
    cursorRef.current = { x: world.x, y: world.y };
    hoveredQuadrantRef.current = detectQuadrantAt(world.x, world.y);
    const tappedCat = detectQuadrantAt(world.x, world.y);

    // Manual double-tap detection — on touch, synthetic dblclick events
    // don't fire reliably under `touch-action: manipulation`. We compare
    // against the previous tap: same quadrant + within 350ms = double-tap
    // = expand. (When already expanded, double-tap anywhere collapses.)
    const now = performance.now();
    const isDoubleTap =
      now - lastTapRef.current.t < 350 &&
      (expandedQuadrant !== null || (tappedCat !== null && tappedCat === lastTapRef.current.cat));
    lastTapRef.current = { t: now, cat: tappedCat };

    if (isDoubleTap) {
      // Reset so a third tap doesn't accidentally re-trigger
      lastTapRef.current = { t: 0, cat: null };
      if (expandedQuadrant) {
        setExpandedQuadrant(null);
      } else if (tappedCat) {
        // Prefer host-driven modal (matches the Expand button +
        // desktop double-click). Fallback to the internal canvas
        // zoom when no consumer wired the prop.
        if (onQuadrantEnlarge) {
          onQuadrantEnlarge(tappedCat);
        } else {
          setExpandedQuadrant(tappedCat);
        }
      }
      return;
    }

    const found = findStarAt(world.x, world.y);
    if (found) {
      setHover({ star: found, mx: mxPx, my: myPx });
      onSelect((found as Star).problem);
      return;
    }
    setHover(null);
    // Label strip tap drills down to the filtered list. Falls through to
    // the quadrant drawer only when the tap missed the label strip.
    if (onCategoryLabelClick) {
      const labelCat = detectLabelAt(world.x, world.y);
      if (labelCat) {
        onCategoryLabelClick(labelCat);
        return;
      }
    }
    if (onQuadrantClick && tappedCat) {
      onQuadrantClick(tappedCat);
      return;
    }
    // Tap on truly empty space (no dot, no label, no quadrant body).
    if (expandedQuadrant) setExpandedQuadrant(null);
    onEmptyClick?.();
  }, [size, findStarAt, onSelect, onQuadrantClick, onCategoryLabelClick, onEmptyClick, screenToWorld, expandedQuadrant]);

  // Build a concise text summary for screen readers so the canvas
  // — which is otherwise opaque to assistive tech — communicates the
  // same information sighted users get from the dots.
  const activeProblemsTotal = useMemo(() => problems.filter((p) => p["event.status"] === "ACTIVE").length, [problems]);
  const a11ySummary = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      const id = resolveGrouping(p);
      if (!id) continue;
      counts[id] = (counts[id] || 0) + 1;
    }
    const parts = groupings
      .map((g) => ({ g, n: counts[g.id] || 0 }))
      .filter((x) => x.n > 0)
      .map((x) => `${x.n} ${labelById[x.g.id] || x.g.id}`);
    if (parts.length === 0) return "No active problems.";
    return `${activeProblemsTotal} active ${activeProblemsTotal === 1 ? "problem" : "problems"} — ${parts.join(", ")}.`;
  }, [problems, groupings, labelById, resolveGrouping, activeProblemsTotal]);

  return (
    <div ref={containerRef} className="neo-constellation">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={a11ySummary}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => {
          setHover(null);
          setHoveredLabel(null);
          setHoveredBubble(false);
          setZoomHint(null);
          hoveredQuadrantRef.current = null;
          cursorRef.current = null;
        }}
        onTouchStart={handleTouchStart}
        style={{
          width: "100%",
          height: "100%",
          // Pointer cursor over any clickable canvas element:
          // a dot (hover), a category label strip (hoveredLabel),
          // or a sub-bubble (hoveredBubble). Otherwise the default
          // OS arrow. The previous `cursor:none` branch (when the
          // pointer sat in empty quadrant area) was a leftover from
          // the now-removed magnifier-lens visual — user reported
          // the cursor was vanishing on bubble hover (0.0.109).
          cursor:
            hover || hoveredLabel || hoveredBubble ? "pointer" : "default",
          touchAction: "manipulation", // disables double-tap zoom on the canvas
        }}
      />
      {expandedQuadrant && !lockExpandedQuadrant && (
        <button
          className="neo-constellation-exit-zoom"
          onClick={() => setExpandedQuadrant(null)}
          title="Exit zoom (Esc)"
        >
          ✕ Exit zoom
        </button>
      )}
      {/* Per-quadrant expand affordances — explicit clickable buttons so
          users (especially on touch) don't have to discover the double-
          click gesture. Each button sits in the TOP-LEFT corner of its
          cell, just before the category title text (which has been
          shifted right to make room). This keeps it clear of the
          top-right ▲ UP / ★ TOP / ▼ DOWN canvas-drawn badges that used
          to overlap. Hidden while a quadrant is already expanded.
          Also hidden when only one grouping is being shown — that's
          the host page mounting us already inside an "enlarged
          quadrant" modal, so the per-cell expand button would just
          loop back into itself. */}
      {!expandedQuadrant && size.w > 0 && groupings.length > 1 && (
        layout.map(({ id: cat, bounds: qb }) => {
          // Anchor the button INSIDE the cell, just below the cell's
          // top border (matches the canvas label which now also sits
          // inside the cell). Works for any layout.
          const left = qb.xMin * size.w + 3;
          const top  = Math.max(2, cellTopNById[cat] * size.h + 3);
          return (
            <button
              key={cat}
              className="neo-quadrant-expand"
              onClick={(e) => {
                e.stopPropagation();
                if (onQuadrantEnlarge) {
                  // Host page renders the enlarged HTML/SVG modal
                  // — no canvas zoom (intentional: feedback was
                  // "ainda vejo um zoom, queremos ampliação").
                  onQuadrantEnlarge(cat);
                } else {
                  setExpandedQuadrant(cat);
                }
              }}
              title={`Expand ${cat.replace(/_/g, " ")}`}
              aria-label={`Expand ${cat.replace(/_/g, " ")} quadrant`}
              style={{
                position: "absolute",
                left,
                top,
                zIndex: 5,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          );
        })
      )}
      {/* Per-cell aggregation toggle removed — per-category drill-down
          via the bubble click is the primary way to explore a crowded
          cell. The whole-cell "+" was redundant and just added noise. */}
      {hover && (() => {
        const p = hover.star.problem;
        const isActive = p["event.status"] === "ACTIVE";
        const ageMs    = Date.now() - new Date(p["event.start"]).getTime();
        const mins     = Math.floor(ageMs / 60000);
        const dur      = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins/60)}h ${mins%60}m` : `${Math.floor(mins/1440)}d`;
        const entities = p.affected_entity_ids?.length || 0;
        const tipW = 240;
        let tx = hover.mx + 14;
        let ty = hover.my - 10;
        if (tx + tipW > size.w - 8) tx = hover.mx - tipW - 14;
        if (ty < 8) ty = hover.my + 18;
        return (
          <div
            style={{
              position: "absolute", left: tx, top: ty, width: tipW,
              background: dk ? "rgba(5,8,15,0.96)" : "rgba(255,255,255,0.98)",
              border: `1px solid ${dk ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)"}`,
              borderRadius: 6, padding: "8px 10px 9px", pointerEvents: "none",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 10,
              borderLeft: `3px solid ${hover.star.color}`,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: dk ? "#e2e8f0" : "#0f172a", lineHeight: 1.3, marginBottom: 4 }}>
              {p["event.name"].length > 60 ? p["event.name"].slice(0, 58) + "…" : p["event.name"]}
            </div>
            <div style={{ display: "flex", gap: 10, fontSize: 10, fontFamily: '"Roboto Mono", "Roboto Mono", "SF Mono", monospace', color: dk ? "#94a3b8" : "#64748b", marginBottom: 4, flexWrap: "wrap" }}>
              {(() => {
                // Grouping (segment / category cell the dot lives in)
                // and Davis category are the same in category mode but
                // differ in segment mode — show both when they differ.
                const groupingLabel = (labelById[hover.star.cluster] || "").replace(/_/g, " ");
                const groupingColor = colorOf(hover.star.cluster);
                const categoryId    = p["event.category"];
                const categoryLabel = getCategoryLabel(categoryId).toUpperCase();
                const categoryColor = hover.star.color; // already the category color
                const sameAsGrouping = groupingLabel.toUpperCase().replace(/[^A-Z]+/g, "")
                                    === categoryLabel.replace(/[^A-Z]+/g, "");
                return (
                  <>
                    <span style={{ color: groupingColor, fontWeight: 700 }}>{groupingLabel}</span>
                    {!sameAsGrouping && (
                      <>
                        <span>·</span>
                        <span style={{ color: categoryColor, fontWeight: 700 }}>{categoryLabel}</span>
                      </>
                    )}
                  </>
                );
              })()}
              <span>·</span>
              <span style={{ color: isActive ? "#ff4d6a" : "#22d3a0", fontWeight: 600 }}>{isActive ? "ACTIVE" : "RESOLVED"}</span>
            </div>
            <div style={{ fontSize: 10, fontFamily: '"Roboto Mono", "Roboto Mono", "SF Mono", monospace', color: dk ? "#94a3b8" : "#64748b" }}>
              {dur} · {entities} {entities === 1 ? "entity" : "entities"} · {p.display_id}
            </div>
          </div>
        );
      })()}
      {/* Bottom legend removed — the RESOLVED zone already shows all 6 categories with color dots. */}
    </div>
  );
};

// Helper: draw a hub circle (used for TOTAL, ACTIVE, RESOLVED — all same size)
function drawSatellite(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
  count: number, label: string,
  color: string, rgb: string, dk: boolean,
  trendDelta: number, risingIsGood: boolean,
  noHalo: boolean = false,
  /** Canvas font multiplier — mirrors the user's font-scale pick
   *  from the Display panel so the TOTAL / ACTIVE / RESOLVED
   *  numbers + labels scale alongside the rest of the app. */
  fsMult: number = 1,
) {
  // Soft halo (skipped when noHalo=true)
  if (!noHalo) {
    ctx.save();
    const halo = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.2);
    halo.addColorStop(0, `rgba(${rgb},0.14)`);
    halo.addColorStop(0.6, `rgba(${rgb},0.04)`);
    halo.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Disc background
  ctx.fillStyle = dk ? "rgba(5,8,15,0.95)" : "rgba(255,255,255,0.97)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // Ring (no shadow glow when noHalo, keeps it crisp)
  ctx.save();
  if (!noHalo) {
    ctx.shadowColor = color;
    ctx.shadowBlur  = 6;
  }
  ctx.strokeStyle = `rgba(${rgb},0.7)`;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Inner accent ring
  ctx.strokeStyle = `rgba(${rgb},0.28)`;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 5, 0, Math.PI * 2);
  ctx.stroke();

  // Label
  ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
  ctx.textAlign    = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle    = dk ? "rgba(148,163,184,0.85)" : "rgba(100,116,139,0.95)";
  ctx.fillText(label, cx, cy - r * 0.48);

  // Number — fits to the circle's interior. With the count-query
  // override active, this can be 5+ digits (e.g. 27548 on a 180d
  // window). The natural size is `r * 0.72`; if the rendered text
  // would overshoot the ring's safe horizontal area, shrink
  // proportionally. `r * 1.55` leaves ~15% margin on each side
  // and keeps the trend indicator below from getting crowded.
  const naturalSize = Math.round(r * 0.72) * fsMult;
  const maxTextWidth = r * 1.55;
  const text = `${count}`;
  ctx.font = `900 ${naturalSize}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
  const measured = ctx.measureText(text).width;
  let numSize = naturalSize;
  if (measured > maxTextWidth) {
    // Scale the font so the rendered width matches the budget.
    // Clamp at 40% of natural to avoid illegible micro-text in
    // pathological inputs (e.g. tens of millions); above that
    // cap we just let it overflow rather than render unreadable.
    numSize = Math.max(naturalSize * 0.4, naturalSize * (maxTextWidth / measured));
    ctx.font = `900 ${numSize}px "Roboto Mono", "Roboto Mono", "SF Mono", monospace`;
  }
  ctx.fillStyle = dk ? "#ffffff" : "#0f172a";
  ctx.fillText(text, cx, cy + 2);

  // Trend indicator below the number
  ctx.font = `500 ${(12 * fsMult).toFixed(2)}px "Roboto Mono", "SF Mono", monospace`;
  if (trendDelta === 0) {
    ctx.fillStyle = dk ? "rgba(148,163,184,0.55)" : "rgba(100,116,139,0.6)";
    ctx.fillText("— neutral", cx, cy + r * 0.55);
  } else {
    const isUp = trendDelta > 0;
    const isGood = isUp ? risingIsGood : !risingIsGood;
    const tColor = isGood ? "#22d3a0" : "#ff4d6a";
    const arrow  = isUp ? "▲" : "▼";
    const text   = `${arrow} ${isUp ? "+" : ""}${trendDelta} /1h`;
    ctx.save();
    ctx.shadowColor = tColor;
    ctx.shadowBlur  = 5;
    ctx.fillStyle   = tColor;
    ctx.fillText(text, cx, cy + r * 0.55);
    ctx.restore();
  }
}

// Memoized export — see PulseVisualizer for the same rationale.
// ConstellationView is by far the heaviest component in the app
// (canvas + RAF + per-render geometry recompute), so memoising
// pays the most here.
export const ConstellationView = React.memo(ConstellationViewImpl);
