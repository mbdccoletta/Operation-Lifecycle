import type { Problem } from "../hooks/useProblems";

// The previous `IMPACT_LABELS` / `IMPACT_MAP` / `getImpacts()`
// helpers were removed in the Tier 2 cleanup — they read
// `affected_entity_types`, a field no live caller imported, and
// the active impact derivation lives in `utils/formatters.ts`
// (which infers from entity IDs and the canonical names from
// dt.davis.problems). Dropping them removed ~50 LoC of dead
// code AND let us shrink the DQL `| fields` projection.

// ── Severity: derived from critScore (duration + impact) ──────────────────
export const SEVERITY_LABELS = [
  "Critical",
  "Major",
  "Minor",
  "Warning",
  "Informational",
] as const;
export type Severity = (typeof SEVERITY_LABELS)[number];

export function getCritScore(p: Problem): number {
  if (p["event.status"] !== "ACTIVE") return 0;
  const hours = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
  const entities = p.affected_entity_ids?.length || 1;
  return Math.min(1, (hours / 8) * 0.55 + (entities / 6) * 0.45);
}

export function getSeverity(p: Problem): Severity {
  // Resolved problems are always Informational
  if (p["event.status"] !== "ACTIVE") return "Informational";
  const score = getCritScore(p);
  if (score >= 0.8) return "Critical";
  if (score >= 0.6) return "Major";
  if (score >= 0.4) return "Minor";
  if (score >= 0.2) return "Warning";
  return "Informational";
}

// Aligned with Strato's 5 universal status levels:
//   Critical → Critical (red),  Major → Warning (amber),
//   Minor    → Neutral  (grey-blue), Warning → Good (sky blue),
//   Informational → Neutral (grey)
// Reference: https://developer.dynatracelabs.com/design/patterns/status-and-health
export const SEVERITY_COLORS: Record<Severity, string> = {
  Critical:      "#ef4444",   // Strato Critical — red
  Major:         "#f59e0b",   // Strato Warning — amber
  Minor:         "#64748b",   // Strato Neutral darker — slate
  Warning:       "#60a5fa",   // Strato Good informative — blue
  Informational: "#94a3b8",   // Strato Neutral — slate-light
};
