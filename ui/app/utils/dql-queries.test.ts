// Tests for the DQL builders. The whitelist + validators are
// the app's primary defense against DQL injection — if any of
// these tests breaks, treat it as a SECURITY regression, not a
// behaviour change.

import { describe, it, expect } from "vitest";
import {
  buildFilteredQuery,
  buildCategoryCountsQuery,
  buildStatusCategoryCountsQuery,
  buildTrendQuery,
  buildRisingProblemsByCategoryQuery,
} from "./dql-queries";

describe("buildFilteredQuery", () => {
  it("emits a minimal query with no filters", () => {
    const q = buildFilteredQuery({});
    expect(q).toContain("fetch dt.davis.problems");
    expect(q).toContain("| sort event.start desc");
    expect(q).toContain("| dedup display_id");
    expect(q).toContain("| limit 500");
  });

  it("applies the NULL-TOLERANT `is_duplicate` filter (native parity)", () => {
    // Treat this as a counts-correctness regression test. The
    // native Davis Problems app uses EXACTLY this expression
    // (confirmed via HAR diff on tenant bwm98081):
    //
    //   isNull(dt.davis.is_duplicate) OR not(dt.davis.is_duplicate)
    //
    // Variants that have already shipped and broken counts:
    //   • `== false`               — drops null-valued records,
    //     under-counts by 100% on tenants with heavy grouping
    //     (the "0 closed Availability in 7d vs 39 in native"
    //     regression).
    //   • No filter at all         — keeps explicit-true rows
    //     that native hides, over-counts by ~5% (the
    //     "37 vs 35" regression).
    const q = buildFilteredQuery({});
    expect(q).toContain("isNull(dt.davis.is_duplicate)");
    expect(q).toContain("not(dt.davis.is_duplicate)");
    // Must NOT use the strict equality form — that was the
    // historical bug.
    expect(q).not.toContain("dt.davis.is_duplicate == false");
  });

  it("applies a valid relative timeframe", () => {
    const q = buildFilteredQuery({ timeframe: "72h" });
    expect(q).toContain("fetch dt.davis.problems, from: now() - 72h");
  });

  it("applies a valid absolute window", () => {
    const q = buildFilteredQuery({
      from: "2024-01-01T00:00:00Z",
      to:   "2024-01-02T00:00:00Z",
    });
    expect(q).toContain('from: "2024-01-01T00:00:00Z"');
    expect(q).toContain('to: "2024-01-02T00:00:00Z"');
  });

  it("rejects a malformed timeframe (silently falls back)", () => {
    const q = buildFilteredQuery({ timeframe: "72hours" as never });
    expect(q).not.toContain("from: now() - 72hours");
    // Defense-in-depth: the fallback is now an explicit 72h window,
    // not an unconstrained fetch. This guarantees Davis can't
    // silently apply its ~2h implicit window when an upstream
    // caller produces a bad timeframe (the root cause of the
    // "0 Closed Availability vs 39 in native" regression).
    expect(q).toContain("fetch dt.davis.problems, from: now() - 72h");
  });

  it("rejects an unknown status (silently dropped)", () => {
    const q = buildFilteredQuery({ status: "DELETE_TABLE" as never });
    expect(q).not.toContain("DELETE_TABLE");
    expect(q).not.toContain('event.status ==');
  });

  it("rejects unknown categories", () => {
    const q = buildFilteredQuery({ categories: ["AVAILABILITY", "DROP TABLE"] });
    expect(q).toContain("AVAILABILITY");
    expect(q).not.toContain("DROP TABLE");
  });

  it("uses `in()` for multi-category", () => {
    const q = buildFilteredQuery({ categories: ["AVAILABILITY", "ERROR"] });
    expect(q).toContain('in(event.category, "AVAILABILITY", "ERROR")');
  });

  it("uses `==` for single category", () => {
    const q = buildFilteredQuery({ categories: ["AVAILABILITY"] });
    expect(q).toContain('event.category == "AVAILABILITY"');
    expect(q).not.toContain("in(event.category");
  });

  it("clamps a non-finite limit to the default", () => {
    expect(buildFilteredQuery({ limit: NaN })).toContain("| limit 500");
    expect(buildFilteredQuery({ limit: -1 })).toContain("| limit 500");
    expect(buildFilteredQuery({ limit: 0 })).toContain("| limit 500");
  });

  it("clamps an excessive limit to 10 000", () => {
    expect(buildFilteredQuery({ limit: 1_000_000 })).toContain("| limit 10000");
  });

  it("rejects a malformed ISO timestamp", () => {
    const q = buildFilteredQuery({
      from: "2024-01-01T00:00:00Z\" | drop",
      to:   "2024-01-02T00:00:00Z",
    });
    // The injection attempt should be rejected — the from: clause
    // is skipped and the query falls back to the defense-in-depth
    // 72h window.
    expect(q).not.toContain("| drop");
    expect(q).not.toContain('"2024-01-01T00:00:00Z" | drop"');
    expect(q).toContain("fetch dt.davis.problems, from: now() - 72h");
  });

  it("ALWAYS emits a bounded `from:` clause (defense-in-depth)", () => {
    // The Overview/TrendAnalysis pages are supposed to translate
    // the Strato TimeframeSelector into a validated window before
    // calling this builder. But Davis silently defaults to ~2h
    // when `from:` is omitted, which catastrophically under-counts
    // closed problems on tenants with heavy problem-grouping
    // (we shipped that bug once already — see git history for the
    // "0 Closed Availability vs 39 in native" investigation).
    //
    // This guard ensures it can NEVER happen again: regardless of
    // what the caller passes (empty object, garbage timeframe,
    // bogus from/to), the emitted DQL always contains a `from:`
    // clause. Treat a failure of THIS test as a counts-correctness
    // regression, not a style nit.
    expect(buildFilteredQuery({})).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildFilteredQuery({ timeframe: "bogus" as never })).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildFilteredQuery({ from: "bad", to: "also-bad" })).toMatch(/fetch dt\.davis\.problems, from: /);
  });

  it("filters by status when valid", () => {
    expect(buildFilteredQuery({ status: "ACTIVE" })).toContain('event.status == "ACTIVE"');
    expect(buildFilteredQuery({ status: "CLOSED" })).toContain('event.status == "CLOSED"');
  });

  it("0.0.190 — dedup sorts by `timestamp` so the LATEST state per problem wins", () => {
    // Davis emits one record per problem state change. The dedup
    // sort key has to point at the per-record emit timestamp
    // (`timestamp`), not `event.start` — otherwise a problem opened
    // at T0 (ACTIVE record) and closed at T1 (CLOSED record at a
    // later `timestamp`) would tie on `event.start` and the engine
    // would pick an arbitrary row, leaving the list showing the old
    // ACTIVE record for a problem Davis has since closed. User
    // observed list = 20 but server count = 15 on dev-tenant.
    const q = buildFilteredQuery({});
    const tsSortIdx = q.indexOf("| sort timestamp desc");
    const dedupIdx  = q.indexOf("| dedup display_id");
    const displaySortIdx = q.indexOf("| sort event.start desc");
    const limitIdx  = q.indexOf("| limit ");
    expect(tsSortIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeGreaterThan(tsSortIdx);
    // Display sort comes AFTER dedup so the user sees newest-first
    // ordering, but it's independent of the dedup-winner choice.
    expect(displaySortIdx).toBeGreaterThan(dedupIdx);
    expect(limitIdx).toBeGreaterThan(displaySortIdx);
  });

  it("0.0.190 — status filter is applied AFTER dedup (latest-state row)", () => {
    // Filtering `event.status == "ACTIVE"` BEFORE dedup would keep
    // the OLD ACTIVE record of a problem that has since closed in
    // the same window — the dedup'd row needs to be the LATEST
    // state row, then the status filter checks whether that latest
    // state is what the user asked for.
    const q = buildFilteredQuery({ status: "ACTIVE" });
    const dedupIdx  = q.indexOf("| dedup display_id");
    const statusIdx = q.indexOf('event.status == "ACTIVE"');
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(dedupIdx);
  });

  it("includes the full field projection used by the Davis Problems UI", () => {
    // Field set was briefly trimmed in audit Tier 2 but restored
    // after the trim coincided with empty-list symptoms in dev.
    // The two "unused" columns are cheap and kept until we can
    // isolate the symptom from another change.
    const q = buildFilteredQuery({});
    expect(q).toContain("affected_entity_types");
    expect(q).toContain("management_zones");
  });
});

