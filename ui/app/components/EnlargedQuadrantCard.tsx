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
import { useRisingProblemsByCategory } from "../hooks/useRisingProblemsByCategory";
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
  /** 0.0.169 — `rising` added: server-authoritative count of
   *  newly arrived ACTIVE problems (= ACTIVE - OLDER per category).
   *  Used by the Rising pill so its number always matches the cell
   *  bubble even when the 250-row sample misses the actual rising
   *  rows. */
  /** 0.0.186 — `newlyStarted` added: server count of ACTIVE problems
   *  whose `event.start` is within the last 1 h. After v0.0.185
   *  the cell Rising bubble started reading this (so the visual cue
   *  fires whenever new problems arrive even if closures matched).
   *  The modal must also consume it for gating the focused Rising
   *  fetch and sizing the canvas slice — otherwise clicking a cell
   *  whose bubble reads "Rising 18" opens a modal that paints
   *  ZERO dots (because `rising`, the net delta, collapsed to 0).
   *  `rising` (the net delta) is kept for the modal HEADER's
   *  `▲/▼ N/1h` trend arrow so queue direction stays visible. */
  categoryCounts?: { active: number; closed: number; stuck?: number; rising?: number; newlyStarted?: number; older?: number };
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
    stuckCutoff?: string;
  };
  /** 0.0.169 — timeframe context for the on-demand rising-by-category
   *  fetch. Mirrors `stuckFetch` — sample-bound Rising slice is
   *  augmented by this focused fetch so the canvas shows the real
   *  newly-arrived problems even when the global sample missed them. */
  risingFetch?: {
    timeframe?: string;
    from?: string;
    to?: string;
  };
  /** 0.0.148 — ms timestamp before which an ACTIVE problem qualifies
   *  as Stuck. Derived from the user-selected timeframe by the host.
   *  Falls back to `now() - 4h` when omitted. */
  stuckCutoffMs?: number;
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
  risingFetch,
  stuckCutoffMs,
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
  // 0.0.148 — Stuck cutoff comes from the host (timeframe-aware) so
  // every Stuck-aware path inside the modal (sampleStuck below,
  // matchesMode in drilldown) reads from the same source. Defensive
  // 4h fallback when host doesn't supply one.
  const stuckCutoff = stuckCutoffMs ?? Date.now() - 4 * 3_600_000;
  // 0.0.145 — surface Stuck count in the modal header. Authoritative
  // value comes from useStatusCategoryCounts.STUCK (sum of ACTIVE &
  // start < stuckCutoff, per category). Falls back to a sample-
  // derived count when no override is available.
  const sampleStuck = useMemo(() => {
    return activeProblems.reduce(
      (n, p) => (new Date(p["event.start"]).getTime() < stuckCutoff ? n + 1 : n),
      0,
    );
  }, [activeProblems, stuckCutoff]);
  const displayedStuck = categoryCounts?.stuck ?? sampleStuck;

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
  // 0.0.195 — Compute the SIGNED net delta from `active - older`
  // when both are available, so the header arrow can show `▼-22`
  // (and the decomposition line below it can split that into
  // "16 arrived, 38 closed in 1h"). Previously we used
  // categoryCounts.rising which was `max(0, ACTIVE-OLDER)` —
  // never negative — and fell through to the sample-derived
  // quadTrend for falling categories. The new pair (active +
  // older) gives a server-authoritative signed delta everywhere.
  const trendDelta =
    (typeof categoryCounts?.active === "number" && typeof categoryCounts?.older === "number")
      ? categoryCounts.active - categoryCounts.older
      : (typeof categoryCounts?.rising === "number")
        ? categoryCounts.rising
        : (quadTrend.recent - quadTrend.older);
  const risingDelta = Math.max(0, trendDelta);
  // 0.0.195 — Decomposition for the header subtitle:
  //   net_delta = newly_started_1h − closed_from_active_1h
  // So:
  //   closed_from_active_1h = newly_started_1h − net_delta
  // (where newly_started_1h = ACTIVE problems opened in the last
  // hour, and closed_from_active_1h = problems that were ACTIVE 1 h
  // ago and have since closed in the last hour). The two together
  // explain how the queue moved by `net_delta`.
  const newlyStartedFor1h = typeof categoryCounts?.newlyStarted === "number"
    ? categoryCounts.newlyStarted
    : null;
  const closedFromOldFor1h = (newlyStartedFor1h !== null)
    ? Math.max(0, newlyStartedFor1h - trendDelta)
    : null;

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
  // stuckCutoff was hoisted up above for the header's sampleStuck.
  const matchesMode = (mode: SubsetMode, p: Problem): boolean => {
    if (mode === "criticality") return true;          // Total — all active
    if (mode === "rising")      return false;         // see slice below
    const startTs = new Date(p["event.start"]).getTime();
    return startTs < stuckCutoff;                     // Stuck — started before timeframe
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
  // 0.0.165 — back to top-10 per user request ("apresentando ao
  // centro os top 10 mais relevantes").
  // 0.0.174 — back to 50 per follow-up: "ao fazer drill down,
  // deveriamos ver os top 50 e os top 10 dos top 50 no centro.
  // Estou vendo apenas os top 10." The inner ConstellationView caps
  // its top-tier ring (the visual leaderboard highlight) at
  // MAX_TIER_PER_CAT = 10 in its `disableAggregation` branch, so
  // passing 50 dots here gives the user both: a dense scatter of the
  // 50 most relevant + the top 10 of those 50 visually elevated at
  // center. The on-demand stuck/rising fetches also cap at this N so
  // the focused queries deliver the same window the modal renders.
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
    stuckCutoff: stuckFetch?.stuckCutoff,
    limit: TOP_N,
    enabled: stuckFetchEnabled,
  });

  // 0.0.169 — on-demand fetch of the newest active problems
  // (Rising). Same gating pattern: only fires when modal is on the
  // Rising pill AND the count override says there's something to
  // show. Bridges the 250-row sample gap for busy categories where
  // the global newest-N doesn't include this category's recent
  // arrivals.
  // 0.0.186 — gate on `newlyStarted` (server count of arrivals in
  // 1 h) instead of `rising` (net delta). Otherwise a category
  // whose closures matched its arrivals would have rising = 0 and
  // the fetch would never fire, leaving the canvas empty even
  // though the cell bubble showed N new problems.
  const risingFetchEnabled =
    currentMode === "rising" &&
    (categoryCounts?.newlyStarted ?? categoryCounts?.rising ?? 0) > 0;
  const { problems: fetchedRisingProblems } = useRisingProblemsByCategory({
    category: quadrantId,
    timeframe: risingFetch?.timeframe,
    from: risingFetch?.from,
    to: risingFetch?.to,
    limit: TOP_N,
    enabled: risingFetchEnabled,
  });

  const drilldown = useMemo(() => {
    const matchingByMode: Record<SubsetMode, Problem[]> = { rising: [], open_time: [], criticality: [] };
    for (const p of activeProblems) {
      for (const { mode } of ALL_MODES) {
        if (matchesMode(mode, p)) matchingByMode[mode].push(p);
      }
    }
    // 0.0.132 — Rising set = the newest active problems. Prefer the
    // server-authoritative count (`categoryCounts.rising`) when
    // available so the slice size matches the cell bubble even on
    // tenants where the 250-row sample undercounts.
    // 0.0.186 — use `newlyStarted` here. The bubble + canvas semantic
    // is now "problems that arrived in the last hour" (always >= 0),
    // not the net delta (which can collapse to 0 even when 18 new
    // ones arrived). Falls back to `rising` for backwards compat
    // when the host hasn't populated newlyStarted yet.
    const authoritativeRising =
      (typeof categoryCounts?.newlyStarted === "number")
        ? categoryCounts.newlyStarted
        : (typeof categoryCounts?.rising === "number")
          ? categoryCounts.rising
          : risingDelta;
    const activeByStartDesc = [...activeProblems].sort(
      (a, b) =>
        new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime(),
    );
    matchingByMode.rising = activeByStartDesc.slice(0, authoritativeRising);

    // 0.0.142 — overlay the focused stuck-fetch result onto the
    // sample-derived list. Dedup by display_id so a problem present
    // in BOTH the global sample and the focused fetch counts once.
    if (fetchedStuckProblems.length > 0) {
      const sampleStuckIds = new Set(matchingByMode.open_time.map((p) => p.display_id));
      const extras = fetchedStuckProblems.filter((p) => !sampleStuckIds.has(p.display_id));
      matchingByMode.open_time = [...matchingByMode.open_time, ...extras];
    }

    // 0.0.169 — same overlay pattern for Rising. The focused fetch
    // returns the top-N newest ACTIVE rows for this category from
    // Grail; merging fills any gap left by the global sample.
    if (fetchedRisingProblems.length > 0) {
      const sampleRisingIds = new Set(matchingByMode.rising.map((p) => p.display_id));
      const extras = fetchedRisingProblems.filter((p) => !sampleRisingIds.has(p.display_id));
      matchingByMode.rising = [...matchingByMode.rising, ...extras];
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
  }, [activeProblems, currentMode, risingDelta, fetchedStuckProblems, fetchedRisingProblems, stuckCutoff, categoryCounts?.rising, categoryCounts?.newlyStarted]);

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
          {/* 0.0.145 — Stuck count (active > 4h) in the header. Tinted
              with the chip's red accent so the eye finds it as a
              risk signal next to the neutral Closed count. */}
          {displayedStuck > 0 && (
            <>
              <span aria-hidden="true" className="neo-enlarged-quadrant-sep">·</span>
              <span
                className="neo-enlarged-quadrant-suffix"
                title={`${displayedStuck} active for more than 4 hours`}
              >
                <strong style={{ color: "#ff4d6a" }}>{displayedStuck}</strong> stuck
              </span>
            </>
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

        {/* 0.0.195 — Decomposition sub-header. Renders only when
            BOTH signals are non-trivial: there are arrivals in the
            last hour AND the net queue movement is non-zero.
            Reads as "16 arrived · 38 closed · queue shrank by 22 in
            1 h" — explains how `▼-22` and `Rising 16` coexist
            instead of looking contradictory. User: "como devo
            interpretar a tendencia de down com rising ao mesmo
            tempo?" */}
        {newlyStartedFor1h !== null && newlyStartedFor1h > 0 && trendDelta !== 0 && closedFromOldFor1h !== null && (
          <div
            aria-live="polite"
            style={{
              padding: "6px 24px 10px",
              fontSize: 11,
              fontFamily: '"SF Mono","JetBrains Mono",monospace',
              color: "var(--neo-text-3)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              borderBottom: "1px dashed rgba(255,255,255,0.06)",
            }}
            title="Net queue movement decomposed: arrivals minus closures of previously-active problems"
          >
            <span style={{ color: "#ff4d6a", fontWeight: 600 }}>
              {newlyStartedFor1h.toLocaleString()} arrived
            </span>
            <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
            <span style={{ color: "#22d3a0", fontWeight: 600 }}>
              {closedFromOldFor1h.toLocaleString()} closed
            </span>
            <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
            <span style={{ color: "var(--neo-text-2)" }}>
              queue {trendDelta > 0 ? "grew by" : "shrank by"}{" "}
              <strong style={{ color: trendDelta > 0 ? "#ff4d6a" : "#22d3a0" }}>
                {Math.abs(trendDelta)}
              </strong>{" "}
              in 1h
            </span>
          </div>
        )}

        <div className="neo-enlarged-quadrant-body">
          {/* 0.0.171 — empty-state gate uses the AUTHORITATIVE
              active count (categoryCounts.active from the count
              query), not just the local sample. On wide timeframes
              (e.g. 365 days) the sample of 250 newest globally is
              dominated by closed rows and the active AVAILABILITY
              problems can fall outside it — header said "4 active"
              but the body printed "No active problems". The focused
              Rising / Stuck fetches will populate the canvas even
              when the global sample missed the category's actives. */}
          {(displayedActive > 0 ? false : activeProblems.length === 0) ? (
            <div className="neo-enlarged-quadrant-empty">
              No active problems in this {grouping.label.toLowerCase()}.
            </div>
          ) : (
            <div className="neo-enlarged-quadrant-canvas" style={{ position: "relative" }}>
              {/* 0.0.165 — explicit caption inside the canvas so
                  the user reads "what am I looking at" without
                  guessing: the dots are the top-N most relevant
                  ACTIVE problems for the selected mode. User:
                  "deixar claro nesta area expandida que os dados
                  apresentados sao baseados em problemas ativos.
                  apresentando ao centro os top 10 mais relevantes."
                  0.0.174 — caption now reflects the two-tier view:
                  the canvas paints the top 50 by mode (TOP_N), and
                  the inner ConstellationView's `disableAggregation`
                  branch elevates the leading 10 of those into the
                  top-tier ring. Without this update the caption
                  still read "Top 50 of N by …" with no mention of
                  the 10-leader highlight, leaving the user wondering
                  why some dots were ringed and others were not.
                  Subtle styling so it sits as metadata above the
                  dot field, not as a heading. */}
              {(() => {
                const matchingForCurrent = drilldown.counts[currentMode];
                const showing = Math.min(TOP_N, matchingForCurrent);
                // Mirror ConstellationView's MAX_TIER_PER_CAT — kept
                // as a local const so the caption stays honest if
                // we ever flex this number per category.
                const LEADING_DEFAULT = 10;
                // 0.0.176 — Rising mode highlights ONLY the net delta.
                // 0.0.186 — replaced net delta with `newlyStarted`
                // (server count of ACTIVE & start ≥ now-1h). The
                // net delta could collapse to zero or go negative
                // when closures matched openings, leaving the canvas
                // with N dots but zero highlighted — confusing.
                // Now leading == min(MAX_TIER_PER_CAT, newlyStarted)
                // so the highlights match the cell bubble exactly.
                const isRising = currentMode === "rising";
                const risingHighlightCount = isRising && typeof categoryCounts?.newlyStarted === "number"
                  ? categoryCounts.newlyStarted
                  : (isRising && typeof categoryCounts?.rising === "number"
                      ? categoryCounts.rising
                      : null);
                const leading = isRising && risingHighlightCount !== null
                  ? Math.min(LEADING_DEFAULT, risingHighlightCount, showing)
                  : Math.min(LEADING_DEFAULT, showing);
                const modeLabel = ALL_MODES.find((m) => m.mode === currentMode)?.label
                  ?? currentMode;
                return (
                  <div
                    aria-live="polite"
                    style={{
                      position: "absolute",
                      top: 8,
                      left: 0,
                      right: 0,
                      textAlign: "center",
                      color: "var(--neo-text-3)",
                      font: '500 11px/1.4 "SF Mono","JetBrains Mono",monospace',
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      pointerEvents: "none",
                      userSelect: "none",
                      zIndex: 3,
                    }}
                  >
                    <span style={{ color: "var(--neo-text-2)", fontWeight: 600 }}>
                      Problems
                    </span>
                    <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
                    <span>
                      {isRising
                        ? `${showing} started in 1h`
                        : `Top ${showing}${matchingForCurrent > showing ? ` of ${matchingForCurrent}` : ""} by ${modeLabel.toLowerCase()}`}
                    </span>
                    {leading > 0 && (showing > leading || isRising) && (
                      <>
                        <span style={{ margin: "0 8px", opacity: 0.5 }}>·</span>
                        <span style={{ color: "var(--neo-text-2)", fontWeight: 600 }}>
                          {isRising
                            ? `${leading} net new highlighted`
                            : `Top ${leading} highlighted`}
                        </span>
                      </>
                    )}
                  </div>
                );
              })()}
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
                /* 0.0.176 — Rising mode caps the highlight ring at
                   the server net delta (categoryCounts.rising). Keeps
                   the slice wide (all problems started in 1h) for
                   context, but only the genuinely net-new arrivals
                   get the ring. Other modes keep MAX_TIER_PER_CAT=10. */
                maxHighlightTier={
                  currentMode === "rising"
                    ? (typeof categoryCounts?.newlyStarted === "number"
                        ? categoryCounts.newlyStarted
                        : (typeof categoryCounts?.rising === "number"
                            ? categoryCounts.rising
                            : undefined))
                    : undefined
                }
                dotScale={1.6}
                initialExpandedQuadrant={quadrantId}
                lockExpandedQuadrant
                catTrendOverride={trendOverride}
                /* 0.0.192 — synthesize a single-cell countOverrides
                   from `categoryCounts` so the inner constellation's
                   animations (bubble ring, title-row trail) read
                   server-authoritative numbers instead of falling
                   back to the sample-derived `catTrends` (which had
                   `older` inflated by closed problems in the slice
                   and routinely flipped sign). Without this every
                   modal canvas reverted to the pre-v0.0.187/191
                   bugs internally. */
                countOverrides={categoryCounts ? {
                  activeByCategory:   { [quadrantId]: categoryCounts.active },
                  resolvedByCategory: { [quadrantId]: categoryCounts.closed },
                  ...(typeof categoryCounts.stuck === "number"
                    ? { stuckByCategory: { [quadrantId]: categoryCounts.stuck } }
                    : {}),
                  ...(typeof categoryCounts.newlyStarted === "number"
                    ? { newlyStartedByCategory: { [quadrantId]: categoryCounts.newlyStarted } }
                    : {}),
                  ...(typeof categoryCounts.rising === "number"
                    ? {
                        risingDeltaByCategory: { [quadrantId]: Math.max(0, categoryCounts.rising) },
                        // Derive olderByCategory so the bubble ring's
                        // net-delta math (active - older) lands on
                        // the same number the header `▲/▼` arrow shows.
                        olderByCategory: { [quadrantId]: Math.max(0, categoryCounts.active - categoryCounts.rising) },
                      }
                    : {}),
                } : undefined}
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
                  // 0.0.234 — Use theme-aware fade-to-zero so the
                  // gradient doesn't drag a dark band through the
                  // light-theme background interpolation.
                  background:
                    "linear-gradient(to top, var(--neo-bg) 55%, var(--neo-bg-transparent) 100%)",
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
                  // 0.0.163 — Total pill = ACTIVE + CLOSED for the
                  // timeframe (matches the cell's Total bubble since
                  // v0.0.161 and the FILTERS-strip chip since
                  // v0.0.160). User: "ao expandir, o total mostra
                  // apenas os ativos."
                  // 0.0.169 — Rising pill ALSO uses the authoritative
                  // count when available (categoryCounts.rising =
                  // ACTIVE - OLDER per category, server-side). This
                  // closes the last sample-bound surface in the
                  // modal — pill matches the cell bubble exactly,
                  // even on tenants where the 250-row sample
                  // undercounted Rising.
                  //
                  // 0.0.176 — Rising pill splits into TWO numbers when
                  // active:
                  //   shownTop = net delta (categoryCounts.rising,
                  //              matches the cell ▲+N badge)
                  //   count    = newly-started in 1h (drilldown.counts.rising,
                  //              the full slice the canvas paints)
                  // Reads as "TOP 2 new Rising of 24 in 1h" — i.e.
                  // "2 net new out of 24 problems that opened in the
                  // 1h window". Without the split, pill said "TOP 2
                  // of 2" while the canvas showed 24 dots — confusing.
                  // When INACTIVE the Rising pill collapses to the
                  // net delta only ("Rising 2") so it agrees with the
                  // cell badge at a glance. Stuck and Total keep the
                  // previous single-number semantic.
                  const isActive = m.mode === currentMode;
                  let count: number;
                  let shownTopActive: number;
                  if (m.mode === "criticality") {
                    count = displayedActive + displayedClosed;
                    shownTopActive = Math.min(TOP_N, count);
                  } else if (m.mode === "open_time") {
                    count = typeof categoryCounts?.stuck === "number"
                      ? categoryCounts.stuck
                      : drilldown.counts.open_time;
                    shownTopActive = Math.min(TOP_N, count);
                  } else {
                    // Rising
                    // 0.0.186 — both the TOP badge and the "of N"
                    // denominator now read `newlyStarted` (server
                    // count of ACTIVE & start ≥ now-1h). v0.0.176
                    // had used net delta for the TOP badge to
                    // distinguish "2 net new" from "24 newly arrived",
                    // but with the v0.0.185 cell change the bubble
                    // already shows newlyStarted — clicking a cell
                    // that reads "Rising 18" and seeing "TOP 0 of 0"
                    // in the modal was the bug. The net delta is
                    // still visible in the modal header's `▲/▼ N/1h`
                    // trend arrow, so queue direction stays clear.
                    const authoritativeNewly =
                      typeof categoryCounts?.newlyStarted === "number"
                        ? categoryCounts.newlyStarted
                        : (typeof categoryCounts?.rising === "number"
                            ? categoryCounts.rising
                            : drilldown.counts.rising);
                    count = authoritativeNewly;
                    shownTopActive = Math.min(TOP_N, authoritativeNewly);
                  }
                  const shownTop = isActive ? shownTopActive : 0;
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
                        // 0.0.234 — Inactive pill backgrounds use
                        // theme-aware tokens so light mode shows a
                        // raised white panel instead of a solid
                        // black blob. See `--neo-pill-bg-*` in
                        // theme.css.
                        background: isActive
                          ? accent
                          : (count > 0 ? "var(--neo-pill-bg-strong)" : "var(--neo-pill-bg-muted)"),
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
                          TOP {shownTop}{m.mode === "rising" ? " new" : ""}
                        </span>
                      )}
                      <span style={{ fontWeight: isActive ? 700 : 600 }}>{m.label}</span>
                      <span style={{
                        fontFamily: '"SF Mono","JetBrains Mono",monospace',
                        fontWeight: 700,
                      }}>
                        {isActive
                          ? `of ${count.toLocaleString()}${m.mode === "rising" ? " in 1h" : ""}`
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
