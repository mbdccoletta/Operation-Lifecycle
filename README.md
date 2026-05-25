# Operation Lifecycle

Dynatrace AppEngine application for triaging, prioritising, and
sharing Davis problems with multi-segment analytics.

Runs directly inside the Dynatrace platform, consuming data via DQL
against the `dt.davis.problems` table and auxiliary tables. Maintains
count parity with the native Davis Problems app, validated by HAR
diff against a reference tenant.

## Functional overview

The app exposes two main reading surfaces plus a set of auxiliary
analytics pages:

- **Incidents (route `/`)** — primary view. Combines:
  - Constellation: quadrant visualisation that distributes active
    problems by Davis category (Availability, Error, Slowdown,
    Resource Contention, Custom Alert, Monitoring Unavailable) or
    by segment. Each problem becomes a dot whose position and size
    reflect severity, impact, and time-open.
  - List: traditional table with filters (status, category, search,
    segment, Group by), inline row expansion that shows affected
    entities, root cause, activity, comments, and an event swimlane.
  - Constellation/List toggle preserves the URL (deep-linkable).
- **Trends (route `/trends`)** — team and tenant analytics. Includes:
  - MTTA / MTTR / MTBF / MTTF KPIs with median, p95, n, and an
    evolution curve over the selected timeframe.
  - Top root causes (entities causing the most problems).
  - Pain entities (entities most affected).
  - MTTR by category.
  - "AT A GLANCE" cards with Active problems, MTTR, Resolution
    rate, and Stuck > 4h.
- **Incident histogram** — pulse chart at the top of Incidents that
  shows the temporal distribution of Active vs Closed problems
  within the selected window, with markers for the constellation's
  top-tier (leaders).

### Filters and context

- **Timeframe Selector** (Strato) — native Dynatrace presets (Last
  30 min, 1h, 2h, Today, Yesterday, 24h, 7d) plus custom range.
  Default: Today.
- **Segment Selector** (Strato) — narrows the data to a tenant filter
  segment. Affects the list, KPIs, and the global tab badge.
- **FILTERS strip** — status chips (Active/Closed) and Davis category
  chips with per-category counts updated in the background.
- **Group by strip** — toggles row grouping by Affected entity and/or
  Root cause. Chips show a numeric badge with the nesting level
  (1 = outer, 2 = inner). URL: `?groupBy=entity,root`.
  Replaced the previous "Has metric" value filter (removed in 0.0.82
  along with the per-problem Metrics column — see commit history for
  the rationale).

### Sharing and drill-down

- Copy ID, Share link, WhatsApp share per problem.
- "Open Problem App" link opens the problem in the native Davis app.
- Chart drill-down (horizontal brush) narrows the list to the
  selected interval and disables auto-refresh.
- Click a category/entity in the analytics cards to filter the list
  by that facet.

### Comments and activity

- Strato composer (TextArea + Button) per problem, mirrored to the
  `CUSTOM_ANNOTATION` events stream that the native Davis app reads.
- Activity feed (lifecycle, comments + insights, automation +
  remediation) consolidated into three lanes, synchronised with the
  visual swimlane.

## Prerequisites

### Local environment

- **Node.js** 16.13 or newer. `dt-app` officially recommends v24;
  the build emits a warning on other versions but still works on
  v18 / v20 / v22.
- **npm** 8+ (ships with Node).
- **Git** to clone the repository.
- **SSH key** configured on GitHub if you want SSH transport (or a
  Personal Access Token / `gh` CLI for HTTPS).

### Dynatrace tenant (developer / deployer)

These are the prerequisites for the **person deploying** the app —
i.e. running `npm run deploy` from this repository.

- A tenant with **AppEngine** enabled (every current SaaS tenant
  has it).
- Tenant URL in the format `https://<tenant>.apps.dynatrace.com`
  (the `environmentUrl` field in `app.config.json`).
- Permissions equivalent to the scopes declared in
  `app.config.json` (the deployer's OAuth token must be allowed to
  hold these scopes so they can be validated against the manifest
  on upload):
  - `storage:events:read` — read `dt.davis.problems`
  - `storage:system:read` — read `dt.system.events` for Automation
    Engine workflow executions
  - `storage:entities:read` — resolve names of affected entities
    and root causes
  - `storage:buckets:read` — bucket metadata for fetch-target
    validation
  - `storage:filter-segments:read` — read filter segments for the
    Segment Selector
  - `document:documents:read` — read saved comments and segments
  - `document:documents:write` — write comments
  - `environment-api:events:write` — ingest `CUSTOM_ANNOTATION`
    events to mirror comments into the native Davis app stream
