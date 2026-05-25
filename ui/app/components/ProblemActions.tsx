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
import { buildOfficialProblemUrl, buildAppShareUrl } from "../utils/dynatrace-links";
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
  // Native Davis Problems detail page link — same on every form
  // factor. The mobile rendering of the destination is rough (text
  // layout breaks on narrow viewports) but the link itself lands
  // the user on the correct problem. We tried sidestepping it in
  // 0.0.93/94 with `?view=graph` (Problems) and `?context=...`
  // (CoPilot) deep-links; neither was honoured by the target apps,
  // so both helpers + buttons were dropped in 0.0.95. See
  // `dynatrace-links.ts` HISTORY block for context.
  const officialUrl = buildOfficialProblemUrl(problem);
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
      {/* "Share link" — copies a deep-link straight to THIS problem
          inside our app (tenant root + `/ui/apps/<self>?focus=<id>`).
          Falls back to the current browser URL when
          buildAppShareUrl returns null (SDK unavailable / unusual
          context). Previously we copied window.location.href
          unconditionally, but inside the AppEngine iframe sandbox
          that's the per-app HASHED origin (`xktbb3yiewy…`) which
          doesn't route from outside — recipients always landed
          nowhere. Fixed in 0.0.97. */}
      <CopyChip
        text={
          buildAppShareUrl(problem.display_id)
          || (typeof window !== "undefined" ? window.location.href : "")
        }
        label="Share link"
        icon="⛓"
        title="Copy a deep-link to this problem inside Problem Lifecycle"
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
