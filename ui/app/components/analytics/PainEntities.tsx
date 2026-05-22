// Top entities by problem count in the window — answers "where
// should we look first today?" Aggregates affected_entity_ids across
// every problem and surfaces the top 5. Clicking a row drills into
// the Incidents list filtered to problems whose `affected_entity_ids`
// includes that entity id (via `?entity=<id>` — Overview hydrates
// the filter from the URL).

import React, { useMemo } from "react";
import type { Problem } from "../../hooks/useProblems";
import { useNavigate } from "react-router-dom";
import { entityTypeLabel, entityTypeOf, shortEntityId } from "../../utils/formatters";

interface PainRow { id: string; name: string | null; type: string; count: number; activeCount: number; }

export const PainEntities: React.FC<{ problems: Problem[]; limit?: number }> = ({ problems, limit = 5 }) => {
  const navigate = useNavigate();
  const rows = useMemo<PainRow[]>(() => {
    const agg: Record<string, { name: string | null; count: number; active: number }> = {};
    for (const p of problems) {
      const ids   = p.affected_entity_ids   || [];
      const names = p.affected_entity_names || [];
      const isActive = p["event.status"] === "ACTIVE";
      for (let i = 0; i < ids.length; i++) {
        const eid = ids[i];
        if (!eid) continue;
        if (!agg[eid]) agg[eid] = { name: names[i] || null, count: 0, active: 0 };
        agg[eid].count++;
        if (isActive) agg[eid].active++;
        // Keep the first non-null name we see.
        if (!agg[eid].name && names[i]) agg[eid].name = names[i];
      }
    }
    return Object.entries(agg)
      .map(([id, v]) => ({ id, name: v.name, type: entityTypeOf(id), count: v.count, activeCount: v.active }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }, [problems, limit]);

  if (rows.length === 0) {
    return <div className="neo-analytics-empty">No affected entities in this window.</div>;
  }

  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  return (
    <div className="neo-pain-list" role="list">
      {rows.map((r, idx) => {
        const pct = (r.count / maxCount) * 100;
        return (
          <button
            key={r.id}
            type="button"
            className="neo-pain-row"
            role="listitem"
            onClick={() => navigate(`/?view=list&entity=${encodeURIComponent(r.id)}`)}
            title={`${r.count} problems · ${r.activeCount} currently active · click to filter to ${r.name || r.id}`}
          >
            <span className="neo-pain-rank">{idx + 1}</span>
            <span className="neo-pain-icon" aria-hidden="true">⌬</span>
            <span className="neo-pain-name">
              {r.name
                ? <span className="neo-pain-name-text">{r.name}</span>
                : <>
                    <span className="neo-pain-name-type">{entityTypeLabel(r.type)}</span>
                    <span className="neo-pain-name-sep"> · </span>
                    <span className="neo-pain-name-uid">{shortEntityId(r.id)}</span>
                  </>
              }
            </span>
            <div className="neo-pain-bar">
              <div className="neo-pain-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="neo-pain-count">{r.count}</span>
            {r.activeCount > 0 && (
              <span className="neo-pain-active" title={`${r.activeCount} active`}>● {r.activeCount}</span>
            )}
            <span className="neo-pain-cta" aria-hidden="true">→</span>
          </button>
        );
      })}
    </div>
  );
};
