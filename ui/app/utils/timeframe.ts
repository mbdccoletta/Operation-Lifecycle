// Parse Strato's `Timeframe` into the shape our DQL builders consume.
//
// WHY THIS LIVES IN ITS OWN MODULE
// --------------------------------
// The Strato `TimeframeSelector` emits values in two different
// vocabularies depending on the preset the user picks:
//
//   • Compact "relative" form (rare, mostly legacy):  "-7d", "1h"
//   • Strato preset form (every built-in preset):     "now()-7d", "now()-30m"
//   • Calendar boundary:                              "@d"  (start of UTC day)
//   • Calendar with offset:                           "-1d@d"  (yesterday → today)
//   • Custom range:                                   absolute ISO timestamps
//
// We previously had inline parsing in `Overview.tsx` that only
// recognised the compact form — when the user picked any built-in
// preset (Last 7 days = `now()-7d`), the regex didn't match and the
// path fell to an absolute-ISO fallback. That fallback in turn
// required BOTH `absoluteDate` fields to be populated, and Strato
// occasionally emits a transition with one of them undefined — at
// which point the whole filter snapped to a 72 h default and the
// list/badges queried a much smaller window than the rest of the
// app. The user-visible symptom was "5 closed Availability problems"
// in our app vs "35" in the native Davis Problems app for the same
// 7-day window.
//
// Pulling the parser into one tested module makes the contract
// inspectable and prevents regressing on every preset shape that
// Strato might add or rename.
//
// Strato preset reference (mirrored from
//   @dynatrace/strato-components/filters/timeframe-selector/constants/timeframe-presets.js):
//
//   Last 30 minutes   from: "now()-30m"  to: "now()"
//   Last 1 hour       from: "now()-1h"   to: "now()"
//   Last 2 hours      from: "now()-2h"   to: "now()"
//   Today             from: "@d"         to: "now()"
//   Yesterday         from: "-1d@d"      to: "@d"
//   Last 24 hours     from: "now()-24h"  to: "now()"
//   Last 7 days       from: "now()-7d"   to: "now()"
//
// Plus a custom-range mode where both values are ISO-8601 strings.

import type { Timeframe } from "@dynatrace/strato-components-preview/core";

/** Output shape consumed by `buildFilteredQuery` /
 *  `buildCategoryCountsQuery`. Exactly one of (`timeframe`) or
 *  (`from` + `to`) is meaningful per call. */
export interface ParsedTimeframe {
  /** Relative window in the `<n>(h|d|m)` form the DQL builder
   *  accepts. */
  timeframe?: string;
  /** Absolute ISO-8601 lower bound. */
  from?: string;
  /** Absolute ISO-8601 upper bound. */
  to?: string;
}

/** Last-resort window used when nothing else parses. Matches the
 *  defense-in-depth fallback inside `buildFilteredQuery` so the two
 *  layers never disagree on what "give up" means. */
export const FALLBACK_TIMEFRAME = "72h";

/** Convert a Strato `Timeframe` into the legacy `{timeframe} |
 *  {from,to}` shape used by our DQL builders. The function is
 *  intentionally tolerant: every recognised preset shape resolves
 *  to a bounded window, and anything unrecognised falls back to
 *  72 h so the resulting DQL is never unbounded. */
export function parseStratoTimeframe(
  timeframe: Timeframe | null | undefined,
): ParsedTimeframe {
  if (!timeframe) return { timeframe: FALLBACK_TIMEFRAME };

  const fromVal = timeframe.from?.value || "";
  const toVal   = timeframe.to?.value   || "";
  const toIsNow = toVal === "now" || toVal === "now()";

  // ── "Today" (`@d` → `now()`) ────────────────────────────────────
  // Anchored to LOCAL midnight (the user's browser timezone) so
  // "Today" matches the user's wall-clock day rather than the UTC
  // day. Previously we used UTC midnight, which for any user not in
  // UTC produced a window that included a slice of the previous
  // local day (3 h for Brazil / UTC-3, 12 h for NZ / UTC+12). The
  // ISO timestamp we emit still carries a Z (UTC offset), so DQL
  // gets an unambiguous timestamp — the shift is purely about where
  // the window STARTS in the calendar.
  if (fromVal === "@d" && toIsNow) {
    const now = new Date();
    // `new Date(year, month, day)` constructs a Date at LOCAL
    // 00:00:00.000; `.toISOString()` then renders it in UTC for DQL.
    // The net effect is: from = "midnight in the user's timezone".
    const startOfDayLocal = new Date(
      now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0,
    );
    return { from: startOfDayLocal.toISOString(), to: now.toISOString() };
  }

  // ── Relative preset / compact form ──────────────────────────────
  // Accepts BOTH the Strato preset shape (`now()-7d`, `now()-30m`)
  // AND the compact relative shape (`-7d`, `1w`, `24h`) the older
  // selector / URL deep-links used. The whole match is gated on the
  // upper bound being `now()` so a window like
  // `now()-7d → now()-1d` (rare but legal in Strato) falls through
  // to the absolute path below where the ISO timestamps carry the
  // exact bounds.
  const m = /^(?:now\(\)-|-?)(\d+)([mhdw])$/.exec(fromVal);
  if (m && toIsNow) {
    let unit  = m[2];
    let value = m[1];
    // Weeks → days: the DQL builder's whitelist is `[hdm]`.
    if (unit === "w") { unit = "d"; value = String(Number(value) * 7); }
    return { timeframe: `${value}${unit}` };
  }

  // ── Absolute fallback ───────────────────────────────────────────
  // Reached for custom ranges (both ends ISO) and any preset we
  // didn't model above (e.g. "Yesterday" = `-1d@d → @d`). Only
  // honoured when BOTH absoluteDate fields are populated — a
  // transient Strato state with one of them undefined would
  // otherwise inject an empty bound into the DQL.
  const absFrom = timeframe.from?.absoluteDate;
  const absTo   = timeframe.to?.absoluteDate;
  if (absFrom && absTo) return { from: absFrom, to: absTo };

  return { timeframe: FALLBACK_TIMEFRAME };
}

/** Convert a Strato `Timeframe` into the legacy "Xh" / "Xd" string
 *  used by `useProblemTrend` (which embeds it in a DQL
 *  `now() - {X}` expression). Wraps `parseStratoTimeframe` so the
 *  preset coverage is identical — for ISO windows it computes the
 *  diff in hours and rounds to the nearest hour or day depending
 *  on size, matching the legacy inline behaviour. */
export function parseStratoTimeframeAsString(
  timeframe: Timeframe | null | undefined,
): string {
  const parsed = parseStratoTimeframe(timeframe);
  if (parsed.timeframe) return parsed.timeframe;
  if (parsed.from && parsed.to) {
    const ms = Date.parse(parsed.to) - Date.parse(parsed.from);
    if (!Number.isFinite(ms) || ms <= 0) return FALLBACK_TIMEFRAME;
    const hours = Math.max(1, Math.round(ms / 3_600_000));
    return hours <= 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
  }
  return FALLBACK_TIMEFRAME;
}
