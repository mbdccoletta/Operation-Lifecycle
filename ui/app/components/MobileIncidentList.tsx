// Mobile / tablet variant of the Incidents list. Each problem
// renders as a self-contained card stacked vertically — replaces
// the desktop's wide 8-column table that doesn't fit below 640px.
//
// Tapping a card toggles inline expansion into the same
// `ProblemActivityFeed` the desktop expanded row uses, so users get
// the full activity feed + comments composer without leaving the
// list. The card layout deliberately surfaces the bits a triage
// user reaches for first on a phone: ID, status, name, affected
// entity, age, then per-metric chips at the bottom.
//
// State (which row is expanded, refresh, etc.) stays in the parent
// (`Overview`) — this component is purely presentational so both
// the mobile list and the desktop table can share the same
// expansion semantics.

import React, { useMemo, useState } from "react";
import type { Problem } from "../hooks/useProblems";
import type { PerProblemMetrics } from "../hooks/useTeamMetrics";
import { MetricChip, METRIC_COLORS } from "./MetricChip";
import { ProblemActivityFeed } from "./ProblemActivityFeed";
import { ProblemActions } from "./ProblemActions";
import {
  formatDurationMs,
  getCategoryLabel,
  getStatusLabel,
} from "../utils/formatters";

interface Props {
  problems: Problem[];
  /** Per-problem metrics map keyed by `davis_problem_id`. Same
   *  shape the desktop table consumes — provided by the parent
   *  page so we don't re-run `useTeamMetrics`. */
  perProblem: Map<string, PerProblemMetrics>;
  /** Currently expanded row ids (controlled by parent). */
  expandedIds: Set<string>;
  /** Toggle expansion for the given display_id. */
  onToggleExpand: (displayId: string) => void;
  /** Activity-feed sort order per problem id (`asc` = oldest first).
   *  Owned by the parent so desktop + mobile share the same state. */
  sortByProblem: Map<string, "asc" | "desc">;
  setActivitySort: (problemId: string, dir: "asc" | "desc") => void;
}

export const MobileIncidentList: React.FC<Props> = ({
  problems,
  perProblem,
  expandedIds,
  onToggleExpand,
  sortByProblem,
  setActivitySort,
}) => {
  if (problems.length === 0) {
    return <div className="neo-empty">No incidents found</div>;
  }
  return (
    <div className="neo-mobile-list" role="list">
      {problems.map((p) => (
        <MobileIncidentCard
          key={p.display_id}
          problem={p}
          metrics={perProblem.get(
            (p as unknown as { davis_problem_id?: string }).davis_problem_id || "",
          )}
          expanded={expandedIds.has(p.display_id)}
          onToggle={() => onToggleExpand(p.display_id)}
          sort={sortByProblem.get(p.display_id) ?? "asc"}
          onSortChange={(dir) => setActivitySort(p.display_id, dir)}
        />
      ))}
    </div>
  );
};

interface CardProps {
  problem: Problem;
  metrics: PerProblemMetrics | undefined;
  expanded: boolean;
  onToggle: () => void;
  sort: "asc" | "desc";
  onSortChange: (dir: "asc" | "desc") => void;
}

