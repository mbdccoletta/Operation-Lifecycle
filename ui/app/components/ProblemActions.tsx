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
  buildProblemGraphUrl,
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
  // Desktop drill-down: native Davis Problems detail page (renders
  // fine on wide viewports).
  const officialUrl = buildOfficialProblemUrl(problem);
  // Mobile drill-downs: avoid the native Davis Problems landing
  // page entirely — its text-heavy header layout breaks on small
  // viewports (the problem title renders vertically, letter by
  // letter — confirmed by user screenshot 0.0.92). Instead, link
  // directly to the two surfaces that DO render cleanly:
  //   • Problem graph (canvas-heavy, mobile-safe)
  //   • Davis CoPilot explainer (chat UI, also mobile-friendly)
  // Falls back to `null` per helper when the target app isn't
  // installed in the tenant — corresponding button just doesn't
  // render then.
  const graphUrl   = isMobileOrTablet ? buildProblemGraphUrl(problem)   : null;
  const explainUrl = isMobileOrTablet ? buildExplainProblemUrl(problem) : null;
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
      {/* Desktop: single "Open Problem App" button that lands on the
          native detail page. Mobile: two focused buttons that
          sidestep the broken layout. The check on isMobileOrTablet
          decides which set renders — there's no overlap, so the
          row's chip count stays bounded on both surfaces. */}
      {!isMobileOrTablet && officialUrl && (
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
      {isMobileOrTablet && graphUrl && (
        <a
          href={graphUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="neo-row-act"
          title="Open the problem's topology graph in Davis Problems (mobile-safe view)"
        >
          <span className="neo-row-act-icon" aria-hidden="true">◈</span>
          <span>Problem Graph</span>
        </a>
      )}
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