describe("buildCategoryCountsQuery", () => {
  it("aggregates by event.category", () => {
    const q = buildCategoryCountsQuery({ timeframe: "72h" });
    expect(q).toContain("summarize count = count(), by: { event.category }");
  });

  it("dedups BEFORE summarize", () => {
    const q = buildCategoryCountsQuery({ timeframe: "72h" });
    const dedupIdx = q.indexOf("| dedup display_id");
    const sumIdx   = q.indexOf("| summarize");
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeGreaterThan(dedupIdx);
  });

  it("respects status filter", () => {
    const q = buildCategoryCountsQuery({ status: "ACTIVE", timeframe: "24h" });
    expect(q).toContain('event.status == "ACTIVE"');
  });

  it("rejects garbage status", () => {
    const q = buildCategoryCountsQuery({ status: "); DROP" as never });
    expect(q).not.toContain("DROP");
  });

  it("ALWAYS emits a bounded `from:` clause (defense-in-depth)", () => {
    // The badges MUST count the same window as the headline list.
    // If this builder ever lets an unbounded query through, the
    // badges report ~2h counts (Davis's implicit default) while
    // the list reports e.g. 7d — and they visibly disagree on
    // screen. Same regression contract as buildFilteredQuery.
    expect(buildCategoryCountsQuery({})).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildCategoryCountsQuery({ timeframe: "bogus" as never })).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildCategoryCountsQuery({ from: "bad", to: "also-bad" })).toMatch(/fetch dt\.davis\.problems, from: /);
  });

  it("applies the NULL-TOLERANT `is_duplicate` filter (native parity)", () => {
    const q = buildCategoryCountsQuery({ status: "CLOSED", timeframe: "7d" });
    expect(q).toContain("isNull(dt.davis.is_duplicate)");
    expect(q).toContain("not(dt.davis.is_duplicate)");
  });
});