const MobileIncidentCard: React.FC<CardProps> = ({ problem: p, metrics, expanded, onToggle, sort, onSortChange }) => {
  const status = p["event.status"];
  const isActive = status === "ACTIVE";
  // Inline-expanded entity list — independent of the card's main
  // expand state. Click `+N` to reveal every affected entity name
  // without firing the heavyweight card body (ProblemActivityFeed).
  // Sometimes the user just wants to see "which 5 services are
  // affected" without scrolling through comments + swimlane.
  const [entitiesExpanded, setEntitiesExpanded] = useState(false);
  const startMs = useMemo(() => new Date(p["event.start"]).getTime(), [p]);
  // Age: time-since-start. For closed problems we still show "started X
  // ago" since that reads more naturally on a card than "lasted X" —
  // the duration is implied by status pill + MTTR chip below.
  const ageMs = useMemo(() => Date.now() - startMs, [startMs]);
  const affected = p.affected_entity_names?.[0] || p.affected_entity_ids?.[0] || "—";
  const moreCount = (p.affected_entity_ids?.length || 0) - 1;
  const categoryLabel = getCategoryLabel(p["event.category"]);

  // Per-problem metric chips — only the metrics with values render;
  // null ones are omitted to keep the card compact.
  const chips = useMemo(() => {
    if (!metrics) return [];
    const out: Array<{ key: "mtta" | "mttr" | "mtbf" | "mttf"; label: string; ms: number; color: string }> = [];
    if (metrics.mttaMs != null) out.push({ key: "mtta", label: "MTTA", ms: metrics.mttaMs, color: METRIC_COLORS.mtta });
    if (metrics.mttrMs != null) out.push({ key: "mttr", label: "MTTR", ms: metrics.mttrMs, color: METRIC_COLORS.mttr });
    if (metrics.mtbfMs != null) out.push({ key: "mtbf", label: "MTBF", ms: metrics.mtbfMs, color: METRIC_COLORS.mtbf });
    if (metrics.mttfMs != null) out.push({ key: "mttf", label: "MTTF", ms: metrics.mttfMs, color: METRIC_COLORS.mttf });
    return out;
  }, [metrics]);

  return (
    <div
      className={`neo-mobile-card${expanded ? " neo-mobile-card-expanded" : ""}${isActive ? " neo-mobile-card-active" : ""}`}
      role="listitem"
      /* Mirrors the `data-display-id` the desktop `<article>` carries,
         so `Overview.toggleRow` can `querySelector` a single selector
         and scroll the newly-opened card into view across both form
         factors. */
      data-display-id={p.display_id}
    >
      {/* Card header is the toggle. Keeps the touch target large
          (entire card width × ~80 px) so accuracy isn't an issue.
          Rendered as a `role="button"` div instead of a real
          <button> so the `+N` chip inside row3 can carry its own
          onClick handler (nested interactive elements inside a
          <button> are invalid HTML and many screen readers can't
          announce them separately). */}
      <div
        className="neo-mobile-card-head"
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        aria-controls={`mc-body-${p.display_id}`}
      >
        <div className="neo-mobile-card-row1">
          <span className="neo-mobile-card-id">{p.display_id}</span>
          <span className={`neo-mobile-card-status neo-mobile-card-status-${isActive ? "active" : "closed"}`}>
            {getStatusLabel(status)}
          </span>
          <span className="neo-mobile-card-age">{formatDurationMs(ageMs)}</span>
        </div>
        <div className="neo-mobile-card-row2">
          <span className="neo-mobile-card-name">{p["event.name"]}</span>
        </div>
        <div className="neo-mobile-card-row3">
          <span className="neo-mobile-card-cat" title={categoryLabel}>{categoryLabel}</span>
          <span className="neo-mobile-card-sep">·</span>
          <span className="neo-mobile-card-entity" title={affected}>
            {affected}
            {moreCount > 0 && (
              // `+N` is a separate click target — opens the entity
              // list inline WITHOUT firing the card toggle (and
              // without firing the heavyweight ProblemActivityFeed).
              // stopPropagation + preventDefault prevent the click
              // from bubbling to the parent div's onClick.
              <span
                role="button"
                tabIndex={0}
                className={`neo-mobile-card-more${entitiesExpanded ? " neo-mobile-card-more-active" : ""}`}
                aria-expanded={entitiesExpanded}
                aria-label={entitiesExpanded ? "Hide affected entities" : `Show ${moreCount} more affected entities`}
                onClick={(e) => {
                  e.stopPropagation();
                  setEntitiesExpanded((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    e.preventDefault();
                    setEntitiesExpanded((v) => !v);
                  }
                }}
              >{" "}+{moreCount}</span>
            )}
          </span>
        </div>
        {/* Inline-expanded list of every affected entity. Pills wrap
            naturally and the row is bounded so it never dominates the
            card — the user is looking for "which services?" not
            "let me read all 50 names". */}
        {entitiesExpanded && (
          <div className="neo-mobile-card-entities-all" aria-label="All affected entities">
            {(p.affected_entity_names ?? p.affected_entity_ids ?? [])
              .filter((n): n is string => !!n)
              .map((name, i) => (
                <span key={i} className="neo-mobile-card-entity-pill">{name}</span>
              ))}
          </div>
        )}
        {/* Root cause — surfaced even when collapsed because it's
            the single piece of information that tells the user
            WHERE to start the investigation. Falls back to the raw
            entity id when the canonical name isn't available. */}
        {p.root_cause_entity_id && (
          <div className="neo-mobile-card-rc" title="Root cause entity">
            <span className="neo-mobile-card-rc-label">Root cause</span>
            <span className="neo-mobile-card-rc-name">
              {p.root_cause_entity_name || p.root_cause_entity_id}
            </span>
          </div>
        )}
        {chips.length > 0 && (
          <div className="neo-mobile-card-chips">
            {chips.map((c) => (
              <MetricChip key={c.key} label={c.label} ms={c.ms} color={c.color} />
            ))}
          </div>
        )}
      </div>
      {/* Expanded body — same ProblemActivityFeed the desktop row
          expand uses. Keeping the shared component means comments,
          swimlane events, and refresh tick behave identically across
          form factors. */}
      {expanded && (
        <div id={`mc-body-${p.display_id}`} className="neo-mobile-card-body">
          {/* Action toolbar — same affordances the desktop row gets
              (Copy ID · WhatsApp · Share link · Open Problem App ·
              Refresh · Sort). Lives ABOVE the activity feed so
              quick actions are within thumb reach without scrolling
              through long comment threads first. Compact density
              shrinks button padding so the 6 items fit a 360 px
              row with horizontal scroll fallback for the longest
              labels. */}
          <ProblemActions
            problem={p}
            sort={sort}
            onSortChange={onSortChange}
            density="compact"
          />
          <ProblemActivityFeed problem={p} />
        </div>
      )}
    </div>
  );
};
