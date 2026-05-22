// Tests for the pure math helpers behind the team-metrics chart.
// These run on every refresh and feed both the chart's bucket
// series AND the KPI scalars above it — a bug here corrupts every
// MTTA / MTTR / MTBF / MTTF number in the app.

import { describe, it, expect } from "vitest";
import {
  percentile,
  pickBucketMs,
  floorToBucket,
  aggregateSeries,
  aggregateScalar,
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
  it("anchors a timestamp to bucket start", () => {
    expect(floorToBucket(125, 10)).toBe(120);
    expect(floorToBucket(120, 10)).toBe(120);
    expect(floorToBucket(0, 10)).toBe(0);
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
