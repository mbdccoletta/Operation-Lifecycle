// Top filter-segments ranked by problem count in the current window,
// with a stacked bar showing the per-segment category mix. Answers
// "which segment is bleeding, and what kind of pain is it?" — pairs
// well with the Segments page constellation drill-down.
//
// Data flow:
//   • parent loads segment catalog + membership map (same hooks the
//     Segments-grouped Overview uses)
//   • this component does the per-(segment, category) tally and
//     ranks segments by total count

import React, { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { LeanFilterSegment } from "@dynatrace-sdk/client-filter-segment-management";
import type { Problem } from "../../hooks/useProblems";
import { Skeleton, SkeletonText } from "@dynatrace/strato-components/content";
import { CATEGORY_GROUPINGS, CATEGORY_COLOR_BY_ID } from "../../utils/grouping";
import { getCategoryLabel } from "../../utils/formatters";

interface Props {
  problems: Problem[];
  segCatalog: LeanFilterSegment[];
  /** display_id → set of segment UIDs the problem belongs to */
  membership: Map<string, Set<string>>;
  loading?: boolean;
  limit?: number;
}

interface Row {
  uid: string;
  name: string;
  total: number;
  active: number;
  /** category-id → count (only categories with count > 0) */
  catCounts: Record<string, number>;
}

const FALLBACK_COLOR = "#6ee7b7";

export const TopSegmentsByCategory: React.FC<Props> = ({
  problems, segCatalog, membership, loading, limit = 8,
}) => {
  const navigate = useNavigate();

  const rows = useMemo<Row[]>(() => {
    if (segCatalog.length === 0 || membership.size === 0) return [];
    // segUid → name lookup so the row labels match what the Segments
    // page constellation shows.
    const nameByUid = new Map<string, string>();
    for (const s of segCatalog) nameByUid.set(s.uid, s.name);

    // Aggregate.
    const agg = new Map<string, Row>();
    for (const p of problems) {
      const segs = membership.get(p.display_id);
      if (!segs || segs.size === 0) continue;
      const cat = p["event.category"];
      if (!cat) continue;
      const isActive = p["event.status"] === "ACTIVE";
      for (const uid of segs) {
        let r = agg.get(uid);
        if (!r) {
          r = { uid, name: nameByUid.get(uid) || uid, total: 0, active: 0, catCounts: {} };
          agg.set(uid, r);
        }
        r.total++;
        if (isActive) r.active++;
        r.catCounts[cat] = (r.catCounts[cat] || 0) + 1;
      }
    }
    return [...agg.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }, [problems, segCatalog, membership, limit]);

  if (loading && rows.length === 0) {
    return (
      <div className="neo-topsegs" aria-busy="true" aria-label="Loading top segments">
        {[1, 2, 3].map((i) => (
          <div key={i} className="neo-topsegs-row" role="listitem">
            <Skeleton width="100%" height="44px" variant="rounded" />
          </div>
        ))}
        <SkeletonText lines={1} width="50%" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="neo-analytics-empty">
        Nenhum segmento elegível com problemas neste período.
      </div>
    );
  }

  const maxTotal = Math.max(...rows.map((r) => r.total), 1);
  // Stable category order across all rows so eyes can compare the
  // mix at a glance (left-to-right always means the same category).
  const orderedCats = CATEGORY_GROUPINGS.map((g) => g.id);

  return (
    <div className="neo-topsegs" role="list">
      {rows.map((r, idx) => {
        const widthPct = (r.total / maxTotal) * 100;
        // Top 3 categories by count for the inline summary
        const topCats = Object.entries(r.catCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3);
        return (
          <button
            key={r.uid}
            type="button"
            className="neo-topsegs-row"
            role="listitem"
            /* Drill into the Incidents list, filtered to problems
               belonging to this segment. The previous target
               (/segments) led to a now-hidden grouped view —
               clicking ended up on a dead page. The Incidents drill
               is what the user wants: see the actual problems behind
               the number. URL contract `?segment=<uid>` is parsed
               at Overview mount (lazy useState). */
            onClick={() => navigate(`/?view=list&segment=${encodeURIComponent(r.uid)}`)}
            title={`${r.name} · ${r.total} problemas (${r.active} ativos) — click to drill into the list`}
          >
            <span className="neo-topsegs-rank">{idx + 1}</span>
            <span className="neo-topsegs-icon" aria-hidden="true">◇</span>
            <span className="neo-topsegs-name">{r.name}</span>
            <span className="neo-topsegs-total">{r.total}</span>
            {r.active > 0 && (
              <span className="neo-topsegs-active" title={`${r.active} ativos`}>● {r.active}</span>
            )}

            {/* Stacked bar — category mix proportional within the bar
                width, which itself is scaled to the segment's total
                relative to the leader. */}
            <div className="neo-topsegs-bar-wrap">
              <div className="neo-topsegs-bar" style={{ width: `${widthPct}%` }}>
                {orderedCats.map((catId) => {
                  const c = r.catCounts[catId] || 0;
                  if (c === 0) return null;
                  const segPct = (c / r.total) * 100;
                  const color  = CATEGORY_COLOR_BY_ID[catId] || FALLBACK_COLOR;
                  return (
                    <span
                      key={catId}
                      className="neo-topsegs-bar-seg"
                      style={{ width: `${segPct}%`, background: color }}
                      title={`${getCategoryLabel(catId)}: ${c}`}
                    />
                  );
                })}
              </div>
            </div>

            <span className="neo-topsegs-mix">
              {topCats.map(([catId, c], i) => (
                <span
                  key={catId}
                  className="neo-topsegs-mix-item"
                  style={{ color: CATEGORY_COLOR_BY_ID[catId] || FALLBACK_COLOR }}
                >
                  {i > 0 && <span className="neo-topsegs-mix-sep"> · </span>}
                  {getCategoryLabel(catId)} {c}
                </span>
              ))}
            </span>

            <span className="neo-topsegs-cta" aria-hidden="true">→</span>
          </button>
        );
      })}
    </div>
  );
};
