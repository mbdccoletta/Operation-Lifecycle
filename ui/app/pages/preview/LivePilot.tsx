// LivePilot — pilot Tab 1.
//
// Reuses `<Overview>` end-to-end (real data, real list, real
// expand/drill-downs, real refresh + countdown). The pilot
// difference vs the current Incidents page:
//
//   • No separate "Segments" tab — segment grouping is exposed as a
//     toggle the user opts into inside this single view.
//   • Constellation toggle is preserved on desktop. On mobile the
//     existing CSS (`@media (max-width: 768px)`) already hides it.
//   • Same TimeRange / Category / Segments contexts as the rest of
//     the app, so toggling between current and pilot doesn't reset
//     the user's selection.
//
// We use the URL state already supported by Overview
// (`?groupBy=segment`) so this is a thin shell over the existing
// component — proves the consolidation is real and viable, not a
// mock.
import React, { useState } from "react";
import { Overview } from "../Overview";

/** Top-of-page chip strip — lets the user choose how to slice the
 *  live view (the two modes that used to be separate tabs in the
 *  current app). Defaults to "By category" since that's the most
 *  common entry point for triage. */
const SliceChips = ({
  groupBy,
  onChange,
}: {
  groupBy: "category" | "segment";
  onChange: (next: "category" | "segment") => void;
}) => (
  <div className="neo-preview-slice" role="tablist" aria-label="Live view grouping">
    <button
      type="button"
      role="tab"
      aria-selected={groupBy === "category"}
      className={`neo-preview-slice-chip${groupBy === "category" ? " active" : ""}`}
      onClick={() => onChange("category")}
    >
      By category
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={groupBy === "segment"}
      className={`neo-preview-slice-chip${groupBy === "segment" ? " active" : ""}`}
      onClick={() => onChange("segment")}
    >
      By segment
    </button>
  </div>
);

export const LivePilot = () => {
  // Local slice state — not URL-persisted on purpose so refreshing
  // the pilot resets to the recommended default (by category). The
  // current app persists `groupBy` via the route itself
  // (/segments vs /), which is what we're proving we can drop.
  const [groupBy, setGroupBy] = useState<"category" | "segment">("category");

  return (
    <div className="neo-preview-page">
      <SliceChips groupBy={groupBy} onChange={setGroupBy} />
      {/* Re-mount `<Overview>` when the slice changes so it re-
          initialises its internal viewMode/selection state from
          scratch — matches what users get today when they navigate
          between /incidents and /segments. */}
      <Overview key={groupBy} groupBy={groupBy} />
    </div>
  );
};