describe("buildStatusCategoryCountsQuery", () => {
  it("aggregates by BOTH status and category", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    // 0.0.137 added `stuck_count`, 0.0.150 added `older_count`,
    // 0.0.184 replaced `count()` with `sum(is_in_user_window)` so
    // CLOSED counts only include records within the user-selected
    // timeframe even when the fetch was widened to cover the 1 h
    // baseline. ACTIVE rows always satisfy is_in_user_window so the
    // ACTIVE counts stay timeframe-invariant.
    expect(q).toContain("summarize count = sum(is_in_user_window)");
    expect(q).toContain("stuck_count = sum(is_stuck)");
    expect(q).toContain("older_count = sum(was_active_1h_ago)");
    expect(q).toContain("by: { event.status, event.category }");
  });

  it("0.0.184 — widens fetch to >= 1h so the 1h baseline is complete", () => {
    // User picks a timeframe shorter than 1 h → fetch expands to 1 h
    // anyway so `was_active_1h_ago` can see all records eligible
    // for the 1 h baseline. CLOSED count is then trimmed back to
    // the user timeframe via `is_in_user_window`.
    const q30 = buildStatusCategoryCountsQuery({ timeframe: "30m" });
    expect(q30).toContain("fetch dt.davis.problems, from: now() - 1h");
    expect(q30).not.toContain("from: now() - 30m\n");
    // Timeframes >= 1h pass through unchanged.
    const q1h = buildStatusCategoryCountsQuery({ timeframe: "1h" });
    expect(q1h).toContain("fetch dt.davis.problems, from: now() - 1h");
    const q7d = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    expect(q7d).toContain("fetch dt.davis.problems, from: now() - 7d");
  });

  it("0.0.185 — adds newly_started_1h field and summarises it", () => {
    // The constellation Rising bubble reads this column so it can
    // show "N problems just opened" regardless of how many closed
    // in the same hour — fixes the "I don't see Rising anymore"
    // case when net delta collapses to zero.
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    expect(q).toContain("newly_started_1h = if(");
    expect(q).toContain('(event.status == "ACTIVE")');
    expect(q).toContain("event.start >= now() - 1h");
    expect(q).toContain("newly_started_count = sum(newly_started_1h)");
  });

  it("0.0.184 — tags each row with is_in_user_window for CLOSED-timeframe trim", () => {
    // ACTIVE rows always count; CLOSED rows count only when their
    // event.end is at or after the user-window start.
    const q30 = buildStatusCategoryCountsQuery({ timeframe: "30m" });
    expect(q30).toContain("is_in_user_window = if(");
    expect(q30).toContain('event.status == "ACTIVE", 1');
    // User-window start is the ORIGINAL timeframe (30m), not the
    // widened fetch window (1h). This is what keeps CLOSED count
    // bound to the user's choice.
    expect(q30).toContain("event.end >= now() - 30m");
  });

  it("tags each row with was_active_1h_ago", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    // 0.0.150 — predicate covers ACTIVE problems that started
    // before the 1h cutoff AND CLOSED problems that ended after
    // it (i.e., were alive 1h ago across both statuses).
    expect(q).toContain("was_active_1h_ago = if(");
    expect(q).toContain("event.start <= now() - 1h");
    expect(q).toContain("event.end > now() - 1h");
  });

  it("tags each row with is_stuck — defaults to now()-4h cutoff", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    // Without a stuckCutoff override the builder falls back to the
    // legacy 4h floor so dev/standalone usage still works.
    expect(q).toContain('is_stuck = if((event.status == "ACTIVE") and (event.start < now() - 4h), 1, else: 0)');
  });

  it("honours a host-supplied stuckCutoff (timeframe-aware)", () => {
    // 0.0.148 — Stuck respects the user-selected timeframe instead
    // of a hardcoded 4h. ISO is validated; an invalid string falls
    // back to now()-4h silently.
    const iso = "2025-05-27T00:00:00.000Z";
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d", stuckCutoff: iso });
    expect(q).toContain(`event.start < toTimestamp("${iso}")`);

    const fallback = buildStatusCategoryCountsQuery({ timeframe: "7d", stuckCutoff: "bogus" });
    expect(fallback).toContain('event.start < now() - 4h');
    expect(fallback).not.toContain("bogus");
  });

  it("dedups BEFORE summarize", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    const dedupIdx = q.indexOf("| dedup display_id");
    const sumIdx   = q.indexOf("| summarize");
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(sumIdx).toBeGreaterThan(dedupIdx);
  });

  it("ALWAYS emits a bounded `from:` clause (defense-in-depth)", () => {
    expect(buildStatusCategoryCountsQuery({})).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildStatusCategoryCountsQuery({ timeframe: "bogus" as never })).toMatch(/fetch dt\.davis\.problems, from: /);
    expect(buildStatusCategoryCountsQuery({ from: "bad", to: "also-bad" })).toMatch(/fetch dt\.davis\.problems, from: /);
  });

  it("applies the NULL-TOLERANT `is_duplicate` filter (native parity)", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    expect(q).toContain("isNull(dt.davis.is_duplicate)");
    expect(q).toContain("not(dt.davis.is_duplicate)");
  });

  it("does NOT apply a status filter — needs both ACTIVE and CLOSED in one response", () => {
    // The whole reason this builder exists is to return COUNTS for
    // BOTH statuses in a single coherent payload, so the rings
    // (TOTAL / ACTIVE / RESOLVED) can never disagree across
    // staggered query landings. If this assertion fails the rings
    // will go back to under-counting the trimmed list.
    //
    // 0.0.137 — the `is_stuck` predicate references event.status,
    // but it's inside a `fieldsAdd if(...)` expression, NOT a
    // `| filter` step. Assert specifically that no filter step
    // narrows by status, while allowing the predicate inside the
    // tagging expression.
    const q = buildStatusCategoryCountsQuery({ timeframe: "7d" });
    expect(q).not.toMatch(/\|\s*filter[^\n]*event\.status\s*==/);
  });

  it("rejects garbage timeframe via fallback (no injection)", () => {
    const q = buildStatusCategoryCountsQuery({ timeframe: "); DROP" as never });
    expect(q).not.toContain("DROP");
    expect(q).toMatch(/from: now\(\) - 72h/);
  });
});

