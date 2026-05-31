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

/** Parse a `<number><h|d|m>` timeframe (the one TIMEFRAME_RE
 *  accepts) into milliseconds. Returns `null` for inputs that
 *  don't match — callers fall back to whatever default the
 *  surrounding builder uses. Used to compare against the 1 h
 *  baseline floor in `buildStatusCategoryCountsQuery`. */
function parseTimeframeToMs(tf: string): number | null {
  const m = /^(\d{1,4})([hdm])$/.exec(tf);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const u = m[2];
  return u === "m" ? n * 60_000
       : u === "h" ? n * 3_600_000
       :             n * 86_400_000; // "d"
}

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
  // 0.0.190 — Filter split: PROBLEM-LEVEL filters (is_duplicate,
  // category) apply BEFORE the dedup pass; the STATUS filter is
  // applied AFTER dedup. Davis emits multiple records per problem
  // (one per state change), and the previous flow filtered by
  // status BEFORE dedup, which kept the OLD ACTIVE record of a
  // problem that had since closed in the same window — list shows
  // such a problem with status=Active even though Davis already
  // closed it. The new dedup sorts by record `timestamp` desc, so
  // the LATEST state record wins per problem; only then do we
  // filter `event.status == "ACTIVE"` to keep currently-active
  // rows. Matches the count query's intent (see v0.0.166 comment).
  // User: list showed 20 ERROR active in 1h but Rising bubble
  // (server count) showed 15 — the 5 difference were closed-in-
  // window problems still appearing as Active in the list.
  const earlyConditions: string[] = [
    `(isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`,
  ];
  const cats = (filters.categories ?? [])
    .filter((c) => ALLOWED_CATEGORIES.has(c));
  if (cats.length === 1) {
    earlyConditions.push(`event.category == "${cats[0]}"`);
  } else if (cats.length > 1) {
    const list = cats.map((c) => `"${c}"`).join(", ");
    earlyConditions.push(`in(event.category, ${list})`);
  } else if (filters.category && ALLOWED_CATEGORIES.has(filters.category)) {
    earlyConditions.push(`event.category == "${filters.category}"`);
  }
  query += `\n| filter ${earlyConditions.join(" and ")}`;

  // 0.0.190 — Sort by record `timestamp` desc + dedup BEFORE the
  // projection. `timestamp` is the implicit per-record emit time
  // that Davis stamps on each state-change event; the latest
  // emission wins per `display_id`, so a problem that was opened
  // (ACTIVE record) and then closed (CLOSED record) in the same
  // window is correctly represented by its CLOSED record. This is
  // intentionally INSIDE the dedup window — the projection below
  // drops `timestamp`, so the sort has to happen before `| fields`
  // strips it. Pulled BEFORE the status filter so the status filter
  // operates on the latest-state row.
  query += `\n| sort timestamp desc`;
  query += `\n| dedup display_id`;
  // Status filter on the latest-state row (post-dedup). Filters out
  // the OLD ACTIVE record of a problem that has since closed in
  // window — that record had been incorrectly counted as "active"
  // by the pre-v0.0.190 ordering.
  if (filters.status && ALLOWED_STATUSES.has(filters.status)) {
    query += `\n| filter event.status == "${filters.status}"`;
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
  // Display ordering — newest problems first. Independent of the
  // dedup-by-timestamp sort above (that one was about "which row
  // wins"; this one is about "what does the user see first").
  query += `\n| sort event.start desc`;
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

/** 0.0.142 — Top-N oldest ACTIVE problems per category, restricted
 *  to age > 4 h (the canonical Stuck threshold). Fires ONLY when the
 *  user opens the enlarged-quadrant modal and lands on the Stuck
 *  pill (on-demand, not on every refresh) — without this the modal
 *  has no Stuck dots to render whenever the first-paint sample (250
 *  newest globally) doesn't include any 4h+ active problems for
 *  this category, which is the common case for busy cells.
 *
 *  Payload: ≤ 50 rows × ~300 bytes ≈ 15 KB. Bytes scanned scale with
 *  the timeframe (filtered server-side to one category + ACTIVE +
 *  age cutoff), so the DPS hit is modest and only paid on user
 *  interaction. */
export function buildStuckProblemsByCategoryQuery(filters: {
  category: string;
  timeframe?: string;
  from?: string;
  to?: string;
  limit?: number;
  /** 0.0.148 — same `stuckCutoff` semantic as
   *  buildStatusCategoryCountsQuery — keeps the modal's drilldown
   *  list aligned with the cell-level Stuck count. */
  stuckCutoff?: string;
}): string {
  if (!ALLOWED_CATEGORIES.has(filters.category)) {
    // Defense-in-depth — caller validated, but never let an
    // unknown category interpolate into a DQL string.
    throw new Error(`Invalid category: ${filters.category}`);
  }
  let query: string;
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    query = `fetch dt.davis.problems, from: "${filters.from}", to: "${filters.to}"`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    query = `fetch dt.davis.problems, from: now() - ${filters.timeframe}`;
  } else {
    query = `fetch dt.davis.problems, from: now() - 72h`;
  }
  query += `\n| filter (isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`;
  query += `\n| filter event.status == "ACTIVE"`;
  query += `\n| filter event.category == "${filters.category}"`;
  // 0.0.148 — same timeframe-aware cutoff. ISO validated up-front.
  const stuckExpr2 = (filters.stuckCutoff && isIsoTimestamp(filters.stuckCutoff))
    ? `toTimestamp("${filters.stuckCutoff}")`
    : `now() - 4h`;
  query += `\n| filter event.start < ${stuckExpr2}`;
  // 0.0.226 — Project the Davis-problem-id aliases so a dot
  // clicked in the modal injects a Problem object that
  // `buildOfficialProblemUrl()` can resolve into the native
  // Davis Problems deep link AND `useProblemTimeline` can use
  // to fetch annotations + workflows. Without this every Stuck
  // drilldown landed on an empty activity feed ("No events
  // match the current filter") and the row was missing the
  // "Open in Davis" link — both symptoms of `davis_problem_id`
  // coming back undefined.
  query += `\n| fieldsAdd davis_problem_id = event.id`;
  query += `\n| fieldsAdd davis_problem_id_alt1 = dt.davis.problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt2 = problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt3 = event.problem_id`;
  query += `\n| fields davis_problem_id, davis_problem_id_alt1, davis_problem_id_alt2, davis_problem_id_alt3, event.name, event.status, event.category, event.start, event.end, event.severity, affected_entity_ids, affected_entity_names, affected_entity_types, root_cause_entity_id, root_cause_entity_name, display_id, management_zones`;
  // Dedup by display_id so each problem contributes once even
  // when Davis emits multiple state-change records.
  query += `\n| sort event.start asc`; // oldest first → most stuck
  query += `\n| dedup display_id`;
  const requested = filters.limit;
  const safeLimit = (typeof requested === "number" && Number.isFinite(requested) && requested > 0)
    ? Math.min(Math.floor(requested), 200)
    : 50;
  query += `\n| limit ${safeLimit}`;
  return query;
}

