export const PROBLEMS_LIST_QUERY = `fetch dt.davis.problems
| fields event.name, event.status, event.category, event.start, affected_entity_ids, affected_entity_names, root_cause_entity_id, root_cause_entity_name, display_id
| sort event.start desc
| limit 200`;

export const ACTIVE_PROBLEMS_SUMMARY = `fetch dt.davis.problems
| filter event.status == "ACTIVE"
| summarize count = count(), by: { event.category }`;

export const TREND_QUERY = `fetch dt.davis.problems
| makeTimeseries count = count(), by: { event.category }, interval: 1h`;

/** Whitelist of `event.status` values accepted by `buildFilteredQuery`.
 *  Anything else is dropped silently so user-supplied or stale state
 *  can never sneak into the DQL string. */
const ALLOWED_STATUSES = new Set(["ACTIVE", "CLOSED"]);

/** Whitelist of Davis category values. Same reasoning as above. */
const ALLOWED_CATEGORIES = new Set([
  "AVAILABILITY", "ERROR", "SLOWDOWN",
  "RESOURCE_CONTENTION", "CUSTOM_ALERT", "MONITORING_UNAVAILABLE",
]);

/** Whitelist for the relative `timeframe` argument — must match the
 *  shape `<number><h|d|m>` (e.g. "72h", "30d", "15m"). Prevents
 *  arbitrary suffixes from being concatenated into the DQL. */
const TIMEFRAME_RE = /^\d{1,4}[hdm]$/;

/** ISO-8601 date validator. Accepts the canonical
 *  `YYYY-MM-DDTHH:MM:SS(.sss)?Z` form that `new Date().toISOString()`
 *  produces. The DQL engine also accepts unquoted timestamps in this
 *  shape, but we keep them double-quoted for clarity.
 *  We reject anything else, including hand-edited strings with extra
 *  whitespace or alternate separators — those are exactly the
 *  surfaces an attacker would use to slip in a `"` and break out. */
function isIsoTimestamp(s: string): boolean {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t);
}