describe("buildFilteredQuery × buildCategoryCountsQuery — native parity", () => {
  // Both builders MUST emit the same window AND the same
  // is_duplicate semantic, otherwise the badge headline number
  // and the list row count visibly disagree. The previous bug
  // shipped exactly this asymmetry (one had the filter, the
  // other didn't) and broke the user's trust in the counts.
  it("share the same is_duplicate filter", () => {
    const a = buildFilteredQuery({ status: "CLOSED", timeframe: "7d" });
    const b = buildCategoryCountsQuery({ status: "CLOSED", timeframe: "7d" });
    for (const q of [a, b]) {
      expect(q).toContain("isNull(dt.davis.is_duplicate)");
      expect(q).toContain("not(dt.davis.is_duplicate)");
    }
  });

  it("share the same window for the same input", () => {
    const a = buildFilteredQuery({ timeframe: "7d" });
    const b = buildCategoryCountsQuery({ timeframe: "7d" });
    expect(a).toContain("from: now() - 7d");
    expect(b).toContain("from: now() - 7d");
  });
});

describe("buildTrendQuery", () => {
  it("emits a makeTimeseries pivot", () => {
    // 0.0.144 — assert the full active-over-time shape: `spread:`
    // makes each problem contribute to every bucket it was alive
    // in (not just the bucket of its event.start), and `bins: 20`
    // matches the native Davis chart bucket count.
    const q = buildTrendQuery("72h");
    expect(q).toContain("makeTimeseries count = count(),");
    expect(q).toContain("by: { event.status }");
    expect(q).toContain("bins: 20");
  });

  it("uses `spread: timeframe(...)` to count actives across buckets", () => {
    // 0.0.158 — back to the native shape. The CLOSED series is
    // transformed to a cumulative running count in the React layer
    // (anchored to the count-query RESOLVED total), so the
    // rightmost bar still matches the RESOLVED ring exactly.
    const q = buildTrendQuery("72h");
    expect(q).toContain("spread: timeframe(from: event.start, to: coalesce(event.end, now()))");
  });

  it("falls back to 72h on malformed input", () => {
    expect(buildTrendQuery("notatimeframe")).toContain("from: now() - 72h");
  });

  it("respects valid timeframes", () => {
    expect(buildTrendQuery("7d")).toContain("from: now() - 7d");
    expect(buildTrendQuery("30d")).toContain("from: now() - 30d");
  });

  it("applies the NULL-TOLERANT `is_duplicate` filter (native parity)", () => {
    // Same contract as the other two builders — the histogram MUST
    // count the same set of records or it diverges from the list
    // and from the badges.
    const q = buildTrendQuery("7d");
    expect(q).toContain("isNull(dt.davis.is_duplicate)");
    expect(q).toContain("not(dt.davis.is_duplicate)");
  });

  it("applies a server-side status filter when status is on the FILTERS strip", () => {
    // When the user pins "Closed" we drop ACTIVE from the
    // histogram entirely so the bars render in a single colour
    // matching the list — the previous behaviour (always both
    // series) made the chart visually disagree with the chip the
    // user just clicked.
    const closed = buildTrendQuery("7d", "CLOSED");
    expect(closed).toContain('event.status == "CLOSED"');
    const active = buildTrendQuery("7d", "ACTIVE");
    expect(active).toContain('event.status == "ACTIVE"');
  });

  it("keeps both series when no status chip is on", () => {
    // 0.0.155 — restored both-series default per user request
    // ("essa barra deve mostrar abertos, fechados e total"). The
    // tooltip's "AT THIS TIME" caption + per-bucket numbers
    // disambiguate from the central ring's cumulative semantic.
    const q = buildTrendQuery("7d");
    // No explicit event.status filter — the makeTimeseries groups
    // by status so both series come back.
    expect(q).not.toMatch(/\|\s*filter[^\n]*event\.status\s*==/);
  });

  it("rejects an unknown status (silently dropped, both series kept)", () => {
    // 0.0.155 — unknown status falls back to no-filter (both series
    // returned). The injected token is dropped, no DQL escapes.
    const q = buildTrendQuery("7d", "DROP_TABLE" as never);
    expect(q).not.toContain("DROP_TABLE");
    expect(q).not.toMatch(/\|\s*filter[^\n]*event\.status\s*==/);
  });
});

