// Average resolution time grouped by Davis category. Answers "where
// does our operational pain compound?" — a category with high MTTR
// and high count is the obvious place to invest in better runbooks
// or tooling.

import React, { useMemo } from "react";
import type { Problem } from "../../hooks/useProblems";
import { getCategoryLabel } from "../../utils/formatters";
import { categoryColorFor } from "../../utils/grouping";

const MIN_REAL_MS = 60_000; // skip 0-duration / synthetic blips

export const MttrByCategory: React.FC<{ problems: Problem[] }> = ({ problems }) => {
  const rows = useMemo(() => {
    const agg: Record<string, { sum: number; n: number; sample: Problem }> = {};
    for (const p of problems) {
      if (p["event.status"] !== "CLOSED") continue;
      const start = new Date(p["event.start"]).getTime();
      const end   = p["event.end"] ? new Date(p["event.end"]).getTime() : NaN;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const dur = end - start;
      if (dur < MIN_REAL_MS) continue;
      const cat = p["event.category"];
      if (!cat) continue;
      if (!agg[cat]) agg[cat] = { sum: 0, n: 0, sample: p };
      agg[cat].sum += dur;
      agg[cat].n++;
    }
    return Object.entries(agg)
      .map(([cat, v]) => ({
        cat,
        label: getCategoryLabel(cat),
        n: v.n,
        mttrH: v.sum / v.n / 3600000,
        color: categoryColorFor(v.sample),
      }))
      .sort((a, b) => b.mttrH - a.mttrH);
  }, [problems]);

  if (rows.length === 0) {
    return <div className="neo-analytics-empty">No closed problems in this window — MTTR by category is unavailable.</div>;
  }

  const maxMttr = Math.max(...rows.map((r) => r.mttrH), 0.1);

  return (
    <div className="neo-mttrcat">
      {rows.map((r) => {
        const pct = (r.mttrH / maxMttr) * 100;
        return (
          <div key={r.cat} className="neo-mttrcat-row" title={`${r.n} resolved · avg ${r.mttrH.toFixed(2)}h`}>
            <span className="neo-mttrcat-label" style={{ color: r.color }}>{r.label}</span>
            <div className="neo-mttrcat-bar">
              <div className="neo-mttrcat-bar-fill" style={{ width: `${pct}%`, background: r.color }} />
            </div>
            <span className="neo-mttrcat-value">{r.mttrH.toFixed(1)}h</span>
            <span className="neo-mttrcat-count">{r.n}</span>
          </div>
        );
      })}
    </div>
  );
};
