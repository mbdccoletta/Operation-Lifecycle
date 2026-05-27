// A Grouping is a bucket the Overview surfaces (constellation, pulse,
// list) organise problems by. The default grouping is the Davis problem
// category (AVAILABILITY, ERROR, …); a future Segments page swaps this
// list for customer-defined segments without any component changes.
import type { Problem } from "../hooks/useProblems";

export interface Grouping {
  /** Stable ID — matches event.category for category-mode, segment.id
   *  for segment-mode. Used as the key in every per-grouping map. */
  id: string;
  /** Display label shown on quadrant headers, resolved zone, table cells. */
  label: string;
  /** Primary hex colour for dots, halos, strip blocks. */
  color: string;
}

/** Default grouping: the six Davis problem categories.
 *
 *  0.0.112 — Harmonised palette. The previous set was 6 fully-
 *  saturated hues (neon pink, hot orange, alert blue, vivid
 *  purple, electric cyan, bright amber) that read as a chaotic
 *  rainbow against the HUD's dark background. User: "nao acho que
 *  as cores estao harmonicas." Each colour is now ~25 % less
 *  saturated, sitting in the same mid-tone band so the cells
 *  share a tonal family while keeping enough hue separation that
 *  they remain identifiable. Constraints preserved:
 *    • no green       (reserved for RESOLVED)
 *    • no red         (reserved for ACTIVE problem ring)
 *    • no yellow      (user excluded outright)
 *    • each hue >40°  apart so dots stay distinguishable. */
export const CATEGORY_GROUPINGS: Grouping[] = [
  { id: "AVAILABILITY",           label: "AVAILABILITY",         color: "#dc7aa3" }, // soft rose
  { id: "ERROR",                  label: "ERROR",                color: "#e89567" }, // coral
  { id: "SLOWDOWN",               label: "SLOWDOWN",             color: "#6fa8d8" }, // steel blue
  { id: "RESOURCE_CONTENTION",    label: "RESOURCE CONTENTION",  color: "#a888d4" }, // lavender
  { id: "CUSTOM_ALERT",           label: "CUSTOM ALERT",         color: "#5fb5c4" }, // soft teal
  { id: "MONITORING_UNAVAILABLE", label: "MONITORING UNAVAIL.",  color: "#cbb46a" }, // sand
];

/** Quick lookup of the Davis-category hex colour by category id. Used
 *  by every surface that wants to colour-code a problem by its
 *  category regardless of the active grouping (e.g. segment-mode dots
 *  still get the category colour so the user can read mix at a glance). */
export const CATEGORY_COLOR_BY_ID: Record<string, string> = Object.fromEntries(
  CATEGORY_GROUPINGS.map((g) => [g.id, g.color]),
);

/** Hex colour for a problem's Davis category, with a neutral fallback
 *  for unrecognised categories. */
export function categoryColorFor(p: Problem): string {
  return CATEGORY_COLOR_BY_ID[p["event.category"]] || "#6ee7b7";
}

/** Resolve which grouping a problem belongs to in category-mode. */
export function resolveByCategory(p: Problem): string | null {
  return p["event.category"] || null;
}

/** Quadrant slot — normalised 0..1 bounds plus the natural centre. */
export interface QuadrantSlot {
  id: string;
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  center: { x: number; y: number };
}

export interface LayoutOptions {
  /** When true (default) the layout reserves a hub band in the middle
   *  of the canvas (y = 0.18 → 0.50) for the TOTAL / ACTIVE / RESOLVED
   *  satellite circles. Quadrants live in the strips above and below.
   *  When false the hub band is dropped and the quadrants expand to
   *  fill the full active area — used by the Segments page where
   *  the hub satellites are removed to make room for more groupings. */
  reserveHubBand?: boolean;
}

/** Build the quadrant layout for the active area of the constellation.
 *  Returns one slot per grouping (up to the layout's capacity).
 *  • `reserveHubBand: true` (default): legacy 2×3 grid with a hub gap.
 *  • `reserveHubBand: false`: dynamic grid (1/2/3 rows × 2/3/4 cols)
 *    that fills the full active area; chosen based on grouping count.
 *    Caps at 12 slots — anything beyond is unrendered. */