describe("buildRisingProblemsByCategoryQuery", () => {
  it("filters by ACTIVE + category + start in last hour", () => {
    const q = buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d" });
    expect(q).toContain('event.status == "ACTIVE"');
    expect(q).toContain('event.category == "ERROR"');
    expect(q).toContain("event.start >= now() - 1h");
  });

  it("sorts newest first and limits to N", () => {
    const q = buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d", limit: 25 });
    expect(q).toContain("sort event.start desc");
    expect(q).toContain("| limit 25");
  });

  it("defaults limit to 10", () => {
    const q = buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d" });
    expect(q).toContain("| limit 10");
  });

  it("clamps limit to [1, 200]", () => {
    expect(buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d", limit: 500 }))
      .toContain("| limit 200");
    expect(buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d", limit: 0 }))
      .toContain("| limit 10");
  });

  it("throws on invalid category (defense-in-depth)", () => {
    expect(() => buildRisingProblemsByCategoryQuery({ category: "DROP_TABLE" as never, timeframe: "7d" }))
      .toThrow(/Invalid category/);
  });

  it("dedups by display_id BEFORE the limit", () => {
    const q = buildRisingProblemsByCategoryQuery({ category: "ERROR", timeframe: "7d" });
    const dedupIdx = q.indexOf("| dedup display_id");
    const limitIdx = q.indexOf("| limit");
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(limitIdx).toBeGreaterThan(dedupIdx);
  });
});
