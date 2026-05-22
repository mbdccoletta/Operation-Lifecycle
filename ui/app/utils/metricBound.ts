// Shared shape for the metric-availability filter on the Incidents
// list. A `MetricBound` can be:
//   • `any`       — the chip is active but no value constraint set
//                    ("show problems where MTTA is defined")
//   • `lt`        — strictly less than `maxMs`         ("MTTA < 5 m")
//   • `gt`        — strictly greater than `minMs`      ("MTTR > 1 d")
//   • `between`   — inclusive range `[minMs, maxMs]`    ("MTBF 1 h – 4 h")
//
// The chip strip on Overview keeps a `Map<MetricKey, MetricBound>`
// instead of the previous `Set<MetricKey>` so each active metric can
// carry its own bound independently. OR semantics across metrics is
// preserved (a row passes if AT LEAST ONE active metric's bound is
// satisfied).

import { formatDurationMs, parseDurationMs } from "./formatters";

export type MetricKey = "mtta" | "mttr" | "mtbf" | "mttf";

export type MetricBound =
  | { type: "any" }
  | { type: "lt"; maxMs: number }
  | { type: "gt"; minMs: number }
  | { type: "between"; minMs: number; maxMs: number };

/** Evaluate a bound against a measured value (ms). `null` / undefined
 *  values fail every non-`any` bound — the chip's contract is "this
 *  metric is defined AND matches the constraint", so missing data is
 *  treated as a non-match regardless of the constraint shape. */
export function matchesBound(ms: number | null | undefined, b: MetricBound): boolean {
  if (ms == null || !Number.isFinite(ms)) return false;
  switch (b.type) {
    case "any":     return true;
    case "lt":      return ms < b.maxMs;
    case "gt":      return ms > b.minMs;
    case "between": return ms >= b.minMs && ms <= b.maxMs;
  }
}

/** Compact label appended to the chip when a bound is constraining
 *  the metric. "MTTA" stays bare when bound = `any`, becomes
 *  "MTTA > 1h" / "MTTA 1h – 4h" otherwise. Used INSIDE the chip
 *  label, not in the popover (which shows the full picker). */
export function formatBoundLabel(b: MetricBound): string {
  switch (b.type) {
    case "any":     return "";
    case "lt":      return `< ${formatDurationMs(b.maxMs)}`;
    case "gt":      return `> ${formatDurationMs(b.minMs)}`;
    case "between": return `${formatDurationMs(b.minMs)} – ${formatDurationMs(b.maxMs)}`;
  }
}

/** Aria-label fragment for the chip — fully spelled out so screen
 *  readers announce "MTTA filter, greater than one hour". */
export function describeBound(metric: MetricKey, b: MetricBound): string {
  const M = metric.toUpperCase();
  switch (b.type) {
    case "any":     return `${M} defined (any value)`;
    case "lt":      return `${M} less than ${formatDurationMs(b.maxMs)}`;
    case "gt":      return `${M} greater than ${formatDurationMs(b.minMs)}`;
    case "between": return `${M} between ${formatDurationMs(b.minMs)} and ${formatDurationMs(b.maxMs)}`;
  }
}

// ── URL encoding ────────────────────────────────────────────────────
// Wire format keeps the existing `?metric=` param shape backward
// compatible. Each chip serialises as:
//   • "mtta"                       → any
//   • "mtta:lt:300000"              → < 5 min
//   • "mtta:gt:3600000"             → > 1 h
//   • "mtta:bw:3600000:14400000"    → 1h – 4h
// Multiple chips are comma-joined: "mtta:gt:3600000,mttr".

const ALLOWED: ReadonlySet<MetricKey> = new Set<MetricKey>(["mtta", "mttr", "mtbf", "mttf"]);

export function serializeMetricFilter(map: Map<MetricKey, MetricBound>): string {
  const parts: string[] = [];
  for (const [k, b] of map) {
    switch (b.type) {
      case "any":     parts.push(k); break;
      case "lt":      parts.push(`${k}:lt:${b.maxMs}`); break;
      case "gt":      parts.push(`${k}:gt:${b.minMs}`); break;
      case "between": parts.push(`${k}:bw:${b.minMs}:${b.maxMs}`); break;
    }
  }
  return parts.join(",");
}