export function buildFilteredQuery(filters: {
  status?: string;
  category?: string;
  /** Multi-value category filter. Takes precedence over `category`
   *  when both are set. Each value is validated against the
   *  whitelist; unknown values are silently dropped. Empty array
   *  (or all values unrecognized) means "no category filter". */
  categories?: string[];
  timeframe?: string;
  from?: string;
  to?: string;
  /** DQL `| limit N` cap. Default 500 — small enough for a fast
   *  first paint on busy tenants but big enough to comfortably cover
   *  what a triage user scans without paging. Callers can ramp this
   *  via Load-more to a hard ceiling of 10 000 (same as the legacy
   *  unlimited path). */
  limit?: number;
}): string {
  // Use the platform's native "-Xh → now" timeframe — same as the Dynatrace
  // Problems UI selector. Dynatrace Intelligence (Davis) emits state-transition records inside this
  // window even for problems that started earlier, so long-running ACTIVE
  // problems are naturally captured after deduping by display_id.
  //
  // Every interpolated value below is validated against a whitelist
  // BEFORE concatenation. Without this, anything that reaches
  // `filters.from` / `filters.timeframe` etc. (URL params, prefs,
  // future settings) could inject arbitrary DQL.
  let query: string;
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    query = `fetch dt.davis.problems, from: "${filters.from}", to: "${filters.to}"`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    query = `fetch dt.davis.problems, from: now() - ${filters.timeframe}`;
  } else {
    // Defense-in-depth: callers should always supply a validated
    // window (the Overview/TrendAnalysis pages translate the Strato
    // TimeframeSelector into either `timeframe` or `from`+`to`). If
    // something upstream produces an empty/invalid value — stale
    // bundle, transient state during a re-render, future caller
    // bug — we still emit a bounded fetch instead of letting Davis
    // fall back to its ~2h implicit window, which silently
    // under-counts and was the root cause of the "0 Closed
    // Availability vs 39 in native" regression. 72h matches the
    // trend query's fallback so all three queries always agree on
    // the worst-case window.
    query = `fetch dt.davis.problems, from: now() - 72h`;
  }

  // NULL-TOLERANT duplicate filter — exact mirror of the native
  // Davis Problems app's DQL (confirmed by HAR diff on tenant
  // bwm98081). Two variants were wrong:
  //
  //   • `dt.davis.is_duplicate == false`  — dropped null-valued
  //     records too, hiding ~all closed Availability on tenants
  //     with heavy problem-grouping (the "0 vs 39" regression).
  //   • No filter at all                   — kept the explicitly-true
  //     records that native hides, over-counting by a few %
  //     (the "37 vs 35" regression).
  //
  // `isNull(...) or not(...)` keeps null + false, drops only
  // explicit true — the exact native semantic.
  const conditions: string[] = [
    `(isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`,
  ];

  if (filters.status && ALLOWED_STATUSES.has(filters.status)) {
    conditions.push(`event.status == "${filters.status}"`);
  }
  // Multi-value takes precedence — that's the path the new chip
  // filter context uses. Single-value `category` is still honoured
  // for any legacy URL deep-link that may still set it.
  const cats = (filters.categories ?? [])
    .filter((c) => ALLOWED_CATEGORIES.has(c));
  if (cats.length === 1) {
    conditions.push(`event.category == "${cats[0]}"`);
  } else if (cats.length > 1) {
    // `in()` is DQL's set-membership predicate — equivalent to
    // `event.category == "A" or event.category == "B" …` but
    // shorter to parse and (more importantly) the canonical way
    // Davis Intelligence recommends matching across enums.
    const list = cats.map((c) => `"${c}"`).join(", ");
    conditions.push(`in(event.category, ${list})`);
  } else if (filters.category && ALLOWED_CATEGORIES.has(filters.category)) {
    conditions.push(`event.category == "${filters.category}"`);
  }

  if (conditions.length > 0) {
    query += `\n| filter ${conditions.join(" and ")}`;
  }

  // Pull the canonical entity NAMES directly from dt.davis.problems
  // alongside their IDs/types. The official Problems app uses these
  // fields verbatim — no separate dt.entity.<type> lookup needed,
  // which means our chips show the same display strings as Dynatrace.
  // Try every plausible field that might carry the Davis "problem id"
  // used by the official app's `/problem/<id>` route. The format is
  // `<cardinality>_<timestamp>V<version>`. Aliases give us
  // dot-free JS keys we can probe at runtime; the helper picks the
  // first that resolves. Adding candidates is cheap — DQL ignores
  // aliases pointing at columns that don't exist on this record set
  // (the field is silently null), so this is safe to over-declare.
  query += `\n| fieldsAdd davis_problem_id = event.id`;
  query += `\n| fieldsAdd davis_problem_id_alt1 = dt.davis.problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt2 = problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt3 = event.problem_id`;
  // Field projection — restored to the full set after the Tier 2
  // trim caused empty problem lists in dev. The cost of carrying
  // two unused columns (`affected_entity_types`, `management_zones`)
  // is negligible per row; debugging the empty state was not. Keep
  // both fields in the projection until we can isolate root cause
  // and re-evaluate independently.
  query += `\n| fields davis_problem_id, davis_problem_id_alt1, davis_problem_id_alt2, davis_problem_id_alt3, event.name, event.status, event.category, event.start, event.end, event.severity, affected_entity_ids, affected_entity_names, affected_entity_types, root_cause_entity_id, root_cause_entity_name, display_id, management_zones`;
  // Dynatrace Intelligence (Davis) emits multiple records per problem (one per state change). Sort
  // by event.start desc and dedup keeps one record per problem.
  query += `\n| sort event.start desc`;
  query += `\n| dedup display_id`;
  // Clamp the caller-supplied limit to a safe integer in
  // [1, 10000]. The upper bound matches the legacy "fetch
  // everything" path so the Load-more ramp never accidentally
  // raises load beyond what the previous implementation already
  // tolerated. Non-positive / non-finite / NaN values fall back to
  // the new conservative default (500) — see the prop doc above.
  const requested = filters.limit;
  const safeLimit = (typeof requested === "number"
    && Number.isFinite(requested)
    && requested > 0)
    ? Math.min(Math.floor(requested), 10_000)
    : 500;
  query += `\n| limit ${safeLimit}`;

  return query;
}

/** Build a cheap aggregation query that returns one row per
 *  category with its problem count inside the same window/segment
 *  filters as the main list — but **without** the category filter
 *  itself. Used to populate the chip badges so they keep showing
 *  real numbers even when the user has activated one or more chips
 *  (i.e. server-side filtered the main list to a subset).
 *
 *  Payload is ≤ 6 rows × ~30 bytes — orders of magnitude smaller
 *  than the main problems query, so this can run alongside the
 *  list query without any meaningful cost. */
