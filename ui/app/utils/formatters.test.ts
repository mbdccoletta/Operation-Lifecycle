// Tests for the pure formatters used everywhere in the UI. Cover:
//   • formatDurationMs + parseDurationMs round-trips (filter chips
//     depend on this — a bug here mis-narrows the list)
//   • getCategoryLabel / getCategoryColor / getCategoryIcon (visual
//     consistency across surfaces — regression would show wrong
//     icon/colour on a Davis category)
//   • getImpacts / getImpactLabel derivation
//   • entityTypeOf / shortEntityId
//
// All inputs are explicit; nothing depends on Date.now() or
// locale.

import { describe, it, expect } from "vitest";
import {
  formatDurationMs,
  parseDurationMs,
  getCategoryLabel,
  getCategoryColor,
  getCategoryIcon,
  getStatusLabel,
  getImpacts,
  getImpactLabel,
  entityTypeOf,
  shortEntityId,
  entityTypeLabel,
} from "./formatters";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

describe("formatDurationMs", () => {
  it("returns a dash for null / undefined / non-finite", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(NaN)).toBe("—");
  });

  it("formats sub-minute as seconds", () => {
    expect(formatDurationMs(30 * SECOND)).toMatch(/30\s*s/);
  });

  it("formats minute scale as `Xm`", () => {
    expect(formatDurationMs(5 * MINUTE)).toMatch(/5\s*m/);
    expect(formatDurationMs(59 * MINUTE)).toMatch(/59\s*m/);
  });

  it("formats hour scale with hours + minutes", () => {
    const out = formatDurationMs(2 * HOUR + 30 * MINUTE);
    expect(out).toMatch(/2\s*h/);
    expect(out).toMatch(/30\s*m/);
  });

  it("formats day scale with days + hours", () => {
    const out = formatDurationMs(2 * DAY + 5 * HOUR);
    expect(out).toMatch(/2\s*d/);
    expect(out).toMatch(/5\s*h/);
  });
});

describe("parseDurationMs", () => {
  it("rejects garbage", () => {
    expect(parseDurationMs("xxx")).toBeNull();
    expect(parseDurationMs("")).toBeNull();
    expect(parseDurationMs("-1h")).toBeNull();
  });

  it("parses explicit single units", () => {
    expect(parseDurationMs("5s")).toBe(5 * SECOND);
    expect(parseDurationMs("5m")).toBe(5 * MINUTE);
    expect(parseDurationMs("2h")).toBe(2 * HOUR);
    expect(parseDurationMs("3d")).toBe(3 * DAY);
  });

  it("parses fractional units", () => {
    expect(parseDurationMs("1.5h")).toBe(1.5 * HOUR);
    expect(parseDurationMs("0.5d")).toBe(0.5 * DAY);
  });

  it("parses space-separated compound forms (1h 30m)", () => {
    // Note: contiguous compound forms like `1h30m` are NOT
    // supported by design — the regex requires a word boundary
    // after each unit, so users must separate with a space. The
    // popover UI accepts both and normalises before submission.
    expect(parseDurationMs("1h 30m")).toBe(1 * HOUR + 30 * MINUTE);
    expect(parseDurationMs("2d 4h")).toBe(2 * DAY + 4 * HOUR);
  });

  it("rejects gibberish between tokens", () => {
    expect(parseDurationMs("1h foo 30m")).toBeNull();
  });

  it("rejects trailing junk", () => {
    expect(parseDurationMs("1h junk")).toBeNull();
  });

  it("round-trips through formatDurationMs for whole-unit values", () => {
    // Round-trip is approximate for compound forms; here we test
    // single-unit values that the formatter is guaranteed to
    // re-encode in the same shape.
    const cases = [5 * MINUTE, 2 * HOUR, 3 * DAY];
    for (const ms of cases) {
      const back = parseDurationMs(formatDurationMs(ms));
      expect(back).toBe(ms);
    }
  });
});