export function computeQuadrantLayout(
  groupings: Grouping[],
  opts: LayoutOptions = {},
): QuadrantSlot[] {
  const reserveHubBand = opts.reserveHubBand !== false;

  if (reserveHubBand) {
    // Hard-coded 2×3 grid bounds — preserved from the original
    // ConstellationView so legacy layouts (categories page) are
    // pixel-identical to the pre-refactor rendering.
    const COLS: Array<{ xMin: number; xMax: number; cx: number }> = [
      { xMin: 0.02, xMax: 0.32, cx: 0.17 },
      { xMin: 0.35, xMax: 0.65, cx: 0.50 },
      { xMin: 0.68, xMax: 0.98, cx: 0.83 },
    ];
    // Row bounds — RESOLVED HUD area finalised at 0.76 (24 %).
    // Row midpoint at 0.38 keeps both rows equal at 0.38 cellRect
    // height each. Hub band moves to 0.235-0.545 in
    // ConstellationView to stay clear of both rows.
    const ROWS: Array<{ yMin: number; yMax: number; cy: number }> = [
      { yMin: 0.040, yMax: 0.210, cy: 0.125 },
      { yMin: 0.570, yMax: 0.740, cy: 0.655 },
    ];
    const out: QuadrantSlot[] = [];
    const max = COLS.length * ROWS.length;
    for (let i = 0; i < Math.min(groupings.length, max); i++) {
      const col = COLS[i % COLS.length];
      const row = ROWS[Math.floor(i / COLS.length)];
      out.push({
        id: groupings[i].id,
        bounds: { xMin: col.xMin, xMax: col.xMax, yMin: row.yMin, yMax: row.yMax },
        center: { x: col.cx, y: row.cy },
      });
    }
    return out;
  }

  // Hub-free layout — pick (rows, cols) for the grouping count and fill
  // the full active area. Each row has a thin header strip above the
  // dot region where the quadrant title is drawn.
  //
  // 0.0.109 follow-up — ACTIVE_Y_MAX bumped from 0.68 to 0.95. The
  // 0.68 ceiling was a holdover from the hub-band layout that
  // reserved the bottom 32 % for the RESOLVED HUD panel. In hub-free
  // mode the panel doesn't render, but the cells stayed cramped at
  // the top, leaving a fat empty band underneath (user reported
  // black space when switching modes inside the modal — only ~60 %
  // of canvas was used). 0.95 leaves a small breathing strip at the
  // bottom and lets the modal's single-cell layout fill the canvas
  // edge-to-edge.
  const N = Math.min(groupings.length, 12);
  if (N === 0) return [];
  const grid = pickGridShape(N);
  const ACTIVE_Y_MIN = 0.0;
  const ACTIVE_Y_MAX = 0.95;
  const HEADER_H     = 0.045;
  const ROW_GAP      = 0.018;
  const COL_GAP      = 0.015;
  const X_MARGIN     = 0.02;

  const dotHeight = (ACTIVE_Y_MAX - ACTIVE_Y_MIN
                    - grid.rows * HEADER_H
                    - (grid.rows - 1) * ROW_GAP) / grid.rows;
  const colWidth  = (1 - 2 * X_MARGIN - (grid.cols - 1) * COL_GAP) / grid.cols;

  const out: QuadrantSlot[] = [];
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / grid.cols);
    const c = i % grid.cols;
    const rowYStart = ACTIVE_Y_MIN + r * (HEADER_H + dotHeight + ROW_GAP);
    const yMin = rowYStart + HEADER_H;
    const yMax = yMin + dotHeight;
    const xMin = X_MARGIN + c * (colWidth + COL_GAP);
    const xMax = xMin + colWidth;
    out.push({
      id: groupings[i].id,
      bounds: { xMin, xMax, yMin, yMax },
      center: { x: (xMin + xMax) / 2, y: (yMin + yMax) / 2 },
    });
  }
  return out;
}

/** Pick a (rows, cols) shape for N groupings (1..12) that fills the
 *  active area without ugly empty slots. Wider grids preferred over
 *  taller ones because the canvas is landscape. */
function pickGridShape(n: number): { rows: number; cols: number } {
  if (n <= 2)  return { rows: 1, cols: Math.max(1, n) };
  if (n === 3) return { rows: 1, cols: 3 };
  if (n === 4) return { rows: 2, cols: 2 };
  if (n <= 6)  return { rows: 2, cols: 3 };
  if (n <= 9)  return { rows: 3, cols: 3 };
  return { rows: 3, cols: 4 };
}

/** Hex "#a3e635" → "163,230,53" tuple for canvas rgba() blending. */
export function hexToRgb(hex: string, fallback = "180,210,255"): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return fallback;
  return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
}

/** Curated palette for auto-assigned segment colours. Picked to:
 *  • avoid all reds — red is reserved across the app to signal ACTIVE
 *    state (bar chart, status badges, severity), so a segment in red
 *    would be confusing.
 *  • stay distinct from the six Davis category hues used for dot
 *    colours so a segment quadrant accent never collides with the
 *    dots inside it.
 *  • ORDERED for maximum perceptual contrast between CONSECUTIVE
 *    indices. The hash function maps similar segment names to nearby
 *    buckets, so neighbouring entries need very different hues to keep
 *    quadrants distinguishable when collisions happen. Each entry
 *    jumps the hue wheel by 100°+ from its predecessor whenever
 *    possible. 13 entries → low chance of duplicate-hue collisions in
 *    typical tenants with <15 segments. */
