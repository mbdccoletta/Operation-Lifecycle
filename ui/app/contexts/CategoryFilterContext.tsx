// Lifts the "Filter by category" state above the route boundary so
// it persists when the user navigates between Incidents / Segments /
// Analytics. The chip strip itself lives in App.tsx (sticky, single
// instance); pages publish their per-window category counts via
// `setCounts` and consume `filter` / `toggle` to apply the choice
// to their own problem lists.
//
// The filter and the counts live in TWO separate contexts on
// purpose (M3 in the perf audit). Pages call `setCounts` on every
// problems-list change, so if both lived under the same context
// every page that reads `filter` (Overview, ProblemTimeline,
// TrendAnalysis) would re-render whenever ANY of them re-publishes
// its counts. Splitting them means the heavy `filter` consumers
// only re-render when the actual user selection changes; the only
// consumer that re-renders on count updates is the chip strip
// (which has to anyway, to update its badges).

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

// ── Filter (rarely changes — user-driven) ────────────────────────────
// The "filter strip" is no longer category-only — it also drives
// the Active/Closed status filter (`?status=` URL param). Keeping
// both pieces of state in the SAME context means the strip renders
// from one provider and pages consume one hook. `status` is a
// single value (mutually-exclusive) since `event.status` is a
// scalar — `null` means "show all statuses".
export type StatusFilter = "ACTIVE" | "CLOSED" | null;

interface CategoryFilterContextValue {
  /** Set of active category ids (e.g. "ERROR", "AVAILABILITY"). */
  filter: Set<string>;
  /** Whether any category is currently selected (size > 0). */
  isFiltering: boolean;
  toggle: (catId: string) => void;
  clear: () => void;
  /** Open/closed problem-status filter. `null` = no constraint. */
  status: StatusFilter;
  /** Idempotent setter — assigns the exact value passed. Use this
   *  for URL hydration / drilldowns where the caller knows the
   *  intended final state. */
  setStatus: (next: StatusFilter) => void;
  /** Toggle setter — passing the currently-active value clears,
   *  passing anything else assigns. Use this for chip clicks, where
   *  re-clicking the active chip should remove the filter. */
  toggleStatus: (next: StatusFilter) => void;
  /** Clears BOTH categories and status — wired to the strip's
   *  unified "✕ Clear" button. */
  clearAll: () => void;
}
const CategoryFilterContext = createContext<CategoryFilterContextValue | null>(null);

// ── Counts (re-published per page on every data refresh) ─────────────
// Read-only access — consumers subscribe to count changes (chip
// strip needs this; pages don't).
interface CategoryCountsContextValue {
  /** category id → active-problem count for the currently visible
   *  page. Mutated by each page via `setCounts` whenever its data
   *  changes; the chip strip reads from here. */
  counts: Record<string, number>;
}
const CategoryCountsContext = createContext<CategoryCountsContextValue | null>(null);

// Setter context — separate so publishers (pages) can call
// `setCounts` without subscribing to count changes themselves.
// The setter identity is stable for the lifetime of the provider,
// so consumers of this context never re-render on counts updates.
type SetCountsFn = (next: Record<string, number>) => void;
const CategoryCountsSetterContext = createContext<SetCountsFn | null>(null);

export const CategoryFilterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [filter, setFilter] = useState<Set<string>>(new Set());
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Lazy-init from `?status=` so the very first render of any
  // page that gates its data on `status` already has the correct
  // value (no flicker of an unfiltered list before the URL → state
  // effect runs). Same pattern Overview used when this state was
  // local; it's now centralised here.
  const [status, setStatusState] = useState<StatusFilter>(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("status");
    return raw === "ACTIVE" || raw === "CLOSED" ? raw : null;
  });

  const toggle = useCallback((catId: string) => {
    setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }, []);
  const clear = useCallback(() => setFilter(new Set()), []);

  // Idempotent setter — used by URL hydration. Always assigns the
  // value passed; never toggles. Keeps URL → state sync safe even
  // when the effect closes over a stale `status` value.
  const setStatus = useCallback((next: StatusFilter) => {
    setStatusState(next);
  }, []);
  // Toggle setter — used by the chip clicks in the strip. Re-clicking
  // the active chip clears the filter without a separate ✕ button.
  const toggleStatus = useCallback((next: StatusFilter) => {
    setStatusState((prev) => (prev === next ? null : next));
  }, []);
  const clearAll = useCallback(() => {
    setFilter(new Set());
    setStatusState(null);
  }, []);

  const filterValue = useMemo<CategoryFilterContextValue>(() => ({
    filter,
    isFiltering: filter.size > 0,
    toggle,
    clear,
    status,
    setStatus,
    toggleStatus,
    clearAll,
  }), [filter, toggle, clear, status, setStatus, toggleStatus, clearAll]);

  const countsValue = useMemo<CategoryCountsContextValue>(() => ({
    counts,
  }), [counts]);

  return (
    <CategoryFilterContext.Provider value={filterValue}>
      <CategoryCountsContext.Provider value={countsValue}>
        <CategoryCountsSetterContext.Provider value={setCounts}>
          {children}
        </CategoryCountsSetterContext.Provider>
      </CategoryCountsContext.Provider>
    </CategoryFilterContext.Provider>
  );
};

/** Backwards-compatible merged hook — used by the chip strip and
 *  any legacy caller that needs both the filter selection AND the
 *  current counts. Re-renders on changes to either. New code
 *  should prefer the granular hooks below. */
export function useCategoryFilter(): CategoryFilterContextValue & CategoryCountsContextValue & { setCounts: SetCountsFn } {
  const filterCtx = useContext(CategoryFilterContext);
  const countsCtx = useContext(CategoryCountsContext);
  const setCounts = useContext(CategoryCountsSetterContext);
  if (!filterCtx || !countsCtx || !setCounts) {
    throw new Error("useCategoryFilter must be used inside <CategoryFilterProvider />");
  }
  return { ...filterCtx, ...countsCtx, setCounts };
}

/** Read JUST the filter selection — does NOT subscribe to counts.
 *  Use this in pages that filter their problem list by category
 *  but don't render the chip strip (Overview, ProblemTimeline,
 *  TrendAnalysis). */
export function useCategoryFilterOnly(): CategoryFilterContextValue {
  const ctx = useContext(CategoryFilterContext);
  if (!ctx) throw new Error("useCategoryFilterOnly must be used inside <CategoryFilterProvider />");
  return ctx;
}

/** Read counts (read-only). Used by the chip strip to render
 *  per-category badges. Re-renders on every page's setCounts call. */
export function useCategoryCounts(): CategoryCountsContextValue {
  const ctx = useContext(CategoryCountsContext);
  if (!ctx) throw new Error("useCategoryCounts must be used inside <CategoryFilterProvider />");
  return ctx;
}

/** Stable setter for category counts. Identity never changes, so
 *  pages can publish counts without re-rendering on every update —
 *  the page is the SOURCE of the count change, it doesn't need to
 *  subscribe to its own writes. */
export function useSetCategoryCounts(): SetCountsFn {
  const setCounts = useContext(CategoryCountsSetterContext);
  if (!setCounts) throw new Error("useSetCategoryCounts must be used inside <CategoryFilterProvider />");
  return setCounts;
}
