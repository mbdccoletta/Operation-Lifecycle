// Team reliability metrics card. 4 KPIs up top, then a single
// evolution chart that overlays the average curve for each of the
// four metrics (MTTA, MTTR, MTBF, MTTF) so they can be compared at
// a glance. All series share bucket alignment (see useTeamMetrics)
// so the X-axis is consistent across lines.

import React, { useMemo, useRef, useState } from "react";
import { Tooltip } from "@dynatrace/strato-components-preview/overlays";
import type { Problem } from "../../hooks/useProblems";
import { useDevice } from "../../hooks/useDevice";
import {
  useTeamMetrics,
  PerMetricStats,
  BucketStat,
  UseTeamMetricsResult,
} from "../../hooks/useTeamMetrics";

type MetricKey = "mtta" | "mttr" | "mtbf" | "mttf";

interface MetricDef {
  key: MetricKey;
  label: string;
  description: string;
  sub: string;
  color: string;
  /** Mathematical definition of the metric, rendered inside the
   *  explanation tooltip. Plain language so non-SRE viewers still
   *  understand it. */
  formula: string;
  /** Plain-language rationale — what the value tells you about
   *  team performance, and how to interpret a high vs. low number.
   *  Reference: https://www.atlassian.com/incident-management/kpis/common-metrics */
  rationale: string;
  /** Which problems contribute to the metric. Surfaced so users
   *  understand why `n` differs across the four KPIs. */
  contributors: string;
}
const METRIC_DEFS: MetricDef[] = [
  {
    key: "mtta",
    label: "MTTA",
    description: "Mean Time To Acknowledge",
    sub: "open → first comment",
    color: "#818CF8",
    formula: "MTTA = avg(firstComment.timestamp − event.start)",
    rationale:
      "Quanto tempo a equipe leva para reagir a um problema. Valores baixos indicam alta vigilância; valores altos sugerem alertas perdidos, ruído ou processo lento de triagem.",
    contributors:
      "Cada problema que recebeu pelo menos um comentário humano (annotation.source = \"Problems App\") contribui com um valor.",
  },
  {
    key: "mttr",
    label: "MTTR",
    description: "Mean Time To Resolve",
    sub: "open → close",
    color: "#FB923C",
    formula: "MTTR = avg(event.end − event.start)",
    rationale:
      "Quanto tempo a equipe leva para resolver um problema do início ao fim. Quedas no MTTR indicam runbooks melhores, automação eficaz ou conhecimento institucional acumulado.",
    contributors:
      "Apenas problemas com status CLOSED (event.end populado) entram no cálculo. ACTIVE não tem MTTR ainda definido.",
  },
  {
    key: "mtbf",
    label: "MTBF",
    description: "Mean Time Between Failures",
    sub: "interval between starts",
    color: "#34D399",
    formula: "MTBF = avg(start[i] − start[i−1])",
    rationale:
      "Intervalo médio entre o início de problemas consecutivos. Mede a cadência de falhas do tenant; inclui o downtime de cada incidente. MTBF baixo = sistema instável.",
    contributors:
      "Cada problema, exceto o primeiro da janela (que não tem predecessor), contribui com a diferença entre seu event.start e o do problema anterior.",
  },
  {
    key: "mttf",
    label: "MTTF",
    description: "Mean Time To Failure (uptime)",
    sub: "previous close → next open",
    color: "#22D3EE",
    formula: "MTTF = avg(start[next] − end[prev_closed])",
    rationale:
      "Tempo em que o sistema permaneceu saudável entre o fim de um problema e o início do próximo. Identidade clássica: MTBF ≈ MTTR + MTTF.",
    contributors:
      "Cada problema que tem um predecessor CLOSED contribui. Problemas que abriram enquanto outro ainda estava ACTIVE são ignorados (não há uptime real para medir).",
  },
];

// ── Chart geometry ────────────────────────────────────────────────
interface ChartDims {
  w: number; h: number;
  padL: number; padR: number; padT: number; padB: number;
}
const DIMS: ChartDims = { w: 880, h: 130, padL: 56, padR: 14, padT: 8, padB: 22 };
const BAR_FLOOR_MS = 60_000;
const Y_TICKS_MS: Array<{ ms: number; label: string }> = [
  { ms: 60_000,                label: "1 m" },
  { ms: 5 * 60_000,            label: "5 m" },
  { ms: 15 * 60_000,           label: "15 m" },
  { ms: 60 * 60_000,           label: "1 h" },
  { ms: 4 * 60 * 60_000,       label: "4 h" },
  { ms: 24 * 60 * 60_000,      label: "1 d" },
  { ms: 7 * 24 * 60 * 60_000,  label: "7 d" },
  { ms: 30 * 24 * 60 * 60_000, label: "30 d" },
];

// `fmtMs` is the canonical alias used throughout this file — it maps
// directly to `formatDurationMs` in utils/formatters.ts. Keeping the
// local name makes the per-call sites compact (the formula in this
// file is dense with `fmtMs(...)` chains).
import { formatDurationMs as fmtMs } from "../../utils/formatters";

function xScale(ms: number, minMs: number, maxMs: number): number {
  if (maxMs <= minMs) return DIMS.padL + (DIMS.w - DIMS.padL - DIMS.padR) / 2;
  const t = (ms - minMs) / (maxMs - minMs);
  return DIMS.padL + t * (DIMS.w - DIMS.padL - DIMS.padR);
}
function yScale(ms: number, maxMs: number): number {
  const clamped = Math.max(BAR_FLOOR_MS, ms);
  const top = Math.max(maxMs, BAR_FLOOR_MS * 60);
  const t = (Math.log(clamped) - Math.log(BAR_FLOOR_MS)) / (Math.log(top) - Math.log(BAR_FLOOR_MS));
  const innerH = DIMS.h - DIMS.padT - DIMS.padB;
  return DIMS.padT + (1 - t) * innerH;
}

