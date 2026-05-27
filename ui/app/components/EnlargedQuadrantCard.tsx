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
import { useStuckProblemsByCategory } from "../hooks/useStuckProblemsByCategory";
import { getCategoryIcon } from "../utils/formatters";
import { CATEGORY_GROUPINGS, resolveByCategory, type Grouping } from "../utils/grouping";
import { ConstellationView, type ConstellationDataMode } from "./ConstellationView";

/** Pick a high-contrast text colour for a filled pill whose
 *  background is the category accent. Uses the YIQ luminance
 *  approximation — bright accents (lime, yellow, cyan around the
 *  140-200 band) keep navy text; darker accents (saturated blue,
 *  violet) flip to white. Threshold tuned for our 6 category
 *  palette so AVAILABILITY (#a3e635) and CUSTOM_ALERT (#22d3ee)
 *  both clear the bar with dark text. */
const pickActiveTextColor = (hex: string): string => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  if (!m) return "#0b0f1a";
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#0b0f1a" : "#ffffff";
};

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
  /** 0.0.127 — Fires when the user clicks the "Total" pill at the
   *  bottom of the modal. Host is expected to close the modal and
   *  switch to LIST view filtered by `groupingId` (the modal's
   *  category). Other filters (status, stuck-hours, segment, etc.)
   *  should be cleared. The user reads Total as "see every
   *  problem from THIS category, regardless of Rising/Stuck split". */
  onDrilldownToList?: (groupingId: string) => void;
  /** 0.0.130 — authoritative active/closed counts for this category
   *  pulled from the count-query (`useStatusCategoryCounts`). When
   *  provided, the modal headline + Total pill use these instead of
   *  deriving from the (capped) `problems` array. Without this prop
   *  a tenant with 1 574 active RESOURCE_CONTENTION problems would
   *  see the canvas cell show "1 574 active" (count-query) but the
   *  modal headline show "6 active" (whatever made it into the first
   *  250-row first-paint sample). Optional so dev/test hosts that
   *  don't run the count query still render. */
  categoryCounts?: { active: number; closed: number; stuck?: number };
  /** 0.0.142 — timeframe context for the on-demand stuck-by-category
   *  fetch. Same shape useProblems accepts. When the user lands on
   *  the Stuck pill the modal fires a focused DQL to retrieve the
   *  oldest active problems in this category (the main list's first-
   *  paint sample is heavily biased toward fresh problems and rarely
   *  contains any 4h+ rows for busy cells). */
  stuckFetch?: {
    timeframe?: string;
    from?: string;
    to?: string;
  };
  onClose: () => void;
}

