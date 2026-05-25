// Davis's own correlation of each problem to a single root-cause
// entity — surfaced here as a leaderboard of "who's getting blamed
// the most" inside the window. Mirrors the angle the official
// Problems app exposes. Click → drill into the Incidents list with
// `?rce=<id>` so Overview filters to problems whose
// `root_cause_entity_id` matches that id.

import React, { useMemo } from "react";
import type { Problem } from "../../hooks/useProblems";
import { useNavigate } from "react-router-dom";
import { entityTypeLabel, entityTypeOf, shortEntityId } from "../../utils/formatters";

interface Row { id: string; name: string | null; type: string; count: number; activeCount: number; }

export const TopRootCauses: React.FC<{ problems: Problem[]; limit?: number }> = ({ problems, limit = 5 }) => {
  const navigate = useNavigate();
  const rows = useMemo<Row[]>(() => {
    const agg: Record<string, { name: string | null; count: number; active: number }> = {};
    for (const p of problems) {
      const id = p.root_cause_entity_id;
      if (!id) continue;
      const cur = agg[id] || { name: null, count: 0, active: 0 };
      cur.count++;
      if (p["event.status"] === "ACTIVE") cur.active++;
      if (!cur.name && p.root_cause_entity_name) cur.name = p.root_cause_entity_name;
      agg[id] = cur;
    }
    return Object.entries(agg)
      .map(([id, v]) => ({ id, name: v.name, type: entityTypeOf(id), count: v.count, activeCount: v.active }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }, [problems, limit]);

  if (rows.length === 0) {
    return <div className="neo-analytics-empty">Davis didn't assign a root cause to any problem in this window.</div>;
  }

  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  return (
    <div className="neo-rootcause-list" role="list">
      {rows.map((r, idx) => {
        const pct = (r.count / maxCount) * 100;
        return (
          <button
            key={r.id}
            type="button"
            className="neo-rootcause-row"
            role="listitem"
            onClick={() => navigate(`/?view=list&rce=${encodeURIComponent(r.id)}`)}
            title={`Root cause: ${r.id} · ${r.count} problems · ${r.activeCount} active · click to filter list`}
          >
            <span className="neo-rootcause-rank">{idx + 1}</span>
            <span className="neo-rootcause-icon" aria-hidden="true">◉</span>
            <span className="neo-rootcause-name">
              {r.name
                ? <span className="neo-rootcause-name-text">{r.name}</span>
                : <>
                    <span className="neo-rootcause-name-type">{entityTypeLabel(r.type)}</span>
                    <span className="neo-rootcause-name-sep"> · </span>
                    <span className="neo-rootcause-name-uid">{shortEntityId(r.id)}</span>
                  </>
              }
            </span>
            <div className="neo-rootcause-bar">
              <div className="neo-rootcause-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="neo-rootcause-count">{r.count}</span>
            {r.activeCount > 0 && (
              <span className="neo-rootcause-active" title={`${r.activeCount} active`}>● {r.activeCount}</span>
            )}
            <span className="neo-rootcause-cta" aria-hidden="true">→</span>
          </button>
        );
      })}
    </div>
  );
};
