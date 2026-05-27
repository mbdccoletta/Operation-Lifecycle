// Compact per-problem activity card. Used both in the single-problem
// view of /timeline (one card, expanded) and in the multi-problem
// stacked view (many cards, each independently collapsible).
//
// The card owns its own `useProblemTimeline` so each card pulls
// data independently — the page just passes problem metadata.

import React, { useMemo, useState } from "react";
import { Chip } from "@dynatrace/strato-components-preview/content";
import { Tooltip } from "@dynatrace/strato-components-preview/overlays";
import { ProblemActivityFeed } from "./ProblemActivityFeed";
import {
  useProblemTimeline,
  TimelineCategory,
} from "../hooks/useProblemTimeline";
import type { Problem } from "../hooks/useProblems";
import { formatDuration, formatDurationMs, getCategoryLabel } from "../utils/formatters";
import { buildOfficialProblemUrl } from "../utils/dynatrace-links";
import type { PerProblemMetrics } from "../hooks/useTeamMetrics";

// CATEGORY_STYLES, formatTime, formatDayHeader, dayKey, Cell — all
// moved into ProblemActivityFeed (A2 of the UX consolidation) so
// they stay with the rendering code that consumes them.

interface Props {
  problem: Problem;
  /** Sort direction shared with the parent page so the toggle at the
   *  top of /timeline affects every card consistently. */
  sortDir: "asc" | "desc";
  /** Category filter shared with the parent page. */
  filter: "all" | TimelineCategory;
  /** Whether the card starts expanded. Single-problem view = true;
   *  multi-problem stack = collapsible (default false). */
  defaultExpanded?: boolean;
  /** Hide the "Open Timeline →" deep-link in the card header. The
   *  single-problem view already IS the timeline so the link would
   *  be redundant. */
  hideOpenLink?: boolean;
  /** When true (default), an in-card composer is rendered above the
   *  events feed so users can post a comment without leaving the
   *  card. */
  allowComposer?: boolean;
  /** Per-problem MTTA/MTTR/MTBF/MTTF, pre-computed by the page from
   *  `useTeamMetrics.perProblem`. The card renders one chip per
   *  defined value — undefined or null fields stay hidden. */
  metrics?: PerProblemMetrics;
}

