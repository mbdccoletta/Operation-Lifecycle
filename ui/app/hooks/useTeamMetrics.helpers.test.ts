// Tests for the pure math helpers behind the team-metrics chart.
// These run on every refresh and feed both the chart's bucket
// series AND the KPI scalars above it — a bug here corrupts every
// MTTA / MTTR / MTBF / MTTF number in the app.
//
// Reference for the MTTx definitions:
//   https://www.atlassian.com/incident-management/kpis/common-metrics

import { describe, it, expect } from "vitest";
import {
  percentile,
  pickBucketMs,
  floorToBucket,
  aggregateSeries,
  aggregateScalar,
  computeMttaPairs,
  computeMttrPairs,
  computeMtbfPairs,
  computeMttfPairs,
} from "./useTeamMetrics.helpers";

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns the single value", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("returns the median of an odd-length sorted array", () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("interpolates the median of an even-length sorted array", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
  });

  it("computes p95 with linear interpolation", () => {
    expect(percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBeCloseTo(95, 5);
  });

  it("returns min at p0 and max at p100", () => {
    expect(percentile([5, 10, 15], 0)).toBe(5);
    expect(percentile([5, 10, 15], 100)).toBe(15);
  });
});

const HOUR = 60 * 60 * 1000;
const DAY  = 24 * HOUR;

describe("pickBucketMs", () => {
  it("picks 15-min buckets for windows ≤ 4h", () => {
    expect(pickBucketMs(4 * HOUR)).toBe(15 * 60 * 1000);
    expect(pickBucketMs(1 * HOUR)).toBe(15 * 60 * 1000);
  });

  it("picks 1h buckets for ~24h windows", () => {
    expect(pickBucketMs(20 * HOUR)).toBe(HOUR);
    expect(pickBucketMs(24 * HOUR)).toBe(HOUR);
  });

  it("picks daily buckets for ~week windows", () => {
    expect(pickBucketMs(7 * DAY)).toBe(DAY);
    expect(pickBucketMs(14 * DAY)).toBe(DAY);
  });

  it("falls back to weekly buckets for very large windows", () => {
    expect(pickBucketMs(90 * DAY)).toBe(7 * DAY);
    expect(pickBucketMs(365 * DAY)).toBe(7 * DAY);
  });
});

