# DPS consumption — Problem Lifecycle app

> Pricing reference: Dynatrace **Grail Query DPS** (unified 2024 model).
> Rule of thumb: **1 DPS ≈ 1 second of Grail compute time**, roughly
> tracking bytes scanned + aggregation overhead. List price band
> commonly quoted: **$0.05 – $0.10 per DPS** (annual commit at the
> low end; spot/PAYG at the high end). All examples use $0.075 mid.

---

## 1 · Query inventory (per user, per Overview page session)

Every entry below maps to a React hook in `ui/app/hooks/`. The "DPS / query" column is for an **xlarge tenant** (~50 k problems in the 7 d window, ~80 MB compressed scan per `fetch dt.davis.problems`).

### 1.1 — Always-on (fire on first paint)

| # | Hook | File | Window | Stale | DPS / query | Notes |
|---|---|---|---|---|---|---|
| 1 | `useProblems` | `hooks/useProblems.ts` | user-selected (default Today) | 120 s | **0.15** | Sorts by `timestamp desc \| dedup display_id` then `\| filter status` (v0.0.190). Same bytes scanned. |
| 2 | `useProblemTrend` | `hooks/useProblemTrend.ts` | same as #1 | 180 s | **0.20** | 20 bucket bins, `spread: timeframe`. |
| 3 | `useCategoryCounts` | `hooks/useCategoryCounts.ts` | same as #1 | 120 s | **0.15** | ≤ 6 rows out. |
| 4 | `useStatusCategoryCounts` | `hooks/useStatusCategoryCounts.ts` | **max(user, 1 h)** | 120 s | **0.18** | 4 derived columns (`is_stuck`, `was_active_1h_ago`, `newly_started_1h`, `is_in_user_window`) + min-1h fetch widening (v0.0.184). ≤ 16 rows out. Slight bump from 0.15 baseline. |
| 5 | `useActiveProblemsCount` | `hooks/useActiveProblemsCount.ts` | last 30 d | 120 s | **0.05** | Single `count = count()`. Drives the red Incidents tab badge. Added v0.0.123-era. |
| 6 | `useTeamMetrics` | `hooks/useTeamMetrics.ts` | last 30 d | 600 s | **0.10** | Gated when `problems.length >= 10 000`. |
| 7 | `useFilterSegments` | `hooks/useFilterSegments.ts` | n/a (SDK) | n/a | 0 | Catalog lookup, no DQL. |
| 8 | `useSegmentMembership` × ≤ 30 | `hooks/useSegmentMembership.ts` | same as #1 | 60 s LRU | **3.60** (30 × 0.12) | **GATED off** since v0.0.120 — see §5. |

### 1.2 — On user interaction (fire only when modal opens)

| # | Hook | File | Window | Stale | DPS / query | Trigger |
|---|---|---|---|---|---|---|
| 9 | `useStuckProblemsByCategory` | `hooks/useStuckProblemsByCategory.ts` | user-selected | 60 s | **0.05** | Modal open + Stuck pill selected (v0.0.142). Limit 50, single category. |
| 10 | `useRisingProblemsByCategory` | `hooks/useRisingProblemsByCategory.ts` | user-selected | 60 s | **0.05** | Modal open + Rising pill selected (v0.0.169). Limit up to 50, single category. |
| 11 | `useProblemTimeline` | `hooks/useProblemTimeline.ts` | per-problem | varies | **0.03** | Problem detail page open. ~1 DPS per page-load max. |

### 1.3 — Demo mode (v0.0.178 — `?demo=1` URL param)

When `useDemoMode().enabled === true`, **every DQL-firing hook short-circuits to `utils/demoData.ts`** and reads synthetic in-memory data. All eight always-on queries skip with `enabled: false` on `useDql`. Total DPS while demo is active: **0**.

---

## 2 · Cold-start (first paint, no caches warm)

```
DPS_cold (always-on)  = 0.15 + 0.20 + 0.15 + 0.18 + 0.05 + 0.10 + 0 + 0
                      = 0.83 DPS                    (post-gate, demo OFF)

DPS_cold (with on-demand) = 0.83 + 0.05 (Stuck OR Rising fetch on modal open)
                          ≈ 0.88 DPS                (one modal open per cold-start)

DPS_cold (demo mode)  = 0 DPS

DPS_cold (pre-gate, historical) = 4.43 DPS         (segment membership still firing)
```

The increase from v0.0.123's 0.75 to today's 0.83 is from:
- `useStatusCategoryCounts` heavier aggregation (`+0.03`): three derived columns now (was one) and the min-1h fetch widening (v0.0.184) means timeframes < 1 h scan more.
- `useActiveProblemsCount` baseline (`+0.05`): wasn't tracked in the v0.0.123 doc but had already shipped.

---

## 3 · Sustained per-user DPS / minute (after caches warm)

