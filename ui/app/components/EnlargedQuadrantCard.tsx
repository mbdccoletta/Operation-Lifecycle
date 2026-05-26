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
import React, { useEffect, useMemo, useState } from "react";
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

  // ── Drill-down: explode top 10 + keep other modes as bubbles ────
  // 0.0.109 follow-up. User asked: "Ao fazer drill down, explodir
  // problemas da categoria selecionada destacando top 10 e manter
  // demais agrupamentos." The modal becomes a focused explorer for
  // ONE subset at a time:
  //   • Top 10 of the active subset render as individual dots in
  //     the canvas, sorted by the subset's own criterion (Rising =
  //     newest, Stuck = oldest, Critical = highest severity).
  //   • The OTHER 2 subset modes stay as small HTML bubbles
  //     overlaid on the canvas. Click one to switch the modal's
  //     focus to that mode (no re-open needed).
  //   • A "+N more <mode>" badge sits next to the bubbles when the
  //     active subset has more than 10 matching problems — the
  //     user knows how much they're not seeing.
  type SubsetMode = "rising" | "open_time" | "criticality";
  const ALL_MODES: Array<{ mode: SubsetMode; label: string; hint: string }> = [
    { mode: "rising",      label: "Rising",   hint: "Opened in the last hour" },
    { mode: "open_time",   label: "Stuck",    hint: "Active for more than 4 hours" },
    { mode: "criticality", label: "Critical", hint: "Severity 4 or 5" },
  ];
  // Active subset starts from the prop (the bubble the user clicked
  // on the main-page cell) and the user can switch it via the
  // overlay bubbles inside the modal.
  const initialMode: SubsetMode = ALL_MODES.some((m) => m.mode === dataMode)
    ? (dataMode as SubsetMode)
    : "rising";
  const [currentMode, setCurrentMode] = useState<SubsetMode>(initialMode);
  useEffect(() => { setCurrentMode(initialMode); }, [initialMode]);

  const matchesMode = (mode: SubsetMode, p: Problem, now: number): boolean => {
    switch (mode) {
      case "rising":
        return new Date(p["event.start"]).getTime() >= now - 3_600_000;
      case "open_time":
        return new Date(p["event.start"]).getTime() <= now - 4 * 3_600_000;
      case "criticality":
        return Number((p as { "event.severity_level"?: number | string })["event.severity_level"] ?? 0) >= 4;
    }
  };
  const sortForMode = (mode: SubsetMode, list: Problem[]): Problem[] => {
    const arr = [...list];
    switch (mode) {
      case "rising":
        return arr.sort(
          (a, b) =>
            new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime(),
        );
      case "open_time":
        return arr.sort(
          (a, b) =>
            new Date(a["event.start"]).getTime() - new Date(b["event.start"]).getTime(),
        );
      case "criticality":
        return arr.sort((a, b) => {
          const sa = Number((a as { "event.severity_level"?: number | string })["event.severity_level"] ?? 0);
          const sb = Number((b as { "event.severity_level"?: number | string })["event.severity_level"] ?? 0);
          return sb - sa;
        });
    }
  };

  const TOP_N = 10;
  const drilldown = useMemo(() => {
    const now = Date.now();
    const matchingByMode: Record<SubsetMode, Problem[]> = { rising: [], open_time: [], criticality: [] };
    for (const p of activeProblems) {
      for (const { mode } of ALL_MODES) {
        if (matchesMode(mode, p, now)) matchingByMode[mode].push(p);
      }
    }
    const matchingForCurrent = sortForMode(currentMode, matchingByMode[currentMode]);
    const top = matchingForCurrent.slice(0, TOP_N);
    const restOfCurrent = Math.max(0, matchingForCurrent.length - TOP_N);
    return {
      top,
      restOfCurrent,
      counts: {
        rising:      matchingByMode.rising.length,
        open_time:   matchingByMode.open_time.length,
        criticality: matchingByMode.criticality.length,
      } as Record<SubsetMode, number>,
    };
  }, [activeProblems, currentMode]);

  // Inner ConstellationView receives the top 10 of the current mode
  // + the closed tail (still feeds `risingCats` / trend bookkeeping).
  const shownProblems = useMemo(
    () => [...drilldown.top, ...closedProblems],
    [drilldown.top, closedProblems],
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
              {/* 0.0.109 drill-down: inner ConstellationView gets the
                  top 10 of the CURRENT subset mode plus the closed
                  tail. The OTHER two modes stay aggregated as small
                  clickable bubbles in the overlay below. */}
              <ConstellationView
                problems={shownProblems}
                onSelect={(p) => onSelectProblem?.(p)}
                dataMode={currentMode}
                groupings={singleGrouping}
                resolveGrouping={resolveGrouping}
                showHub={false}
                showResolvedZone={false}
                disableMagnifierLens
                disableAggregation
                dotScale={1.6}
                initialExpandedQuadrant={quadrantId}
                lockExpandedQuadrant
              />
              {/* Mode strip — ALL three mode pills shown, with the
                  active one filled + labelled "TOP 10 of N" so the
                  user can't miss what they're looking at (was just
                  the other two modes + a "+N more" badge, which left
                  the active mode implicit). Clicking any inactive
                  pill switches focus. */}
              <div
                style={{
                  position: "absolute",
                  right: 16,
                  bottom: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  pointerEvents: "auto",
                  zIndex: 2,
                }}
              >
                {ALL_MODES.map((m) => {
                  const count = drilldown.counts[m.mode];
                  const isActive = m.mode === currentMode;
                  const shownTop = isActive ? Math.min(TOP_N, count) : 0;
                  return (
                    <button
                      key={m.mode}
                      type="button"
                      onClick={() => !isActive && count > 0 && setCurrentMode(m.mode)}
                      title={isActive
                        ? `Currently showing top ${shownTop} of ${count} ${m.label.toLowerCase()}`
                        : (count > 0 ? `${m.hint} — switch to ${m.label}` : `No ${m.label.toLowerCase()} problems`)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: isActive ? "8px 14px" : "6px 12px",
                        borderRadius: 999,
                        background: isActive
                          ? accent
                          : (count > 0 ? "rgba(8,12,22,0.78)" : "rgba(8,12,22,0.4)"),
                        border: `1px solid ${accent}`,
                        color: isActive
                          ? "#0b0f1a"
                          : (count > 0 ? "var(--neo-text)" : "var(--neo-text-3)"),
                        font: '600 12px/1.2 "Inter", system-ui, sans-serif',
                        cursor: isActive ? "default" : (count > 0 ? "pointer" : "default"),
                        opacity: count > 0 ? 1 : 0.55,
                        boxShadow: isActive
                          ? `0 0 16px ${accent}66`
                          : "0 4px 12px rgba(0,0,0,0.25)",
                        userSelect: "none",
                      }}
                      disabled={count === 0 && !isActive}
                      aria-pressed={isActive}
                    >
                      {isActive && (
                        <span style={{
                          font: '700 10px/1 "SF Mono","JetBrains Mono",monospace',
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: "rgba(0,0,0,0.18)",
                          letterSpacing: "0.04em",
                        }}>
                          TOP {shownTop}
                        </span>
                      )}
                      <span style={{ fontWeight: isActive ? 700 : 600 }}>{m.label}</span>
                      <span style={{
                        fontFamily: '"SF Mono","JetBrains Mono",monospace',
                        fontWeight: 700,
                      }}>
                        {isActive
                          ? `of ${count.toLocaleString()}`
                          : count.toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