const SEGMENT_PALETTE: string[] = [
  "#14b8a6", // 0  teal
  "#ec4899", // 1  hot pink
  "#3b82f6", // 2  pure blue
  "#facc15", // 3  yellow
  "#6366f1", // 4  indigo
  "#22c55e", // 5  green
  "#d946ef", // 6  fuchsia
  "#10b981", // 7  emerald
  "#a78bfa", // 8  light violet
  "#22d3ee", // 9  bright cyan
  "#f472b6", // 10 soft pink
  "#38bdf8", // 11 sky
  "#fde047", // 12 pale yellow
];

/** Deterministic name → hex colour drawn from a curated, red-free
 *  palette. The same name always maps to the same swatch across
 *  sessions so users build muscle memory for "the cyan one is
 *  Payments". */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return SEGMENT_PALETTE[Math.abs(h) % SEGMENT_PALETTE.length];
}

/** Implicit bucket for problems that don't belong to any segment in the
 *  current grouping list (either no segments match, or every match is
 *  outside the top-N rendered on screen). Always rendered last. */
export const UNASSIGNED_GROUPING: Grouping = {
  id:    "__UNASSIGNED__",
  label: "UNASSIGNED",
  color: "#94a3b8",
};

/** Shape we need from a filter segment to build a Grouping. Kept loose
 *  so callers can pass `LeanFilterSegment`, `DetailedFilterSegment`, or
 *  a hand-built object without coupling this module to the SDK types. */
export interface SegmentLike {
  uid:  string;
  name: string;
}

/** Convert a list of filter segments to Grouping[] with auto-assigned
 *  colours. Order is preserved — call sites are expected to sort by
 *  active-problem count beforehand if they want top-N behaviour. */
export function segmentsToGroupings(segments: SegmentLike[]): Grouping[] {
  return segments.map((s) => ({
    id:    s.uid,
    label: s.name,
    color: colorForName(s.name),
  }));
}

/** Build a `resolveGrouping` function for the Segments-grouped view.
 *  - `membership`: from useSegmentMembership — display_id → segment UIDs
 *  - `allowedIds`: optional filter (typically the top-N segment UIDs);
 *    a match outside this set is treated as unassigned so the dot lands
 *    in the unassigned bucket rather than a quadrant that isn't drawn.
 *  Returns `null` for unassigned. Wrap in `|| UNASSIGNED_GROUPING.id`
 *  at the call site if you want unassigned problems bucketed instead
 *  of dropped. */
export function resolveBySegmentMembership(
  membership: Map<string, Set<string>>,
  allowedIds?: Set<string>,
): (problem: Problem) => string | null {
  return (p: Problem) => {
    const segs = membership.get(p.display_id);
    if (!segs || segs.size === 0) return null;
    if (allowedIds) {
      for (const id of segs) if (allowedIds.has(id)) return id;
      return null;
    }
    return segs.values().next().value || null;
  };
}

/** Width of the header strip above each slot's dot region, in
 *  normalised canvas units. Matches the HEADER_H used by the hub-free
 *  layout in computeQuadrantLayout. */
const LABEL_STRIP_HEIGHT_N = 0.045;
/** A small generosity margin around each slot's bounds so the rim
 *  between two quadrants stays clickable. Normalised. */
const SLOT_MARGIN_N = 0.008;

/** Detect which grouping's quadrant cell a normalised (xN, yN) point
 *  lands in. Returns null when the point is outside every slot. The
 *  layout argument should be the same array used to draw the
 *  quadrants — usually computeQuadrantLayout(groupings, opts). */
export function detectQuadrantAt(
  xN: number, yN: number, layout: QuadrantSlot[],
): string | null {
  for (const slot of layout) {
    const b = slot.bounds;
    if (xN >= b.xMin - SLOT_MARGIN_N &&
        xN <  b.xMax + SLOT_MARGIN_N &&
        yN >= b.yMin - SLOT_MARGIN_N &&
        yN <  b.yMax + SLOT_MARGIN_N) {
      return slot.id;
    }
  }
  return null;
}

/** Detect the header-strip band above each slot (clicking the strip
 *  drills into the filtered list). The strip occupies the area
 *  immediately above each slot's dot region. */
export function detectLabelAt(
  xN: number, yN: number, layout: QuadrantSlot[],
): string | null {
  for (const slot of layout) {
    const b = slot.bounds;
    const stripYMin = Math.max(0, b.yMin - LABEL_STRIP_HEIGHT_N);
    const stripYMax = b.yMin;
    if (yN >= stripYMin && yN < stripYMax &&
        xN >= b.xMin - SLOT_MARGIN_N &&
        xN <  b.xMax + SLOT_MARGIN_N) {
      return slot.id;
    }
  }
  return null;
}