- A role that allows deploying apps to the tenant (typically
  Administrator, or a custom role with `app-engine:apps:install`).

### End-user permissions (people who USE the app after deploy)

After you deploy, **end users do NOT automatically see the app**
in their Dynatrace launcher. AppEngine apps are gated by IAM
policies, and every user (or group) who should be able to launch
Operation Lifecycle needs the right permissions assigned by a
tenant admin.

The minimum-viable policy that grants a user read-only access
(view the app, see problems, read comments, see analytics):

```
ALLOW app-engine:apps:run
  WHERE app-engine:appId = "my.problems.hub";
ALLOW storage:events:read,
      storage:system:read,
      storage:entities:read,
      storage:buckets:read,
      storage:filter-segments:read,
      document:documents:read;
```

To also let the user **post comments** (and have those comments
mirror into the native Davis Problems stream), add the write
scopes:

```
ALLOW document:documents:write,
      environment-api:events:write;
```

How to apply this in Dynatrace:

1. **Settings → Account Management → Policies** (or via Dynatrace
   IAM API). Create a new policy named e.g.
   `Operation Lifecycle — Read` and paste the read-only block
   above. Create a second `Operation Lifecycle — Comment` policy
   with the write block if you want some users to comment.
2. **Settings → Account Management → Groups**. Either create a
   new group (e.g. `Operation Lifecycle Users`) or pick an
   existing one (e.g. `SREs`, `On-call`), and **bind the policies**
   to that group on the tenant where the app is deployed.
3. **Add users to the group(s).** Users get the permissions on
   their next login (or right away if they refresh the Dynatrace
   page).

What goes wrong if a permission is missing:

| Missing scope                       | Symptom for the end user                       |
|-------------------------------------|------------------------------------------------|
| `app-engine:apps:run` (for this app)| App icon missing from launcher; direct URL 403 |
| `storage:events:read`               | Empty problem list; "No incidents found"       |
| `storage:filter-segments:read`      | Segment Selector dropdown empty                 |
| `storage:entities:read`             | Affected entities + Root cause cells show IDs instead of names |
| `document:documents:read`           | Comments section blank; activity feed missing comment events |
| `document:documents:write`          | Comment composer rejects with 403; UI shows "Davis API error" toast |
| `environment-api:events:write`      | Comments save but DON'T mirror to native Davis Problems stream |
| `storage:system:read`               | Automation tab on the per-problem detail is empty |

Read-only users (only the first block of policies above) can still
do 95 % of the triage workflow: see problems, drill down, view
metrics, share via WhatsApp / link. They just can't add comments
from inside the app.

Tenant admins typically grant the FULL set (read + write) to the
on-call / SRE group, and the read-only set to a broader audience
(developers, product managers, etc.) who consume incident data but
don't participate in triage.

### Local authentication (first time)

