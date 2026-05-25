// Tests for the Strato Timeframe → ParsedTimeframe parser.
//
// Treat a failure here as a counts-correctness regression: every
// failure has historically translated into "my app shows fewer
// problems than the native Davis Problems app", because an
// upstream timeframe that doesn't parse cascades into an
// unbounded or 72h-clamped DQL.

import { describe, it, expect } from "vitest";
import type { Timeframe } from "@dynatrace/strato-components-preview/core";
import {
  parseStratoTimeframe,
  parseStratoTimeframeAsString,
  FALLBACK_TIMEFRAME,
} from "./timeframe";

/** Build a Timeframe with the same shape Strato emits. The
 *  absolute date is only consulted by the parser when no preset
 *  match is found, so most tests pass a placeholder value. */
function tf(fromVal: string, toVal: string, absFrom = "2026-01-01T00:00:00Z", absTo = "2026-01-08T00:00:00Z"): Timeframe {
  return {
    from: { value: fromVal, absoluteDate: absFrom, type: "expression" },
    to:   { value: toVal,   absoluteDate: absTo,   type: "expression" },
  };
}

describe("parseStratoTimeframe — Strato preset coverage", () => {
  it("recognises 'Last 7 days' (`now()-7d` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-7d", "now()"))).toEqual({ timeframe: "7d" });
  });

  it("recognises 'Last 30 days' (`now()-30d` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-30d", "now()"))).toEqual({ timeframe: "30d" });
  });

  it("recognises 'Last 1 hour' (`now()-1h` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-1h", "now()"))).toEqual({ timeframe: "1h" });
  });

  it("recognises 'Last 2 hours' (`now()-2h` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-2h", "now()"))).toEqual({ timeframe: "2h" });
  });

  it("recognises 'Last 24 hours' (`now()-24h` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-24h", "now()"))).toEqual({ timeframe: "24h" });
  });

  it("recognises 'Last 30 minutes' (`now()-30m` → `now()`)", () => {
    expect(parseStratoTimeframe(tf("now()-30m", "now()"))).toEqual({ timeframe: "30m" });
  });
});

describe("parseStratoTimeframe — compact / legacy shapes", () => {
  it("accepts `-7d` (legacy URL deep-link form)", () => {
    expect(parseStratoTimeframe(tf("-7d", "now()"))).toEqual({ timeframe: "7d" });
  });

  it("accepts `7d` (bare relative form)", () => {
    expect(parseStratoTimeframe(tf("7d", "now()"))).toEqual({ timeframe: "7d" });
  });

  it("converts weeks to days so the DQL whitelist accepts the value", () => {
    expect(parseStratoTimeframe(tf("-1w", "now()"))).toEqual({ timeframe: "7d" });
    expect(parseStratoTimeframe(tf("-2w", "now()"))).toEqual({ timeframe: "14d" });
    expect(parseStratoTimeframe(tf("4w",  "now()"))).toEqual({ timeframe: "28d" });
  });

  it("accepts the bare `now` upper bound (no parentheses)", () => {
    // Some Strato versions emit `now` without parens; we honour
    // both spellings.
    expect(parseStratoTimeframe(tf("now()-7d", "now"))).toEqual({ timeframe: "7d" });
  });
});

describe("parseStratoTimeframe — `@d` (Today)", () => {
  it("anchors `from` to LOCAL midnight of the current day", () => {
    // We anchor to local midnight (the user's wall-clock day) so the
    // window matches "today" as the user understands it, not "today
    // in UTC". For a user in UTC-3 (Brazil) at 10:00 local on
    // 2026-05-25, the previous behaviour returned UTC 00:00 which is
    // 21:00 of 2026-05-24 in their timezone — three hours of
    // "yesterday" leaked into "today".
    const parsed = parseStratoTimeframe(tf("@d", "now()"));
    expect(parsed.timeframe).toBeUndefined();
    expect(parsed.from).toBeDefined();
    expect(parsed.to).toBeDefined();

    const fromMs = Date.parse(parsed.from!);
    const toMs   = Date.parse(parsed.to!);

    // The from timestamp, when read in LOCAL time, should be
    // midnight (00:00:00) of today.
    const fromDate = new Date(fromMs);
    expect(fromDate.getHours()).toBe(0);
    expect(fromDate.getMinutes()).toBe(0);
    expect(fromDate.getSeconds()).toBe(0);
    expect(fromDate.getMilliseconds()).toBe(0);

    // And the date itself should match today's local date.
    const today = new Date();
    expect(fromDate.getFullYear()).toBe(today.getFullYear());
    expect(fromDate.getMonth()).toBe(today.getMonth());
    expect(fromDate.getDate()).toBe(today.getDate());

    // Sanity: from ≤ to, and the diff is at most 24h.
    expect(toMs - fromMs).toBeGreaterThanOrEqual(0);
    expect(toMs - fromMs).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
  });

  it("produces ISO strings with the trailing Z (UTC encoding) for DQL", () => {
    // The ISO is emitted in UTC for the DQL query (DQL expects UTC),
    // even though the LOCAL midnight semantic is what the user picks.
    // We just check the timestamp encoding is valid and ends in Z.
    const parsed = parseStratoTimeframe(tf("@d", "now()"));
    expect(parsed.from).toMatch(/Z$/);
    expect(parsed.to).toMatch(/Z$/);
  });
});