export function parseMetricFilter(raw: string | null | undefined): Map<MetricKey, MetricBound> {
  const out = new Map<MetricKey, MetricBound>();
  if (!raw) return out;
  for (const seg of raw.split(",")) {
    const tokens = seg.trim().toLowerCase().split(":");
    const key = tokens[0] as MetricKey;
    if (!ALLOWED.has(key)) continue;
    if (tokens.length === 1) {
      out.set(key, { type: "any" });
      continue;
    }
    const op = tokens[1];
    if (op === "lt" && tokens[2]) {
      const v = Number(tokens[2]);
      if (Number.isFinite(v) && v > 0) out.set(key, { type: "lt", maxMs: v });
    } else if (op === "gt" && tokens[2]) {
      const v = Number(tokens[2]);
      if (Number.isFinite(v) && v >= 0) out.set(key, { type: "gt", minMs: v });
    } else if (op === "bw" && tokens[2] && tokens[3]) {
      const a = Number(tokens[2]);
      const c = Number(tokens[3]);
      if (Number.isFinite(a) && Number.isFinite(c) && a >= 0 && c > a) {
        out.set(key, { type: "between", minMs: a, maxMs: c });
      }
    } else {
      // Unknown operator → fall back to "any" so we never silently
      // drop a chip just because the wire format gained a feature
      // the deployed code doesn't recognise.
      out.set(key, { type: "any" });
    }
  }
  return out;
}

// ── Preset table ────────────────────────────────────────────────────
// Quick choices in the popover. Tuned to the time scales typical for
// each metric class — MTTA is usually minutes/hours, MTTR hours/days,
// MTBF/MTTF hours/days. The same presets are offered for all four
// metrics so the picker stays consistent and discoverable; users who
// need something specific use the custom range fields.
export interface PresetOption {
  /** Short label shown on the preset button. */
  label: string;
  /** Resulting bound when clicked. */
  bound: MetricBound;
}

const MIN  = 60_000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

export const METRIC_BOUND_PRESETS: PresetOption[] = [
  { label: "Any value",   bound: { type: "any" } },
  { label: "< 5 m",       bound: { type: "lt", maxMs:   5 * MIN } },
  { label: "< 30 m",      bound: { type: "lt", maxMs:  30 * MIN } },
  { label: "< 1 h",       bound: { type: "lt", maxMs:       HOUR } },
  { label: "1 h – 4 h",   bound: { type: "between", minMs:       HOUR, maxMs:  4 * HOUR } },
  { label: "4 h – 1 d",   bound: { type: "between", minMs:  4 * HOUR, maxMs:        DAY } },
  { label: "> 1 d",       bound: { type: "gt", minMs:        DAY } },
  { label: "> 1 w",       bound: { type: "gt", minMs:    7 * DAY } },
];

/** True when two bounds are functionally identical — used to flag
 *  the currently-selected preset inside the popover. */
export function boundsEqual(a: MetricBound, b: MetricBound): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "any":     return true;
    case "lt":      return (b as { maxMs: number }).maxMs === a.maxMs;
    case "gt":      return (b as { minMs: number }).minMs === a.minMs;
    case "between": {
      const bb = b as { minMs: number; maxMs: number };
      return bb.minMs === a.minMs && bb.maxMs === a.maxMs;
    }
  }
}

// Re-export parseDurationMs for component callers that don't want a
// second import line.
export { parseDurationMs };

/** Parse a free-form bound expression into a `MetricBound`.
 *
 *  Accepted grammar (case-insensitive, whitespace flexible):
 *    `>5m`            → { type: "gt", minMs: 300_000 }
 *    `<30m`           → { type: "lt", maxMs: 1_800_000 }
 *    `>10d`           → { type: "gt", minMs: 864_000_000 }
 *    `1h..4h`         → { type: "between", 3_600_000, 14_400_000 }
 *    `1h - 4h`        → same
 *    `1h to 4h`       → same
 *    `>1h <4h`        → same (compound — order doesn't matter)
 *    `<4h >1h`        → same
 *    `>=5m`           → treated as `>5m` (strict for simplicity;
 *                       chip semantics don't need ≥ separation)
 *    empty / `any`    → { type: "any" }
 *
 *  Returns `null` for syntactically invalid expressions (caller
 *  shows a parse-error toast / inline message). */