/** 0.0.169 — Top-N most recently opened ACTIVE problems per
 *  category (started in the last 1 hour). Mirrors the
 *  buildStuckProblemsByCategoryQuery pattern. Fires ONLY when the
 *  enlarged-quadrant modal opens on the Rising pill so the DPS cost
 *  is paid on user interaction, not on every refresh. Without this
 *  the modal's Rising slice was bounded by the 250-row first-paint
 *  sample, so the pill number (server-authoritative once we wire
 *  this up) and the visible dots could drift.
 *
 *  Payload: ≤ 10 rows × ~300 B = ~3 KB. Bytes scanned scale with
 *  the timeframe filtered to one category + ACTIVE + 1h cutoff,
 *  ~3-5 MB compressed for an xlarge tenant. ≈ 0.05 DPS per modal
 *  open with Rising selected. */
export function buildRisingProblemsByCategoryQuery(filters: {
  category: string;
  timeframe?: string;
  from?: string;
  to?: string;
  limit?: number;
}): string {
  if (!ALLOWED_CATEGORIES.has(filters.category)) {
    throw new Error(`Invalid category: ${filters.category}`);
  }
  let query: string;
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    query = `fetch dt.davis.problems, from: "${filters.from}", to: "${filters.to}"`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    query = `fetch dt.davis.problems, from: now() - ${filters.timeframe}`;
  } else {
    query = `fetch dt.davis.problems, from: now() - 72h`;
  }
  query += `\n| filter (isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`;
  query += `\n| filter event.status == "ACTIVE"`;
  query += `\n| filter event.category == "${filters.category}"`;
  // Rising = newly arrived ACTIVE problems (started in the last
  // hour, i.e. wasn't alive 1h ago).
  query += `\n| filter event.start >= now() - 1h`;
  // 0.0.226 — Same davis_problem_id projection as the Stuck
  // query above (see comment there for rationale).
  query += `\n| fieldsAdd davis_problem_id = event.id`;
  query += `\n| fieldsAdd davis_problem_id_alt1 = dt.davis.problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt2 = problem.id`;
  query += `\n| fieldsAdd davis_problem_id_alt3 = event.problem_id`;
  query += `\n| fields davis_problem_id, davis_problem_id_alt1, davis_problem_id_alt2, davis_problem_id_alt3, event.name, event.status, event.category, event.start, event.end, event.severity, affected_entity_ids, affected_entity_names, affected_entity_types, root_cause_entity_id, root_cause_entity_name, display_id, management_zones`;
  query += `\n| sort event.start desc`; // newest first → most "rising"
  query += `\n| dedup display_id`;
  const requested = filters.limit;
  const safeLimit = (typeof requested === "number" && Number.isFinite(requested) && requested > 0)
    ? Math.min(Math.floor(requested), 200)
    : 10;
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
  /** 0.0.148 — ISO timestamp before which an ACTIVE problem
   *  qualifies as "stuck". When omitted falls back to `now() - 4h`
   *  (the legacy hardcoded threshold). Callers pass the resolved
   *  `from` of the user-selected timeframe so Stuck respects the
   *  observation window — a problem that started inside Today is
   *  noise; one that's been alive since yesterday is genuinely
   *  stuck. */
  stuckCutoff?: string;
}): string {
  // 0.0.184 — Fetch window must cover at least the last 1 h so the
  // `was_active_1h_ago` predicate (and therefore the Rising bubble)
  // sees the full set of records eligible for "alive 1 h ago",
  // independent of the user's selected timeframe. Without this,
  // shorter user timeframes (e.g. "Last 30 min") truncate the
  // CLOSED records whose `event.end` is between user_tf and 1 h —
  // those records would normally satisfy `was_active_1h_ago = 1`
  // but get dropped before the predicate runs, inflating Rising.
  // HAR-verified production case: RESOURCE_CONTENTION Rising read
  // +1 in "Today" tf and +3 in "30m" tf with the same underlying
  // state, because the 30m fetch lost 2 closures from the 1h
  // baseline.
  //
  // The CLOSED count itself stays user-timeframe-bound via the
  // `is_in_user_window` conditional column below — the fetch is
  // only WIDER than the user picked, never narrower.
  let query: string;
  let userWindowStartExpr: string; // DQL expr for the user-tf start
  if (filters.from && filters.to && isIsoTimestamp(filters.from) && isIsoTimestamp(filters.to)) {
    const userFromMs = new Date(filters.from).getTime();
    const minFromMs  = Date.now() - 3_600_000; // 1 h ago
    const effFromIso = userFromMs > minFromMs ? new Date(minFromMs).toISOString() : filters.from;
    query = `fetch dt.davis.problems, from: "${effFromIso}", to: "${filters.to}"`;
    userWindowStartExpr = `toTimestamp("${filters.from}")`;
  } else if (filters.timeframe && TIMEFRAME_RE.test(filters.timeframe)) {
    const userTfMs = parseTimeframeToMs(filters.timeframe);
    const effTf    = (userTfMs !== null && userTfMs < 3_600_000) ? "1h" : filters.timeframe;
    query = `fetch dt.davis.problems, from: now() - ${effTf}`;
    userWindowStartExpr = `now() - ${filters.timeframe}`;
  } else {
    query = `fetch dt.davis.problems, from: now() - 72h`;
    userWindowStartExpr = `now() - 72h`;
  }
  // Same null-tolerant `is_duplicate` filter the other builders use.
  query += `\n| filter (isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate))`;
  // 0.0.166 — deterministic dedup. Davis emits multiple state-change
  // records per problem; for a problem that's been closed, both
  // ACTIVE and CLOSED records share the same event.start. The
  // previous `sort event.start desc | dedup` therefore picked an
  // arbitrary record per problem — so the same closed problem could
  // be counted in either bucket depending on the engine's tie-break.
  // The list query (`buildFilteredQuery`) filters by status BEFORE
  // dedup, so it sees the closed record reliably. To keep both
  // queries in lockstep, sort here so CLOSED records sort FIRST per
  // problem (lexicographically CLOSED < ACTIVE in DESC: "C" > "A"
  // → C comes first in desc). Dedup then keeps the CLOSED record
  // whenever it exists; count.CLOSED matches what the list returns.
  // User: "vejo 2 problemas aqui mas ao fazer drilldown, nao vejo
  // eles na lista."
  query += `\n| sort event.status desc, event.start desc`;
  query += `\n| dedup display_id`;
  // 0.0.137 — also tag whether each row is "stuck" (ACTIVE and
  // started more than 4 hours ago) so the constellation can show an
  // authoritative Stuck count per category. Without this, the cell-
  // level loaded sample (top 250 newest globally) underestimates
  // Stuck whenever a busy category overflows the sample — its newest
  // 250 are mostly <4h old, so loaded.open_time = 0 and the Stuck
  // bubble disappears even when hundreds of older actives exist.
  // 0.0.148 — Stuck cutoff now honours the user-selected timeframe
  // when provided, falling back to the legacy now()-4h floor when
  // omitted. ISO validated up-front to keep DQL injection-safe.
  const stuckExpr = (filters.stuckCutoff && isIsoTimestamp(filters.stuckCutoff))
    ? `toTimestamp("${filters.stuckCutoff}")`
    : `now() - 4h`;
  query += `\n| fieldsAdd is_stuck = if((event.status == "ACTIVE") and (event.start < ${stuckExpr}), 1, else: 0)`;
  // 0.0.150 — `was_active_1h_ago` lets the count query report how
  // many problems were alive an hour ago across BOTH statuses
  // (ACTIVE-now problems that started ≥ 1h ago, plus CLOSED
  // problems whose end is after the 1h cutoff). Summed per category
  // it yields a server-authoritative "older" baseline so the Rising
  // bubble can be `max(0, active - older)` without the 250-row
  // sample bias. User: "os calculos estao limitados a 250 ... deve
  // respeitar timeframe padrao."
  query += `\n| fieldsAdd was_active_1h_ago = if(`
         + `(event.start <= now() - 1h) and `
         + `((event.status == "ACTIVE") or (isNotNull(event.end) and (event.end > now() - 1h))),`
         + ` 1, else: 0)`;
  // 0.0.185 — `newly_started_1h` counts ACTIVE-now problems whose
  // event.start is within the last 1 h. Unlike Rising delta
  // (ACTIVE − OLDER, which goes to zero or negative on busy
  // categories where closures match openings), this is always >= 0
  // and tells the user "N problems opened in 1 h" regardless of net
  // queue movement. The constellation cell's Rising bubble uses
  // this so the visual cue fires whenever new problems arrive,
  // independent of whether the same minute saw enough closures to
  // bring the net delta to zero. The trend arrow ▲/▼ next to
  // "N active" still reads the net delta (via OLDER) so the user
  // sees both: "things are coming in" (bubble) AND "queue is
  // shrinking/growing" (arrow).
  query += `\n| fieldsAdd newly_started_1h = if(`
         + `(event.status == "ACTIVE") and (event.start >= now() - 1h),`
         + ` 1, else: 0)`;
  // 0.0.184 — `is_in_user_window` masks CLOSED records that fall
  // OUTSIDE the user's chosen timeframe (relevant whenever the
  // fetch above was widened to cover the 1 h baseline). ACTIVE rows
  // always count (the "Active" headline number is intended to be
  // timeframe-invariant — the user-selected timeframe bounds
  // closures only). For CLOSED rows we require event.end to fall on
  // or after the user-window start; null event.end is treated as
  // out-of-window (defensive, shouldn't happen for CLOSED).
  query += `\n| fieldsAdd is_in_user_window = if(`
         + `event.status == "ACTIVE", 1, `
         + `else: if(isNotNull(event.end) and (event.end >= ${userWindowStartExpr}), 1, else: 0))`;
  // Three-dimensional summarize: total count (timeframe-bound
  // CLOSED + all ACTIVE), stuck count (ACTIVE & older than the
  // timeframe-aware cutoff), and the 1h-ago baseline (uses ALL
  // fetched rows so Rising stays consistent regardless of the
  // user timeframe).
  query += `\n| summarize count = sum(is_in_user_window), stuck_count = sum(is_stuck), older_count = sum(was_active_1h_ago), newly_started_count = sum(newly_started_1h), by: { event.status, event.category }`;
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
  // 0.0.155 — restore the both-series default. User: "essa barra
  // deve mostrar abertos, fechados e total." When no FILTERS chip
  // pins a status, the chart returns ACTIVE + CLOSED series so the
  // tooltip can list all three numbers. v0.0.147 had narrowed it to
  // ACTIVE-only to avoid the bar-vs-ring number confusion; that's
  // now disambiguated in the tooltip semantic ("AT THIS TIME" label
  // + per-bucket numbers, contrasted with the cumulative ring).
  if (status && ALLOWED_STATUSES.has(status)) {
    conds.push(`event.status == "${status}"`);
  }
  q += `\n| filter ${conds.join(" and ")}`;
  // 0.0.158 — Reverted v0.0.156's per-row spread. Reason: Grail's
  // `spread:` does per-bucket overlap (a CLOSED row spread over
  // (event.end, now()) contributes to every bucket between, summing
  // to > 1 across the timeframe). That made the latest bar's
  // "closed" count exceed the RESOLVED ring instead of matching it.
  //
  // Back to native semantic: each row spreads across the buckets it
  // was alive in. The PulseVisualizer then transforms the closed
  // series client-side into a cumulative running count anchored to
  // the count-query's `resolved` total — that's how the rightmost
  // bar lands EXACTLY on the RESOLVED ring (and Active + Closed =
  // TOTAL). See bars useMemo in PulseVisualizer.
  q += `\n| makeTimeseries count = count(),`
     + ` spread: timeframe(from: event.start, to: coalesce(event.end, now())),`
     + ` by: { event.status },`
     + ` bins: 20`;
  return q;
}