`dt-app` stores OAuth tokens in `.dt-app/.tokens.json` (gitignored
because it's a secret). The first time you run any command that
talks to the tenant (`dev`, `deploy`, `info`, etc.), `dt-app` opens
an OAuth flow in the browser to authenticate. After that the token
is refreshed automatically.

## Installation and local setup

```bash
git clone git@github.com:mbdccoletta/Operation-Lifecycle.git
cd Operation-Lifecycle
npm install
```

`npm install` pulls every runtime and dev dependency (React,
dt-app, Strato components, vitest, RTL, jsdom, etc.).

## Available scripts

Defined in `package.json`:

| Script              | Underlying command | When to use                                                  |
|---------------------|--------------------|--------------------------------------------------------------|
| `npm start`         | `dt-app dev`       | Local dev server with tenant proxy. HMR active.              |
| `npm run build`     | `dt-app build`     | Production build in `dist/ui/`. Doesn't publish.             |
| `npm run deploy`    | `dt-app deploy`    | Build + upload + activate on the tenant. Requires valid auth.|
| `npm run uninstall` | `dt-app uninstall` | Removes the currently installed version from the tenant.     |
| `npm run update`    | `dt-app update`    | Updates the local dt-app schema/scaffold.                    |
| `npm run info`      | `dt-app info`      | Shows the install state on the tenant.                       |
| `npm test`          | `vitest run`       | Runs the full suite (184 tests as of 0.0.84) once.           |
| `npm run test:watch`| `vitest`           | Watch mode with automatic re-run on file save.               |

## Development workflow

1. Clone and install (see "Installation and local setup" above).
2. Confirm `environmentUrl` in `app.config.json` points to your
   tenant. The repo default is the dev tenant
   `https://bwm98081.apps.dynatrace.com`; adjust if needed.
3. Run `npm start`. The first time it'll open the browser for
   OAuth. After that the dev server runs at the local URL it
   prints (typically `http://localhost:3000/`).
4. Edit files under `ui/app/`. HMR applies them in real time.
5. Run `npm test` before committing — every DQL builder, the
   timeframe parser, and the critical aggregation helpers have
   tests that act as count-regression guards.
6. Commit and push to GitHub:
   ```bash
   git add -A
   git commit -m "describe the change"
   git push
   ```

## How to deploy

### Pre-deploy checklist

Before any deploy, always:

1. **Tests green** — `npm test` must pass (184 / 184 as of 0.0.84,
   or the current number of specs). Any DQL-builder spec failure
   should be treated as a security or count regression, not as
   test noise.
2. **Type check clean** — `npx tsc --noEmit -p ui/tsconfig.json`.
   Empty output = OK.
3. **Version bumped** — increment `app.version` in
   `app.config.json` (e.g. `0.0.83` → `0.0.84`). Dynatrace rejects
   re-publishing the same version; trying to deploy without a
   bump returns `version already exists` at the end of the log.
4. **App ID intact** — `app.id` in `app.config.json` MUST be
   `my.problems.hub`. Changing the ID breaks existing deep-links
   and creates a parallel installation instead of updating the
   current one.
5. **Branch up to date** — preferably `main` with every relevant
   commit pushed to origin before deploying, so git and tenant
   stay in sync.

### Deploy command

```bash
npm run deploy
```

`dt-app deploy` runs, in order:

1. **Build** — compiles TypeScript and generates a Vite bundle in
   `dist/ui/`.
2. **Validate manifest** — checks `app.config.json` against the
   schema in `.dt-app/app.config.schema.json`.
3. **Compress artifact** — zips the bundle.
4. **Upload + activate** — uploads to the tenant and activates the
   new version. The current user sees the freshly deployed version
   in ~1 minute (bundle cache).

Expected success output:

```
Building your app
Creating bundles...
Built the app
Validating manifest
Compressing app artifact
Compressed app artifact
Deploying the app
App is deployed
Open your deployed app: 'https://<tenant>/ui/apps/my.problems.hub'
Done.
```

### Post-deploy validation

1. Open the URL printed by the deploy.
2. Confirm that the version shown in the UI corner (typically the
   Dynatrace sidebar footer) matches `app.version` in
   `app.config.json`.
3. Sanity-check counts: apply
   `Status=Closed + Category=Availability + Last 7 days` in the
   app and compare with the same combination in the native Davis
   Problems app. Numbers should match (parity validated via HAR
   diff against the reference tenant).

### Rollback

To revert to a previous version:

```bash
# 1. Restore app.config.json to the previous version
git checkout <previous-commit> -- app.config.json
# 2. Deploy
npm run deploy
```

Or, if you want to fully remove the app:

```bash
npm run uninstall
```

This command removes the current version from the tenant. The app
disappears from every user's menu until a re-deploy happens.

## Project layout

```
.
├── app.config.json            Dynatrace AppEngine manifest (id, version, scopes)
├── icon.png                   App icon (displayed in the Dynatrace menu)
├── package.json               npm dependencies + scripts
├── vitest.config.ts           Test-runner config
├── vitest.setup.ts            Global test setup (jsdom, polyfills)
├── ui/
│   ├── tsconfig.json          TypeScript config for the UI
│   ├── main.tsx               React entrypoint (renders <App/>)
│   └── app/
│       ├── App.tsx            Root: providers, router, global tab bar
│       ├── pages/             Routes
│       │   ├── Overview.tsx           Incidents view (constellation + list)
│       │   ├── TrendAnalysis.tsx      Trends page
│       │   ├── ProblemTimeline.tsx    Per-problem timeline drill-down
│       │   └── Timeline.tsx           Legacy redirector (compat with old URLs)
│       ├── components/        Reusable components
│       │   ├── ConstellationView.tsx        Quadrant canvas
│       │   ├── PulseVisualizer.tsx          Temporal histogram
│       │   ├── MobileIncidentList.tsx       Mobile list variant
│       │   ├── CategoryFilterChips.tsx      Category-chip strip
│       │   ├── ProblemActivityFeed.tsx      Comments + swimlane + events
│       │   ├── EventSwimlane.tsx            Temporal lane visualisation
│       │   ├── CommentsSection.tsx          Composer + comment list
│       │   ├── MetricFilterChip.tsx         Metric-bound filter chip (legacy; no longer used in Overview)
│       │   ├── ErrorBoundary.tsx            Global React error boundary
│       │   ├── PinnedBanners.tsx            Active-filter banners
│       │   ├── HealthRing.tsx               Health-score ring
│       │   ├── ShareWhatsApp.tsx            WhatsApp share button (mobile / desktop variants)
│       │   ├── analytics/                   Analytics cards (Trends page)
│       │   └── ...
│       ├── hooks/             React hooks
│       │   ├── useProblems.ts               useDql wrapper for the list
│       │   ├── useProblemTrend.ts           useDql for the histogram
│       │   ├── useCategoryCounts.ts         useDql for chip badges
│       │   ├── useActiveProblemsCount.ts    useDql for the global tab badge
│       │   ├── useSegmentMembership.ts      useDql + LRU cache for segments
│       │   ├── useTeamMetrics.ts            MTTA/MTTR/MTBF/MTTF aggregation
│       │   ├── useTeamMetrics.helpers.ts    Pure pair-computation helpers (unit-tested)
│       │   ├── useComments.ts               document-store wrapper
│       │   ├── useTimeRange.ts              Brush range state
│       │   ├── useUiUtils.ts                useDebounce, useDelayedLoading, etc.
│       │   ├── useDevice.ts                 Mobile / tablet / desktop detection
│       │   └── useScenario.ts               Demo scenario state
│       ├── contexts/          React contexts
│       │   ├── CategoryFilterContext.tsx    Status + category chip state
│       │   ├── TimeRangeContext.tsx         Brush range (chart drill-down)
│       │   ├── RefreshSignalContext.tsx     Global manual-refresh tick
│       │   └── ScenarioContext.tsx          Demo scenario context
│       ├── utils/             Pure helpers (React-free)
│       │   ├── dql-queries.ts               Whitelisted DQL builders
│       │   ├── timeframe.ts                 Strato Timeframe -> DQL parser
│       │   ├── filters.ts                   Client-side filter helpers
│       │   ├── formatters.ts                Duration / date formatting
│       │   ├── scoring.ts                   Ranking score helpers
│       │   ├── metricBound.ts               Metric-bound parser
│       │   ├── grouping.ts                  Category / segment group resolution
│       │   ├── dynatrace-links.ts           Deep links to native apps
│       │   ├── davis-comments.ts            CUSTOM_ANNOTATION ingestion
│       │   ├── debugScenario.ts             Synthetic scenarios (demo panel)
│       │   ├── problem-timeline-queries.ts  DQL for the timeline page
│       │   ├── analyticsKpis.ts             KPI catalogue (Trends page)
│       │   ├── logger.ts                    Structured logger
│       │   └── markdown.tsx                 Lightweight markdown renderer
│       ├── styles/
│       │   └── theme.css                    Tokens + global styles
│       └── *.test.ts/.test.tsx             Co-located vitest specs
```

Files and directories ignored (in `.gitignore`): `node_modules/`,
`dist/`, `.dt-app/`, `.claude/`, `reports/`, logs, `.env*`.

## Tests

184 vitest specs covering:

- **DQL builders** (`utils/dql-queries.test.ts`) — safety guard
  against DQL injection via the whitelist + parity invariants with
  the native app (always emits `from:`, null-tolerant `is_duplicate`
  filter, dedup before summarize, etc.).
- **Timeframe parser** (`utils/timeframe.test.ts`) — coverage of
  every Strato preset (`now()-Xunit`, `@d`, custom ISO, etc.) and
  the degenerate cases (null, undefined, missing absoluteDate).
- **Filters** (`utils/filters.test.ts`) — client-side filter
  predicates (status, category, age, stuck, has-metric — the
  predicate itself is still tested even though the UI no longer
  exposes the chip).
- **Formatters** (`utils/formatters.test.ts`) — duration, dates,
  status / category labels.
- **Metric-bound parser** (`utils/metricBound.test.ts`) — lenient
  syntax for metric bounds (`>5m`, `< 1h`, etc.).
- **useTeamMetrics helpers** (`hooks/useTeamMetrics.helpers.test.ts`)
  — MTTA/MTTR/MTBF/MTTF pair aggregations, percentiles, bucketing
  (including a real-data fixture from the bwm98081 tenant and the
  per-pair reliability identity `MTBF = MTTR + MTTF`).
- **CategoryFilterContext** — store + actions + URL sync.
- **PinnedBanners** — DOM test of the banners component.
- **dom-smoke** — render smoke test of the App.

Run:

```bash
npm test            # one shot
npm run test:watch  # watch mode
```

CI also runs these commands before any merge into `main`.

## Architecture: critical notes

### DQL construction

Every DQL against `dt.davis.problems` goes through the builders in
`utils/dql-queries.ts`:

- `buildFilteredQuery` — paginated list (Incidents page)
- `buildCategoryCountsQuery` — category chip badges
- `buildTrendQuery` — temporal histogram (Trends page)

The three share invariants:

1. **`from:` clause always present** — defensive fallback of
   `from: now() - 72h` if the caller passes invalid input. Davis
   without `from:` falls back to an implicit ~2 h window that
   silently under-counts.
2. **Null-tolerant `is_duplicate` filter** —
   `isNull(dt.davis.is_duplicate) or not(dt.davis.is_duplicate)`.
   Exactly the form the native Davis Problems app uses (validated
   by HAR diff). The strict `== false` form drops records with a
   null value and under-counts on tenants with heavy problem
   grouping.
3. **Status and category whitelists** — any value outside the
   whitelist is silently dropped before being concatenated into the
   DQL string, removing the injection surface.

Breaking any of those three contracts is treated as a count (or
security) regression, not a behaviour change.

### Timeframe parser

`utils/timeframe.ts` translates the Strato `Timeframe` object into
`{ timeframe }` or `{ from, to }` that the DQL builders consume.
Knows every Strato preset (`now()-30m`, `now()-1h`, `now()-2h`,
`@d`, `-1d@d`, `now()-24h`, `now()-7d`) plus custom ISO ranges.
Anything that doesn't match a preset falls back to 72 h, documented
in the code.

Why this matters: the previous inline parser in `Overview.tsx` only
recognised the compact form (`-7d`); Strato presets arrived with
the `now()-` prefix and silently fell into the fallback,
reproducing the "5 vs 35 closed Availability" bug that motivated
the extraction.

### Timezone behaviour

- **Display** (chart labels, list timestamps, tooltips, share
  messages) renders in the user's LOCAL timezone via `toLocaleString`
  / `getHours()` style methods. Each user sees their own clock.
- **DQL window bounds** (the `from:` / `to:` in `dt.davis.problems`
  queries) are emitted as UTC ISO timestamps. The Strato "Today"
  preset (`@d`) anchors to **UTC midnight** to match the native
  Davis Problems app — diverging from the user's local day for
  count parity. This is documented in `utils/timeframe.ts`.
- **Chart day-bucket alignment** (`floorToBucket` in
  `useTeamMetrics.helpers.ts`) anchors to LOCAL midnight for
  `bucketMs >= DAY_MS` so the bar labelled "May 18" contains
  problems that opened on May 18 in the user's clock — not a UTC
  day that crosses local midnight. Sub-day buckets stay on the UTC
  modular floor (UTC vs local cancels out for hour / 15-min slices).

### MTTx metrics (MTTA / MTTR / MTBF / MTTF)

Implemented in `useTeamMetrics.helpers.ts` and validated against
the canonical Atlassian SRE definitions
(https://www.atlassian.com/incident-management/kpis/common-metrics).

- `computeMttaPairs(problems, firstCommentByDavisId)` — MTTA =
  `firstComment − event.start`. Davis has no explicit ack
  timestamp; the first user comment is the closest proxy.
- `computeMttrPairs(problems)` — MTTR = `event.end − event.start`
  for CLOSED problems only.
- `computeMtbfPairs(problems)` — MTBF = interval between
  consecutive failure starts (`start[i] − start[i-1]`).
- `computeMttfPairs(problems)` — MTTF = uptime gap between the most
  recent CLOSED end and the next start. Satisfies the per-pair
  reliability identity `MTBF = MTTR + MTTF`.

Per-problem chip strip on the Incidents list was REMOVED in 0.0.81 —
the "M" (Mean) prefix doesn't apply to a single observation, and
MTTR per problem duplicated the existing Duration column. The
metrics keep their value in aggregate, surfaced via the Trends-page
KPI cards.

### Feature flags

- **`SHOW_SEGMENT_VIEW`** in `ui/app/pages/Overview.tsx` (module
  scope) — hides the Category/Segment toggle and the Segment
  column in the table. Currently `false`. All the segment
  infrastructure stays functional; flip to `true` to re-enable.

## Troubleshooting

### "Deploy fails with version already exists"

`app.version` in `app.config.json` still equals the version already
installed. Bump it before re-deploying.

### "Deploy fails with Invalid size: limit is 512 KB"

`icon.png` is over the AppEngine icon-size cap. Resize: target ~480
px square (PNG with transparency lands around 450–500 KB at that
resolution — well below the cap).

### "Counts don't match native Davis Problems"

1. Compare via HAR: open DevTools, capture a page load in both
   your app and the native one, export the HARs.
2. Look for queries in `query:execute` or `query/v1/`.
3. Diff the DQL string. Common differences:
   - `from:` window (Strato presets vs the compact string).
   - `is_duplicate` filter (null-tolerant vs strict vs absent).
   - Status comparison (`==` UPPERCASE vs `matchesValue` Title
     Case; `matchesValue` is case-insensitive, so functionally
     equivalent, but the presence of the filter matters).
   - `dedup display_id` before or after summarize.

### "OAuth token expired" during deploy

Delete `.dt-app/.tokens.json` and run the command again. `dt-app`
will reopen the browser for re-authentication.

### Light theme: low-contrast components

Look for hardcoded `rgba(...)` in component inline styles. Most
secondary text should use `var(--neo-text-2)` which automatically
flips between dark (`#94a3b8`) and light (`#475569`). See
`DebugScenarioPanel.tsx` and `HealthRing.tsx` for examples.

### Build warning about Node version

```
To prevent potential issues, please use dt-app with the officially
supported Node.js version 24
```

`dt-app` officially recommends v24, but works fine on v16.13+ in
practice. To silence the warning, install v24 (`nvm install 24 &&
nvm use 24`). If you actually see a runtime error, then upgrade.

### WhatsApp share — mobile body arrives empty

iOS WhatsApp's URL-scheme handler strips text around URLs when the
share intent arrives via `whatsapp://send?text=...` or
`wa.me/?text=...`. The current implementation puts the body in the
WhatsApp compose (via the URL scheme) WITHOUT the deep-link URL,
and copies the URL + tip footer to the system clipboard so the
user pastes it at the end. A modal walks the user through the
paste step before launching WhatsApp.

Web Share API (`navigator.share`) would solve this cleanly, but is
gated by the `web-share` permission policy which the AppEngine
iframe shell doesn't currently grant — calls throw
`NotAllowedError`. The code tries Web Share first anyway: if the
permission ever becomes available, the body+URL ship together
without the paste step.

## Contribution conventions

1. **Always run `npm test` before committing.** Green tests are a
   precondition for any PR.
2. **Bump the version in `app.config.json`** when the change is
   going to production. Patch (`0.0.X`) for fixes; minor (`0.X.0`)
   for new features.
3. **Don't touch `app.id`** — `my.problems.hub` is the canonical
   ID referenced by external deep-links.
4. **DQL: always go through the builders.** Never concatenate DQL
   strings directly in `useDql` calls. The builders do the
   whitelisting and uphold the parity invariants.
5. **Code comments:** write the "why", not the "what". The code
   already shows the "what". Use the long-form comments in
   `ui/app/utils/dql-queries.ts` as a style reference.
6. **Language:** all source code, comments, commit messages, and
   documentation are written in English. The repository is the
   source of truth for an international audience.
7. **Colours:** new components should use `var(--neo-*)` tokens
   instead of hardcoded hex / rgba so the light theme works.

## Reference tenant

All native-app parity work was validated against the tenant
`bwm98081.apps.dynatrace.com` (DPS, prod3). To validate against a
different tenant:

1. Change `environmentUrl` in `app.config.json`.
2. Re-authenticate (`rm .dt-app/.tokens.json`, then run any
   `dt-app` command).
3. Run the count sanity-check described in "Post-deploy
   validation".

## Licence

See `LICENSE.txt` (Apache-2.0 or as updated by the maintainer).

## Useful links

- Production app: https://bwm98081.apps.dynatrace.com/ui/apps/my.problems.hub
- Repository: https://github.com/mbdccoletta/Operation-Lifecycle
- dt-app docs: https://developer.dynatrace.com/
- Strato design system: https://developer.dynatrace.com/develop/design-system/
- DQL reference: https://docs.dynatrace.com/docs/discover-dynatrace/references/dynatrace-query-language
