// Centered modal that shows one quadrant at enlarged size by
// rendering an actual `<ConstellationView>` inside the modal body
// configured to display only that single grouping. The grouping
// can be a Davis category OR a tenant segment — the host page
// passes the active `groupings` list + a `resolveGrouping`
// resolver so this component stays dimension-agnostic.
//
// This is the only path that preserves 100 % of the inline cell's
// characteristics (dot positioning algorithm, pulse, halo, glow,
// inner highlight, ★ TOP / ▲ UP / ▼ DOWN badges, hover lens,
// score-based ranking, deterministic layout).
//
// Lifecycle:
//   • Click on a dot → drill down to the list (host wires
//     `onSelectProblem`, which closes the modal and pins the row).
//   • Backdrop click → close.
//   • ESC → close.
import React, { useEffect, useMemo } from "react";
import { Problem } from "../hooks/useProblems";
import { getCategoryIcon } from "../utils/formatters";
import { CATEGORY_GROUPINGS, resolveByCategory, type Grouping } from "../utils/grouping";
import { ConstellationView, type ConstellationDataMode } from "./ConstellationView";

export interface EnlargedQuadrantCardProps {
  /** ID of the grouping being expanded — matches one of the entries
   *  in the `groupings` array. For category mode this is a Davis
   *  category name (e.g. "AVAILABILITY"); for segment mode it's the
   *  segment UID (or UNASSIGNED_GROUPING.id). */
  quadrantId: string;
  problems: Problem[];
  /** Full list of groupings the host is rendering. Used to look up
   *  the expanded grouping's label + colour (so segments display
   *  their tenant name instead of a UID). Defaults to the six
   *  Davis categories — keeps the component usable as a drop-in
   *  for category-mode hosts that haven't migrated yet. */
  groupings?: Grouping[];
  /** Resolver that decides which grouping a problem belongs to —
   *  category-by-attribute for the default mode, segment-by-
   *  membership-set in segment mode. Used both to (a) filter
   *  problems to this quadrant and (b) pass through to the inner
   *  ConstellationView so its rendering matches what the inline
   *  cell did. */
  resolveGrouping?: (p: Problem) => string | null;
  /** Picks which dots get the TOP focus ring — should match the
   *  page's active Show By mode so the same incidents are
   *  highlighted across views. */
  dataMode?: ConstellationDataMode;
  /** Fires when the user clicks a dot. The host page is expected
   *  to (a) close this card and (b) pin the chosen problem in the
   *  list. See `onQuadrantProblemSelect` in Overview.tsx. */
  onSelectProblem?: (problem: Problem) => void;
  onClose: () => void;
}

export const EnlargedQuadrantCard = ({
  quadrantId,
  problems,
  groupings = CATEGORY_GROUPINGS,
  resolveGrouping = resolveByCategory,
  dataMode = "criticality",
  onSelectProblem,
  onClose,
}: EnlargedQuadrantCardProps) => {
  // ESC closes — same shortcut every other modal uses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Resolve the grouping metadata from the host-provided list.
  // Falls back to a synthetic grouping if the id isn't in the
  // active list (shouldn't happen — defensive).
  const grouping = useMemo(
    () => groupings.find((g) => g.id === quadrantId)
      ?? { id: quadrantId, label: quadrantId, color: "#6366f1" },
    [groupings, quadrantId],
  );
  const accent = grouping.color;

  // Filter the FULL category problem set (active + closed) using
  // the host's resolver. ConstellationView still filters by
  // status internally when rendering dots; passing both keeps the
  // `risingCats` trend calc consistent with the inline cell.
  const quadProblems = useMemo(
    () => problems.filter((p) => resolveGrouping(p) === quadrantId),
    [problems, quadrantId, resolveGrouping],
  );
  const activeProblems = quadProblems.filter((p) => p["event.status"] === "ACTIVE");
  const closedProblems = quadProblems.filter((p) => p["event.status"] === "CLOSED");

  // Single-grouping array we feed to the inner ConstellationView
  // so it lays out ONE quadrant filling the canvas.
  const singleGrouping: Grouping[] = useMemo(() => [grouping], [grouping]);

  return (
    <div className="neo-enlarged-quadrant-backdrop" onClick={onClose} role="presentation">
      <div
        className="neo-enlarged-quadrant"
        role="dialog"
        aria-modal="true"
        aria-label={`Enlarged view of ${grouping.label}`}
        onClick={(e) => e.stopPropagation()}
        style={{ borderColor: accent, ["--quadrant-accent" as string]: accent }}
      >
        <header className="neo-enlarged-quadrant-head">
          <span className="neo-enlarged-quadrant-icon" style={{ color: accent }} aria-hidden="true">
            {getCategoryIcon(quadrantId)}
          </span>
          <h2 className="neo-enlarged-quadrant-title" style={{ color: accent }}>
            {grouping.label}
          </h2>
          <span className="neo-enlarged-quadrant-bignum">{activeProblems.length}</span>
          <span className="neo-enlarged-quadrant-suffix">active</span>
          {closedProblems.length > 0 && (
            <>
              <span aria-hidden="true" className="neo-enlarged-quadrant-sep">·</span>
              <span className="neo-enlarged-quadrant-suffix">
                <strong>{closedProblems.length}</strong> closed
              </span>
            </>
          )}
          <button
            type="button"
            className="neo-enlarged-quadrant-close"
            onClick={onClose}
            aria-label="Close enlarged view (Esc)"
          >
            ✕
          </button>
        </header>

        <div className="neo-enlarged-quadrant-body">
          {activeProblems.length === 0 ? (
            <div className="neo-enlarged-quadrant-empty">
              No active problems in this {grouping.label.toLowerCase()}.
            </div>
          ) : (
            <div className="neo-enlarged-quadrant-canvas">
              {/* Pass the FULL quadrant problem set (active +
                  closed) so ConstellationView's `risingCats` trend
                  calc has the historical baseline it needs.
                  Internally the canvas only paints ACTIVE dots; the
                  closed ones just inform whether the category is
                  "rising" right now (matches the inline cell). */}
              <ConstellationView
                problems={quadProblems}
                onSelect={(p) => onSelectProblem?.(p)}
                dataMode={dataMode}
                groupings={singleGrouping}
                resolveGrouping={resolveGrouping}
                showHub={false}
                showResolvedZone={false}
                disableMagnifierLens
                dotScale={1.6}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
