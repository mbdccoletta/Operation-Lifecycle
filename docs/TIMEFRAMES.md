# Timeframes & temporal thresholds — Problem Lifecycle app

> Single source of truth for **every time window** that drives a
> number, chart, or badge in the app. If a surface shows a count
> and you're not sure which clock it's on, start here.
>
> Cross-references file:line so you can jump to the implementation.
> Bump the file when you change any of these values — the visual
> contract between surfaces depends on them being consistent.

---

## 1 · User-selected timeframe (the top-bar control)

The Strato `TimeframeSelector` on the Overview header drives every
DQL query in the app. It is the **only** clock the user can move.

| Form | Example | Meaning |
|---|---|---|
| Relative (compact) | `-7d`, `1h`, `24h` | Legacy shorthand, still parsed |
| Strato form | `now()-1h`, `now()-7d` | Default preset format |
| Calendar | `@d`, `-1d@d` | Start-of-day UTC, yesterday |
| Custom range | ISO-8601 `from` / `to` | Absolute timestamps |

- **Parser**: `parseStratoTimeframe()` in `ui/app/utils/timeframe.ts`
  — normalises every shape into `{ timeframe }` or `{ from, to }`
  before it reaches the DQL builder.
- **Fallback**: when no form is recognised, builders emit
  `from: now() - 72h` (defence-in-depth, added v0.0.27 after a
  bug where the empty-filter transition wiped the clause). See
  `ui/app/utils/dql-queries.ts` line 87.
- **Auto-refresh**: default **OFF** (manual). When enabled, the
  shortest interval is **5 min** (the 1-min option was removed in
  v0.0.120 for DPS reasons — see `DPS.md` §2).

---

## 2 · Stuck / Rising / the 1h–4h gap

These are **hardcoded thresholds** that don't move with the
user-selected timeframe. They define the visual language of the
constellation cells and the modal pills.

| Concept | Threshold | Where | Surfaces it drives |
|---|---|---|---|
| **Rising** | `event.start >= now() - 1h` | `buildRisingProblemsByCategoryQuery` (`dql-queries.ts:268`); `was_active_1h_ago` flag in `buildStatusCategoryCountsQuery` (`dql-queries.ts:416–418`) | Cell ▲+N badge · modal "Rising" pill · modal canvas dots when Rising selected |
| **Stuck** | `event.status == "ACTIVE" AND event.start < now() - 4h` | `buildStuckProblemsByCategoryQuery` (`dql-queries.ts:218`); `is_stuck` flag (`dql-queries.ts:407`) | Cell "Stuck N" bubble · modal "Stuck of N" pill · modal canvas dots when Stuck selected |
| **1h–4h gap** | Problems aged 1h–4h get **no** label | implicit | Explains why `active = stuck + (small N)` — the small N is exactly the cohort in the gap |

### The arithmetic users encounter

For any category in any timeframe:

```
ACTIVE        = currently active right now (server count)
STUCK         = subset of ACTIVE older than 4 h
RISING_DELTA  = max(0, ACTIVE - was_active_1h_ago)
TOTAL_pill    = ACTIVE + CLOSED-in-timeframe
```

So when the user sees `1069 active · 1062 stuck · 1079 total`:

```
1069 - 1062 = 7   problems active but younger than 4 h (the 1h–4h gap)
1079 - 1069 = 10  problems closed during the timeframe
RISING_DELTA ≈ 7 (most of the gap arrived in the last hour)
```

All four numbers come from the **same count query**
(`buildStatusCategoryCountsQuery`) so they cannot disagree — they
just measure different facets. This unification landed in v0.0.173
after a 4-surface discrepancy bug (▲+5 / bubble 3 / ▲+4 / pill 1).

---

## 3 · DQL query windows

Every builder in `ui/app/utils/dql-queries.ts`. The "Window" column
is the **clock that scopes the query**; "Threshold" lists any
hardcoded cutoff inside the window.

