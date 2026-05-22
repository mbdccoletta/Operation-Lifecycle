// Consistency tests for the severity + crit-score derivation.
//
// `getSeverity` drives the chip colour (Critical/Major/Minor/
// Warning/Informational) shown on every problem row. The mapping
// is a function of:
//   • event.status — only ACTIVE problems get scored.
//   • event.start  — hours-since-open feeds 55 % of the score.
//   • affected_entity_ids.length — entity blast radius feeds 45 %.
// Closed problems collapse to "Informational" regardless of how
// long they ran.
//
// A regression here paints chips in the wrong colour, which is
// the kind of bug operators only notice when a "Critical" incident
// shows up green.

import { describe, it, expect } from "vitest";
import { getCritScore, getSeverity, SEVERITY_COLORS } from "./filters";
import type { Problem } from "../hooks/useProblems";

const HOUR = 60 * 60 * 1000;

// Build a fixture with a configurable age + entity count.
const makeProblem = (opts: {
  status?: "ACTIVE" | "CLOSED";
  hoursAgo?: number;
  entityCount?: number;
}): Problem => ({
  "event.name":     "fixture",
  "event.status":   opts.status ?? "ACTIVE",
  "event.category": "ERROR",
  "event.start":    new Date(Date.now() - (opts.hoursAgo ?? 0) * HOUR).toISOString(),
  affected_entity_ids: new Array(opts.entityCount ?? 1).fill("HOST-AB").map((_, i) => `HOST-${i}`),
  root_cause_entity_id: "HOST-AB",
  display_id: "P-fixture",
});

describe("getCritScore", () => {
  it("scores closed problems as 0 regardless of age / entities", () => {
    expect(getCritScore(makeProblem({ status: "CLOSED", hoursAgo: 200, entityCount: 100 }))).toBe(0);
  });

  it("scores a brand-new single-entity active problem near 0", () => {
    const s = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 0, entityCount: 1 }));
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0.1);
  });

  it("scales score monotonically with age", () => {
    const a = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 1, entityCount: 1 }));
    const b = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 4, entityCount: 1 }));
    expect(b).toBeGreaterThan(a);
  });

  it("scales score monotonically with entity count", () => {
    const a = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 2, entityCount: 1 }));
    const b = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 2, entityCount: 4 }));
    expect(b).toBeGreaterThan(a);
  });

  it("caps score at 1", () => {
    const s = getCritScore(makeProblem({ status: "ACTIVE", hoursAgo: 200, entityCount: 50 }));
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("getSeverity buckets", () => {
  it("maps closed problems to Informational", () => {
    expect(getSeverity(makeProblem({ status: "CLOSED" }))).toBe("Informational");
  });

  it("maps high score to Critical", () => {
    expect(getSeverity(makeProblem({ status: "ACTIVE", hoursAgo: 100, entityCount: 10 }))).toBe("Critical");
  });

  it("maps low score to Informational", () => {
    expect(getSeverity(makeProblem({ status: "ACTIVE", hoursAgo: 0, entityCount: 1 }))).toBe("Informational");
  });

  it("every severity label has a hex colour in SEVERITY_COLORS", () => {
    const labels = ["Critical", "Major", "Minor", "Warning", "Informational"] as const;
    labels.forEach((l) => {
      expect(SEVERITY_COLORS[l]).toMatch(/^#[0-9a-fA-F]{6,8}$/);
    });
  });

  it("Critical uses the canonical red", () => {
    // Aligned with the rest of the app's "open problem = red"
    // standardisation. If this changes, the matching banner /
    // chip / FILTERS strip rules need to move in lock-step.
    expect(SEVERITY_COLORS.Critical).toBe("#ef4444");
  });
});

describe("severity monotonicity", () => {
  // Order from most→least severe.
  const RANK = ["Critical", "Major", "Minor", "Warning", "Informational"] as const;
  type Sev = (typeof RANK)[number];
  const rank = (s: Sev) => RANK.indexOf(s);

  it("severity strictly worsens (or stays) as the problem ages", () => {
    let prev: Sev = "Informational";
    for (const h of [1, 2, 4, 6, 8, 12]) {
      const s = getSeverity(makeProblem({ status: "ACTIVE", hoursAgo: h, entityCount: 6 }));
      expect(rank(s)).toBeLessThanOrEqual(rank(prev));
      prev = s;
    }
  });
});