A query that fires every `R` minutes (refresh interval) but has `staleTime = S` seconds only refires every `max(R, S/60)` minutes. So the per-minute DPS contribution is

```
contrib_per_min = DPS_per_query / max(R, S/60)
```

Default auto-refresh is **OFF** (manual only). 1-min option was removed in v0.0.120. Shortest auto-refresh today: **5 min**.

### 3.1 — Always-on hooks

| Hook | staleTime | Refresh **5 min** | Refresh **OFF (manual ~10 min)** |
|---|---|---|---|
| useProblems | 120 s | 0.030 | 0.015 |
| useProblemTrend | 180 s | 0.040 | 0.020 |
| useCategoryCounts | 120 s | 0.030 | 0.015 |
| useStatusCategoryCounts | 120 s | 0.036 | 0.018 |
| useActiveProblemsCount | 120 s | 0.010 | 0.005 |
| useTeamMetrics | 600 s | 0.010 | 0.010 |
| useSegmentMembership (gated off) | — | 0 | 0 |
| **Subtotal — always-on** | | **0.156** | **0.083** |

### 3.2 — On-demand hooks (per modal open)

A typical triage session opens 5–10 modals over ~10 minutes. With 60 s `staleTime`, each unique (category, pill) pair fires at most once per minute.

| Hook | Cost / open | Typical bursts / hour | Per-min average |
|---|---|---|---|
| useStuckProblemsByCategory | 0.05 | ~10 | 0.008 |
| useRisingProblemsByCategory | 0.05 | ~10 | 0.008 |
| useProblemTimeline (per detail page) | 0.03 | ~5 | 0.003 |
| **Subtotal — interactive** | | | **0.019** |

### 3.3 — Combined total

| Scenario | DPS / user / min |
|---|---|
| Auto-refresh **5 min**, active triage | **~0.18** |
| Auto-refresh **OFF**, casual viewing | **~0.09** |
| Demo mode (any pattern) | **0** |

Historical pre-gate (v0.0.123 doc) was **0.14** at 5 min refresh — slight uptick from the new `useStatusCategoryCounts` columns + the new on-demand fetches paid for `Rising`/`Stuck` modal accuracy.

---

## 4 · Fleet formula — `N` simultaneous users

```
DPS_per_min      = N × Total_per_user_per_min
DPS_per_second   = DPS_per_min / 60
DPS_per_hour     = DPS_per_min × 60
DPS_per_day      = DPS_per_hour × hours_active_per_day        # 8 h typical
DPS_per_month    = DPS_per_day × working_days                 # 22 typical
DPS_cold_spike   = N × DPS_cold                               # 1 st second of mass-login
$ / month        = DPS_per_month × $/DPS                      # $0.05–$0.10 band
```

---

## 5 · Worked example — `N = 1 000`, xlarge tenant, 8 h × 22 d/month

### 5.1 — Today's baseline (v0.0.196)

| Scenario | DPS/min | DPS/s | DPS/h | DPS/day | DPS/month | Cost @ $0.075 |
|---|---|---|---|---|---|---|
| Auto-refresh **5 min**, active triage | 180 | 3.0 | 10 800 | 86 400 | **~1.90 M** | **~$143 K/mo** |
| Auto-refresh **15 min** | 60 | 1.0 | 3 600 | 28 800 | **~634 K** | **~$48 K/mo** |
| Auto-refresh **OFF** (manual, ~10 min avg) | 90 | 1.5 | 5 400 | 43 200 | **~950 K** | **~$71 K/mo** |
| Cold-start spike (all 1 000 open at once) | — | **830** for 1 s | — | — | — | (one-off) |

Diff vs v0.0.123 doc baseline:
- 5-min refresh: ~1.48 M → ~1.90 M  (+28 % from new on-demand fetches + heavier counts)
- Manual: ~792 K → ~950 K  (+20 %)

### 5.2 — Demo-only fleet (zero-DPS scenario)

If the entire `N = 1 000` fleet runs with `?demo=1` (training, demos, recorded walkthroughs), every query short-circuits to `demoData.ts`. **DPS = 0 across all scenarios.**

---

## 6 · Optimisations applied (cumulative)