export const EnlargedQuadrantCard = ({
  quadrantId,
  problems,
  groupings = CATEGORY_GROUPINGS,
  resolveGrouping = resolveByCategory,
  dataMode = "criticality",
  onSelectProblem,
  onDrilldownToList,
  categoryCounts,
  stuckFetch,
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
  // 0.0.130 — authoritative counts when the host passes the
  // count-query override (matches what the canvas cell prints).
  // Falls back to list-derived numbers so dev/standalone uses still
  // work. Rising/Stuck pills below still derive from `activeProblems`
  // because the count query doesn't carry the 1h split — they
  // remain "sample of the list" numbers and are bounded above by
  // `displayedActive` so they never claim more than the headline.
  const displayedActive = categoryCounts?.active ?? activeProblems.length;
  const displayedClosed = categoryCounts?.closed ?? closedProblems.length;

  // 0.0.118 — compute the trend `(recent, older)` from the FULL
  // category set so the inner ConstellationView's seal + comet
  // animation match what the main view shows. Without this, the
  // canvas only sees the top-50 + closed slice and the math
  // disagrees (closed problems inflate `older` and flip the
  // direction). User: "vejo up aqui e animacaoe sem up aqui."
  //
  // 0.0.132 — also drives the Rising drilldown slice (see below).
  // Moved up from below `drilldown` so the latter can consume it.
  const quadTrend = useMemo(() => {
    const WINDOW_MS = 3_600_000;
    const tCut = Date.now() - WINDOW_MS;
    let recent = 0, older = 0;
    for (const p of quadProblems) {
      const startTs = new Date(p["event.start"]).getTime();
      const endTs   = p["event.end"] ? new Date(p["event.end"]).getTime() : null;
      const isActiveNow    = p["event.status"] === "ACTIVE";
      const wasActiveAtCut = startTs <= tCut && (isActiveNow || (endTs !== null && endTs > tCut));
      if (isActiveNow)    recent++;
      if (wasActiveAtCut) older++;
    }
    return { recent, older };
  }, [quadProblems]);
  const trendDelta = quadTrend.recent - quadTrend.older;
  const risingDelta = Math.max(0, trendDelta);

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
    { mode: "criticality", label: "Total",    hint: "All active problems in this category" },
  ];
  // Active subset starts from the prop (the bubble the user clicked
  // on the main-page cell) and the user can switch it via the
  // overlay bubbles inside the modal.
  const initialMode: SubsetMode = ALL_MODES.some((m) => m.mode === dataMode)
    ? (dataMode as SubsetMode)
    : "rising";
  const [currentMode, setCurrentMode] = useState<SubsetMode>(initialMode);
  useEffect(() => { setCurrentMode(initialMode); }, [initialMode]);

  // 0.0.115 — third mode is now "Total" (was "Critical"). Matches
  // all active problems in the cell regardless of category or age.
  // Mode name stays "criticality" internally to avoid a refactor
  // cascade — only the UI label changed.
  //
  // 0.0.132 — Rising is now a DELTA mode (max(0, recent − older)),
  // not a predicate match. The Rising set is built outside this
  // function by slicing the `risingDelta` newest active problems.
  // This predicate only owns Stuck + Total.
  // 0.0.133 — Stuck = active > 4h (canonical app threshold, matches
  // TrendAnalysis + analyticsKpis stuckHours=4 + chip hint text).
  // Was incorrectly using 1h here; problems aged 1-4h are now in
  // neither Rising (delta) nor Stuck and surface only via Total.
  const STUCK_MS = 4 * 3_600_000;
  const matchesMode = (mode: SubsetMode, p: Problem, now: number): boolean => {
    if (mode === "criticality") return true;          // Total — all active
    if (mode === "rising")      return false;         // see slice below
    const startTs = new Date(p["event.start"]).getTime();
    return startTs < now - STUCK_MS;                  // Stuck — active > 4h
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
        // Total list — newest first so the most recent additions
        // surface at the top.
        return arr.sort(
          (a, b) =>
            new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime(),
        );
    }
  };

  // User 0.0.109: "ao fazer drilldown mostrar top 50." Was 10.
  const TOP_N = 50;

  // 0.0.142 — on-demand fetch of the oldest active problems for
  // this category. Only fires when the modal is open AND the user
  // has the Stuck pill selected — pays the ~0.05 DPS hit on user
  // interaction, not on every page refresh. Without this hook the
  // modal had no Stuck dots to render whenever the first-paint
  // sample (250 newest globally) contained no 4h+ rows for the
  // category, which is the common case on busy cells like ERROR.
  // User: "Nao esta mostrando os stucks."
  const stuckFetchEnabled =
    currentMode === "open_time" &&
    (categoryCounts?.stuck ?? 0) > 0;
  const { problems: fetchedStuckProblems } = useStuckProblemsByCategory({
    category: quadrantId,
    timeframe: stuckFetch?.timeframe,
    from: stuckFetch?.from,
    to: stuckFetch?.to,
    limit: TOP_N,
    enabled: stuckFetchEnabled,
  });

  const drilldown = useMemo(() => {
    const now = Date.now();
    const matchingByMode: Record<SubsetMode, Problem[]> = { rising: [], open_time: [], criticality: [] };
    for (const p of activeProblems) {
      for (const { mode } of ALL_MODES) {
        if (matchesMode(mode, p, now)) matchingByMode[mode].push(p);
      }
    }
    // 0.0.132 — Rising set = the `risingDelta` newest active
    // problems. Mirrors the canvas cell's Rising bubble (which now
    // shows the +N delta). When delta is 0 the modal shows zero
    // rising dots, matching the cell's absence of a Rising bubble.
    // User: "se tenho 3 ativos e 2 rising, destacar os 2 rising no
    // top central" — exactly this slice.
    const activeByStartDesc = [...activeProblems].sort(
      (a, b) =>
        new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime(),
    );
    matchingByMode.rising = activeByStartDesc.slice(0, risingDelta);

    // 0.0.142 — overlay the focused stuck-fetch result onto the
    // sample-derived list. Dedup by display_id so a problem present
    // in BOTH the global sample and the focused fetch counts once.
    if (fetchedStuckProblems.length > 0) {
      const sampleStuckIds = new Set(matchingByMode.open_time.map((p) => p.display_id));
      const extras = fetchedStuckProblems.filter((p) => !sampleStuckIds.has(p.display_id));
      matchingByMode.open_time = [...matchingByMode.open_time, ...extras];
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
  }, [activeProblems, currentMode, risingDelta, fetchedStuckProblems]);

  // Inner ConstellationView receives the top 10 of the current mode
  // + the closed tail (still feeds `risingCats` / trend bookkeeping).
  const shownProblems = useMemo(
    () => [...drilldown.top, ...closedProblems],
    [drilldown.top, closedProblems],
  );

  // quadTrend / trendDelta / risingDelta are now declared above —
  // drilldown needs `risingDelta` to slice the Rising set. Only the
  // override wrapper remains here.
  const trendOverride = useMemo(
    () => ({ [quadrantId]: quadTrend }),
    [quadrantId, quadTrend],
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
          <span className="neo-enlarged-quadrant-bignum">{displayedActive}</span>
          <span className="neo-enlarged-quadrant-suffix">active</span>
          {/* 0.0.118 — surface the same ▲/▼ trend the main view
              shows, computed from the FULL category set (not the
              top-50 slice). Hidden when delta is zero. */}
          {trendDelta !== 0 && (
            <span
              className="neo-enlarged-quadrant-suffix"
              style={{
                color: trendDelta > 0 ? "#ff4d6a" : "#22d3a0",
                marginLeft: 8,
                fontWeight: 600,
              }}
              title={`${trendDelta > 0 ? "Rising" : "Falling"} — ${quadTrend.recent} now vs ${quadTrend.older} an hour ago`}
            >
              {trendDelta > 0 ? "▲" : "▼"} {trendDelta > 0 ? `+${trendDelta}` : trendDelta} /1h
            </span>
          )}
          {displayedClosed > 0 && (
            <>
              <span aria-hidden="true" className="neo-enlarged-quadrant-sep">·</span>
              <span className="neo-enlarged-quadrant-suffix">
                <strong>{displayedClosed}</strong> closed
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
                catTrendOverride={trendOverride}
              />
              {/* 0.0.117 — gradient backdrop strip behind the mode
                  pills. Without it, dots placed near the bottom-right
                  of the canvas peek through the gaps BETWEEN pills
                  and look like the chip is sitting on top of a dot
                  ("bolinha sobreposta"). The gradient fades the
                  background to opaque toward the bottom so the dot
                  field appears to recede into a hud strip rather
                  than being abruptly cut. Sits below the pills in
                  the z-stack (zIndex 1 vs 2). */}
              <div
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 72,
                  background:
                    "linear-gradient(to top, var(--neo-bg) 55%, rgba(11,15,26,0) 100%)",
                  pointerEvents: "none",
                  zIndex: 1,
                }}
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
                  // 0.0.130 — for the Total ("criticality") pill, swap
                  // the sample-derived count for the authoritative
                  // category total when the host provided one. Keeps
                  // the modal headline (1 574 active) and the Total
                  // pill (1 574) reading the same number.
                  // 0.0.137 — Stuck pill also gets the authoritative
                  // count (categoryCounts.stuck) from the same query,
                  // so it stops collapsing to 0 when the cell's
                  // loaded sample is all <4h (busy categories).
                  // Rising stays sample-derived since the count query
                  // doesn't carry a 1h split for the delta.
                  const count = m.mode === "criticality"
                    ? displayedActive
                    : (m.mode === "open_time" && typeof categoryCounts?.stuck === "number"
                        ? categoryCounts.stuck
                        : drilldown.counts[m.mode]);
                  const isActive = m.mode === currentMode;
                  const shownTop = isActive ? Math.min(TOP_N, count) : 0;
                  // 0.0.109 follow-up — pick the active pill's text
                  // colour by accent luminance (YIQ). User reported
                  // "não consigo ler" on AVAILABILITY's lime green
                  // because dark navy at 10-12 px against a bright
                  // saturated accent was illegible. Bright accents
                  // (lime, yellow, cyan) keep dark navy; darker
                  // accents (blue, purple) flip to white. The "TOP N"
                  // inset gets a stronger backplate so it stands
                  // apart from the pill body regardless of accent.
                  const activeTextColor = pickActiveTextColor(accent);
                  const insetBg = activeTextColor === "#0b0f1a"
                    ? "rgba(0,0,0,0.32)"
                    : "rgba(255,255,255,0.22)";
                  // 0.0.127 — Total pill acts as a drilldown to the
                  // raw list (no filters). User: "Botao Total da
                  // area expandida dele fazer drilldown para a list
                  // sem filtros." For Rising / Stuck the pill keeps
                  // its in-modal mode-switch behaviour.
                  const isTotalEscape = m.mode === "criticality" && !!onDrilldownToList;
                  return (
                    <button
                      key={m.mode}
                      type="button"
                      onClick={() => {
                        if (isTotalEscape) {
                          onDrilldownToList!(quadrantId);
                          return;
                        }
                        if (!isActive && count > 0) setCurrentMode(m.mode);
                      }}
                      title={isTotalEscape
                        ? `Open the list filtered by ${grouping.label}`
                        : (isActive
                            ? `Currently showing top ${shownTop} of ${count} ${m.label.toLowerCase()}`
                            : (count > 0 ? `${m.hint} — switch to ${m.label}` : `No ${m.label.toLowerCase()} problems`))}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 7,
                        padding: isActive ? "9px 15px" : "7px 13px",
                        borderRadius: 999,
                        // Fully opaque pill backgrounds + backdrop
                        // blur so canvas animation behind the strip
                        // (highlighted bubble's dashed ring) doesn't
                        // bleed THROUGH the pill text. User reported
                        // "animação não deve sobrepor texto".
                        background: isActive
                          ? accent
                          : (count > 0 ? "rgba(11,15,26,0.96)" : "rgba(11,15,26,0.85)"),
                        backdropFilter: "blur(6px)",
                        WebkitBackdropFilter: "blur(6px)",
                        border: `1px solid ${accent}`,
                        color: isActive
                          ? activeTextColor
                          : (count > 0 ? "var(--neo-text)" : "var(--neo-text-3)"),
                        font: '600 13px/1.2 "Inter", system-ui, sans-serif',
                        cursor: isActive ? "default" : (count > 0 ? "pointer" : "default"),
                        opacity: count > 0 ? 1 : 0.55,
                        // No box-shadow glow on the active pill —
                        // the glow extended ~16 px into the
                        // neighbouring pills and overlapped their
                        // text. The accent fill + thicker padding
                        // already differentiate it.
                        boxShadow: "none",
                        userSelect: "none",
                      }}
                      disabled={count === 0 && !isActive && !isTotalEscape}
                      aria-pressed={isActive}
                    >
                      {isActive && (
                        <span style={{
                          font: '700 11px/1 "SF Mono","JetBrains Mono",monospace',
                          padding: "3px 7px",
                          borderRadius: 4,
                          background: insetBg,
                          letterSpacing: "0.05em",
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
