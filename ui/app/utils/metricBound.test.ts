// Tests for the metric-filter bound parser + matcher. Drives the
// "Has metric" chips on Incidents — a regression here silently
// mis-narrows the visible problem list, which is the kind of bug
// users only notice when they're missing an incident they expected
// to see.

import { describe, it, expect } from "vitest";
import {
  matchesBound,
  formatBoundLabel,
  boundsEqual,
  parseMetricBoundExpression,
  boundToExpression,
  serializeMetricFilter,
  parseMetricFilter,
  type MetricKey,
  type MetricBound,
} from "./metricBound";

describe("matchesBound", () => {
  it("rejects null / undefined / non-finite for non-`any` bounds", () => {
    const b: MetricBound = { type: "gt", minMs: 100 };
    expect(matchesBound(null, b)).toBe(false);
    expect(matchesBound(undefined, b)).toBe(false);
    expect(matchesBound(NaN, b)).toBe(false);
    expect(matchesBound(Infinity, b)).toBe(false);
  });

  it("the `any` bound rejects null + accepts finite values", () => {
    expect(matchesBound(null, { type: "any" })).toBe(false);
    expect(matchesBound(0,    { type: "any" })).toBe(true);
    expect(matchesBound(1234, { type: "any" })).toBe(true);
  });

  it("respects lt / gt strictness", () => {
    expect(matchesBound(99,  { type: "lt", maxMs: 100 })).toBe(true);
    expect(matchesBound(100, { type: "lt", maxMs: 100 })).toBe(false);
    expect(matchesBound(101, { type: "gt", minMs: 100 })).toBe(true);
    expect(matchesBound(100, { type: "gt", minMs: 100 })).toBe(false);
  });

  it("treats `between` as inclusive on both ends", () => {
    const b: MetricBound = { type: "between", minMs: 100, maxMs: 200 };
    expect(matchesBound(100, b)).toBe(true);
    expect(matchesBound(200, b)).toBe(true);
    expect(matchesBound(150, b)).toBe(true);
    expect(matchesBound(99,  b)).toBe(false);
    expect(matchesBound(201, b)).toBe(false);
  });
});

describe("boundsEqual", () => {
  it("compares by type + values", () => {
    expect(boundsEqual({ type: "any" }, { type: "any" })).toBe(true);
    expect(boundsEqual({ type: "lt", maxMs: 100 }, { type: "lt", maxMs: 100 })).toBe(true);
    expect(boundsEqual({ type: "lt", maxMs: 100 }, { type: "lt", maxMs: 101 })).toBe(false);
    expect(boundsEqual({ type: "gt", minMs: 100 }, { type: "lt", maxMs: 100 })).toBe(false);
  });
});

describe("parseMetricBoundExpression", () => {
  it("accepts bare numbers as minutes", () => {
    // `5` → 5 minutes ≈ "any value > 5 (min)" if combined with > etc.
    // But the spec says bare numbers default to minutes.
    const b = parseMetricBoundExpression(">5");
    expect(b?.type).toBe("gt");
    if (b?.type === "gt") expect(b.minMs).toBe(5 * 60_000);
  });

  it("accepts explicit duration units", () => {
    const b = parseMetricBoundExpression(">1h");
    expect(b?.type).toBe("gt");
    if (b?.type === "gt") expect(b.minMs).toBe(60 * 60_000);
  });

  it("accepts range with `..`", () => {
    const b = parseMetricBoundExpression("1h..4h");
    expect(b?.type).toBe("between");
    if (b?.type === "between") {
      expect(b.minMs).toBe(60 * 60_000);
      expect(b.maxMs).toBe(4 * 60 * 60_000);
    }
  });

  it("accepts compound `>X <Y`", () => {
    const b = parseMetricBoundExpression(">1h <4h");
    expect(b?.type).toBe("between");
  });

  it("returns null for garbage", () => {
    // `""` / `"any"` / `"*"` map to `{ type: "any" }` BY DESIGN —
    // they're the textual form of "no constraint, just require the
    // metric to be defined". Truly malformed input returns null.
    expect(parseMetricBoundExpression("xxx")).toBeNull();
    expect(parseMetricBoundExpression(">>1h")).toBeNull();
    expect(parseMetricBoundExpression("1h..")).toBeNull();
  });

  it("treats empty / `any` / `*` as the `any` bound", () => {
    expect(parseMetricBoundExpression("")?.type).toBe("any");
    expect(parseMetricBoundExpression("any")?.type).toBe("any");
    expect(parseMetricBoundExpression("*")?.type).toBe("any");
  });

  it("round-trips through boundToExpression", () => {
    const original = parseMetricBoundExpression(">5m");
    const reparsed = original ? parseMetricBoundExpression(boundToExpression(original)) : null;
    expect(boundsEqual(original!, reparsed!)).toBe(true);
  });
});

describe("serializeMetricFilter ↔ parseMetricFilter", () => {
  it("round-trips a mixed map", () => {
    const map = new Map<MetricKey, MetricBound>([
      ["mtta", { type: "any" }],
      ["mttr", { type: "lt", maxMs: 5 * 60_000 }],
      ["mtbf", { type: "between", minMs: 60_000, maxMs: 5 * 60_000 }],
    ]);
    const s = serializeMetricFilter(map);
    const back = parseMetricFilter(s);
    expect(back.size).toBe(3);
    expect(boundsEqual(back.get("mtta")!, { type: "any" })).toBe(true);
    expect(boundsEqual(back.get("mttr")!, { type: "lt", maxMs: 5 * 60_000 })).toBe(true);
  });

  it("returns an empty map for null / empty", () => {
    expect(parseMetricFilter(null).size).toBe(0);
    expect(parseMetricFilter(undefined).size).toBe(0);
    expect(parseMetricFilter("").size).toBe(0);
  });

  it("ignores unknown metric keys", () => {
    // Wire format separator is `,` between chips and `:` between
    // tokens of a single chip. Unknown keys (here `xxx`) are
    // silently skipped so a malicious / stale URL can't inject
    // garbage into the filter map.
    const back = parseMetricFilter("xxx,mtta");
    expect(back.size).toBe(1);
    expect(back.has("mtta")).toBe(true);
  });
});

describe("formatBoundLabel", () => {
  it("produces compact human strings", () => {
    // `any` collapses to an empty string — the chip body itself
    // carries the metric name, so the value slot stays empty.
    expect(formatBoundLabel({ type: "any" })).toBe("");
    expect(formatBoundLabel({ type: "lt", maxMs: 5 * 60_000 })).toMatch(/^< /);
    expect(formatBoundLabel({ type: "gt", minMs: 60 * 60_000 })).toMatch(/^> /);
    // Uses EN DASH (–), not two dots, in the rendered label.
    expect(formatBoundLabel({ type: "between", minMs: 60_000, maxMs: 5 * 60_000 })).toContain(" – ");
  });
});
