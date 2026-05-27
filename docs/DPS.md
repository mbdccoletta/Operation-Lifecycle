# DPS consumption — Problem Lifecycle app

> Pricing reference: Dynatrace **Grail Query DPS** (unified 2024 model).
> Rule of thumb: **1 DPS ≈ 1 second of Grail compute time**, roughly
> tracking bytes scanned + aggregation overhead. List price band
> commonly quoted: **$0.05 – $0.10 per DPS** (annual commit at the
> low end; spot/PAYG at the high end). All examples use $0.075 mid.

---

## 1 · Query inventory (per user, per Overview page session)

Every entry below maps to a React hook in `ui/app/hooks/`. The "DPS / query" column is for an **xlarge tenant** (~50k problems in the 7d window, ~80 MB compressed scan per `fetch dt.davis.problems`).

| # | Hook | File | Window | Stale | DPS / query | Gated by |
|---|---|---|---|---|---|---|
| 1 | `useProblems` | `hooks/useProblems.ts` | user-selected (default Today) | 120 s | **0.15** | always |
| 2 | `useProblemTrend` | `hooks/useProblemTrend.ts` | same as #1 | 180 s | **0.20** | always |
| 3 | `useCategoryCounts` | `hooks/useCategoryCounts.ts` | same as #1 | 120 s | **0.15** | always |
| 4 | `useStatusCategoryCounts` | `hooks/useStatusCategoryCounts.ts` | same as #1 | 120 s | **0.15** | always |
| 5 | `useTeamMetrics` | `hooks/useTeamMetrics.ts` | last 30 d | 600 s | **0.10** | disabled if `problems.length >= 10 000` |
| 6 | `useFilterSegments` | `hooks/useFilterSegments.ts` | n/a (SDK) | n/a | 0 | always |
| 7 | `useSegmentMembership` × ≤ 30 | `hooks/useSegmentMembership.ts` | same as #1 | 60 s LRU | **3.60** (30 × 0.12) | **GATED off** in v0.0.120 (see §5) |

**Total cold-start (no caches warm)**
```
DPS_cold = Σ(per-query DPS) = 0.15 + 0.20 + 0.15 + 0.15 + 0.10 + 3.60
         = 4.35 DPS         (pre-gate)
         = 0.75 DPS         (post-gate, useSegmentMembership = 0)
```

---

## 2 · Sustained per-user DPS / minute (after caches warm)

A query that fires every `R` minutes (refresh interval) but has `staleTime = S` seconds only refires every `max(R, S/60)` minutes. So the per-minute DPS contribution is

```
contrib_per_min = DPS_per_query / max(R, S/60)
```

Below, "Total / user / min" is the sum across all active hooks for a given refresh interval. Default auto-refresh is **OFF** (manual only); the 1-min option was removed in v0.0.120 so the shortest auto-refresh today is **5 min**.

| Hook | staleTime | Refresh **1 min** ⚠️ | Refresh **5 min** | Refresh **OFF (manual ~10 min)** |
|---|---|---|---|---|
| useProblems | 120 s | 0.075 | 0.030 | 0.015 |
| useProblemTrend | 180 s | 0.067 | 0.040 | 0.020 |
| useCategoryCounts | 120 s | 0.075 | 0.030 | 0.015 |
| useStatusCategoryCounts | 120 s | 0.075 | 0.030 | 0.015 |
| useTeamMetrics | 600 s | 0.010 | 0.010 | 0.010 |
| useSegmentMembership (pre-gate) | 60 s | 3.60 | 0.72 | 0.36 |
| useSegmentMembership (post-gate) | n/a | **0** | **0** | **0** |
| **Total — pre-gate** | | **3.90** | **0.86** | **0.43** |
| **Total — post-gate** | | n/a (option removed) | **0.14** | **0.075** |

⚠️ The "1 min refresh" column is documentation-only — that option was **removed** from the UI in v0.0.120 because the cost was prohibitive at scale.

---

## 3 · Fleet formula — `N` simultaneous users

```
DPS_per_min      = N × Total_per_user_per_min
DPS_per_second   = DPS_per_min / 60
DPS_per_hour     = DPS_per_min × 60
DPS_per_day      = DPS_per_hour × hours_active_per_day        # 8 h typical
DPS_per_month    = DPS_per_day × working_days                 # 22 typical
DPS_cold_spike   = N × DPS_cold                               # 1st second of mass-login
$ / month        = DPS_per_month × $/DPS                      # $0.05–$0.10 band
```

---

## 4 · Worked example — `N = 1000`, xlarge tenant, 8 h × 22 d/month

### Post-gate (v0.0.120 baseline)

