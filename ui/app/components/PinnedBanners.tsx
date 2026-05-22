// Stack of pinned-filter banners shown above the incidents list.
//
// Each banner is a one-line summary of an active drilldown filter
// (pinned problem, affected entity, root cause, status, stuck > Nh)
// with a single `✕ Clear` action. Extracted out of `Overview.tsx`
// (audit Step 3) because the JSX was repeating the same shape five
// times and burying it inside the page made the rest of the file
// harder to scan.
//
// All state lives in the host — these banners are dumb renderers.
// Friendly-name derivation (entity / root cause) is computed by
// looking up the first matching problem in the supplied list so
// the chips read as "tacocorp" instead of "HOST-AB12C34DEF56".

import React from "react";
import type { Problem } from "../hooks/useProblems";

interface BannerRowProps {
  label: string;
  id: string;
  /** Hex / token for the leading status dot. */
  dotColor: string;
  onClear: () => void;
  /** Tooltip on the clear button — should describe what clearing
   *  this banner restores ("Show every entity again"). */
  clearTitle: string;
}

const BannerRow: React.FC<BannerRowProps> = ({ label, id, dotColor, onClear, clearTitle }) => (
  <div className="neo-pinned-banner" role="status">
    <span className="neo-pinned-dot" aria-hidden="true" style={{ background: dotColor }} />
    <span className="neo-pinned-label">{label}</span>
    <span className="neo-pinned-id">{id}</span>
    <button
      type="button"
      className="neo-pinned-clear"
      onClick={onClear}
      title={clearTitle}
    >✕ Clear</button>
  </div>
);

export interface PinnedBannersProps {
  /** Problem rows currently in scope — only used to recover the
   *  friendly display name for entity / RCE filters. Passing an
   *  empty array is fine; the banner just falls back to the raw id. */
  problems: Problem[];

  pinnedProblemId: string | null;
  onClearPinnedProblem: () => void;

  entityFilter: string | null;
  onClearEntityFilter: () => void;

  rceFilter: string | null;
  onClearRceFilter: () => void;

  statusFilter: "ACTIVE" | "CLOSED" | null;
  onClearStatusFilter: () => void;

  stuckHoursFilter: number | null;
  onClearStuckHoursFilter: () => void;
}

export const PinnedBanners: React.FC<PinnedBannersProps> = ({
  problems,
  pinnedProblemId,
  onClearPinnedProblem,
  entityFilter,
  onClearEntityFilter,
  rceFilter,
  onClearRceFilter,
  statusFilter,
  onClearStatusFilter,
  stuckHoursFilter,
  onClearStuckHoursFilter,
}) => {
  // The pinned-problem banner has no leading dot in the original
  // markup, so we render it with an undefined background style.
  // Keeping the same DOM as before to avoid CSS regressions.
  const pinnedSection = pinnedProblemId ? (
    <div className="neo-pinned-banner" role="status">
      <span className="neo-pinned-dot" aria-hidden="true" />
      <span className="neo-pinned-label">Pinned to problem</span>
      <span className="neo-pinned-id">{pinnedProblemId}</span>
      <button
        type="button"
        className="neo-pinned-clear"
        onClick={onClearPinnedProblem}
        title="Show every problem again"
      >✕ Show all</button>
    </div>
  ) : null;

  let entitySection: React.ReactNode = null;
  if (entityFilter) {
    const sample = problems.find((p) =>
      Array.isArray(p.affected_entity_ids) && p.affected_entity_ids.includes(entityFilter),
    );
    const idx = sample?.affected_entity_ids?.indexOf(entityFilter) ?? -1;
    const friendly = idx >= 0 ? (sample?.affected_entity_names?.[idx] || entityFilter) : entityFilter;
    entitySection = (
      <BannerRow
        label="Affected entity"
        id={friendly}
        dotColor="#60A5FA"
        onClear={onClearEntityFilter}
        clearTitle="Show every entity again"
      />
    );
  }

  let rceSection: React.ReactNode = null;
  if (rceFilter) {
    const sample = problems.find((p) => p.root_cause_entity_id === rceFilter);
    const friendly = sample?.root_cause_entity_name || rceFilter;
    rceSection = (
      <BannerRow
        label="Root cause"
        id={friendly}
        dotColor="#F59E0B"
        onClear={onClearRceFilter}
        clearTitle="Show every root cause again"
      />
    );
  }

  const statusSection = statusFilter ? (
    <BannerRow
      label="Status"
      id={statusFilter === "ACTIVE" ? "Active" : "Closed"}
      // Active uses the canonical "open problem" red; Closed uses
      // a neutral grey so the visual semantics match the rest of
      // the app (FILTERS strip, mobile card stripe, etc.).
      dotColor={statusFilter === "ACTIVE" ? "#ff4d6a" : "#94A3B8"}
      onClear={onClearStatusFilter}
      clearTitle="Show problems of any status"
    />
  ) : null;

  const stuckSection = stuckHoursFilter !== null ? (
    <BannerRow
      label="Stuck"
      id={
        stuckHoursFilter >= 24
          ? `> ${Math.round(stuckHoursFilter / 24)} d`
          : `> ${stuckHoursFilter} h`
      }
      dotColor="#A855F7"
      onClear={onClearStuckHoursFilter}
      clearTitle="Remove the stuck-age filter"
    />
  ) : null;

  return (
    <>
      {pinnedSection}
      {entitySection}
      {rceSection}
      {statusSection}
      {stuckSection}
    </>
  );
};
