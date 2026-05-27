// Shared "rich expand body" for any per-problem drill-down surface
// (Overview list row, ProblemTimelineCard, future detail page).
// Renders, in order:
//   1. <CommentsSection> — comments + composer (read/write).
//   2. <EventSwimlane>   — 3-lane RUM-style timeline of events.
//   3. Activity feed     — day-grouped list of every TimelineEvent.
//
// Why a shared component (instead of inlining the JSX in each
// surface): the original duplicated `<CommentsSection>` placement
// in Overview and ProblemTimelineCard meant the rich drill-down
// (swimlane + workflow events) was ONLY available on the Timeline
// page. A2 of the UX consolidation moves this body into Overview's
// row expand too — extracting first keeps both surfaces byte-
// identical so there's no semantic drift between them.
//
// All filtering / sorting / DQL gating happens here so the surface
// just decides "should this render?" (via `enabled`) and the rest
// is taken care of.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentsSection } from "./CommentsSection";
import {
  useProblemTimeline,
  type TimelineEvent,
  type TimelineCategory,
} from "../hooks/useProblemTimeline";
import type { Problem } from "../hooks/useProblems";
import { renderMarkdown } from "../utils/markdown";
import { useRefreshTick } from "../contexts/RefreshSignalContext";
import { EventSwimlane } from "./EventSwimlane";

// ── Per-category visual styling (icon + label + accent) ─────────────
interface CategoryStyle { label: string; icon: string; color: string; }
const CATEGORY_STYLES: Record<TimelineCategory, CategoryStyle> = {
  comment:    { label: "Comment",    icon: "💬", color: "#60A5FA" },
  insight:    { label: "Insight",    icon: "🤖", color: "#A78BFA" },
  automation: { label: "Automation", icon: "⚡", color: "#34D399" },
  lifecycle:  { label: "Lifecycle",  icon: "◉",  color: "#06B6D4" },
  other:      { label: "Other",      icon: "·",  color: "#94A3B8" },
};

// ── Time formatters — render in UTC to match the canonical view
//    Dynatrace ships (Davis Workflows + dt.system.events tables both
//    display UTC). When we use the browser's local timezone the times
//    diverge from those tables for users outside UTC, which makes
//    cross-referencing impossible. UTC is also the SRE/ops convention
//    for incident timelines so multiple time zones can compare notes
//    without arithmetic.  ────────────────────────────────────────────
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  });
}
function formatDayHeader(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}
/** Day-bucket key — uses the UTC date portion so events near
 *  midnight don't drift across day headers depending on viewer TZ. */
function dayKey(iso: string): string { return iso.slice(0, 10); }

export interface ProblemActivityFeedProps {
  problem: Problem;
  /** Comment composer visibility. Defaults to true. */
  allowComposer?: boolean;
  /** INITIAL activity feed sort direction. Default is "asc"
   *  (oldest-first / chronological top-to-bottom) — that's the
   *  natural reading direction for incident narratives ("Problem
   *  opened" → … → last automation). User can flip via the inline
   *  toggle. The prop seeds initial state only. */
  sortDir?: "asc" | "desc";
  /** Activity feed category filter. Defaults to "all". */
  filter?: "all" | TimelineCategory;
  /** Set to `false` to skip the DQL queries entirely (lets a host
   *  surface that mounts but doesn't yet show the body avoid firing
   *  the calls). Defaults to `true` — callers should only mount this
   *  when they're actually rendering the expand body. */
  enabled?: boolean;
}

