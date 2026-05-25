// Per-row action toolbar shown inside an expanded incident:
//   Copy ID · WhatsApp · Share link · Open Problem App · Refresh · Sort
//
// Extracted from Overview's desktop row-expand so the mobile card
// list (`MobileIncidentList`) can render the SAME affordances. Both
// surfaces now share one source of truth — change the toolbar once,
// it lands everywhere.

import React from "react";
import type { Problem } from "../hooks/useProblems";
import { CopyChip } from "./CopyChip";
import { ShareWhatsApp } from "./ShareWhatsApp";
import {
  buildOfficialProblemUrl,
  buildExplainProblemUrl,
} from "../utils/dynatrace-links";
import { useDevice } from "../hooks/useDevice";
import { useTriggerRefresh } from "../contexts/RefreshSignalContext";

interface Props {
  problem: Problem;
  /** Current sort order for THIS problem's activity feed below. */
  sort: "asc" | "desc";
  onSortChange: (dir: "asc" | "desc") => void;
  /** Optional density modifier — `compact` shrinks button padding +
   *  font so the toolbar fits a narrow mobile card without wrapping
   *  to a 3rd row. */
  density?: "default" | "compact";
}

export const ProblemActions: React.FC<Props> = ({ problem, sort, onSortChange, density = "default" }) => {
  const triggerRefresh = useTriggerRefresh();
  const { isMobileOrTablet } = useDevice();
  // Native Davis Problems detail page link — kept on every form
  // factor (the mobile rendering is broken in the native app, but
  // we tried bypassing it via a graph-view deep-link in 0.0.93 and
  // the param was ignored; user reverted in 0.0.94. So we ship
  // the same button on mobile and accept the broken native UX —
  // it's still useful for users who want to drill into Davis's
  // own data, even if the layout is rough).
  const officialUrl = buildOfficialProblemUrl(problem);
  // Davis CoPilot deep-link (mobile only). The CoPilot chat UI is
  // mobile-native by design — gives users a way to get problem
  // context without having to fight the broken Davis Problems
  // detail page on small viewports. Returns null when CoPilot
  // isn't installed in the tenant; button just doesn't render.
  const explainUrl  = isMobileOrTablet ? buildExplainProblemUrl(problem) : null;
  return (
    <div
      className={`neo-row-actions${density === "compact" ? " neo-row-actions-compact" : ""}`}
      onClick={(e) => e.stopPropagation()}
    >
      <CopyChip
        text={problem.display_id}
        label="Copy ID"
        icon="⎘"
        title="Copy problem ID"
      />
      <span className="neo-row-act-share" title="Share via WhatsApp">
        <ShareWhatsApp problem={problem} />
      </span>
      <CopyChip
        text={typeof window !== "undefined" ? window.location.href : ""}
        label="Share link"
        icon="⛓"
        title="Copy URL for this problem"
      />
      {officialUrl && (
        <a
          href={officialUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="neo-row-act"
          title="Open this problem in the official Davis Problems app"
        >
          <span className="neo-row-act-icon" aria-hidden="true">↗</span>
          <span>Open Problem App</span>
        </a>
      )}
      {/* Mobile-only: "Explain Problem" → Davis CoPilot. The CoPilot
          chat UI scales cleanly on small viewports, so it's the
          mobile-safe complement to the (rougher) native Davis
          Problems link above. Hidden on desktop because there the
          native page renders fine and one drill-down is plenty.
          Skipped when the helper returns null (CoPilot not
          installed in tenant). */}
      {isMobileOrTablet && explainUrl && (
        <a
          href={explainUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="neo-row-act"
          title="Ask Davis CoPilot to explain this problem in plain language"
        >
          <span className="neo-row-act-icon" aria-hidden="true">✦</span>
          <span>Explain Problem</span>
        </a>
      )}
      <button
        type="button"
        className="neo-row-act neo-row-act-refresh"
        onClick={triggerRefresh}
        title="Refresh comments + activity feed without leaving this row"
        aria-label="Refresh activity"
      >
        <span className="neo-row-act-icon" aria-hidden="true">↻</span>
        <span>Refresh</span>
      </button>
      <div
        className="neo-row-act-sort"
        role="group"
        aria-label="Activity sort order"
      >
        <span className="ptl-activity-sort-label">Sort</span>
        <div className="neo-segctrl" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={sort === "asc"}
            className={`neo-segctrl-btn${sort === "asc" ? " neo-segctrl-btn-active" : ""}`}
            onClick={() => onSortChange("asc")}
            title="Show oldest event at the top (chronological narrative)"
          >Oldest first</button>
          <button
            type="button"
            role="tab"
            aria-selected={sort === "desc"}
            className={`neo-segctrl-btn${sort === "desc" ? " neo-segctrl-btn-active" : ""}`}
            onClick={() => onSortChange("desc")}
            title="Show newest event at the top (latest-update feed)"
          >Newest first</button>
        </div>
      </div>
    </div>
  );
};