| Builder | Window | Threshold | Used by |
|---|---|---|---|
| `buildFilteredQuery` | user timeframe, fallback `72h` (L87) | none | `useProblems` — main list |
| `buildCategoryCountsQuery` | user timeframe, fallback `72h` (L305) | none | per-category badge counts |
| `buildStatusCategoryCountsQuery` | user timeframe, fallback `72h` (L374) | `is_stuck` (>4h), `was_active_1h_ago` | constellation cells · modal header · panel rings |
| `buildStuckProblemsByCategoryQuery` | user timeframe + `event.start < now()-4h` (L218) | 4 h | `useStuckProblemsByCategory` — modal Stuck dots |
| `buildRisingProblemsByCategoryQuery` | user timeframe + `event.start >= now()-1h` (L268) | 1 h | `useRisingProblemsByCategory` — modal Rising dots |
| `buildTrendQuery` | user timeframe, fallback `72h` (L431) | `bins: 20` + `spread: timeframe(event.start, coalesce(event.end, now()))` (L465) | `useProblemTrend` — TrendChart / PulseVisualizer |
| `TREND_QUERY` const | `from: now() - 72h` + `interval: 1h` (L11) | hourly buckets | timeseries-by-category global |

### `spread: timeframe(...)` — what it does

Used by `buildTrendQuery`. A single problem with
`event.start = T0` and `event.end = T1` (or `now()` if still
active) contributes to **every** bucket between T0 and T1. So the
TrendChart bar at hour H counts every problem that was alive
during H, not just problems that started at H. This is why the
chart's leftmost bar in a 7d view is much taller than the
rightmost — it includes all the long-running stucks.

---

## 4 · First-paint limits & sample sizes

These cap how many rows the app pulls per query. Important
because **counts derived from samples are bounded above** by these
limits, while count-only queries (e.g. `useStatusCategoryCounts`)
return the authoritative total. The Stuck/Rising on-demand
fetches exist specifically to bridge the gap when the global
250-row sample doesn't include a category's actives.

| Hook | Limit | File:line | Notes |
|---|---|---|---|
| `useProblems` (list) | `DEFAULT_INITIAL = 250` | `useProblems.ts:77` | Was 500, reduced for DPS Tier 3. Load-more doubles until ceiling. |
| `useProblems` (ceiling) | `HARD_CEILING = 10_000` | `useProblems.ts:72` | Stops doubling here. |
| `useStuckProblemsByCategory` | `50` | `useStuckProblemsByCategory.ts:226` | Per-category fetch; capped to TOP_N in modal. |
| `useRisingProblemsByCategory` | `50` | (v0.0.174) | Mirrors Stuck fetch; bumped from 10 with the modal top-50 change. |
| `useStatusCategoryCounts` | `maxResultRecords: 16` | `useStatusCategoryCounts.ts:101` | 4 statuses × ~6 categories ≤ 16 rows. |
| `useSegmentMembership` | `maxResultRecords: 10_000` | `useSegmentMembership.ts:130` | Per-segment member IDs. |
| `buildFilteredQuery` (default limit) | `500` | `dql-queries.ts:169` | Only if caller doesn't pass `limit:` — they always do. |
| Modal `TOP_N` (canvas) | `50` | `EnlargedQuadrantCard.tsx:296` | Inner ConstellationView highlights leading 10 of those 50 (`MAX_TIER_PER_CAT`). |

---

## 5 · Cache TTL / staleTime per hook

React Query `staleTime` controls "how long is a cached result
trusted without a refetch". Combine with the auto-refresh
interval to derive sustained DPS — see `DPS.md` §2.

| Hook | `staleTime` | Reason |
|---|---|---|
| `useProblems` | **120 s** (`useProblems.ts:158`) | "Matches native Davis Problems list refresh cadence." Was 90s pre-DPS Tier 3. |
| `useStatusCategoryCounts` | **120 s** (`useStatusCategoryCounts.ts:113`) | Pinned to useProblems so adjacent surfaces refresh together. |
| `useStuckProblemsByCategory` | **60 s** | On-demand fetch — user just clicked Stuck, freshness matters. |
| `useRisingProblemsByCategory` | **60 s** | Mirrors Stuck fetch — Rising changes minute-to-minute. |
| `useSegmentMembership` (module LRU) | `TTL_MS = 60_000` (`useSegmentMembership.ts:38`) | 200-entry cap (`CACHE_MAX_ENTRIES`, L46) to avoid leaks. Bumped from 30s in v0.0.120. |

### Request timeouts

DQL queries that miss `staleTime` go to the SDK with these
ceilings (anything slower throws):