export const ProblemActivityFeed: React.FC<ProblemActivityFeedProps> = ({
  problem,
  allowComposer = true,
  sortDir = "asc",
  filter = "all",
  enabled = true,
}) => {
  const davisId = (problem as unknown as { davis_problem_id?: string }).davis_problem_id || "";
  // sortDir is owned by the HOST (Overview's row actions render the
  // toggle next to the action chips so both control bars live on one
  // line). This component just consumes the prop — no internal state
  // here so the toggle position isn't tied to the feed.

  const timeline = useProblemTimeline(
    davisId,
    problem["event.start"],
    {
      startIso:    problem["event.start"],
      endIso:      problem["event.end"] ?? null,
      problemName: problem["event.name"],
      status:      problem["event.status"],
      category:    problem["event.category"],
    },
    { enabled },
  );

  // Subscribe to the global refresh signal — when the host page
  // (Overview's manual refresh or auto-refresh interval) fires
  // `triggerRefresh()`, this re-runs and bypasses the useDql cache
  // via `timeline.refetch()`. Fixes the regression where new
  // automations / Davis annotations / workflow runs only showed up
  // after a hard browser reload.
  const refreshTick = useRefreshTick();
  useEffect(() => {
    if (refreshTick === 0 || !enabled) return; // skip initial mount + collapsed cards
    timeline.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const visibleEvents = useMemo(() => {
    const filtered = filter === "all"
      ? timeline.events
      : timeline.events.filter((e) => e.category === filter);
    return sortDir === "asc" ? filtered : [...filtered].reverse();
  }, [timeline.events, filter, sortDir]);

  const grouped = useMemo(() => {
    const map = new Map<string, TimelineEvent[]>();
    visibleEvents.forEach((e) => {
      const k = dayKey(e.timestamp);
      const arr = map.get(k) || [];
      arr.push(e);
      map.set(k, arr);
    });
    return Array.from(map.entries());
  }, [visibleEvents]);

  const totalCount = timeline.events.length;

  // ── Swimlane → feed selection bridge ─────────────────────────────
  // Clicking a swimlane marker / chip lifts its bucket's event keys
  // here. We:
  //   1. Apply a `.ptl-cell-highlighted` class to matching <li>s
  //      (visible accent + soft glow — drawn in theme.css).
  //   2. Scroll the FIRST matching cell into view (smooth, centred)
  //      so users with a long feed don't have to hunt.
  //   3. Auto-clear after `HIGHLIGHT_TTL_MS` so the feed returns to
  //      its neutral state — leaving permanent highlights would
  //      confuse the next interaction.
  // The whole feed is also a click-to-clear surface: clicking the
  // feed wrapper (outside any cell) drops the highlight immediately.
  const HIGHLIGHT_TTL_MS = 6000;
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const feedRef = useRef<HTMLDivElement | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHighlight = useCallback(() => {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    setSelectedKeys((prev) => (prev.size === 0 ? prev : new Set<string>()));
  }, []);

  const handleSwimlaneSelect = useCallback(
    (keys: string[]) => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      if (keys.length === 0) {
        setSelectedKeys(new Set<string>());
        return;
      }
      const next = new Set(keys);
      setSelectedKeys(next);
      // Defer to next paint so the cells have the highlight class
      // applied before we measure / scroll — otherwise the browser
      // can scroll to the OLD position the cell occupied.
      requestAnimationFrame(() => {
        const root = feedRef.current;
        if (!root) return;
        const firstKey = keys[0];
        const sel = `[data-event-key="${CSS.escape(firstKey)}"]`;
        const el = root.querySelector<HTMLElement>(sel);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      clearTimer.current = setTimeout(() => {
        setSelectedKeys(new Set<string>());
        clearTimer.current = null;
      }, HIGHLIGHT_TTL_MS);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  return (
    <div className="ptl-activity-feed" ref={feedRef}>
      {allowComposer && davisId && (
        <CommentsSection
          problemId={problem.display_id}
          davisProblemId={davisId}
        />
      )}

      {timeline.events.length > 0 && (
        <EventSwimlane
          events={timeline.events}
          problemStartIso={problem["event.start"]}
          problemEndIso={problem["event.end"]}
          highlightedKeys={selectedKeys}
          onSelectKeys={handleSwimlaneSelect}
        />
      )}

      {timeline.loading && totalCount === 0 ? (
        <div className="ptl-empty"><div className="ptl-empty-body">Loading…</div></div>
      ) : (timeline.annotationsError || timeline.workflowsError) ? (
        <div className="ptl-empty">
          <div className="ptl-empty-title">Couldn't load activity</div>
          <div className="ptl-empty-body">
            {(timeline.annotationsError || timeline.workflowsError)?.message}
          </div>
        </div>
      ) : visibleEvents.length === 0 ? (
        <div className="ptl-empty"><div className="ptl-empty-body">No events match the current filter.</div></div>
      ) : (
        <div className="ptl-stream ptl-stream-compact">
          {grouped.map(([k, items]) => (
            <section key={k} className="ptl-day-section">
              <h3 className="ptl-day-header">
                <span className="ptl-day-line" />
                <span className="ptl-day-label">{formatDayHeader(items[0].timestamp)} · UTC</span>
                <span className="ptl-day-count">{items.length}</span>
              </h3>
              <ol className="ptl-day-list">
                {items.map((e) => (
                  <Cell
                    key={e.key}
                    event={e}
                    highlighted={selectedKeys.has(e.key)}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Internal cell renderer — one row per TimelineEvent. ────────────
// `highlighted` is true while this event is selected by the swimlane
// above. We add a `data-event-key` attribute on the <li> so the host
// can `querySelector` for scroll-into-view without keeping a parallel
// ref-map (which would grow / shrink every render and complicate the
// memoisation story).
const Cell: React.FC<{ event: TimelineEvent; highlighted?: boolean }> = ({
  event,
  highlighted = false,
}) => {
  const style = CATEGORY_STYLES[event.category];
  return (
    <li
      className={`ptl-cell${highlighted ? " ptl-cell-highlighted" : ""}`}
      data-event-key={event.key}
    >
      <div className="ptl-cell-rail">
        {/* ▼ marker — points down to indicate chronological flow
            (events read top → bottom in asc sort, the feed's default).
            Replaces the previous circular dot; same per-category
            color coding via inline style. `aria-hidden` since the
            category label below carries the semantic meaning. */}
        <span
          className="ptl-cell-dot"
          style={{ color: style.color }}
          aria-hidden="true"
        >
          ▼
        </span>
      </div>
      <div className="ptl-cell-body">
        <div className="ptl-cell-head">
          <span className="ptl-cell-time">{formatTime(event.timestamp)}</span>
          <span className="ptl-cell-tag" style={{ color: style.color, borderColor: `${style.color}55` }}>
            <span className="ptl-cell-tag-icon">{style.icon}</span>
            {style.label}
          </span>
          <span className="ptl-cell-source">{event.sourceLabel}</span>
          {event.actor && <span className="ptl-cell-actor">· {event.actor}</span>}
        </div>
        <div className="ptl-cell-content">{renderMarkdown(event.body)}</div>
        {event.meta && <div className="ptl-cell-meta">{event.meta}</div>}
      </div>
    </li>
  );
};
