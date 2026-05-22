// Aging histogram for active problems — answers "how stuck are we?"
// at a finer grain than the binary "Stuck > 4h" KPI. 4 buckets,
// stacked horizontally with proportional widths.

import React, { useMemo } from "react";
import type { Problem } from "../../hooks/useProblems";

interface Bucket { id: string; label: string; min: number; max: number; color: string; }

const BUCKETS: Bucket[] = [
  { id: "lt1h",    label: "< 1h",   min: 0,      max: 3600,    color: "#22d3a0" },
  { id: "1to4h",   label: "1 – 4h", min: 3600,   max: 14400,   color: "#60a5fa" },
  { id: "4to24h",  label: "4 – 24h",min: 14400,  max: 86400,   color: "#f59e0b" },
  { id: "gt24h",   label: "> 24h",  min: 86400,  max: Infinity,color: "#ff4d6a" },
];

export const AgingBuckets: React.FC<{ problems: Problem[] }> = ({ problems }) => {
  const data = useMemo(() => {
    const now = Date.now();
    const counts: Record<string, number> = {};
    for (const b of BUCKETS) counts[b.id] = 0;
    for (const p of problems) {
      if (p["event.status"] !== "ACTIVE") continue;
      const ageSec = (now - new Date(p["event.start"]).getTime()) / 1000;
      if (!Number.isFinite(ageSec) || ageSec < 0) continue;
      const b = BUCKETS.find((x) => ageSec >= x.min && ageSec < x.max);
      if (b) counts[b.id]++;
    }
    const total = BUCKETS.reduce((s, b) => s + counts[b.id], 0);
    return { counts, total };
  }, [problems]);

  if (data.total === 0) {
    return <div className="neo-analytics-empty">No active problems — nothing to age.</div>;
  }

  return (
    <div className="neo-aging">
      <div className="neo-aging-bar" role="img" aria-label={`Aging distribution across ${data.total} active problems`}>
        {BUCKETS.map((b) => {
          const c = data.counts[b.id];
          const pct = (c / data.total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={b.id}
              className="neo-aging-bar-seg"
              style={{ width: `${pct}%`, background: b.color }}
              title={`${b.label}: ${c} (${pct.toFixed(0)}%)`}
            />
          );
        })}
      </div>
      {/* Legend = read-only summary. Drilldown was removed: this
          chart describes the AGE distribution of the currently
          active set, not a slice users typically drill into — and
          the previous "click any bucket → list of ALL active
          problems" was misleading because it ignored which bucket
          was clicked. If a real per-bucket drilldown is wanted in
          the future, wire each item to `/?status=ACTIVE&age=<id>`
          and have Overview honour the age param. */}
      <div className="neo-aging-legend">
        {BUCKETS.map((b) => (
          <div
            key={b.id}
            className="neo-aging-legend-item"
            title={`${data.counts[b.id]} active problems aged ${b.label}`}
          >
            <span className="neo-aging-legend-dot" style={{ background: b.color }} />
            <span className="neo-aging-legend-label">{b.label}</span>
            <span className="neo-aging-legend-count">{data.counts[b.id]}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
