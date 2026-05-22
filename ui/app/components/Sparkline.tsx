// Tiny SVG sparkline — values array → normalised polyline + optional
// filled area. Used by the Trends page KPI cards. Kept dependency-
// free so it costs nothing at the bundle level vs pulling in a real
// chart lib.
//
// Hover affordance: when the cursor enters the sparkline, the
// component renders a vertical guideline, a highlighted dot on the
// nearest data point, and an inline tooltip with the bucket's value
// (and timestamp, if a `range` is supplied). Cursor leaves → all
// hover decorations come down. No animations, no transitions on
// the marker — instant feedback so the user can scrub the curve.

import React, { useState } from "react";

interface SparklineProps {
  values: number[];
  color: string;
  height?: number;
  width?: number;
  /** Render the area under the line at 15 % alpha. Defaults to true. */
  fill?: boolean;
  /** Optional ms-timestamp window the series spans. When provided,
   *  the hover tooltip labels each point with its bucket time. */
  range?: { from: number; to: number };
  /** Optional suffix appended to the raw value in the tooltip
   *  (e.g. "h" for MTTR, "%" for resolution rate, "" for counts). */
  valueSuffix?: string;
  /** Optional formatter for the value. Overrides the default
   *  `${v}${valueSuffix}` rendering — use when a metric needs
   *  custom formatting (decimals, conversion, etc). */
  formatValue?: (v: number) => string;
}

function fmtBucketTime(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs < 48 * 3_600_000) {
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const Sparkline: React.FC<SparklineProps> = ({
  values, color, height = 28, width = 100, fill = true,
  range, valueSuffix = "", formatValue,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!values || values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const yRange = Math.max(1, max - min);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - 2 - ((v - min) / yRange) * (height - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;

  // Cursor → nearest bucket. Snap to nearest x-step so the marker
  // sits ON a data point instead of between two. Uses the SVG's
  // own bounding rect (not the wrapper div) so scaling / padding
  // never throws off the math.
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // Translate clientX into the SVG's logical coord space — the
    // SVG can be CSS-scaled (the card width responds to grid), so
    // we have to undo the scale via (rect.width / width).
    const xScale = rect.width / width;
    const xLogical = (e.clientX - rect.left) / Math.max(0.0001, xScale);
    const idx = Math.max(0, Math.min(values.length - 1, Math.round(xLogical / step)));
    setHoverIdx(idx);
  };
  const onLeave = () => setHoverIdx(null);

  const hp = hoverIdx !== null ? pts[hoverIdx] : null;
  const hv = hoverIdx !== null ? values[hoverIdx] : null;

  // Tooltip text — value first (the headline), bucket time second
  // (the context). When no range is supplied we just print the
  // value, which still beats the previous "no feedback at all".
  let tipText = "";
  if (hoverIdx !== null && hv !== null) {
    const valStr = formatValue
      ? formatValue(hv)
      : Number.isFinite(hv) ? `${Number.isInteger(hv) ? hv : hv.toFixed(1)}${valueSuffix}` : "—";
    if (range) {
      const spanMs = range.to - range.from;
      const t = range.from + (hoverIdx / (values.length - 1)) * spanMs;
      tipText = `${valStr} · ${fmtBucketTime(t, spanMs)}`;
    } else {
      tipText = valStr;
    }
  }

  // Clamp the tooltip's horizontal position so it doesn't overflow
  // the card edges when the cursor is near the start/end of the
  // line. 50 % each side covers tooltips up to ~100 px wide before
  // they'd start clipping the typical 200 px sparkline.
  const tipLeftPct = hp ? Math.max(8, Math.min(92, (hp[0] / width) * 100)) : 50;

  return (
    <div
      style={{
        position: "relative",
        display: "inline-block",
        width,
        // The pointer cursor signals the chart is interactive even
        // before the user moves the mouse over a data point.
        cursor: "crosshair",
      }}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
        onMouseMove={onMove}
        onMouseLeave={onLeave}
        style={{ display: "block" }}
      >
        {fill && <path d={area} fill={color} opacity="0.15" />}
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {hp && (
          <>
            {/* Vertical guideline — half-opacity so the user can
                still read the curve beneath it. */}
            <line
              x1={hp[0]} x2={hp[0]} y1={0} y2={height}
              stroke={color} strokeWidth="0.6" opacity="0.45"
            />
            {/* Highlighted data point — solid dot, no stroke (the
                card's bg provides enough contrast). */}
            <circle cx={hp[0]} cy={hp[1]} r="2.5" fill={color} />
          </>
        )}
      </svg>
      {hp && tipText && (
        <div
          className="neo-sparkline-tip"
          style={{ left: `${tipLeftPct}%` }}
          role="tooltip"
        >
          {tipText}
        </div>
      )}
    </div>
  );
};
