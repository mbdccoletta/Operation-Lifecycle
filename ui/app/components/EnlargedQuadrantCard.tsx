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

  // ── Show By → subset filter ──────────────────────────────────────
  // User asked (0.0.108) that opening the modal show ONLY the
  // problems matching the current Show By chip (Rising = recent,
  // Oldest = stale, Criticality = severe, Total = all). The rest go
  // into a "+N others" bubble overlay (rendered below the canvas).
  //
  // Per-mode predicate on an active problem:
  //   • rising      → opened in the last hour (matches the cell
  //                   header's +N /1h badge semantically — "the new
  //                   ones"). Slight numerical drift from the badge
  //                   value is expected when problems both opened
  //                   AND closed within the hour.
  //   • open_time   → still active > 4h (the "stuck" threshold the
  //                   AT-A-GLANCE card already uses).
  //   • criticality → severity_level ≥ 4 (high or critical).
  //   • total       → everyone (no filter).
  const shownActive = useMemo(() => {
    const now = Date.now();
    return activeProblems.filter((p) => {
      switch (dataMode) {
        case "rising": {
          const startTs = new Date(p["event.start"]).getTime();
          return startTs >= now - 3_600_000;
        }
        case "open_time": {
          const startTs = new Date(p["event.start"]).getTime();
          return startTs <= now - 4 * 3_600_000;
        }
        case "criticality": {
          const sev = Number((p as { "event.severity_level"?: number | string })["event.severity_level"] ?? 0);
          return sev >= 4;
        }
        case "total":
        default:
          return true;
      }
    });
  }, [activeProblems, dataMode]);

  const restCount = activeProblems.length - shownActive.length;

  // Inner ConstellationView receives the filtered active set + the
  // closed tail (closed problems still feed `risingCats` etc.).
  const shownProblems = useMemo(
    () => [...shownActive, ...closedProblems],
    [shownActive, closedProblems],
  );

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
            <div className="neo-enlarged-quadrant-canvas" style={{ position: "relative" }}>
              {/* 0.0.108: feed the inner ConstellationView only the
                  Show-By-matching active problems + the closed
                  tail. The matching set renders as individual dots;
                  the remainder gets the "+N others" overlay below.
                  `disableAggregation` skips the bubble/cap rules so
                  the inner canvas doesn't re-aggregate the already-
                  filtered subset. */}
              <ConstellationView
                problems={shownProblems}
                onSelect={(p) => onSelectProblem?.(p)}
                dataMode={dataMode}
                groupings={singleGrouping}
                resolveGrouping={resolveGrouping}
                showHub={false}
                showResolvedZone={false}
                disableMagnifierLens
                disableAggregation
                dotScale={1.6}
                /* 0.0.108: opens already zoomed into the single
                   grouping so the cell fills the whole modal canvas
                   in one click (without this the user had to double-
                   click the cell inside the modal to trigger the
                   internal "Exit zoom" mode). `lockExpandedQuadrant`
                   pins the zoom — hides the Exit-zoom button, blocks
                   ESC/double-click from leaving the zoom, and drops
                   the zoom padding so the cell fills the canvas
                   edge-to-edge. The modal's own ✕ button stays the
                   only way out. */
                initialExpandedQuadrant={quadrantId}
                lockExpandedQuadrant
              />
              {restCount > 0 && (
                /* "Rest of the cell" badge — non-matching active
                   problems collapse here so the user can see at a
                   glance how many were grouped vs how many are
                   shown as individual dots. */
                <div
                  className="neo-enlarged-quadrant-rest-bubble"
                  style={{
                    position: "absolute",
                    right: 16,
                    bottom: 16,
                    padding: "8px 14px",
                    borderRadius: 999,
                    background: "rgba(8,12,22,0.78)",
                    border: `1px solid ${accent}`,
                    color: "var(--neo-text)",
                    font: '600 12px/1.2 "SF Mono","JetBrains Mono",monospace',
                    boxShadow: "0 6px 18px rgba(0,0,0,0.32)",
                    pointerEvents: "none",
                    zIndex: 2,
                  }}
                  aria-label={`${restCount} other active problems grouped`}
                >
                  +{restCount.toLocaleString()} others
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
