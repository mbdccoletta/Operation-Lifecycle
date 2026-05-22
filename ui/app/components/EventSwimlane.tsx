// Per-problem swimlane — RUM-style overview chart that renders one
// horizontal lane per event category. Each lane is a CSS grid row
// (icon · label · positioned-track) so layout, typography and
// iconography stay native HTML and don't get warped by SVG viewBox
// scaling. Lane icons come from the Strato icon set so they match
// the Dynatrace platform's visual language.
//
// Markers within each track are absolutely positioned by percentage
// of the time window; single events render as small dots, clustered
// events render as numbered chips. The chronological text feed
// directly below the swimlane (in ProblemActivityFeed) carries the
// textual detail — the swimlane is the "where + when" overview, and
// clicking a marker HIGHLIGHTS the matching events in that feed
// (no tooltip — the feed already shows the details, and duplicating
// them in a popover meant the user had to read the same row twice).

import React, { useMemo } from "react";
import {
  CycleIcon,
  ChatIcon,
  AutomationsSignetIcon,
} from "@dynatrace/strato-icons";
import type { TimelineEvent, TimelineCategory } from "../hooks/useProblemTimeline";
import { useDevice } from "../hooks/useDevice";

// Strato icons accept a `size` prop typed as `number | SvgIconSize`
// (the union includes named sizes like "small"). We only ever pass
// numbers, so use the actual icon component type via
// `typeof CycleIcon` to stay compatible.
type StratoIcon = typeof CycleIcon;

interface LaneDef {
  /** Stable lane id used as a Map key + React key. NOT a category
   *  name — a lane can aggregate multiple TimelineCategory values
   *  (e.g. "Comments and insights" groups comment + insight). */
  key: string;
  label: string;
  color: string;
  Icon: StratoIcon;
  /** Which TimelineCategory values feed this lane. Events whose
   *  category is not in any lane's list are silently dropped from
   *  the swimlane — the chronological feed below still shows them. */
  categories: TimelineCategory[];
}
// Three lanes mirroring the native Davis Problems app's section
// layout: lifecycle markers on top, then a single "Comments and
// insights" row that fuses user comments with Davis CoPilot
// insights, then "Automation and remediation" for the workflow
// runs that respond to the problem.
const LANES: LaneDef[] = [
  {
    key: "lifecycle",
    label: "Lifecycle",
    color: "#06B6D4",
    Icon: CycleIcon,
    categories: ["lifecycle"],
  },
  {
    key: "comments-insights",
    label: "Comments and insights",
    color: "#60A5FA",
    Icon: ChatIcon,
    categories: ["comment", "insight"],
  },
  {
    key: "automation-remediation",
    label: "Automation and remediation",
    color: "#34D399",
    Icon: AutomationsSignetIcon,
    categories: ["automation"],
  },
];

// Reverse index: category → lane.key. Built once at module load so
// the bucket loop below is O(events) instead of O(events × lanes).
const CATEGORY_TO_LANE_KEY = new Map<TimelineCategory, string>();
for (const lane of LANES) {
  for (const cat of lane.categories) CATEGORY_TO_LANE_KEY.set(cat, lane.key);
}

const X_TICK_COUNT = 5;

interface BucketEntry {
  centerMs: number;
  count:    number;
  events:   TimelineEvent[];
}

