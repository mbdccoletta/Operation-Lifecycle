// Tiny SVG sparkline — values array → normalised polyline + optional
// filled area. Used by the Analytics page KPI cards. Kept dependency-
// free so it costs nothing at the bundle level vs pulling in a real
// chart lib.

import React from "react";

interface SparklineProps {
  values: number[];
  color: string;
  height?: number;
  width?: number;
  /** Render the area under the line at 15 % alpha. Defaults to true. */
  fill?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = ({
  values, color, height = 28, width = 100, fill = true,
}) => {
  if (!values || values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {fill && <path d={area} fill={color} opacity="0.15" />}
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