describe("floorToBucket", () => {
  it("anchors a sub-day timestamp to bucket start via plain modular floor", () => {
    expect(floorToBucket(125, 10)).toBe(120);
    expect(floorToBucket(120, 10)).toBe(120);
    expect(floorToBucket(0, 10)).toBe(0);
  });

  // ── Day-and-larger buckets: LOCAL-midnight alignment ──────────────
  // The next three tests verify the timezone fix where day buckets
  // align to the user's local midnight rather than UTC midnight.
  // We construct a known timestamp by going through the LOCAL Date
  // constructor — then no matter what timezone vitest runs in, the
  // "local midnight" we expect is computable consistently from the
  // same constructor.
  it("aligns a DAY bucket to LOCAL midnight of that timestamp's calendar day", () => {
    // Build a local timestamp = May 18, 2026 at 14:30 local.
    const t = new Date(2026, 4, 18, 14, 30, 0, 0).getTime();
    // Expected: midnight of May 18 LOCAL, in ms.
    const expected = new Date(2026, 4, 18, 0, 0, 0, 0).getTime();
    expect(floorToBucket(t, DAY)).toBe(expected);
  });

  it("DAY bucket: timestamps just after local midnight floor to that same day, not the previous", () => {
    // Catch the off-by-one bug a UTC-floor would introduce: a
    // problem at 00:01 local on May 18 must stay in the "May 18"
    // bucket, not migrate back to "May 17".
    const t = new Date(2026, 4, 18, 0, 1, 0, 0).getTime();
    const expected = new Date(2026, 4, 18, 0, 0, 0, 0).getTime();
    expect(floorToBucket(t, DAY)).toBe(expected);
  });

  it("DAY bucket: timestamps just before local midnight floor to the previous local day", () => {
    // Mirror of the above: 23:59 local May 17 stays in May 17 even
    // if its UTC clock reads 02:59 May 18 (e.g. Brazil UTC-3).
    const t = new Date(2026, 4, 17, 23, 59, 0, 0).getTime();
    const expected = new Date(2026, 4, 17, 0, 0, 0, 0).getTime();
    expect(floorToBucket(t, DAY)).toBe(expected);
  });

  it("multi-DAY (3d) bucket: floor lands on local midnight of some day", () => {
    // The exact day depends on the local-epoch anchor (Jan 1 1970
    // LOCAL), so we don't assert which day — we just assert that
    // the floored value IS a local midnight (00:00:00.000 local).
    const t = new Date(2026, 4, 18, 14, 0).getTime();
    const flooredDate = new Date(floorToBucket(t, 3 * DAY));
    expect(flooredDate.getHours()).toBe(0);
    expect(flooredDate.getMinutes()).toBe(0);
    expect(flooredDate.getSeconds()).toBe(0);
    expect(flooredDate.getMilliseconds()).toBe(0);
  });

  it("multi-DAY (3d) bucket: floor is invariant within the bucket span", () => {
    // Take any timestamp, floor it. Any timestamp strictly inside
    // [floor, floor + 3*DAY) must produce the same floor.
    const t = new Date(2026, 4, 18, 14, 0).getTime();
    const f = floorToBucket(t, 3 * DAY);
    // 1 ms after the floor → same bucket
    expect(floorToBucket(f + 1, 3 * DAY)).toBe(f);
    // 1 ms before the bucket ends → same bucket
    expect(floorToBucket(f + 3 * DAY - 1, 3 * DAY)).toBe(f);
    // Exactly at the next boundary → different bucket
    expect(floorToBucket(f + 3 * DAY, 3 * DAY)).toBe(f + 3 * DAY);
  });

  it("WEEK (7d) bucket: floor lands on local midnight", () => {
    const t = new Date(2026, 4, 18, 14, 0).getTime();
    const flooredDate = new Date(floorToBucket(t, 7 * DAY));
    expect(flooredDate.getHours()).toBe(0);
    expect(flooredDate.getMinutes()).toBe(0);
  });

  it("WEEK (7d) bucket: floor invariant within a 7-day span", () => {
    const t = new Date(2026, 4, 18, 14, 0).getTime();
    const f = floorToBucket(t, 7 * DAY);
    // 6.99 days into the bucket → same floor
    expect(floorToBucket(f + Math.floor(6.99 * DAY), 7 * DAY)).toBe(f);
    // Exactly 7 days later → next bucket
    expect(floorToBucket(f + 7 * DAY, 7 * DAY)).toBe(f + 7 * DAY);
  });
});

describe("aggregateSeries", () => {
  it("returns empty buckets when no pairs match", () => {
    const out = aggregateSeries([], 1000, 0, 4000);
    expect(out.length).toBe(5); // 0..4000 step 1000 inclusive
    out.forEach((b) => {
      expect(b.count).toBe(0);
      expect(b.avgMs).toBe(0);
    });
  });

  it("groups values into the correct bucket", () => {
    const out = aggregateSeries(
      [
        { ms: 1500, valueMs: 100 },
        { ms: 1700, valueMs: 200 },
        { ms: 2200, valueMs: 50  },
      ],
      1000, 0, 3000,
    );
    // Buckets: 0, 1000, 2000, 3000 — 4 entries.
    expect(out.map((b) => b.count)).toEqual([0, 2, 1, 0]);
    expect(out[1].avgMs).toBe(150);   // (100 + 200) / 2
    expect(out[2].avgMs).toBe(50);
  });

  it("drops values outside the window", () => {
    const out = aggregateSeries(
      [
        { ms: -500, valueMs: 999 },
        { ms: 5000, valueMs: 999 },
        { ms: 1500, valueMs: 100 },
      ],
      1000, 0, 3000,
    );
    const total = out.reduce((acc, b) => acc + b.count, 0);
    expect(total).toBe(1);
  });

  it("computes median + p95 inside a bucket", () => {
    const pairs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((v, i) => ({
      ms: 100 + i, valueMs: v,
    }));
    const [b] = aggregateSeries(pairs, 1000, 0, 1000);
    expect(b.count).toBe(10);
    expect(b.avgMs).toBe(55);
    expect(b.medianMs).toBe(55);
    expect(b.p95Ms).toBeCloseTo(95.5, 5);
  });
});

