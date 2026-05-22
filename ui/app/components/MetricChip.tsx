// Single colour-coded metric chip used per-problem in the
// expanded row body (Overview list). Originally lived inside
// ProblemTimelineCard but extracted here so any surface — list
// row, Analytics drill-down, future detail panels — can render
// the same pill without duplicating styles. Matches the colour
// scheme of the TeamMetricsCard legend at the top of Analytics
// so the visual association reads at a glance:
//   • MTTA → purple  (#818CF8)
//   • MTTR → orange  (#FB923C)
//   • MTBF → green   (#34D399)
//   • MTTF → cyan    (#22D3EE)
import React from "react";
import { Tooltip } from "@dynatrace/strato-components-preview/overlays";
import { formatDurationMs } from "../utils/formatters";

/** Stable colour map matching the TeamMetricsCard legend strip
 *  at the top of Analytics. Kept here so any new surface that
 *  renders metric chips picks up the same accents automatically. */
export const METRIC_COLORS = {
  mtta: "#818CF8",
  mttr: "#FB923C",
  mtbf: "#34D399",
  mttf: "#22D3EE",
} as const;

export interface MetricChipProps {
  label: string;
  /** Duration in milliseconds, or null/undefined to render the
   *  chip as a muted "—" placeholder. */
  ms: number | null | undefined;
  color: string;
  /** Optional Strato Tooltip text — leave undefined to skip the
   *  tooltip wrapper (useful for dense rows that already have
   *  the meaning explained nearby). */
  title?: string;
}

export const MetricChip: React.FC<MetricChipProps> = ({ label, ms, color, title }) => {
  const value = (ms === null || ms === undefined) ? "—" : formatDurationMs(ms);
  const muted = ms === null || ms === undefined;
  const chip = (
    <span className={`neo-metric-chip${muted ? " neo-metric-chip-muted" : ""}`} style={{ borderColor: `${color}55` }}>
      <span className="neo-metric-chip-label" style={{ color: muted ? undefined : color }}>{label}</span>
      <span className="neo-metric-chip-value">{value}</span>
    </span>
  );
  if (!title) return chip;
  return (
    <Tooltip text={title} placement="top" fallbackPlacements={["bottom", "left", "right"]}>
      {chip}
    </Tooltip>
  );
};