export function parseMetricBoundExpression(input: string): MetricBound | null {
  if (input == null) return null;
  const text = input.trim().toLowerCase();
  if (text === "" || text === "any" || text === "*") {
    return { type: "any" };
  }

  // Pattern: range with `..` / `-` / `to` separator. Bare numbers
  // without a unit default to minutes (same lenient rule as the
  // comparison parser below) — `5..30` reads as "5 to 30 minutes".
  const rangeMatch = /^([0-9].*?)\s*(?:\.\.|–|—|-|to)\s*([0-9].*)$/.exec(text);
  if (rangeMatch) {
    const a = parseDurationOrMinutes(rangeMatch[1]);
    const b = parseDurationOrMinutes(rangeMatch[2]);
    if (a == null || b == null) return null;
    if (a >= b) return null;
    return { type: "between", minMs: a, maxMs: b };
  }

  // Pattern: compound `>X <Y` or `<Y >X` (two comparison clauses).
  // Split on whitespace, parse each clause, combine. Both clauses
  // must specify the same metric → only need a `>` and a `<`.
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 2) {
    let minMs: number | null = null;
    let maxMs: number | null = null;
    for (const tok of tokens) {
      const c = parseSingleComparison(tok);
      if (!c) return null;
      if (c.op === "gt") {
        if (minMs !== null) return null; // duplicate
        minMs = c.ms;
      } else if (c.op === "lt") {
        if (maxMs !== null) return null;
        maxMs = c.ms;
      } else {
        return null;
      }
    }
    if (minMs !== null && maxMs !== null && minMs < maxMs) {
      return { type: "between", minMs, maxMs };
    }
    return null;
  }

  // Single comparison: `>5m` / `<5m` / `>=5m` / `<=5m`.
  const single = parseSingleComparison(text);
  if (single?.op === "gt") return { type: "gt", minMs: single.ms };
  if (single?.op === "lt") return { type: "lt", maxMs: single.ms };

  return null;
}

/** Lenient duration parser — tries `parseDurationMs` first (requires
 *  an explicit unit like `5m`, `1h`, `2d`), then falls back to
 *  treating a bare number as MINUTES. Used by the metric bound
 *  expressions so users can type `>5` and get the natural triage
 *  default ("5 minutes") instead of a parse error. */
function parseDurationOrMinutes(s: string): number | null {
  const explicit = parseDurationMs(s);
  if (explicit !== null) return explicit;
  const m = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return n * 60_000;
}

/** Parse a single `>X` / `<X` / `>=X` / `<=X` comparison token.
 *  Returns null for tokens without a leading operator or where the
 *  duration can't be parsed.
 *
 *  Lenient parsing: bare numbers without a unit default to MINUTES
 *  (SRE triage default — `>5` reads as "5 minutes", not "5
 *  seconds" or "5 hours"). Explicit units always win. */
function parseSingleComparison(tok: string): { op: "gt" | "lt"; ms: number } | null {
  const m = /^(>=|<=|>|<)\s*(.+)$/.exec(tok);
  if (!m) return null;
  const ms = parseDurationOrMinutes(m[2]);
  if (ms == null) return null;
  const opChar = m[1][0];
  return { op: opChar === ">" ? "gt" : "lt", ms };
}

/** Inverse of `parseMetricBoundExpression` — render a bound as the
 *  compact text expression a user would type. Used to pre-fill the
 *  input when the user re-opens the chip with an existing bound. */
export function boundToExpression(b: MetricBound): string {
  switch (b.type) {
    case "any":     return "";
    case "lt":      return `<${formatDurationCompact(b.maxMs)}`;
    case "gt":      return `>${formatDurationCompact(b.minMs)}`;
    case "between": return `${formatDurationCompact(b.minMs)}..${formatDurationCompact(b.maxMs)}`;
  }
}

/** Tight-format duration without spaces — "5m", "1h30m", "2d".
 *  Used by `boundToExpression` so the user sees a string that
 *  round-trips through their own parser. */
function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const restM = min % 60;
    return restM > 0 ? `${hr}h${restM}m` : `${hr}h`;
  }
  const d = Math.floor(hr / 24);
  const restH = hr % 24;
  return restH > 0 ? `${d}d${restH}h` : `${d}d`;
}
