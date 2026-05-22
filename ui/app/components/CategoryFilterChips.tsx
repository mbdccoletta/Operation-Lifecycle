// Shared "Filters" strip — single sticky surface above every page
// that lets the user narrow the problem list. Started life as a
// category-only strip ("Filter by category"); now also drives the
// Active/Closed status filter so both pieces of triage state share
// the same visual real estate.
//
// State source: CategoryFilterContext (filter Set + status scalar +
// clearAll). Counts come from whichever page is currently visible
// (it publishes via useSetCategoryCounts on every list change).
//
// Two rendering modes:
//   • Desktop — chips render inline in a wrap row (default).
//   • Mobile/tablet — collapsed by default into a disclosure
//     summary ("Filters · Active · 2 cats ▾"). Tap expands the
//     panel below.

import React, { useState } from "react";
import { CATEGORY_GROUPINGS } from "../utils/grouping";
import { useCategoryFilter } from "../contexts/CategoryFilterContext";
import { useDevice } from "../hooks/useDevice";

// Status chip palette — Active uses the canonical "open problem"
// red (`#ff4d6a`) the rest of the app already uses for the desktop
// `.neo-tstatus-active` badge, mobile `.neo-mobile-card-status-active`,
// segment cards, and the PulseVisualizer "hot incidents" cluster.
// Standardising on one colour for "open problem = red" everywhere
// keeps the visual semantics legible across surfaces. Closed stays
// neutral grey so it doesn't compete with Active visually.
const STATUS_CHIPS = [
  { id: "ACTIVE", label: "Active", color: "#ff4d6a" },
  { id: "CLOSED", label: "Closed", color: "#94A3B8" },
] as const;

export const CategoryFilterChips: React.FC = () => {
  const { filter, toggle, counts, status, toggleStatus, clearAll } = useCategoryFilter();
  const { isMobileOrTablet } = useDevice();
  const [expanded, setExpanded] = useState(false);

  const activeCatCount = filter.size;
  const hasAnyFilter = activeCatCount > 0 || status !== null;
  // Friendly summary for the collapsed header — surfaces the active
  // filters so users know what's narrowing the list even without
  // opening the disclosure. Status appears first because it's the
  // coarser cut ("show only Active" usually dominates intent).
  const summaryParts: string[] = [];
  if (status === "ACTIVE") summaryParts.push("Active");
  if (status === "CLOSED") summaryParts.push("Closed");
  if (activeCatCount === 1) summaryParts.push(Array.from(filter)[0]);
  else if (activeCatCount > 1) summaryParts.push(`${activeCatCount} cats`);
  const summary = summaryParts.length === 0 ? "All problems" : summaryParts.join(" · ");

  // ── Status chips (Active / Closed) ──────────────────────────────
  // Mutually exclusive — `setStatus` toggles the same value off, so
  // clicking the active chip a second time clears the filter without
  // needing a separate ✕.
  const statusChips = STATUS_CHIPS.map((s) => {
    const isActive = status === s.id;
    // When the user has Active OR Closed selected, dim the OTHER one
    // so the picked state visually dominates — same visual grammar
    // the category chips use.
    const isDimmed = status !== null && !isActive;
    return (
      <button
        key={s.id}
        type="button"
        className={
          "neo-category-filter-chip neo-status-filter-chip"
          + (isActive ? " neo-category-filter-chip-active" : "")
          + (isDimmed ? " neo-category-filter-chip-dimmed" : "")
        }
        onClick={() => toggleStatus(s.id as "ACTIVE" | "CLOSED")}
        aria-pressed={isActive}
        title={isActive
          ? `Remove ${s.label} filter`
          : `Show only ${s.label.toLowerCase()} problems`}
        style={isActive
          ? { borderColor: s.color, boxShadow: `0 0 0 1px ${s.color}, 0 0 12px ${s.color}55` }
          : undefined}
      >
        <span
          className="neo-category-filter-dot"
          style={{ background: s.color, boxShadow: isActive ? `0 0 10px ${s.color}` : `0 0 6px ${s.color}` }}
          aria-hidden="true"
        />
        <span className="neo-category-filter-name" style={isActive ? { color: s.color } : undefined}>
          {s.label}
        </span>
      </button>
    );
  });

  // ── Category chips ──────────────────────────────────────────────
  const chips = CATEGORY_GROUPINGS.map((g) => {
    const activeCount = counts[g.id] || 0;
    const isActive  = filter.has(g.id);
    const isDimmed  = filter.size > 0 && !isActive;
    return (
      <button
        key={g.id}
        type="button"
        className={
          "neo-category-filter-chip"
          + (isActive ? " neo-category-filter-chip-active" : "")
          + (isDimmed ? " neo-category-filter-chip-dimmed" : "")
        }
        onClick={() => toggle(g.id)}
        aria-pressed={isActive}
        title={isActive
          ? `Remove ${g.label} filter`
          : `Filter by ${g.label} (${activeCount} active)`}
        style={isActive
          ? { borderColor: g.color, boxShadow: `0 0 0 1px ${g.color}, 0 0 12px ${g.color}55` }
          : undefined}
      >
        <span
          className="neo-category-filter-dot"
          style={{ background: g.color, boxShadow: isActive ? `0 0 10px ${g.color}` : `0 0 6px ${g.color}` }}
          aria-hidden="true"
        />
        <span className="neo-category-filter-name" style={isActive ? { color: g.color } : undefined}>
          {g.label}
        </span>
        <span className="neo-category-filter-count">{activeCount}</span>
      </button>
    );
  });

  // Visual separator between the status group and the category
  // group — same height as a chip so the row reads as one band.
  const groupSep = <span className="neo-category-filter-sep" aria-hidden="true" />;

  const clearButton = hasAnyFilter ? (
    <button
      type="button"
      className="neo-category-filter-clear"
      onClick={clearAll}
      title="Clear all filters"
    >✕ Clear</button>
  ) : null;

  // Desktop / wide tablet — keep the inline strip, unchanged layout.
  if (!isMobileOrTablet) {
    return (
      <div className="neo-category-filters" role="group" aria-label="Filter problems">
        <span className="neo-category-filters-label">Filters</span>
        {statusChips}
        {groupSep}
        {chips}
        {clearButton}
      </div>
    );
  }

  // Mobile/tablet — disclosure pattern. Header reads as a single
  // tappable summary row; chips expand below into a 2-column grid.
  return (
    <div className="neo-category-filters neo-category-filters-mobile" role="group" aria-label="Filter problems">
      <button
        type="button"
        className="neo-category-filters-toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="cat-filter-panel"
      >
        <span className="neo-category-filters-label">Filters</span>
        <span className={`neo-category-filters-summary${hasAnyFilter ? " neo-category-filters-summary-active" : ""}`}>
          {summary}
        </span>
        <span className="neo-category-filters-caret" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && (
        <div id="cat-filter-panel" className="neo-category-filters-panel">
          {/* Status chips render full-width on their own row so the
              two coarse options dominate before the category grid. */}
          <div className="neo-category-filters-status-row">
            {statusChips}
          </div>
          {chips}
          {clearButton}
        </div>
      )}
    </div>
  );
};
