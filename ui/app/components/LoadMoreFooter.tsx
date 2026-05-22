// Footer affordance for paginated lists — shown at the bottom of any
// list that's backed by `useProblems` (Incidents, Timeline,
// Analytics) when the DQL `| limit` clipped the result and a bigger
// query could legitimately return more records.
//
// UX rules baked in:
//   • Hidden completely when there's nothing to load (no result
//     beyond the cap) — no "you've hit the end" message because
//     that's not useful info on a triage screen.
//   • Disabled while a refetch is in flight so the user can't
//     stack four loadMore() calls and watch the cap double four
//     times.
//   • Shows the current loaded count so the user has context for
//     what they're about to expand.
import React from "react";

export interface LoadMoreFooterProps {
  /** Currently-loaded record count. Shown as the contextual "of N
   *  loaded so far" hint next to the button. */
  loadedCount: number;
  /** `true` when a `loadMore()` round-trip is currently in flight.
   *  We use the parent page's existing `fetching` flag (from
   *  `useProblems`) which already covers manual refresh + auto
   *  refresh — same spinner contract as the toolbar refresh button. */
  fetching: boolean;
  /** Hook callback that doubles the active limit. */
  onLoadMore: () => void;
  /** Optional override of the cap callout — defaults to "10 000".
   *  Stays in sync with the `HARD_CEILING` in useProblems. */
  ceilingLabel?: string;
}

export const LoadMoreFooter = ({
  loadedCount,
  fetching,
  onLoadMore,
  ceilingLabel = "10 000",
}: LoadMoreFooterProps) => {
  return (
    <div className="neo-load-more">
      <button
        type="button"
        className="neo-load-more-btn"
        onClick={onLoadMore}
        disabled={fetching}
        aria-label="Load more problems"
      >
        {fetching ? "Loading…" : "Load more"}
      </button>
      <span className="neo-load-more-hint">
        {loadedCount} loaded so far · ceiling {ceilingLabel}
      </span>
    </div>
  );
};