function formatAxisTime(ms: number, rangeMs: number): string {
  const d = new Date(ms);
  if (rangeMs < 6 * 3600_000) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  if (rangeMs < 7 * 86_400_000) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Props {
  events: TimelineEvent[];
  problemStartIso?: string;
  problemEndIso?: string | null;
  /** Set of TimelineEvent.key strings currently highlighted in the
   *  feed below. The swimlane uses this to draw an "active" outline
   *  on any marker / chip whose bucket contains a highlighted event,
   *  so the link between dot and list cell is visible at a glance. */
  highlightedKeys?: ReadonlySet<string>;
  /** Click / tap callback — receives the event keys for the bucket
   *  the user activated. The host (`ProblemActivityFeed`) owns the
   *  highlight state and scroll-into-view; the swimlane is just the
   *  input device. Empty array clears the selection. */
  onSelectKeys?: (keys: string[]) => void;
}

export const EventSwimlane: React.FC<Props> = ({
  events,
  problemStartIso,
  problemEndIso,
  highlightedKeys,
  onSelectKeys,
}) => {
  const { isMobileOrTablet } = useDevice();
  // Mobile / tablet tracks are ~200 px wide — 5 ticks like "May 11"
  // each ~40 px = guaranteed overlap. Drop to 3 anchors (left, mid,
  // right) so the axis stays readable. Desktop keeps 5 for finer
  // visual granularity on the wide canvas. */
  const tickCount = isMobileOrTablet ? 3 : 5;

  // ── Time range — widen to whichever extreme is more extreme,
  //    among events and the problem lifecycle window. ───────────────
  const { minMs, maxMs } = useMemo(() => {
    // Single pass — accumulate min/max while iterating instead of
    // building an intermediate array + spreading into Math.min/max.
    // See C4 in the perf audit.
    let mn = Infinity;
    let mx = -Infinity;
    let seen = 0;
    for (let i = 0; i < events.length; i++) {
      const t = new Date(events[i].timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      if (t < mn) mn = t;
      if (t > mx) mx = t;
      seen++;
    }
    if (problemStartIso) {
      const t = new Date(problemStartIso).getTime();
      if (Number.isFinite(t)) {
        if (t < mn) mn = t;
        if (t > mx) mx = t;
        seen++;
      }
    }
    const endT = problemEndIso ? new Date(problemEndIso).getTime() : Date.now();
    if (Number.isFinite(endT)) {
      if (endT < mn) mn = endT;
      if (endT > mx) mx = endT;
      seen++;
    }
    if (seen === 0) {
      const now = Date.now();
      return { minMs: now - 3600_000, maxMs: now };
    }
    // Force a non-zero range — otherwise X collapses to a point.
    if (mx - mn < 60_000) mx = mn + 60_000;
    return { minMs: mn, maxMs: mx };
  }, [events, problemStartIso, problemEndIso]);
  const rangeMs = maxMs - minMs;

  // ── Per-lane buckets. Slot width is constant (~22 logical px on
  //    typical render widths) so markers in different lanes line up
  //    vertically when they happen at the same time. Buckets are
  //    keyed by LANE id (not category) — a single lane like
  //    "Comments and insights" merges the comment + insight streams
  //    so user comments and Davis CoPilot insights land on the
  //    same row. Events whose category isn't in any lane's list
  //    (currently `other`) are dropped from the swimlane. ──────────
  const bucketsByLane = useMemo<Map<string, BucketEntry[]>>(() => {
    // Aim for ~40 slots across the visible track; that gives chips
    // breathing room while keeping the chart compact.
    const slotMs = rangeMs / 40;
    const map = new Map<string, BucketEntry[]>();
    for (const lane of LANES) map.set(lane.key, []);
    const byKey = new Map<string, BucketEntry>();
    for (const e of events) {
      const laneKey = CATEGORY_TO_LANE_KEY.get(e.category);
      if (!laneKey) continue;
      const t = new Date(e.timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      const slot = Math.floor((t - minMs) / slotMs);
      const key = `${laneKey}:${slot}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        existing.events.push(e);
        existing.centerMs = (existing.centerMs * (existing.count - 1) + t) / existing.count;
      } else {
        const entry: BucketEntry = { centerMs: t, count: 1, events: [e] };
        byKey.set(key, entry);
        const arr = map.get(laneKey) || [];
        arr.push(entry);
        map.set(laneKey, arr);
      }
    }
    for (const arr of map.values()) arr.sort((a, b) => a.centerMs - b.centerMs);
    return map;
  }, [events, minMs, rangeMs]);

  // ── X-axis ticks. Pure %-based positions so they scale with the
  //    parent width without any SVG transforms. ─────────────────────
  const xTicks = useMemo(() => {
    return Array.from({ length: tickCount }, (_, i) => {
      const t = i / (tickCount - 1);
      return {
        xPct: t * 100,
        label: formatAxisTime(minMs + t * rangeMs, rangeMs),
      };
    });
  }, [minMs, rangeMs, tickCount]);

  // ── Per-lane event counts — drive the legend strip up top.
  //    Empty lanes still appear so the user can confirm at a glance
  //    "no automation ran", "no comments yet" etc.
  const countsByLane = useMemo<Record<string, number>>(() => {
    const c: Record<string, number> = {};
    for (const lane of LANES) c[lane.key] = 0;
    for (const e of events) {
      const laneKey = CATEGORY_TO_LANE_KEY.get(e.category);
      if (laneKey) c[laneKey]++;
    }
    return c;
  }, [events]);

  if (events.length === 0) return null;

  // Click handler shared by chip + marker: lifts the bucket's event
  // keys to the host (ProblemActivityFeed), which highlights the
  // matching <li> rows in the feed below and scrolls the first into
  // view. We DON'T render a tooltip anymore — the chronological list
  // already shows full details, so doubling them up was noise.
  const selectBucket = (b: BucketEntry, e: React.SyntheticEvent) => {
    e.stopPropagation(); // never collapse the row we live inside
    if (!onSelectKeys) return;
    onSelectKeys(b.events.map((ev) => ev.key));
  };

  return (
    <div className="evt-swimlane">
      {/* Legend strip — icon + label + count per category. Acts as
          both a colour key for the markers below and a quick
          summary of what happened in the problem's lifetime. */}
      <header className="evt-swimlane-legend">
        {LANES.map((lane) => {
          const count = countsByLane[lane.key];
          return (
            <span
              key={lane.key}
              className={`evt-swimlane-legend-item${count === 0 ? " evt-swimlane-legend-item-empty" : ""}`}
            >
              <span className="evt-swimlane-legend-icon" style={{ color: lane.color }} aria-hidden="true">
                <lane.Icon size={12} />
              </span>
              <span className="evt-swimlane-legend-label" style={{ color: lane.color }}>{lane.label}</span>
              <span className="evt-swimlane-legend-count">{count}</span>
            </span>
          );
        })}
      </header>

      {LANES.map((lane) => {
        const buckets = bucketsByLane.get(lane.key) || [];
        return (
          <div className="evt-lane" key={lane.key}>
            <div className="evt-lane-icon" style={{ color: lane.color }} aria-hidden="true">
              <lane.Icon size={14} />
            </div>
            <div className="evt-lane-label" style={{ color: lane.color }}>
              {lane.label}
            </div>
            <div className="evt-lane-track">
              {buckets.map((b) => {
                const xPct = ((b.centerMs - minMs) / rangeMs) * 100;
                const isChip = b.count >= 2;
                // A marker / chip is "active" if ANY event in its
                // bucket is currently highlighted in the feed below.
                // Using `some` rather than `every` so partial matches
                // (e.g. user re-clicks a different bucket which only
                // overlaps one event) still light up correctly.
                const isActive = highlightedKeys
                  ? b.events.some((ev) => highlightedKeys.has(ev.key))
                  : false;
                return (
                  <span
                    key={`${lane.key}-${b.centerMs}`}
                    className={`${isChip ? "evt-chip" : "evt-marker"}${isActive ? " evt-marker-active" : ""}`}
                    style={{
                      left: `${xPct}%`,
                      background: lane.color,
                      // Chip text colour: dark on bright background.
                      ...(isChip ? { color: "rgba(8,12,22,0.94)" } : null),
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${lane.label}, ${b.count} event${b.count === 1 ? "" : "s"} — highlight in list`}
                    onClick={(e) => selectBucket(b, e)}
                    onTouchStart={(e) => selectBucket(b, e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectBucket(b, e);
                      }
                    }}
                  >
                    {isChip ? b.count : null}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* X-axis — sits in its own row at the bottom, aligned to the
          track column via the same grid template. */}
      <div className="evt-axis">
        <div className="evt-axis-spacer" />
        <div className="evt-axis-track">
          {xTicks.map((t, i) => (
            <span key={i} className="evt-axis-tick" style={{ left: `${t.xPct}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