describe("aggregateScalar", () => {
  it("returns null fields for an empty array", () => {
    expect(aggregateScalar([])).toEqual({
      avgMs: null, medianMs: null, p95Ms: null, count: 0,
    });
  });

  it("aggregates a single value", () => {
    const out = aggregateScalar([42]);
    expect(out.avgMs).toBe(42);
    expect(out.medianMs).toBe(42);
    expect(out.p95Ms).toBe(42);
    expect(out.count).toBe(1);
  });

  it("computes the mean correctly with unsorted input", () => {
    const out = aggregateScalar([30, 10, 20]);
    expect(out.avgMs).toBe(20);
    expect(out.medianMs).toBe(20);
  });
});

// ── MTTx HELPERS ────────────────────────────────────────────────────
//
// The four functions below (computeMttaPairs, computeMttrPairs,
// computeMtbfPairs, computeMttfPairs) feed every KPI on the Trends
// page. Tests below cover:
//   (a) a didactic 4-problem timeline where the right answer is
//       provable by inspection (the same numbers a human would
//       compute on paper),
//   (b) edge cases (empty, single, missing fields, negative
//       durations, concurrent overlap),
//   (c) the per-pair reliability identity:
//
//          MTBF[i→i+1] = MTTR[i] + MTTF[i→i+1]
//
//       which must hold whenever P[i] closes before P[i+1] starts,
//   (d) a real-data fixture pulled via the Dynatrace MCP server from
//       the bwm98081 tenant — proves the formulas work against the
//       same data the deployed app sees.
//
// MIN is the minute unit in ms; lets the didactic example read like
// a wall-clock schedule (start: 0, +30 min, +90 min, …).
const MIN = 60_000;

// ── Didactic schedule shared by every MTTx test ─────────────────────
// Four problems arranged on a clean wall clock so the expected MTTA,
// MTTR, MTBF, MTTF values are obvious by inspection. Reused across
// describes so the reader can build mental shorthand.
//
//   t (min)  0     20     30     60     90    105   120
//   P1       ├──────┤
//   P2              ├─────│─────┤
//   P3                            ├─────│──┤        (no overlap with P4)
//   P4                                         ├ (still ACTIVE)
//
//   P1: start=0,  end=20, comment@5      (CLOSED, MTTR=20, MTTA=5)
//   P2: start=30, end=60, comment@40     (CLOSED, MTTR=30, MTTA=10)
//   P3: start=90, end=105, comment@92    (CLOSED, MTTR=15, MTTA=2)
//   P4: start=120, end=null              (ACTIVE, no MTTR, no comment)
//
//   MTBF intervals: 30, 60, 30           → avg=40
//   MTTR durations:  20, 30, 15          → avg≈21.67
//   MTTF intervals:  10 (P1→P2), 30 (P2→P3), 15 (P3→P4)  → avg≈18.33
//   MTTA durations:  5, 10, 2            → avg≈5.67
const didactic = [
  {
    davis_problem_id: "p1",
    "event.start":  new Date(0          ).toISOString(),
    "event.end":    new Date(20  * MIN  ).toISOString(),
    "event.status": "CLOSED",
  },
  {
    davis_problem_id: "p2",
    "event.start":  new Date(30  * MIN  ).toISOString(),
    "event.end":    new Date(60  * MIN  ).toISOString(),
    "event.status": "CLOSED",
  },
  {
    davis_problem_id: "p3",
    "event.start":  new Date(90  * MIN  ).toISOString(),
    "event.end":    new Date(105 * MIN  ).toISOString(),
    "event.status": "CLOSED",
  },
  {
    davis_problem_id: "p4",
    "event.start":  new Date(120 * MIN  ).toISOString(),
    "event.end":    null,
    "event.status": "ACTIVE",
  },
];