| Scenario | DPS/min | DPS/s | DPS/h | DPS/day | DPS/month | Cost @ $0.075 |
|---|---|---|---|---|---|---|
| Auto-refresh **5 min** | 140 | 2.3 | 8 400 | 67 200 | **~1.48 M** | **~$111 K/mo** |
| Auto-refresh **15 min** | 47 | 0.8 | 2 800 | 22 400 | **~493 K** | **~$37 K/mo** |
| Auto-refresh **OFF** (manual, ~10 min avg) | 75 | 1.25 | 4 500 | 36 000 | **~792 K** | **~$59 K/mo** |
| Cold-start spike (all 1 000 open at once) | — | **750** for 1 s | — | — | — | (one-off) |

### Pre-gate (historical, for context)

| Scenario | DPS/month | Cost @ $0.075 |
|---|---|---|
| 1 min refresh (removed) | ~41 M | ~$3 M/mo ⚠️ |
| 5 min refresh | ~9.1 M | ~$680 K/mo |

---

## 5 · Optimisations applied (cumulative)

| Version | Change | Saving |
|---|---|---|
| **v0.0.120** | Gate `useSegmentMembership` behind `SHOW_SEGMENT_VIEW = false`. The hook was firing up to 30 parallel DQL queries per refresh cycle for side-features (Segments column drilldown, Top Segments card) that the UI no longer surfaces. | **-83 %** of per-user budget |
| **v0.0.120** | Removed the 30-second and 1-minute auto-refresh options. New minimum is 5 minutes; the manual `↻` button bypasses cache for "I need fresh NOW". | **-80 %** vs 1 min, **-50 %** vs 30 s |
| **v0.0.121** | Removed Segments column from incident list (depended on the gated data anyway). | UI cleanup; no DPS impact (already gated) |
| **v0.0.122** | Removed Top Segments section from Trends page (same rationale). | UI cleanup |

---

## 6 · Caps already in place that bound worst-case cost

| Cap | Value | Source | Effect |
|---|---|---|---|
| `HARD_CEILING` | 10 000 problems | `useProblems.ts` | DQL `\| limit` ceiling — server-side. |
| `DEFAULT_INITIAL` | 250 problems | `useProblems.ts` | First-paint cap; user must click "Load more" to expand. |
| `TEAM_METRICS_CAP` | 10 000 problems | `useTeamMetrics.ts` | Hook returns empty KPIs above this — short-circuits the 30-d comments scan. |
| `MAX_RENDER_ROWS` | 1 000 rows | `Overview.tsx` | List DOM cap (rendering perf, not DPS). |
| `pageVisible` refetch gate | n/a | `Overview.tsx` | `setInterval` pauses when tab is hidden. |
| Built-in SDK Grail cache | 60 s | `@dynatrace-sdk/client-query` | Identical-query dedup window before our `staleTime` check. |

---

## 7 · Mobile cold-start (post-gate, on 3G/4G)

The DPS is the same as desktop (same hooks fire). The concern is **payload bytes** over the link:

| Source | Payload (uncompressed JSON) |
|---|---|
| useProblems (limit 250, ~10 fields) | ~600 KB |
| useProblemTrend (timeseries) | ~50 KB |
| useCategoryCounts (≤ 6 rows) | ~1 KB |
| useStatusCategoryCounts (≤ 12 rows) | ~2 KB |
| useTeamMetrics (≤ 10k comments) | ~1 MB worst-case |
| useFilterSegments (catalog) | ~30 KB |
| **Total cold-start payload** | **~1.7 MB** (post-gate) |

On 4G LTE (~30 Mbps): < 0.5 s. On 3G (~3 Mbps): ~5 s — perceptible but acceptable.

Further reductions available as follow-ups (not yet applied):

- **Field projection** on `useProblems` — explicit `| fields` to drop unused columns. Cuts payload ~50 %.
- **Smaller mobile first-paint cap** — 250 → 50 rows.
- **Gate `useProblemTrend` on mobile** — chart not rendered on mobile.
- **Lazy-load `useTeamMetrics`** behind IntersectionObserver — fire only when metric chips scroll into view.

---

## 8 · Quick recompute when premises change

```
DPS_per_query     ∝ bytes_scanned ∝ records_in_window
records_in_window ∝ tenant_problem_rate × time_window

If tenant size halves         → DPS scales × 0.5
If timeframe doubles (7d→14d) → DPS scales × 2 (linear)
If user count halves          → cost scales × 0.5
If refresh interval doubles   → cost scales × ~0.5 (modulo staleTime floors)
```

The leverage points are (in order of impact):

1. **Refresh interval** — direct multiplier (50 % easy win).
2. **User count** — direct multiplier.
3. **Timeframe** — direct multiplier on bytes scanned.
4. **Field projection** — ~50 % one-time payload + scan reduction.
5. **Tenant size** — fixed for any given customer.

---

*Last updated: v0.0.123 — Group-by chips (Rising / Stuck / Total) added to list view.*