export const ProblemTimelineCard: React.FC<Props> = ({
  problem,
  sortDir,
  filter,
  defaultExpanded = false,
  hideOpenLink = false,
  allowComposer = true,
  metrics,
}) => {
  const davisId = (problem as unknown as { davis_problem_id?: string }).davis_problem_id || "";
  const [expanded, setExpanded] = useState(defaultExpanded);
  // Gate the two timeline DQL queries on the card's expanded state.
  // Without this every card in a multi-problem stack (potentially
  // 1000+ on a busy tenant) fires its annotation + workflow queries
  // on mount even though the body is collapsed and the user can't
  // see any of the data — see C2 in the perf audit.
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
    { enabled: expanded },
  );

  // Comments + composer are delegated to the same `<CommentsSection>`
  // component the Incidents list uses (see render below). That keeps
  // the read + write paths byte-identical between pages and lets
  // users see the freshly-added comment immediately via the local
  // `documentsClient` mirror that `useComments` maintains.

  // MTTA: time from open → first comment (humans only).
  const mtta = useMemo(() => {
    const start = problem["event.start"];
    if (!start) return null;
    const firstComment = timeline.events.find((e) => e.category === "comment");
    if (!firstComment) return null;
    const formatted = formatDuration(start, firstComment.timestamp);
    if (!formatted) return null;
    return { formatted, ackAt: firstComment.timestamp };
  }, [problem, timeline.events]);

  // visibleEvents + grouped used to live here for the activity feed
  // render — moved into `<ProblemActivityFeed>`. The Card now keeps
  // `counts` (header badges) + `totalCount` (header label) only.
  const counts = timeline.counts;
  const totalCount = timeline.events.length;
  // Status badge uses Strato `<Chip>` — `critical` palette for
  // ACTIVE (red-ish), `success` for CLOSED (green). Picks up theme
  // tokens automatically so dark/light mode "just work".
  const statusBadge =
    problem["event.status"] === "ACTIVE"
      ? <Chip color="critical" size="condensed">ACTIVE</Chip>
      : problem["event.status"] === "CLOSED"
        ? <Chip color="success" size="condensed">CLOSED</Chip>
        : null;

  return (
    <article className={`ptl-card${expanded ? " ptl-card-expanded" : ""}`}>
      <header className="ptl-card-head" onClick={() => setExpanded((v) => !v)}>
        <div className="ptl-card-head-main">
          <span className="ptl-card-displayid">{problem.display_id}</span>
          <span className="ptl-card-name">{problem["event.name"]}</span>
        </div>
        <div className="ptl-card-head-meta">
          {statusBadge}
          <span className="ptl-card-category">{getCategoryLabel(problem["event.category"])}</span>
          {/* Four colour-coded metric chips. Rendered only when the
              value is defined (e.g. MTTR hides for ACTIVE problems,
              MTBF/MTTF hide for the earliest problem in the window).
              Falls back to the locally computed MTTA when no
              external `metrics` prop is supplied. */}
          <span className="ptl-metric-strip">
            {(metrics?.mttaMs ?? null) !== null ? (
              <MetricChip label="MTTA" value={formatDurationMs(metrics!.mttaMs!)} color="#818CF8"
                title={`Open → first comment. ${fmtTooltipFor("mtta", problem, metrics!.mttaMs!)}`} />
            ) : mtta ? (
              <MetricChip label="MTTA" value={mtta.formatted} color="#818CF8"
                title={`First comment at ${new Date(mtta.ackAt).toLocaleString(undefined, { timeZone: "UTC" })} UTC`} />
            ) : null}
            {(metrics?.mttrMs ?? null) !== null ? (
              <MetricChip label="MTTR" value={formatDurationMs(metrics!.mttrMs!)} color="#FB923C"
                title={`Open → close. ${fmtTooltipFor("mttr", problem, metrics!.mttrMs!)}`} />
            ) : problem["event.status"] === "ACTIVE" ? (
              // Live "open duration" indicator — surfaces an
              // in-flight equivalent so the user understands the
              // problem is still active rather than the metric being
              // unavailable. Re-rendered on every parent refresh
              // (manual or auto-refresh tick).
              <MetricChip
                label="OPEN"
                value={formatDurationMs(Date.now() - new Date(problem["event.start"]).getTime())}
                /* Red ("#ff4d6a") matches every other "open problem"
                   surface in the app — desktop list status badge,
                   mobile card stripe, FILTERS strip Active chip,
                   PulseVisualizer ACTIVE focal number. Was orange
                   before, which read as "warning" rather than "open
                   incident" and broke the colour grammar. */
                color="#ff4d6a"
                title={`Problem is still ACTIVE — opened ${new Date(problem["event.start"]).toLocaleString(undefined, { timeZone: "UTC" })} UTC. Final MTTR will be calculated once the problem is resolved (event.end populated by Davis).`}
              />
            ) : null}
            {(metrics?.mtbfMs ?? null) !== null && (
              <MetricChip label="MTBF" value={formatDurationMs(metrics!.mtbfMs!)} color="#34D399"
                title="Interval since the previous problem's start in this window. Lower = more frequent failures." />
            )}
            {(metrics?.mttfMs ?? null) !== null && (
              <MetricChip label="MTTF" value={formatDurationMs(metrics!.mttfMs!)} color="#22D3EE"
                title="Uptime since the previous closed problem's end. Higher = longer healthy runs between failures." />
            )}
          </span>
          <span className="ptl-card-counts">
            <span title="Comments">💬 {counts.comment}</span>
            <span title="Automations">⚡ {counts.automation}</span>
            {counts.insight > 0 && <span title="Insights">🤖 {counts.insight}</span>}
          </span>
          {!hideOpenLink && (() => {
            // Native Davis Problems app — keeps users one click
            // away from the canonical, full-featured problem view
            // (correlation graph, raw timeline, related events…)
            // without losing the analytics they're looking at here.
            // `buildOfficialProblemUrl` returns null when the
            // problem lacks a usable Davis composite id, in which
            // case we render nothing instead of a broken link.
            const davisUrl = buildOfficialProblemUrl(problem);
            if (!davisUrl) return null;
            return (
              <a
                href={davisUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ptl-card-open"
                onClick={(e) => e.stopPropagation()}
                title="Open this problem in the official Davis Problems app (new tab)"
              >
                <span aria-hidden="true">↗</span>
                <span>Open in Davis</span>
              </a>
            );
          })()}
          <span className="ptl-card-toggle" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </div>
      </header>

      {expanded && (
        <div className="ptl-card-body">
          {/* All comments / swimlane / activity-feed rendering moved
              into the shared `<ProblemActivityFeed>` (A2 of the UX
              consolidation). The card now owns only its header +
              chips; the body is identical between this surface and
              the Overview row expand. */}
          <ProblemActivityFeed
            problem={problem}
            allowComposer={allowComposer}
            sortDir={sortDir}
            filter={filter}
            enabled={expanded}
          />
        </div>
      )}
    </article>
  );
};

/** Single colour-coded metric chip used in the card header strip.
 *  Wrapped in a Strato `<Tooltip>` so the explanation popover is
 *  positioned via Floating UI (proper flip / shift / viewport
 *  containment instead of relying on the native `title` attribute
 *  which can't be styled and disappears after a few seconds). */
const MetricChip: React.FC<{ label: string; value: string; color: string; title?: string }> = ({ label, value, color, title }) => {
  const chip = (
    <span className="ptl-metric-chip" style={{ borderColor: `${color}55` }}>
      <span className="ptl-metric-chip-label" style={{ color }}>{label}</span>
      <span className="ptl-metric-chip-value">{value}</span>
    </span>
  );
  if (!title) return chip;
  return (
    <Tooltip text={title} placement="top" fallbackPlacements={["bottom", "left", "right"]}>
      {chip}
    </Tooltip>
  );
};

function fmtTooltipFor(kind: "mtta" | "mttr", problem: Problem, _ms: number): string {
  // UTC display matches native Davis Problems (see TIMEZONE CONVENTION
  // docblock in utils/formatters.ts). The "UTC" suffix on tooltips
  // disambiguates for users in other timezones who might assume local.
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { timeZone: "UTC" }) + " UTC";
  if (kind === "mtta") return `Opened ${fmt(problem["event.start"])}`;
  return problem["event.end"]
    ? `Closed ${fmt(problem["event.end"])}`
    : "";
}