describe("getCategoryLabel / getCategoryColor / getCategoryIcon", () => {
  // Davis emits ~6 canonical categories. Every consumer in the
  // app reads these helpers, so they MUST stay coherent — a
  // mismatch between label and color (e.g. "Error" rendered with
  // the cyan reserved for Slowdown) is a UX bug that screenshots
  // catch but reviewers usually don't.

  const CANONICAL = ["AVAILABILITY", "ERROR", "SLOWDOWN", "RESOURCE_CONTENTION", "CUSTOM_ALERT", "MONITORING_UNAVAILABLE"];

  it("returns a non-empty label for every canonical category", () => {
    CANONICAL.forEach((c) => {
      expect(getCategoryLabel(c)).toBeTruthy();
    });
  });

  it("returns a Strato design-token name for every canonical category", () => {
    // Returns semantic tokens (`critical` / `warning` / `neutral` /
    // `info` / `success`) — NOT hex — so the rest of the app can
    // map them to the theme via Strato classes. Reuses the same
    // tokens as the Davis Problems list for visual continuity.
    const TOKEN_RE = /^(critical|warning|neutral|info|success)$/;
    CANONICAL.forEach((c) => {
      expect(getCategoryColor(c)).toMatch(TOKEN_RE);
    });
  });

  it("returns a glyph for every canonical category", () => {
    CANONICAL.forEach((c) => {
      const icon = getCategoryIcon(c);
      expect(typeof icon).toBe("string");
      expect(icon.length).toBeGreaterThan(0);
    });
  });

  it("falls back gracefully for an unknown category", () => {
    expect(getCategoryLabel("MADE_UP_CATEGORY")).toBeTruthy();
    // Unknown categories collapse to the `neutral` token — that's
    // the contract callers rely on for stable styling.
    expect(getCategoryColor("MADE_UP_CATEGORY")).toBe("neutral");
  });
});

describe("getStatusLabel", () => {
  it("maps ACTIVE to `Active`", () => {
    expect(getStatusLabel("ACTIVE")).toBe("Active");
  });

  it("treats everything non-ACTIVE as `Closed`", () => {
    // Davis only ever emits ACTIVE or CLOSED — collapsing the rest
    // to Closed is safer than rendering a raw enum string in the UI.
    expect(getStatusLabel("CLOSED")).toBe("Closed");
    expect(getStatusLabel("WEIRD_STATE")).toBe("Closed");
    expect(getStatusLabel("")).toBe("Closed");
  });
});

describe("getImpacts / getImpactLabel", () => {
  it("derives impacts from entity ids by prefix", () => {
    const out = getImpacts([
      "HOST-AB12",
      "SERVICE-CD34",
      "WEB_APPLICATION-EF56",
    ]);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores nulls / unknowns gracefully", () => {
    expect(() => getImpacts(undefined)).not.toThrow();
    expect(() => getImpacts([])).not.toThrow();
  });

  it("getImpactLabel returns null for empty input", () => {
    expect(getImpactLabel(undefined)).toBeNull();
    expect(getImpactLabel([])).toBeNull();
  });

  it("getImpactLabel reports primary + extras", () => {
    const out = getImpactLabel([
      "HOST-1",
      "HOST-2",
      "HOST-3",
      "SERVICE-4",
    ]);
    expect(out).not.toBeNull();
    expect(out?.extra).toBeGreaterThanOrEqual(0);
    expect(out?.label).toBeTruthy();
  });
});

describe("entityTypeOf / shortEntityId / entityTypeLabel", () => {
  it("extracts the type prefix from a Davis entity id", () => {
    expect(entityTypeOf("HOST-AB12C34D")).toBe("HOST");
    expect(entityTypeOf("SERVICE-1234")).toBe("SERVICE");
  });

  it("handles input without a dash", () => {
    expect(entityTypeOf("UNKNOWN")).toBeTruthy();
  });

  it("shortens an entity id to the suffix tail", () => {
    const short = shortEntityId("HOST-ABCDEF1234567890");
    expect(short.length).toBeLessThan("HOST-ABCDEF1234567890".length);
  });

  it("produces a human label for a type", () => {
    expect(entityTypeLabel("HOST")).toBeTruthy();
    expect(entityTypeLabel("SERVICE")).toBeTruthy();
  });
});