const didacticComments = new Map<string, string>([
  ["p1", new Date(5  * MIN).toISOString()],
  ["p2", new Date(40 * MIN).toISOString()],
  ["p3", new Date(92 * MIN).toISOString()],
  // p4 intentionally absent — tests the "no comment → skip" path.
]);

describe("computeMttaPairs", () => {
  it("returns empty array for empty input", () => {
    expect(computeMttaPairs([], new Map())).toEqual([]);
  });

  it("returns empty when no problems have matching comments", () => {
    expect(computeMttaPairs(didactic, new Map())).toEqual([]);
  });

  it("computes ack-latency from the didactic schedule", () => {
    const pairs = computeMttaPairs(didactic, didacticComments);
    // p4 has no comment → skipped; three pairs remain.
    expect(pairs).toHaveLength(3);
    const values = pairs.map((p) => p.valueMs);
    expect(values).toEqual([5 * MIN, 10 * MIN, 2 * MIN]);
  });

  it("skips problems without a davis_problem_id", () => {
    const orphan = [{ "event.start": new Date(0).toISOString() }];
    expect(computeMttaPairs(orphan, didacticComments)).toEqual([]);
  });

  it("drops negative durations (comment before start, e.g. clock skew)", () => {
    // Comment timestamp PRECEDES the start — invalid, must skip.
    const skew = new Map([["p1", new Date(-1 * MIN).toISOString()]]);
    expect(computeMttaPairs(didactic.slice(0, 1), skew)).toEqual([]);
  });

  it("anchors each pair to the problem's event.start", () => {
    const pairs = computeMttaPairs(didactic.slice(0, 1), didacticComments);
    expect(pairs[0].ms).toBe(0);
  });
});

describe("computeMttrPairs", () => {
  it("returns empty array for empty input", () => {
    expect(computeMttrPairs([])).toEqual([]);
  });

  it("returns empty when all problems are ACTIVE", () => {
    const allActive = didactic.map((p) => ({
      ...p, "event.status": "ACTIVE", "event.end": null,
    }));
    expect(computeMttrPairs(allActive)).toEqual([]);
  });

  it("computes durations from the didactic schedule", () => {
    const pairs = computeMttrPairs(didactic);
    // p4 ACTIVE → no MTTR; three closed pairs remain.
    expect(pairs).toHaveLength(3);
    const values = pairs.map((p) => p.valueMs);
    expect(values).toEqual([20 * MIN, 30 * MIN, 15 * MIN]);
  });

  it("drops CLOSED problems missing event.end", () => {
    const broken = [{
      "event.start": new Date(0).toISOString(),
      "event.end":   null,
      "event.status": "CLOSED",
    }];
    expect(computeMttrPairs(broken)).toEqual([]);
  });

  it("drops zero / negative durations (end ≤ start)", () => {
    const bad = [
      { "event.start": new Date(0).toISOString(),
        "event.end":   new Date(0).toISOString(),
        "event.status": "CLOSED" },
      { "event.start": new Date(0).toISOString(),
        "event.end":   new Date(-1 * MIN).toISOString(),
        "event.status": "CLOSED" },
    ];
    expect(computeMttrPairs(bad)).toEqual([]);
  });
});