interface HoverState { bucketIdx: number; x: number; }

interface Props {
  /** Problems list — used only for the empty-state branch when no
   *  pre-computed `metrics` are supplied. The page should normally
   *  pass `metrics` to avoid running `useTeamMetrics` twice (the
   *  hook fires a 10k-row DQL each invocation). */
  problems: Problem[];
  /** Pre-computed metrics from the parent page. When provided, the
   *  card uses them directly and skips its own `useTeamMetrics`
   *  call. This is the recommended path — see C1 in the perf
   *  audit (duplicate DQL fan-out). */
  teamMetrics?: UseTeamMetricsResult;
  /** Forwarded to `useTeamMetrics` ONLY when `teamMetrics` isn't
   *  supplied — legacy callers that still want the card to manage
   *  its own data source can pass the sim map here. */
  simulatedFirstComments?: Map<string, string> | null;
  /** Optional drilldown — click a bucket to see the problems that
   *  contributed to that point. Host receives the bucket's [start,
   *  end] window in ms and is expected to navigate / filter the
   *  list accordingly. When omitted, the chart stays read-only. */
  onBucketClick?: (startMs: number, endMs: number) => void;
  /** Optional drilldown — click one of the four metric lines.
   *  Host receives the metric key PLUS the [start, end] window of
   *  the bucket the cursor was over when the click fired (derived
   *  from the live `hover` state). Lets the host filter to
   *  "problems that contributed to THIS line's value at THIS
   *  point in time" instead of the broader "any problem with this
   *  metric defined anywhere". When the cursor isn't over a
   *  specific bucket the window args are `null` and the host can
   *  decide the fallback (typically: filter the whole timeframe). */
  onMetricClick?: (
    metric: "mtta" | "mttr" | "mtbf" | "mttf",
    bucketStartMs: number | null,
    bucketEndMs: number | null,
  ) => void;
  /** Brush-to-zoom — host receives the [from, to] window the user
   *  dragged on the chart. Typically wired to `handleRangeSelect`
   *  so the page-level timeframe narrows, useTeamMetrics re-runs
   *  with finer bucket sizing, and overlapping dots fan out. When
   *  omitted, drag is a no-op and the chart stays click-only. */
  onZoomRangeSelect?: (fromMs: number, toMs: number) => void;
  /** Whether the host is currently in a "zoomed" state (i.e. a
   *  user-selected range is active). Drives the reset-zoom button
   *  visibility inside the card. */
  zoomed?: boolean;
  /** Reset handler — clears whatever range the host is using to
   *  narrow the chart. Usually `clearRange` from useTimeRange. */
  onResetZoom?: () => void;
  /** Optional drilldown — click a whole KPI card (the value /
   *  sub / meta area, not the label text used for highlight) to
   *  navigate into the underlying problems. Host receives the
   *  metric key and decides where to send the user (typically
   *  the Incidents list filtered to "has metric"). When omitted,
   *  the card stays static and the value area is a plain div. */
  onCardDrillDown?: (metric: "mtta" | "mttr" | "mtbf" | "mttf") => void;
}