| Hook | `requestTimeoutMilliseconds` |
|---|---|
| `useProblems` | 30 000 ms (`useProblems.ts:141`) |
| `useStatusCategoryCounts` | 15 000 ms (`useStatusCategoryCounts.ts:102`) |
| `useSegmentMembership` | 30 000 ms (`useSegmentMembership.ts:129`) |

`useSegmentMembership` additionally polls **up to 30 times × 1 s**
when waiting for asynchronous segment expansion (L146) — soft
timeout ≈ 30 s.

---

## 6 · Component-internal time windows

Windows that don't come from DQL — they're UI heuristics inside
the chart / swimlane / animation layers.

| Surface | Window | Where | Purpose |
|---|---|---|---|
| `EventSwimlane` minimum span | 60 000 ms floor | `EventSwimlane.tsx:2213` (`if (mx - mn < 60_000) mx = mn + 60_000`) | Prevents zero-width swimlanes for events < 60 s apart. |
| `TrendChart` / `PulseVisualizer` buckets | 20 bins across the user timeframe | inherited from `buildTrendQuery` `bins: 20` | Same X resolution regardless of timeframe — bar width scales. |
| `ConstellationView` RAF loop | paused when `document.visibilityState !== "visible"` | C5 perf fix | Saves CPU on backgrounded tabs. |
| Logger `sessionId` | one per page load (regenerated on hard refresh) | `logger.ts:53–64` | Correlates hook events within a session in log aggregation. |

---

## 7 · Surface → window mapping (quick reference)

When debugging "why does cell N differ from list M", trace each
surface back here:

| Surface | Driving query | Window | Threshold |
|---|---|---|---|
| Constellation cell `N active` | `useStatusCategoryCounts.ACTIVE` | user timeframe | none |
| Constellation cell ▲+N badge | `ACTIVE - OLDER` from same query | 1 h vs now | `was_active_1h_ago` (1 h) |
| Constellation cell **Stuck** bubble | `useStatusCategoryCounts.STUCK` | user timeframe | `is_stuck` (4 h) |
| Constellation cell **Total** bubble | `ACTIVE + CLOSED` from same query | user timeframe | none |
| Modal header `N active ▲ ±M /1h` | `categoryCounts.active` + delta | user timeframe + 1 h delta | `was_active_1h_ago` |
| Modal Rising pill `Rising N` | `categoryCounts.rising` (server) | 1 h | `event.start >= now()-1h` |
| Modal Stuck pill `TOP K Stuck of N` | `categoryCounts.stuck` (server) | 4 h | `event.start < now()-4h` |
| Modal canvas dots (top 50) | `useProblems` sample ∪ on-demand fetch | user timeframe | TOP_N=50, leading 10 highlighted |
| List footer `X of Y problems` | sample size vs `expectedListTotal` from count query | user timeframe | none |
| TrendChart bars | `useProblemTrend` (`buildTrendQuery`) | user timeframe | `spread: timeframe(...)` |
| EventSwimlane rows | per-problem timeline events | per-problem `event.start → event.end` | 60 s floor |

---

## Changelog of timeframe decisions

Notable inflection points so future you can find the "why":

- **v0.0.27** — defence-in-depth: every builder always emits a
  `from:` clause (fallback `72h`). Fixed an empty-filter
  regression on timeframe transitions.
- **v0.0.120** — `useSegmentMembership` TTL `30 s → 60 s`;
  1-min auto-refresh option removed (DPS Tier 2).
- **v0.0.137** — `STUCK` exposed via `useStatusCategoryCounts`.
- **v0.0.150** — `OLDER` exposed (server-side
  `was_active_1h_ago`) so Rising delta stops depending on the
  sample.
- **v0.0.158** — cumulative TrendChart bars rebuilt so the
  rightmost bar = RESOLVED ring exactly.
- **v0.0.166** — `event.status desc` sort added for deterministic
  dedup (was causing flaky counts between fetches).
- **v0.0.169** — `useRisingProblemsByCategory` introduced as the
  Rising mirror of the Stuck on-demand fetch.
- **v0.0.173** — all four "Rising surfaces" unified onto
  `olderByCategory` so the constellation override drives cell
  badge, modal header, modal pill, and canvas dots from one
  source. Killed a 4-surface discrepancy bug.
- **v0.0.174** — modal canvas `TOP_N: 10 → 50`; inner ring
  highlight kept at 10 (`MAX_TIER_PER_CAT`). Caption now reads
  "Top 50 by X · Top 10 highlighted".