| Version | Change | Saving |
|---|---|---|
| **v0.0.120** | Gate `useSegmentMembership` behind `SHOW_SEGMENT_VIEW = false`. The hook was firing up to 30 parallel DQL queries per refresh cycle for side-features (Segments column drilldown, Top Segments card) that the UI no longer surfaces. | **−83 %** of per-user budget |
| **v0.0.120** | Removed the 30-second and 1-minute auto-refresh options. New minimum is 5 minutes; the manual `↻` button bypasses cache for "I need fresh NOW". | **−80 %** vs 1 min, **−50 %** vs 30 s |
| **v0.0.121** | Removed Segments column from incident list (depended on the gated data anyway). | UI cleanup; no DPS impact (already gated) |
| **v0.0.122** | Removed Top Segments section from Trends page (same rationale). | UI cleanup |
| **v0.0.142** | `useStuckProblemsByCategory` introduced — focused fetch fires only when the modal is open AND the Stuck pill is selected. Pays ~0.05 DPS per user interaction instead of widening every refresh. | Cost-shifting (not strict saving): bytes paid per interaction, not per refresh |
| **v0.0.169** | `useRisingProblemsByCategory` introduced — same pattern as v0.0.142 but for the Rising pill. | Same: per-interaction |
| **v0.0.178** | Demo mode (`?demo=1`) bypasses all DQL → zero DPS while active. | **−100 %** during demo sessions |
| **v0.0.184** | `buildStatusCategoryCountsQuery` widens fetch to `max(user_tf, 1 h)` so the 1 h baseline is always complete. Slight cost bump for user timeframes < 1 h. | Cost: ≤ +5 % on short timeframes; nothing on ≥ 1 h |

---

## 7 · Caps already in place that bound worst-case cost

| Cap | Value | Source | Effect |
|---|---|---|---|
| `HARD_CEILING` | 10 000 problems | `useProblems.ts` | DQL `\| limit` ceiling — server-side. |
| `DEFAULT_INITIAL` | 250 problems | `useProblems.ts` | First-paint cap; user must click "Load more" to expand. |
| `TEAM_METRICS_CAP` | 10 000 problems | `useTeamMetrics.ts` | Hook returns empty KPIs above this — short-circuits the 30-d comments scan. |
| `MAX_RENDER_ROWS` | 1 000 rows | `Overview.tsx` | List DOM cap (rendering perf, not DPS). |
| `useProblemTimeline.enabled` gate | gates on detail-page mount | `Overview.tsx` | Timeline DQL only fires when a problem is expanded. |
| `useStuckProblemsByCategory` gate | `currentMode === "open_time" && stuck > 0` | `EnlargedQuadrantCard.tsx` | Fires only on modal open with Stuck pill selected. |
| `useRisingProblemsByCategory` gate | `currentMode === "rising" && newlyStarted > 0` | `EnlargedQuadrantCard.tsx` | Fires only on modal open with Rising pill selected. |
| `useDemoMode.enabled` gate | `?demo=1` URL param | every DQL hook | All DQL queries short-circuit when in demo. |
| `pageVisible` refetch gate | n/a | `Overview.tsx` | `setInterval` pauses when tab is hidden. |
| Built-in SDK Grail cache | 60 s | `@dynatrace-sdk/client-query` | Identical-query dedup window before our `staleTime` check. |

---

## 8 · Mobile cold-start (post-gate, on 3G/4G)

The DPS is the same as desktop (same hooks fire). The concern is **payload bytes** over the link:

| Source | Payload (uncompressed JSON) |
|---|---|
| useProblems (limit 250, full field projection) | ~600 KB |
| useProblemTrend (timeseries) | ~50 KB |
| useCategoryCounts (≤ 6 rows) | ~1 KB |
| useStatusCategoryCounts (≤ 16 rows, 4 columns) | ~3 KB |
| useActiveProblemsCount (1 row) | ~0.1 KB |
| useTeamMetrics (≤ 10 k comments) | ~1 MB worst-case |
| useFilterSegments (catalog) | ~30 KB |
| **Total cold-start payload** | **~1.7 MB** (post-gate) |

On 4G LTE (~30 Mbps): < 0.5 s. On 3G (~3 Mbps): ~5 s — perceptible but acceptable.

Further reductions available as follow-ups (not yet applied):

- **Field projection** on `useProblems` — explicit `| fields` already in place (v0.0.27); some unused columns (`affected_entity_types`, `management_zones`) still ride along.
- **Smaller mobile first-paint cap** — 250 → 50 rows.
- **Gate `useProblemTrend` on mobile** — chart not rendered on mobile.
- **Lazy-load `useTeamMetrics`** behind IntersectionObserver — fire only when metric chips scroll into view.

---

## 9 · Quick recompute when premises change

```
DPS_per_query     ∝ bytes_scanned ∝ records_in_window
records_in_window ∝ tenant_problem_rate × time_window

If tenant size halves         → DPS scales × 0.5
If timeframe doubles (7d→14d) → DPS scales × 2 (linear)
If user count halves          → cost scales × 0.5
If refresh interval doubles   → cost scales × ~0.5 (modulo staleTime floors)
If users run with ?demo=1     → that user's DPS = 0
```

The leverage points are (in order of impact):

1. **Refresh interval** — direct multiplier (50 % easy win).
2. **User count** — direct multiplier.
3. **Timeframe** — direct multiplier on bytes scanned.
4. **Demo mode for training fleets** — −100 % per demo user.
5. **Field projection** — ~50 % one-time payload + scan reduction.
6. **Tenant size** — fixed for any given customer.

---

*Last updated: v0.0.196 — comet animation universal, leader/falling seals server-side, modal decomposition line, list dedup by record timestamp.*