export const TeamMetricsCard: React.FC<Props> = ({
  problems,
  teamMetrics,
  simulatedFirstComments,
  onBucketClick,
  onMetricClick,
  onZoomRangeSelect,
  zoomed,
  onResetZoom,
  onCardDrillDown,
}) => {
  // Only call the heavy hook when the parent didn't already feed
  // us pre-computed metrics. React rules of hooks require an
  // unconditional call — short-circuit with empty inputs when
  // `teamMetrics` is provided so the hook is cheap (still runs,
  // but operates on empty arrays and skips the DQL via the sim
  // map shortcut).
  const ownMetrics = useTeamMetrics(
    teamMetrics ? [] : problems,
    { simulatedFirstComments: teamMetrics ? new Map() : simulatedFirstComments },
  );
  const m = teamMetrics ?? ownMetrics;
  const { isMobileOrTablet } = useDevice();
  const [highlight, setHighlight] = useState<MetricKey | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  /** Which SPECIFIC dot (metric × bucket) the cursor is over.
   *  Distinct from `hover` (which tracks the bucket guide-line) and
   *  `highlight` (which is the sticky legend-toggle). Used to surface
   *  visual confirmation that the user is mirroring an exact
   *  datapoint — halo ring on the dot + matching tooltip row
   *  brightened — so picking among clustered MTTA/MTTR/MTBF dots
   *  feels precise instead of guesswork. */
  const [hoveredDot, setHoveredDot] = useState<{ metric: MetricKey; bucketIdx: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // ── Brush-to-zoom ────────────────────────────────────────────────
  // `brush` tracks the active mouse-drag selection in SVG viewBox
  // coordinates so the highlight band scales correctly even when
  // the SVG is responsively stretched. `dragMoved` guards click
  // handlers: a real click is a mousedown+mouseup pair with no
  // movement; once the cursor has crossed the threshold we suppress
  // the click and treat the gesture as a zoom selection.
  const [brush, setBrush] = useState<{ startX: number; endX: number } | null>(null);
  const dragMoved = useRef(false);
  const DRAG_THRESHOLD_PX = 4;
  /** Convert a clientX from a mouse event into SVG viewBox X coords
   *  — the SVG uses preserveAspectRatio="none" so width can stretch
   *  independently from the viewBox; ratio-correcting here keeps the
   *  brush rect aligned to the visible mouse position. */
  const clientXToViewBox = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return 0;
    const t = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(DIMS.w, t * DIMS.w));
  };

  const metrics: Record<MetricKey, PerMetricStats> = {
    mtta: m.mtta, mttr: m.mttr, mtbf: m.mtbf, mttf: m.mttf,
  };

  // All four series share the same bucket alignment by construction
  // (useTeamMetrics enforces it). Take any one's structure as the
  // canonical X-axis — use the longest non-empty one defensively in
  // case the first metric has no data.
  const canonicalSeries = useMemo<BucketStat[]>(() => {
    const longest = [m.mtta.series, m.mttr.series, m.mtbf.series, m.mttf.series]
      .reduce((a, b) => (a.length >= b.length ? a : b), [] as BucketStat[]);
    return longest;
  }, [m.mtta.series, m.mttr.series, m.mtbf.series, m.mttf.series]);
  const hasData = canonicalSeries.length > 0
    && (m.mtta.count + m.mttr.count + m.mtbf.count + m.mttf.count) > 0;

  // Bounds across ALL series so every line fits on the same canvas.
  const minX = hasData ? canonicalSeries[0].startMs : 0;
  const bucketMs = canonicalSeries.length > 1
    ? canonicalSeries[1].startMs - canonicalSeries[0].startMs
    : 24 * 60 * 60_000;
  const maxX = hasData ? canonicalSeries[canonicalSeries.length - 1].startMs + bucketMs : 0;
  const maxY = useMemo(() => {
    let top = BAR_FLOOR_MS * 60;
    for (const k of ["mtta", "mttr", "mtbf", "mttf"] as MetricKey[]) {
      for (const b of metrics[k].series) {
        if (b.count > 0 && b.avgMs > top) top = b.avgMs;
      }
    }
    return top;
  }, [metrics]);
  /** Build a polyline `d` for one metric — connects every non-empty
   *  bucket with a straight line, bridging across empty ones. We
   *  intentionally drop the "break the line at gaps" behaviour
   *  because sparse metrics like MTTA (driven by first-comment data)
   *  often only have a handful of non-empty buckets, and with gaps
   *  they degenerate into a single `M` per point — which SVG renders
   *  as nothing, so the legend showed a colour with no line.
   *
   *  `xJitter` is the per-metric horizontal offset (see the jitter
   *  block down where the dots are drawn). Lines and dots share the
   *  same offset so dots always sit precisely on their own line —
   *  the line just appears uniformly shifted by a few pixels per
   *  metric, which the eye reads as "MTTR is slightly to the right
   *  of MTTA at every bucket" instead of "the line is wrong". */
  const pathForMetric = (key: MetricKey, xJitter = 0): string => {
    const segs: string[] = [];
    let isFirst = true;
    for (const b of metrics[key].series) {
      if (b.count === 0) continue;
      const cx = xScale(b.startMs + bucketMs / 2, minX, maxX) + xJitter;
      const cy = yScale(b.avgMs, maxY);
      segs.push((isFirst ? "M" : "L") + cx + "," + cy);
      isFirst = false;
    }
    return segs.join(" ");
  };

  const xTickCount = 4;
  const xTicks = hasData
    ? Array.from({ length: xTickCount }, (_, i) => {
        const t = i / (xTickCount - 1);
        const ms = minX + t * (maxX - minX);
        return {
          x: xScale(ms, minX, maxX),
          label: new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        };
      })
    : [];
  const yTicks = Y_TICKS_MS.filter((t) => t.ms <= maxY * 1.05);

  return (
    <div className="neo-mtta">
      {/* KPI strip — clicking a card highlights its line in the
          chart (dimming the others); clicking the same card again
          clears the highlight. The (?) badge inside each label
          opens an explanation popover on hover. */}
      <div className="neo-team-kpis">
        {METRIC_DEFS.map((d) => {
          const s = metrics[d.key];
          const isHighlighted = highlight === d.key;
          return (
            <div
              key={d.key}
              className={`neo-team-kpi${isHighlighted ? " neo-team-kpi-active" : ""}`}
              // Per-card accent injected as a CSS var so the corner
              // brackets + pulse dot + active ring all pick up the
              // metric's signature colour. Mirrors the contract used
              // by `.neo-kpi-card` (AT A GLANCE strip).
              style={{ ["--neo-kpi-accent" as string]: d.color }}
            >
              <div className="neo-team-kpi-labelrow">
                {/* Click-target for the highlight toggle. Kept narrow
                    so the (?) badge has its own hover surface. */}
                <button
                  type="button"
                  className="neo-team-kpi-label-btn"
                  style={{ color: d.color }}
                  onClick={() => setHighlight((cur) => (cur === d.key ? null : d.key))}
                  title={isHighlighted ? "Click to clear highlight" : `Click to highlight ${d.label} in the chart`}
                >
                  {d.label}
                </button>
                <Tooltip
                  placement="bottom-start"
                  fallbackPlacements={["bottom-end", "top-start", "top-end"]}
                  text={
                    <div className="neo-team-kpi-info-tip-body">
                      <strong className="neo-team-kpi-info-title" style={{ color: d.color }}>
                        {d.label} · {d.description}
                      </strong>
                      <code className="neo-team-kpi-info-formula">{d.formula}</code>
                      <span className="neo-team-kpi-info-section">
                        <em>O que significa</em>
                        <span>{d.rationale}</span>
                      </span>
                      <span className="neo-team-kpi-info-section">
                        <em>Quais problemas contribuem</em>
                        <span>{d.contributors}</span>
                      </span>
                      <span className="neo-team-kpi-info-section">
                        <em>Como é agregado</em>
                        <span>
                          Avg = média aritmética. p50 = mediana. p95 = percentil 95
                          (sob esse valor estão 95% dos casos). n = quantidade de
                          amostras na janela atual.
                        </span>
                      </span>
                    </div>
                  }
                >
                  <span className="neo-team-kpi-info" tabIndex={0} aria-label={`How is ${d.label} calculated`}>
                    ?
                  </span>
                </Tooltip>
              </div>
              {/* Drilldown surface — value / sub / meta as a button
                  when the host wires `onCardDrillDown`. Disabled when
                  there are no samples (n=0) since drilling into an
                  empty set is dead-end UX. The label button above
                  still toggles chart highlight independently. */}
              {onCardDrillDown ? (
                <button
                  type="button"
                  className="neo-team-kpi-drill"
                  onClick={() => onCardDrillDown(d.key)}
                  disabled={s.count === 0}
                  title={s.count > 0
                    ? `See the ${s.count} ${s.count === 1 ? "problem" : "problems"} contributing to ${d.label}`
                    : `No problems contributing to ${d.label} in this window`
                  }
                >
                  <div className="neo-team-kpi-value">{fmtMs(s.avgMs)}</div>
                  <div className="neo-team-kpi-sub">{d.sub}</div>
                  <div className="neo-team-kpi-meta">
                    {s.count > 0
                      ? `n=${s.count} · p50 ${fmtMs(s.medianMs)} · p95 ${fmtMs(s.p95Ms)}`
                      : "no samples"}
                  </div>
                  {s.count > 0 && (
                    <span className="neo-team-kpi-cta" aria-hidden="true">→</span>
                  )}
                </button>
              ) : (
                <>
                  <div className="neo-team-kpi-value">{fmtMs(s.avgMs)}</div>
                  <div className="neo-team-kpi-sub">{d.sub}</div>
                  <div className="neo-team-kpi-meta">
                    {s.count > 0
                      ? `n=${s.count} · p50 ${fmtMs(s.medianMs)} · p95 ${fmtMs(s.p95Ms)}`
                      : "no samples"}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {m.loading && (
        <div className="neo-analytics-empty">Loading comments stream…</div>
      )}
      {m.error && (
        <div className="neo-analytics-empty">
          Couldn't load metrics · {m.error.message || "DQL query failed."}
        </div>
      )}
      {!m.loading && !m.error && m.totalProblems === 0 && (
        <div className="neo-analytics-empty">
          No problems in the selected timeframe. Widen the window via the timeframe
          picker, or pick an MTTA scenario from the Debug panel.
        </div>
      )}

      {!m.loading && !m.error && m.totalProblems > 0 && (
        /* Hover is cleared on the WRAP, not the SVG, so the cursor
           can move from a chart dot onto the tooltip rows (rendered
           as a sibling HTML node, not inside the SVG) without the
           tooltip vanishing mid-trajectory. This is what makes the
           per-row drilldown clickable when the metric lines overlap
           and the user can't pick one directly from the chart. */
        <div
          className="neo-mtta-chart-wrap"
          ref={wrapRef}
          onMouseLeave={() => { setHover(null); setHoveredDot(null); }}
        >

          {/* Legend = chart key. Clicking a legend item also toggles
              the matching highlight, so users discover the
              interaction from two surfaces. The trailing
              `neo-mtta-zoom-controls` block holds the drag-to-zoom
              affordance: a quiet hint when no zoom is active, plus
              a "Reset zoom" button while zoomed. */}
          <div className="neo-mtta-chart-legend">
            {METRIC_DEFS.map((d) => (
              <button
                key={d.key}
                type="button"
                className={`neo-team-legend-item${highlight === d.key ? " neo-team-legend-item-active" : ""}`}
                onClick={() => setHighlight((cur) => (cur === d.key ? null : d.key))}
                title={d.description}
              >
                <span className="neo-mtta-legend-swatch" style={{ background: d.color }} />
                <span>{d.label}</span>
              </button>
            ))}
            {onZoomRangeSelect && (
              <div className="neo-mtta-zoom-controls">
                {zoomed && onResetZoom ? (
                  <button
                    type="button"
                    className="neo-mtta-zoom-reset"
                    onClick={onResetZoom}
                    title="Reset the chart back to the full timeframe"
                  >
                    ⤺ Reset zoom
                  </button>
                ) : isMobileOrTablet ? (
                  /* Mobile / tablet: drag-to-zoom is awkward on touch
                     (especially with the existing tooltip layer); we
                     swap the hint for a row of preset-duration chips
                     that anchor on `now()`. Tap a chip → zoom into
                     that window via the same `onZoomRangeSelect`
                     callback the brush uses. */
                  <div className="neo-mtta-zoom-presets" role="group" aria-label="Zoom presets">
                    {[
                      { label: "6 h",  ms: 6 * 60 * 60_000 },
                      { label: "24 h", ms: 24 * 60 * 60_000 },
                      { label: "3 d",  ms: 3 * 24 * 60 * 60_000 },
                      { label: "7 d",  ms: 7 * 24 * 60 * 60_000 },
                    ].map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className="neo-mtta-zoom-preset"
                        onClick={() => {
                          const now = Date.now();
                          onZoomRangeSelect(now - p.ms, now);
                        }}
                        title={`Zoom into the last ${p.label}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="neo-mtta-zoom-hint" aria-hidden="true">
                    Drag on the chart to zoom in →
                  </span>
                )}
              </div>
            )}
          </div>

          {hasData ? (
            <svg
              ref={svgRef}
              className={`neo-mtta-chart${brush ? " neo-mtta-chart-brushing" : ""}`}
              viewBox={`0 0 ${DIMS.w} ${DIMS.h}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Evolution of MTTA, MTTR, MTBF and MTTF over time"
              /* Brush-to-zoom handlers. mousedown arms a potential
                 selection (recorded but not visible yet); mousemove
                 promotes it to a real drag once we cross the
                 movement threshold and starts rendering the band;
                 mouseup converts the band's [startX, endX] to a time
                 window and fires `onZoomRangeSelect`. Click handlers
                 on dots / rects check `dragMoved.current` to know
                 whether to fire (no = real click, yes = swallowed). */
              onMouseDown={(e) => {
                if (!onZoomRangeSelect || e.button !== 0) return;
                const x = clientXToViewBox(e.clientX);
                // Ignore clicks outside the plot area (axis labels)
                if (x < DIMS.padL || x > DIMS.w - DIMS.padR) return;
                dragMoved.current = false;
                setBrush({ startX: x, endX: x });
              }}
              onMouseMove={(e) => {
                if (!brush) return;
                const x = clientXToViewBox(e.clientX);
                const clampedX = Math.max(DIMS.padL, Math.min(DIMS.w - DIMS.padR, x));
                if (Math.abs(clampedX - brush.startX) > DRAG_THRESHOLD_PX) {
                  dragMoved.current = true;
                }
                setBrush({ startX: brush.startX, endX: clampedX });
              }}
              onMouseUp={() => {
                if (!brush) return;
                const moved = dragMoved.current;
                const { startX, endX } = brush;
                setBrush(null);
                if (!moved || !onZoomRangeSelect) return;
                // Invert xScale: bucket-center x → ms.
                const innerW = DIMS.w - DIMS.padL - DIMS.padR;
                const xToMs = (x: number) => {
                  const t = (x - DIMS.padL) / innerW;
                  return minX + t * (maxX - minX);
                };
                const a = xToMs(Math.min(startX, endX));
                const b = xToMs(Math.max(startX, endX));
                // Require at least one bucket worth of span; otherwise
                // a frustrated tiny drag would zoom to a useless slice.
                if (b - a < bucketMs / 4) return;
                onZoomRangeSelect(a, b);
              }}
              onMouseLeave={() => {
                // Abort an in-progress brush if the cursor leaves the
                // SVG without releasing. Don't clear `dragMoved` here —
                // we still want the next click suppression for the
                // current gesture. It resets on the next mousedown.
                if (brush) setBrush(null);
              }}
              /* Touch counterparts of the brush handlers. Mirror the
                 mouse logic so tablets / phones can zoom into a window
                 by drag-selecting. preventDefault on touchstart only
                 when the touch lands inside the plot area AND zoom is
                 wired — otherwise random taps anywhere on the chart
                 would block native page-scroll, frustrating users who
                 just want to scroll past. The mouseclick on dots /
                 rects fires naturally on tap via the browser's
                 touch→click synthesis; dragMoved still gates them so
                 a real drag-to-zoom doesn't accidentally drill. */
              onTouchStart={(e) => {
                if (!onZoomRangeSelect) return;
                const t = e.touches[0];
                if (!t) return;
                const x = clientXToViewBox(t.clientX);
                if (x < DIMS.padL || x > DIMS.w - DIMS.padR) return;
                e.preventDefault(); // claim the gesture
                dragMoved.current = false;
                setBrush({ startX: x, endX: x });
              }}
              onTouchMove={(e) => {
                if (!brush) return;
                const t = e.touches[0];
                if (!t) return;
                const x = clientXToViewBox(t.clientX);
                const clampedX = Math.max(DIMS.padL, Math.min(DIMS.w - DIMS.padR, x));
                if (Math.abs(clampedX - brush.startX) > DRAG_THRESHOLD_PX) {
                  dragMoved.current = true;
                  // Once we've crossed the drag threshold we know the
                  // gesture is a brush, not a tap — block scroll so
                  // the user can keep dragging without the page
                  // jumping under their finger.
                  e.preventDefault();
                }
                setBrush({ startX: brush.startX, endX: clampedX });
              }}
              onTouchEnd={() => {
                if (!brush) return;
                const moved = dragMoved.current;
                const { startX, endX } = brush;
                setBrush(null);
                if (!moved || !onZoomRangeSelect) return;
                const innerW = DIMS.w - DIMS.padL - DIMS.padR;
                const xToMs = (x: number) => {
                  const t = (x - DIMS.padL) / innerW;
                  return minX + t * (maxX - minX);
                };
                const a = xToMs(Math.min(startX, endX));
                const b = xToMs(Math.max(startX, endX));
                if (b - a < bucketMs / 4) return;
                onZoomRangeSelect(a, b);
              }}
              onTouchCancel={() => {
                if (brush) setBrush(null);
              }}
            >
              {/* Y grid + ticks. */}
              {yTicks.map((t) => {
                const y = yScale(t.ms, maxY);
                return (
                  <g key={t.ms}>
                    <line x1={DIMS.padL} x2={DIMS.w - DIMS.padR} y1={y} y2={y} className="neo-mtta-grid" />
                    <text x={DIMS.padL - 8} y={y + 3} className="neo-mtta-tick neo-mtta-tick-y">{t.label}</text>
                  </g>
                );
              })}
              {xTicks.map((t, i) => (
                <text key={i} x={t.x} y={DIMS.h - DIMS.padB + 14} className="neo-mtta-tick">{t.label}</text>
              ))}

              <line x1={DIMS.padL} x2={DIMS.padL} y1={DIMS.padT} y2={DIMS.h - DIMS.padB}
                    className="neo-mtta-axis" />
              <line x1={DIMS.padL} x2={DIMS.w - DIMS.padR} y1={DIMS.h - DIMS.padB} y2={DIMS.h - DIMS.padB}
                    className="neo-mtta-axis" />

              {/* Brush band — visible only while the user is
                  dragging. Translucent accent fill marks the
                  selected window; the edges get a hairline so the
                  exact zoom bounds are perceivable even with a
                  very faint fill. pointer-events:none so the band
                  itself doesn't block the dot click-throughs (the
                  click suppression is handled via dragMoved). */}
              {brush && dragMoved.current && (() => {
                const left = Math.min(brush.startX, brush.endX);
                const right = Math.max(brush.startX, brush.endX);
                return (
                  <g pointerEvents="none">
                    <rect
                      x={left}
                      y={DIMS.padT}
                      width={Math.max(0, right - left)}
                      height={DIMS.h - DIMS.padT - DIMS.padB}
                      className="neo-mtta-brush-band"
                    />
                    <line x1={left}  x2={left}  y1={DIMS.padT} y2={DIMS.h - DIMS.padB} className="neo-mtta-brush-edge" />
                    <line x1={right} x2={right} y1={DIMS.padT} y2={DIMS.h - DIMS.padB} className="neo-mtta-brush-edge" />
                  </g>
                );
              })()}

              {/* Hover vertical guide. */}
              {hover && (() => {
                const b = canonicalSeries[hover.bucketIdx];
                if (!b) return null;
                const x = xScale(b.startMs + bucketMs / 2, minX, maxX);
                return (
                  <line
                    x1={x} x2={x}
                    y1={DIMS.padT} y2={DIMS.h - DIMS.padB}
                    className="neo-team-guide"
                  />
                );
              })()}

              {/* LAYER ORDER (SVG paints later-on-top, hit-tests
                  top-first): bucket rects FIRST so they're the
                  bottom layer — they own hover and bucket drilldown,
                  but DON'T eat metric-line / dot clicks. Previously
                  these rects were drawn LAST and intercepted every
                  click, which is why the URL after drilldown only
                  ever had `range_from/range_to` and never `metric=`:
                  the per-metric line clicks were buried under the
                  bucket hit-area. */}
              {canonicalSeries.map((b, idx) => {
                const cx = xScale(b.startMs + bucketMs / 2, minX, maxX);
                const w = (DIMS.w - DIMS.padL - DIMS.padR) / Math.max(1, canonicalSeries.length);
                const clickable = !!onBucketClick && b.count > 0;
                return (
                  /* No native <title> on the rect — the OS-level
                     tooltip rendered ON TOP of the custom hover
                     popup and blocked the click target. Pointer
                     cursor + the inline CTA footer in the custom
                     tooltip cover discoverability without overlap. */
                  <rect
                    key={`hit-${b.startMs}`}
                    x={cx - w / 2}
                    y={DIMS.padT}
                    width={w}
                    height={DIMS.h - DIMS.padT - DIMS.padB}
                    fill="transparent"
                    style={{ cursor: clickable ? (brush ? "ew-resize" : "pointer") : (onZoomRangeSelect ? "ew-resize" : "default") }}
                    onMouseEnter={() => setHover({ bucketIdx: idx, x: cx })}
                    /* Touch parity: tap reveals the bucket tooltip
                       same as a desktop hover would. The synthetic
                       click that follows a tap fires onClick → drills
                       (if `dragMoved` is false). */
                    onTouchStart={() => setHover({ bucketIdx: idx, x: cx })}
                    /* `dragMoved` is true after a brush drag crossed
                       the threshold — suppress the click in that case
                       so the gesture is interpreted as zoom-only. */
                    onClick={clickable ? () => { if (!dragMoved.current) onBucketClick!(b.startMs, b.startMs + bucketMs); } : undefined}
                  />
                );
              })}

              {/* Four overlaid metric lines. Wider invisible stroke
                  is the hit-area for line clicks; the visible thin
                  stroke has `pointer-events: none` so it never
                  intercepts events. With the bucket rects now BELOW
                  these paths, clicking anywhere along a line fires
                  the per-metric drilldown, not the bucket one.

                  Each metric's line is shifted by the SAME jitter
                  offset as its dots (computed below in the dot
                  block) so the dot sits exactly on its line. The
                  visual effect is four nearly-parallel curves
                  stepping through each bucket, rather than one
                  bundle of overlapping squiggles — which is also
                  what makes overlapping values readable in the
                  first place. */}
              {(() => {
                // Recomputed identically in the dot block below — kept
                // close to its consumer there so the jitter logic
                // stays readable; here we just mirror it for the
                // lines. If you tweak the formula update both sites.
                const bucketWidthPx = (DIMS.w - DIMS.padL - DIMS.padR) / Math.max(1, canonicalSeries.length);
                const jitterMax = Math.min(9, Math.max(3, bucketWidthPx * 0.32));
                const JITTER_PX = [-jitterMax, -jitterMax / 3, jitterMax / 3, jitterMax];
                return METRIC_DEFS.map((d, mIdx) => {
                  const isHighlighted = highlight === d.key;
                  const dimmed = highlight !== null && !isHighlighted;
                  const clickable = !!onMetricClick;
                  const dx = JITTER_PX[mIdx] ?? 0;
                  return (
                    <g key={d.key} style={{ cursor: clickable ? "pointer" : "default" }}>
                      {clickable && (
                        <path
                          d={pathForMetric(d.key, dx)}
                          stroke="transparent"
                          strokeWidth={14}
                          fill="none"
                          onClick={() => {
                            if (dragMoved.current) return;
                            const hovered = hover ? canonicalSeries[hover.bucketIdx] : null;
                            const startMs = hovered ? hovered.startMs : null;
                            const endMs   = hovered ? hovered.startMs + bucketMs : null;
                            onMetricClick!(d.key, startMs, endMs);
                          }}
                        />
                      )}
                      <path
                        d={pathForMetric(d.key, dx)}
                        className="neo-team-line"
                        stroke={d.color}
                        strokeWidth={isHighlighted ? 3 : 2}
                        opacity={dimmed ? 0.25 : 1}
                        pointerEvents="none"
                      />
                    </g>
                  );
                });
              })()}

              {/* Per-metric dots — ON TOP so hovering over a dot
                  reliably sets the right bucket, AND clicking a dot
                  drills into THAT metric for THAT bucket.

                  HORIZONTAL JITTER (the "encavalados" fix): dots
                  within the same bucket are nudged left/right by a
                  per-metric offset so they never share the exact
                  same (cx, cy) when their values happen to collide.
                  Without this, MTTA / MTTR / MTBF stack on the same
                  pixel when their averages are close (e.g. 5d 7h /
                  5d 20h / 4d 22h all map to indistinguishable Y on
                  the log scale and the same X), and the topmost
                  invisible hit-circle in DOM order eats every click.

                  The X-axis within a single bucket has no semantic
                  meaning — the data is already aggregated into the
                  bucket window — so jittering is visually honest.
                  Spread is proportional to bucket width (capped at
                  ±9 px / 18 px total) so dense charts with many
                  buckets don't have adjacent buckets bleed into each
                  other. The hit-circles (r=4) are spaced 6 px apart
                  centre-to-centre at the cap → 2 px overlap at the
                  edges, none in the middle, so clicks land on the
                  intended metric across the full vertical range. */}
              {METRIC_DEFS.map((d, mIdx) => {
                const dimmed = highlight !== null && highlight !== d.key;
                const clickable = !!onMetricClick;
                // Proportional to the bucket pixel-width: ~⅓ of a
                // bucket from the centre at the cap. Falls back to a
                // tighter spread when buckets are narrow so adjacent
                // buckets' jittered dots never intermingle.
                const bucketWidthPx = (DIMS.w - DIMS.padL - DIMS.padR) / Math.max(1, canonicalSeries.length);
                const jitterMax = Math.min(9, Math.max(3, bucketWidthPx * 0.32));
                const JITTER_PX = [-jitterMax, -jitterMax / 3, jitterMax / 3, jitterMax];
                const dx = JITTER_PX[mIdx] ?? 0;
                return metrics[d.key].series.map((b, idx) => {
                  if (b.count === 0) return null;
                  const cx = xScale(b.startMs + bucketMs / 2, minX, maxX) + dx;
                  const cy = yScale(b.avgMs, maxY);
                  /* Is THIS specific (metric × bucket) the one the
                     cursor is over right now? Drives the hover-
                     confirmation effect — halo ring + larger fill
                     dot + animated pulse so the user can SEE which
                     datapoint they're targeting, not guess. */
                  const isHoveredDot = hoveredDot?.metric === d.key && hoveredDot.bucketIdx === idx;
                  return (
                    <g key={`${d.key}-${b.startMs}`}>
                      {/* Confirmation halo — rendered BEHIND the
                          dot so it reads as "ambient glow" around
                          the targeted point. Pointer-events disabled
                          so it doesn't shadow the hit-circle. SMIL
                          animate gives a one-shot pulse on enter
                          across all browsers without RAF. */}
                      {isHoveredDot && (
                        <g pointerEvents="none">
                          <circle
                            cx={cx} cy={cy}
                            r={10}
                            fill="none"
                            stroke={d.color}
                            strokeWidth={2}
                            opacity={0.55}
                          >
                            <animate
                              attributeName="r"
                              values="6;12;10"
                              dur="320ms"
                              repeatCount="1"
                              fill="freeze"
                            />
                            <animate
                              attributeName="opacity"
                              values="0;0.7;0.55"
                              dur="320ms"
                              repeatCount="1"
                              fill="freeze"
                            />
                          </circle>
                          {/* Soft inner glow — translucent disc with
                              the metric's accent, very subtle. */}
                          <circle
                            cx={cx} cy={cy} r={7}
                            fill={d.color}
                            opacity={0.18}
                          />
                        </g>
                      )}
                      {/* Invisible hit-circle around each dot's
                          jittered position. r=4 keeps adjacent
                          metrics' targets from re-overlapping at the
                          ±9 px jitter cap (centre-to-centre = 6 px,
                          r=4 → 2 px overlap at the edges only). No
                          native SVG <title> — the OS-level popup
                          overlaid the custom tooltip and blocked
                          clicks. */}
                      {clickable && (
                        <circle
                          cx={cx} cy={cy} r={4}
                          fill="transparent"
                          style={{ cursor: "pointer" }}
                          onMouseEnter={() => {
                            setHover({ bucketIdx: idx, x: cx - dx });
                            setHoveredDot({ metric: d.key, bucketIdx: idx });
                          }}
                          onMouseLeave={() => {
                            // Only clear when leaving THIS dot to a
                            // non-dot region; another dot's mouseenter
                            // will overwrite the state if the cursor
                            // crosses directly between them.
                            setHoveredDot((prev) =>
                              prev?.metric === d.key && prev.bucketIdx === idx ? null : prev,
                            );
                          }}
                          /* Touch counterpart: touchstart sets the
                             same hover + hoveredDot state as a
                             mouseEnter would. The synthetic click
                             that the browser fires from the same
                             touch sequence still triggers `onClick`,
                             so a tap on the dot first highlights it
                             (visually confirming which metric was
                             hit even with overlapping clusters) AND
                             drills — same one-step interaction the
                             desktop user gets via hover+click. */
                          onTouchStart={() => {
                            setHover({ bucketIdx: idx, x: cx - dx });
                            setHoveredDot({ metric: d.key, bucketIdx: idx });
                          }}
                          onClick={() => { if (!dragMoved.current) onMetricClick!(d.key, b.startMs, b.startMs + bucketMs); }}
                        />
                      )}
                      <circle
                        cx={cx} cy={cy}
                        /* Hovered dot grows by 50% so the target
                           reads as "lifted" — same affordance Strato
                           charts use on hover. The growth + halo
                           together make the confirmation
                           unmistakable. */
                        r={isHoveredDot ? 5 : (highlight === d.key ? 4 : 3)}
                        fill={d.color}
                        opacity={dimmed && !isHoveredDot ? 0.25 : 1}
                        stroke={isHoveredDot ? "rgba(255,255,255,0.95)" : "rgba(8,12,22,0.95)"}
                        strokeWidth={isHoveredDot ? 1.5 : 1}
                        pointerEvents="none"
                      />
                    </g>
                  );
                });
              })}
            </svg>
          ) : (
            <div className="neo-analytics-empty neo-analytics-empty-inline">
              No samples in this window for any metric.
            </div>
          )}

          {/* Tooltip: information-only Dynatrace-style surface that
              FOLLOWS the cursor X with a small keep-out offset.
              Read-only, so the user never has to navigate toward it
              — the previous "chase" problem (tooltip jumping bucket-
              by-bucket as the user moved toward a clickable row)
              doesn't exist anymore. The tooltip just sits next to
              whatever bucket the cursor is on, flipping to the other
              side at the chart midline so it never overflows past
              the chart edges. Hidden while brushing so the gesture
              has a clear visual canvas. */}
          {hover && !brush && (() => {
            const b = canonicalSeries[hover.bucketIdx];
            if (!b) return null;
            const cursorOnLeft = hover.x < DIMS.w / 2;
            // Position differs by device:
            //   • Desktop: follow cursor X with a 48 px keep-out so
            //     the popup clears the jittered dot cluster + halo.
            //   • Mobile / tablet: anchor to the chart-wrap bottom
            //     edge full-width — "sheet" style. There's no cursor
            //     to follow and the user's finger is already on the
            //     chart; positioning the panel under it keeps the
            //     reading flow vertical and avoids ovelapping the
            //     dots they just tapped.
            const xPct = (hover.x / DIMS.w) * 100;
            const tipStyle: React.CSSProperties = isMobileOrTablet
              ? { left: 8, right: 8, bottom: 8, top: "auto", maxWidth: "none" }
              : cursorOnLeft
                ? { left: `calc(${xPct}% + 48px)`, right: "auto", top: 28 }
                : { left: `calc(${xPct}% - 48px)`, right: "auto", top: 28, transform: "translateX(-100%)" };
            const bucketCount = m.problemCountSeries[hover.bucketIdx]?.count ?? 0;
            const hasAnyDrilldown = !!onBucketClick || !!onMetricClick;
            return (
              <div className={`neo-mtta-tooltip${isMobileOrTablet ? " neo-mtta-tooltip-sheet" : ""}`} style={tipStyle} role="status" aria-live="polite">
                <header className="neo-mtta-tooltip-header">
                  <div className="neo-mtta-tooltip-date">
                    {new Date(b.startMs).toLocaleDateString(undefined, {
                      weekday: "short", month: "short", day: "numeric", year: "numeric",
                    })}
                  </div>
                  <div className="neo-mtta-tooltip-bucketcount">
                    {bucketCount} problem{bucketCount === 1 ? "" : "s"} started in this bucket
                  </div>
                </header>
                <div className="neo-mtta-tooltip-rows">
                  {METRIC_DEFS.map((d) => {
                    const ms = metrics[d.key].series[hover.bucketIdx];
                    const hasValue = !!ms && ms.count > 0;
                    /* The row matching the hovered dot is brightened
                       (background tint + bolder border) so the user
                       gets a second confirmation channel: the chart
                       shows the halo, the tooltip shows which metric
                       it belongs to. Closes the loop on "am I really
                       hovering over MTTA?". */
                    const isTargeted = hoveredDot?.metric === d.key && hoveredDot.bucketIdx === hover.bucketIdx;
                    return (
                      <div
                        key={d.key}
                        className={`neo-mtta-tooltip-row${isTargeted ? " neo-mtta-tooltip-row-targeted" : ""}`}
                        style={{ borderLeftColor: d.color, ["--metric-accent" as string]: d.color }}
                        data-has={hasValue ? "yes" : "no"}
                      >
                        <span className="neo-mtta-tooltip-row-label" style={{ color: d.color }}>
                          {d.label}
                        </span>
                        <span className="neo-mtta-tooltip-row-value">
                          {hasValue ? fmtMs(ms.avgMs) : "—"}
                        </span>
                        <span className="neo-mtta-tooltip-row-n">
                          {hasValue ? `n=${ms.count}` : "no samples"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {/* Drilldown hints — chart-level, not row-level. The
                    user clicks the dot or the bucket area, not the
                    tooltip itself. Hidden when no handler is wired. */}
                {hasAnyDrilldown && bucketCount > 0 && (
                  <footer className="neo-mtta-tooltip-cta">
                    {onMetricClick && "Click a dot → drill into that metric"}
                    {onMetricClick && onBucketClick && <br />}
                    {onBucketClick && "Click the bucket area → drill the full bucket"}
                  </footer>
                )}
              </div>
            );
          })()}

          {/* Data-density footer — surfaces the gap between "total
              problems in window" and "problems contributing to each
              metric series" so the user can validate why some lines
              look sparse. Most common gotcha: MTTA only counts
              problems that received a human comment, MTTR only
              CLOSED ones, MTBF/MTTF skip the first problem in the
              window. Showing the breakdown here turns "the chart is
              empty?" into "ah, only N of M problems contribute". */}
          {!m.loading && !m.error && m.totalProblems > 0 && (
            <div className="neo-mtta-density" role="note">
              <span className="neo-mtta-density-label">Samples</span>
              {METRIC_DEFS.map((d) => {
                const n = metrics[d.key].count;
                const pct = m.totalProblems > 0 ? Math.round((n / m.totalProblems) * 100) : 0;
                return (
                  <span
                    key={d.key}
                    className={`neo-mtta-density-stat${n === 0 ? " neo-mtta-density-stat-zero" : ""}`}
                    style={{ ["--metric-accent" as string]: d.color }}
                    title={`${n} of ${m.totalProblems} problems contribute to ${d.label} (${pct}%)`}
                  >
                    <span className="neo-mtta-density-dot" />
                    <span className="neo-mtta-density-name">{d.label}</span>
                    <span className="neo-mtta-density-count">{n}</span>
                  </span>
                );
              })}
              <span className="neo-mtta-density-total">
                of {m.totalProblems} problem{m.totalProblems === 1 ? "" : "s"} in window
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
