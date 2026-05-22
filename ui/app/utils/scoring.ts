// Single source of truth for "how important is this problem RIGHT NOW".
// Used by the constellation (top-tier focus rings), the bar chart
// (highlight markers), the list (mode-driven row highlight), and the
// Analytics priority queue. Anything that picks the "top" problem(s)
// under a given Show By mode goes through here.
import type { Problem } from "../hooks/useProblems";

export type DataMode = "rising" | "open_time" | "criticality" | "total";

/** Score a single problem under the active mode. Range is loosely
 *  0..1 but not strictly bounded — callers normalise per-cluster /
 *  per-cell when picking the top tier. Total mode returns a constant
 *  so every problem ties (no useful ranking exists). */
export function scoreOf(p: Problem, mode: DataMode): number {
  const hours = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
  const sev   = parseInt(String(p["event.severity"] || "0"), 10);
  switch (mode) {
    case "rising":      return Math.max(0, 1 - hours);
    case "total":       return 1;
    case "criticality": return Math.min(1, Math.max(0, sev) / 5);
    case "open_time":
    default:            return Math.min(1, hours / 12);
  }
}

/** Top-tier threshold — anything within 95 % of the cluster max is
 *  flagged as a leader. Matches the Incidents-page focus ring rule
 *  the rest of the app already follows. */
export const TOP_TIER_THRESHOLD = 0.95;

/** Convenience: given a candidate list and mode, return the set of
 *  display_ids that should be highlighted. Empty for Total mode and
 *  when the max score is 0. */
export function pickTopTier(problems: Problem[], mode: DataMode): Set<string> {
  if (mode === "total") return new Set();
  const scored = problems
    .map((p) => ({ p, s: scoreOf(p, mode) }))
    .sort((a, b) => b.s - a.s);
  if (scored.length === 0 || scored[0].s <= 0) return new Set();
  const max = scored[0].s;
  return new Set(
    scored.filter(({ s }) => s >= max * TOP_TIER_THRESHOLD).map(({ p }) => p.display_id),
  );
}