export function buildCategoryCountsQuery(filters: {
  status?: string;
  timeframe?: string;
  from?: string;
  to?: string;
}): string {
  let query: string;
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    query = `fetch dt.davis.problems, from: "${filters.from}", to: "${filters.to}"`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    query = `fetch dt.davis.problems, from: now() - ${filters.timeframe}`;
  } else {
    // See buildFilteredQuery for the rationale — both queries MUST
    // emit identical windows or the badge counts disagree with the
    // headline. 72h matches the trend query fallback.
    query = `fetch dt.davis.problems, from: now() - 72h`;
  }
  // Same contract as the list query — apply the null-tolerant
  // duplicate filter so the badge counts match what the native
  // Davis Problems pill shows. See buildFilteredQuery for the
  // exact rationale (confirmed via HAR diff against the native
  // app on the bwm98081 tenant: 37 → 35 once this filter is on).
  const conditions: string[] = [
    `(isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`,
  ];
  if (filters.status && ALLOWED_STATUSES.has(filters.status)) {
    conditions.push(`event.status == "${filters.status}"`);
  }
  if (conditions.length > 0) {
    query += `\n| filter ${conditions.join(" and ")}`;
  }
  // Dedup BEFORE summarize so each unique problem contributes
  // exactly once to its category count (Davis emits multiple
  // state-change records per problem).
  query += `\n| sort event.start desc`;
  query += `\n| dedup display_id`;
  query += `\n| summarize count = count(), by: { event.category }`;
  return query;
}

/** Combined per-(status × category) aggregation. Returns one row
 *  per unique (event.status, event.category) pair in the window —
 *  bounded by 2 statuses × 6 Davis categories = ≤12 rows.
 *
 *  Why a SEPARATE query from `buildCategoryCountsQuery`?
 *
 *  The Overview central rings (TOTAL / ACTIVE / RESOLVED) and the
 *  per-category "Active Problems" + "RESOLVED" panels in the
 *  ConstellationView USED to derive their numbers from the trimmed
 *  problems list (`useProblems`). With `DEFAULT_INITIAL = 250`
 *  this broke parity with native: on a tenant with 889 problems in
 *  the window, the rings showed `1 active / 250 total / 249 resolved`
 *  while the chip badges (sourced from `buildCategoryCountsQuery`)
 *  correctly showed `5 active`. The 4 missing ACTIVE problems were
 *  beyond the first 250 (sort `event.start desc` favours new closed
 *  problems over long-running active ones).
 *
 *  This builder closes that gap with ONE small query that feeds
 *  ALL ring + panel counts. Payload is ≤ 12 rows × ~50 bytes —
 *  cheaper than running `buildCategoryCountsQuery` twice (once for
 *  ACTIVE, once for CLOSED) and stays coherent in a single response
 *  so totals can never disagree across statuses.
 *
 *  Mirrors the same window + `is_duplicate` + dedup contract as
 *  `buildCategoryCountsQuery` — see that builder for the rationale. */
export function buildStatusCategoryCountsQuery(filters: {
  timeframe?: string;
  from?: string;
  to?: string;
}): string {
  let query: string;
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    query = `fetch dt.davis.problems, from: "${filters.from}", to: "${filters.to}"`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    query = `fetch dt.davis.problems, from: now() - ${filters.timeframe}`;
  } else {
    query = `fetch dt.davis.problems, from: now() - 72h`;
  }
  // Same null-tolerant `is_duplicate` filter the other builders use.
  query += `\n| filter (isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`;
  // Dedup BEFORE summarize so each unique problem contributes once.
  query += `\n| sort event.start desc`;
  query += `\n| dedup display_id`;
  // Two-dimensional summarize: counts grouped by (status, category).
  query += `\n| summarize count = count(), by: { event.status, event.category }`;
  return query;
}

export function buildTrendQuery(timeframe: string, status?: string): string {
  // Validate the timeframe against the same whitelist used elsewhere
  // to keep injection surface flat — anything unrecognised falls
  // back to a safe 72h window.
  const tf = TIMEFRAME_RE.test(timeframe) ? timeframe : "72h";

  // Mirror the duplicate semantic from the other two builders so
  // the histogram counts agree with the badge counts + list size.
  // Without this, the chart would also count is_duplicate=true
  // records that the native Davis app (and our list) hide.
  let q = `fetch dt.davis.problems, from: now() - ${tf}`;
  const conds: string[] = [
    `(isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`,
  ];
  // Optional status filter — wired from the FILTERS strip so the
  // chart visibly tracks the same subset as the list. When the
  // strip says "Closed" we drop the ACTIVE series entirely (the
  // bars render in a single colour); when no status chip is on,
  // we keep both series so the user sees the ACTIVE-vs-CLOSED
  // breakdown across the window. Whitelist-guarded for the same
  // injection-surface reasons as the other builders.
  if (status && ALLOWED_STATUSES.has(status)) {
    conds.push(`event.status == "${status}"`);
  }
  q += `\n| filter ${conds.join(" and ")}`;
  // Group by event.status so the chart can render ACTIVE vs CLOSED as
  // separate stacked bars. The DQL engine auto-picks an interval that
  // gives a sensible bucket count for the requested timeframe.
  q += `\n| makeTimeseries count = count(), by: { event.status }`;
  return q;
}