describe("computeMtbfPairs", () => {
  it("returns empty array for empty input", () => {
    expect(computeMtbfPairs([])).toEqual([]);
  });

  it("returns empty for a single problem (no interval to measure)", () => {
    expect(computeMtbfPairs(didactic.slice(0, 1))).toEqual([]);
  });

  it("computes intervals from the didactic schedule", () => {
    const pairs = computeMtbfPairs(didactic);
    // 4 problems → 3 intervals.
    expect(pairs).toHaveLength(3);
    const values = pairs.map((p) => p.valueMs);
    expect(values).toEqual([30 * MIN, 60 * MIN, 30 * MIN]);
  });

  it("validates the telescoping identity (sum of intervals = first→last)", () => {
    const pairs = computeMtbfPairs(didactic);
    const sum = pairs.reduce((acc, p) => acc + p.valueMs, 0);
    const first = new Date(didactic[0]["event.start"]).getTime();
    const last  = new Date(didactic[3]["event.start"]).getTime();
    expect(sum).toBe(last - first);
  });

  it("sorts unsorted input before computing", () => {
    // Reverse-order input should produce the same intervals.
    const reversed = [...didactic].reverse();
    const pairs = computeMtbfPairs(reversed);
    expect(pairs.map((p) => p.valueMs)).toEqual([30 * MIN, 60 * MIN, 30 * MIN]);
  });

  it("skips zero-interval duplicates (simultaneous starts)", () => {
    // Two problems with the EXACT same start (Davis is allowed to
    // emit cascading failures with identical timestamps). MTBF=0
    // for that pair would drag the average down; skip it.
    const twins = [
      { "event.start": new Date(0          ).toISOString() },
      { "event.start": new Date(0          ).toISOString() },
      { "event.start": new Date(30  * MIN  ).toISOString() },
    ];
    const pairs = computeMtbfPairs(twins);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].valueMs).toBe(30 * MIN);
  });
});

describe("computeMttfPairs", () => {
  it("returns empty array for empty input", () => {
    expect(computeMttfPairs([])).toEqual([]);
  });

  it("returns empty for a single problem (nothing to measure from)", () => {
    expect(computeMttfPairs(didactic.slice(0, 1))).toEqual([]);
  });

  it("computes uptime intervals from the didactic schedule", () => {
    const pairs = computeMttfPairs(didactic);
    // 4 problems but the first has no MTTF (no prior end). Pairs:
    //   P1→P2: 30 − 20 = 10 min uptime
    //   P2→P3: 90 − 60 = 30 min
    //   P3→P4: 120 − 105 = 15 min
    expect(pairs).toHaveLength(3);
    const values = pairs.map((p) => p.valueMs);
    expect(values).toEqual([10 * MIN, 30 * MIN, 15 * MIN]);
  });

  it("skips MTTF when the previous problem hasn't closed yet (overlap)", () => {
    // P1 still active at t=15, P2 starts at t=10 (concurrent).
    // No uptime between them — running-max-end is still null when
    // P2 starts, so the pair is skipped.
    const overlap = [
      { "event.start": new Date(0          ).toISOString(),
        "event.end":   new Date(50  * MIN  ).toISOString() },
      { "event.start": new Date(10  * MIN  ).toISOString(),
        "event.end":   new Date(20  * MIN  ).toISOString() },
    ];
    // P2 starts while P1 still active → no MTTF entry for P2.
    // After P1 closes at 50min, no further problem follows → empty.
    const pairs = computeMttfPairs(overlap);
    expect(pairs).toEqual([]);
  });

  it("uses the LATEST end-time (not just immediate predecessor) for the cursor", () => {
    // P1 closes LATE (after P2 and P3 already finished). MTTF for
    // a problem after all three should subtract P1's end (the
    // running max), not P3's (the most recently STARTED).
    const fixture = [
      { "event.start": new Date(0          ).toISOString(),
        "event.end":   new Date(100 * MIN  ).toISOString() },     // P1 closes very late
      { "event.start": new Date(10  * MIN  ).toISOString(),
        "event.end":   new Date(20  * MIN  ).toISOString() },     // P2 quick
      { "event.start": new Date(30  * MIN  ).toISOString(),
        "event.end":   new Date(40  * MIN  ).toISOString() },     // P3 quick
      { "event.start": new Date(150 * MIN  ).toISOString(),
        "event.end":   new Date(160 * MIN  ).toISOString() },     // P4 starts after P1 closes
    ];
    const pairs = computeMttfPairs(fixture);
    // Only P4 gets a pair — P2 and P3 overlap with P1 (no uptime).
    // P4's MTTF = 150 − 100 = 50 min (subtracted from P1's late close).
    expect(pairs).toHaveLength(1);
    expect(pairs[0].valueMs).toBe(50 * MIN);
  });
});