describe("parseStratoTimeframe — absolute / custom range", () => {
  it("returns ISO bounds when the from/to don't match any relative shape", () => {
    // A custom-range selection: Strato fills both `value` and
    // `absoluteDate` with the same ISO string.
    const t: Timeframe = {
      from: { value: "2026-04-01T00:00:00Z", absoluteDate: "2026-04-01T00:00:00Z", type: "iso8601" },
      to:   { value: "2026-04-15T00:00:00Z", absoluteDate: "2026-04-15T00:00:00Z", type: "iso8601" },
    };
    expect(parseStratoTimeframe(t)).toEqual({
      from: "2026-04-01T00:00:00Z",
      to:   "2026-04-15T00:00:00Z",
    });
  });

  it("falls back to 72h when absoluteDate is missing on either side", () => {
    // Transient Strato state: relative `from`, absoluteDate not
    // yet resolved. This is the exact path that produced the
    // `5 vs 35` regression — the inline parser in Overview.tsx
    // landed here and silently clamped to 72h.
    const t: Timeframe = {
      from: { value: "garbage", absoluteDate: "" as unknown as string, type: "expression" },
      to:   { value: "garbage", absoluteDate: "" as unknown as string, type: "expression" },
    };
    expect(parseStratoTimeframe(t)).toEqual({ timeframe: FALLBACK_TIMEFRAME });
  });
});

describe("parseStratoTimeframe — degenerate inputs", () => {
  it("returns the fallback for null / undefined", () => {
    expect(parseStratoTimeframe(null)).toEqual({ timeframe: FALLBACK_TIMEFRAME });
    expect(parseStratoTimeframe(undefined)).toEqual({ timeframe: FALLBACK_TIMEFRAME });
  });

  it("returns the fallback for an empty-string `from.value` without absoluteDate", () => {
    const t: Timeframe = {
      from: { value: "", absoluteDate: "" as unknown as string, type: "expression" },
      to:   { value: "now()", absoluteDate: "" as unknown as string, type: "expression" },
    };
    expect(parseStratoTimeframe(t)).toEqual({ timeframe: FALLBACK_TIMEFRAME });
  });
});

describe("parseStratoTimeframeAsString — trend-chart consumer", () => {
  it("returns the relative form when the parsed result is relative", () => {
    expect(parseStratoTimeframeAsString(tf("now()-7d", "now()"))).toBe("7d");
    expect(parseStratoTimeframeAsString(tf("now()-30m", "now()"))).toBe("30m");
  });

  it("converts ISO bounds to hours when the window is short", () => {
    const t: Timeframe = {
      from: { value: "2026-04-01T00:00:00Z", absoluteDate: "2026-04-01T00:00:00Z", type: "iso8601" },
      to:   { value: "2026-04-01T12:00:00Z", absoluteDate: "2026-04-01T12:00:00Z", type: "iso8601" },
    };
    expect(parseStratoTimeframeAsString(t)).toBe("12h");
  });

  it("converts ISO bounds to days when the window is long", () => {
    const t: Timeframe = {
      from: { value: "2026-04-01T00:00:00Z", absoluteDate: "2026-04-01T00:00:00Z", type: "iso8601" },
      to:   { value: "2026-04-08T00:00:00Z", absoluteDate: "2026-04-08T00:00:00Z", type: "iso8601" },
    };
    expect(parseStratoTimeframeAsString(t)).toBe("7d");
  });

  it("falls back to 72h for null / undefined", () => {
    expect(parseStratoTimeframeAsString(null)).toBe(FALLBACK_TIMEFRAME);
    expect(parseStratoTimeframeAsString(undefined)).toBe(FALLBACK_TIMEFRAME);
  });
});