describe("Reliability identity per pair: MTBF[i→i+1] = MTTR[i] + MTTF[i→i+1]", () => {
  // The Atlassian doc defines this as the SRE reliability identity.
  // It holds whenever P[i] is CLOSED before P[i+1] starts (no
  // overlap). Verifies our four formulas agree at the per-pair
  // level, which is the strictest correctness check we can apply.
  it("holds for every consecutive-CLOSED pair in the didactic schedule", () => {
    const closedOnly = didactic.filter((p) => p["event.status"] === "CLOSED");
    const mtbfMap = new Map<number, number>();
    computeMtbfPairs(closedOnly).forEach((p) => mtbfMap.set(p.ms, p.valueMs));
    const mttrMap = new Map<number, number>();
    computeMttrPairs(closedOnly).forEach((p) => mttrMap.set(p.ms, p.valueMs));
    const mttfMap = new Map<number, number>();
    computeMttfPairs(closedOnly).forEach((p) => mttfMap.set(p.ms, p.valueMs));

    // Walk consecutive starts → for each i+1, identity should hold.
    const sorted = [...closedOnly].sort(
      (a, b) => new Date(a["event.start"]).getTime() -
                new Date(b["event.start"]).getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      const prevStart = new Date(sorted[i - 1]["event.start"]).getTime();
      const curStart  = new Date(sorted[i]    ["event.start"]).getTime();
      const mtbf = mtbfMap.get(curStart)!;
      const mttr = mttrMap.get(prevStart)!;
      const mttf = mttfMap.get(curStart)!;
      expect(mttr + mttf).toBe(mtbf);
    }
  });
});

// ── REAL-DATA FIXTURE ───────────────────────────────────────────────
// Six consecutive non-overlapping problems pulled live via the
// Dynatrace MCP server from the bwm98081 tenant (2026-05-18 evening
// — Failure rate / Response time degradation incidents). The "ms"
// columns are precomputed once so the math in the test is auditable
// without going back to ISO parsing.
//
// Fetched via:
//   fetch dt.davis.problems, from: now() - 7d
//   | filter in(event.status, {"ACTIVE", "CLOSED"})
//   | fields display_id, davis_problem_id = event.id,
//            event.start, event.end, event.status
//   | sort event.start asc
//
// Picked these six because they're all CLOSED and non-overlapping —
// the cleanest subset for the reliability-identity check. The
// timestamps below are the actual values from the tenant on the
// fetch date.
const realFixture = [
  // P-26052042 — "Failure rate increase", 52 min outage
  { davis_problem_id: "-8936756956169533050_1779118500000V2",
    "event.start":  "2026-05-18T15:40:00.000Z",
    "event.end":    "2026-05-18T16:32:00.000Z",
    "event.status": "CLOSED" },
  // P-26052046 — "User action duration degradation", 9 min outage
  { davis_problem_id: "4079508163553390477_1779122520000V2",
    "event.start":  "2026-05-18T16:47:00.000Z",
    "event.end":    "2026-05-18T16:56:00.000Z",
    "event.status": "CLOSED" },
  // P-26052050 — "Response time degradation", 1 min outage
  { davis_problem_id: "3591258011905923805_1779125220000V2",
    "event.start":  "2026-05-18T17:32:00.000Z",
    "event.end":    "2026-05-18T17:33:00.000Z",
    "event.status": "CLOSED" },
  // P-26052052 — "Response time degradation", 1 min outage
  { davis_problem_id: "-7142292373701388279_1779126720000V2",
    "event.start":  "2026-05-18T17:57:00.000Z",
    "event.end":    "2026-05-18T17:58:00.000Z",
    "event.status": "CLOSED" },
  // P-26052065 — "Unexpected low traffic", 5 min outage
  { davis_problem_id: "-3476044459187471390_1779133740000V2",
    "event.start":  "2026-05-18T19:54:00.000Z",
    "event.end":    "2026-05-18T19:59:00.000Z",
    "event.status": "CLOSED" },
  // P-26052066 — "Failure rate increase", 7 min outage
  { davis_problem_id: "5995102876980559376_1779135120000V2",
    "event.start":  "2026-05-18T20:17:00.000Z",
    "event.end":    "2026-05-18T20:24:00.000Z",
    "event.status": "CLOSED" },
];

describe("Real-data fixture (bwm98081 — 6 consecutive non-overlapping CLOSED problems)", () => {
  it("MTBF — 5 intervals between consecutive starts (sums to first→last)", () => {
    const pairs = computeMtbfPairs(realFixture);
    expect(pairs).toHaveLength(5);

    // Manually-computed expected intervals (minutes between starts):
    //   15:40 → 16:47 = 67 min
    //   16:47 → 17:32 = 45 min
    //   17:32 → 17:57 = 25 min
    //   17:57 → 19:54 = 117 min
    //   19:54 → 20:17 = 23 min
    expect(pairs.map((p) => p.valueMs / MIN)).toEqual([67, 45, 25, 117, 23]);

    // Telescoping check: sum should equal start[last] − start[first]
    //   = 20:17 − 15:40 = 4h 37min = 277 min
    const sum = pairs.reduce((acc, p) => acc + p.valueMs, 0) / MIN;
    expect(sum).toBe(277);
  });

  it("MTTR — 6 durations, each matching end − start for the real problem", () => {
    const pairs = computeMttrPairs(realFixture);
    expect(pairs).toHaveLength(6);
    expect(pairs.map((p) => p.valueMs / MIN)).toEqual([52, 9, 1, 1, 5, 7]);
  });

  it("MTTF — 5 uptime intervals between previous end and next start", () => {
    const pairs = computeMttfPairs(realFixture);
    expect(pairs).toHaveLength(5);
    // Expected uptimes (minutes between previous close and next open):
    //   16:32 → 16:47 = 15 min   (P1 closes, P2 starts)
    //   16:56 → 17:32 = 36 min   (P2 closes, P3 starts)
    //   17:33 → 17:57 = 24 min
    //   17:58 → 19:54 = 116 min
    //   19:59 → 20:17 = 18 min
    expect(pairs.map((p) => p.valueMs / MIN)).toEqual([15, 36, 24, 116, 18]);
  });

  it("Reliability identity MTBF = MTTR + MTTF holds for every pair", () => {
    const mtbfMap = new Map<number, number>();
    computeMtbfPairs(realFixture).forEach((p) => mtbfMap.set(p.ms, p.valueMs));
    const mttrMap = new Map<number, number>();
    computeMttrPairs(realFixture).forEach((p) => mttrMap.set(p.ms, p.valueMs));
    const mttfMap = new Map<number, number>();
    computeMttfPairs(realFixture).forEach((p) => mttfMap.set(p.ms, p.valueMs));

    const sorted = [...realFixture].sort(
      (a, b) => new Date(a["event.start"]).getTime() -
                new Date(b["event.start"]).getTime(),
    );
    for (let i = 1; i < sorted.length; i++) {
      const prevStart = new Date(sorted[i - 1]["event.start"]).getTime();
      const curStart  = new Date(sorted[i]    ["event.start"]).getTime();
      expect(mttrMap.get(prevStart)! + mttfMap.get(curStart)!)
        .toBe(mtbfMap.get(curStart)!);
    }
  });

  it("Scalar aggregates match the worked numbers from the fixture", () => {
    // MTBF avg = 277 / 5 = 55.4 min
    expect(aggregateScalar(
      computeMtbfPairs(realFixture).map((p) => p.valueMs / MIN),
    ).avgMs).toBeCloseTo(55.4, 5);

    // MTTR avg = (52 + 9 + 1 + 1 + 5 + 7) / 6 = 75 / 6 = 12.5 min
    expect(aggregateScalar(
      computeMttrPairs(realFixture).map((p) => p.valueMs / MIN),
    ).avgMs).toBeCloseTo(12.5, 5);

    // MTTF avg = (15 + 36 + 24 + 116 + 18) / 5 = 209 / 5 = 41.8 min
    expect(aggregateScalar(
      computeMttfPairs(realFixture).map((p) => p.valueMs / MIN),
    ).avgMs).toBeCloseTo(41.8, 5);
  });
});
