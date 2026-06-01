import React, { Suspense, lazy } from "react";
import { Route, Routes, NavLink, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useCurrentTheme } from "@dynatrace/strato-components/core";
import { SegmentsProvider } from "@dynatrace/strato-components-preview/filters";
import { ProgressCircle } from "@dynatrace/strato-components/content";
import {
  AnalyticsIcon,
} from "@dynatrace/strato-icons";
import { ErrorBoundary, installGlobalErrorHandlers } from "./components/ErrorBoundary";
import { HubBackdropDebugPanel } from "./components/HubBackdropDebugPanel";

// One-time install — runs at module load, before any React tree
// mounts. Captures async / event-handler errors that React's own
// boundary mechanism would otherwise miss. Idempotent.
installGlobalErrorHandlers();
import { TimeRangeProvider } from "./hooks/useTimeRange";
import { CategoryFilterProvider } from "./contexts/CategoryFilterContext";
import { RefreshSignalProvider } from "./contexts/RefreshSignalContext";
import { IntensityProvider } from "./contexts/IntensityContext";
import { DemoModeProvider } from "./contexts/DemoModeContext";
// DisplaySettingsPanel is rendered inline by each page's header
// (Overview, TrendAnalysis) — no longer a global floating widget.
import { useActiveProblemsCount } from "./hooks/useActiveProblemsCount";
import "./styles/theme.css";

// Code-split page bundles — Dynatrace recommends route-based splitting
// to keep main.js under 1 MB. Each route loads its own chunk on demand
// so visitors who never open /analytics never download its bundle.
// See https://developer.dynatrace.com/guides/code-splitting/
const Overview        = lazy(() => import("./pages/Overview").then((m) => ({ default: m.Overview })));
const TrendAnalysis   = lazy(() => import("./pages/TrendAnalysis").then((m) => ({ default: m.TrendAnalysis })));
// ProblemTimeline page retired in A3 — see RedirectTimeline below.

/** Backwards-compatible redirect — the standalone `/detail/:id` triage
 *  page is gone (everything is now inline in the list). Old links keep
 *  working by being rewritten to `/?focus=<id>`, which the Incidents
 *  page reads to expand + scroll to that problem. */
const RedirectToFocus = () => {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/?focus=${id}` : "/"} replace />;
};

/** Backwards-compatible redirect for the retired `/timeline` route
 *  (A3 of the UX consolidation). Any deeplink that carried `?id=<X>`
 *  is rewritten to `/?focus=<X>` so the user lands on the same
 *  problem expanded inline in the unified list. Plain `/timeline`
 *  without a query just goes to `/`. */
const RedirectTimeline = () => {
  const [params] = useSearchParams();
  const id = params.get("id");
  return <Navigate to={id ? `/?focus=${id}` : "/"} replace />;
};

const AppContent = () => {
  // `useCurrentTheme` is the canonical Strato hook (returns
  // "light" | "dark" — never undefined per its type contract).
  // We re-publish it via `data-theme` on this wrapper so the
  // `[data-theme="light"]` CSS overrides in `theme.css` resolve
  // correctly even when the host AppEngine shell hasn't yet
  // injected the attribute on `<html>` (notably in the local
  // dev server). The Strato design tokens (`--dt-*`) flip based
  // on this same attribute, so a single source-of-truth covers
  // the whole stylesheet.
  const theme = useCurrentTheme();
  // Global "active problems" counter — drives the red badge on the
  // Incidents tab, mirroring the badge Dynatrace shows next to
  // "Problems" in its own platform menu. Polls every 60s through
  // its own lightweight count-only DQL query (see hook for cost).
  const { count: activeCount } = useActiveProblemsCount();
  // Cap at 999+ to keep the badge a stable width regardless of how
  // busy the tenant is. Anything ≥ 1000 just reads "999+". User
  // 0.0.182 — bumped from 99+ → 999+ so 3-digit counts (typical on
  // busy tenants) show their actual value instead of always
  // reading "99+".
  const badgeLabel = activeCount > 999 ? "999+" : String(activeCount);

  return (
    <div data-theme={theme} style={{ minHeight: "100vh" }}>
      {/* 0.0.253 — Hub backdrop debug panel. Mounts globally
          so it floats above every page. Renders nothing unless
          the URL carries `?hubDebug=1`, so end-users never see
          it. */}
      <HubBackdropDebugPanel />
      {/* Inner wrapper around the routed pages exists ONLY so the
          `[data-intensity="medium|bold"]` saturate filter (see
          theme.css `@ around line 168`) can be scoped to the page
          content — NOT the fixed-position `.neo-tabbar` that
          renders as a sibling below.
          Why this matters: CSS `filter` on an ancestor creates a
          new STACKING CONTEXT, which turns descendant `position:
          fixed` into effectively `position: absolute` relative to
          that ancestor. The tabbar then pins to the BOTTOM of the
          filtered element (which extends below the viewport when
          page content scrolls) instead of the viewport, making it
          disappear off-screen in medium/bold mode. Keeping the
          filter on `.neo-app-routes` only — never on `[data-theme]`
          or anything containing the tabbar — preserves the
          viewport-relative fixed positioning. */}
      <div className="neo-app-routes">
      <Suspense
        fallback={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "70vh" }}>
            <ProgressCircle aria-label="Loading Problem Lifecycle…" />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Overview groupBy="category" />} />
          <Route path="/segments" element={<Overview groupBy="segment" />} />
          {/* Canonical route is `/trends` after the F4 rename — the
              page is primarily the time-series team-performance
              chart, with secondary rankings as context. `/analytics`
              is kept as an alias so deep links / Slack shares from
              before the rename keep resolving. */}
          <Route path="/trends" element={<TrendAnalysis />} />
          <Route path="/analytics" element={<TrendAnalysis />} />
          {/* `/timeline` retired in A3 of the UX consolidation —
              the page's content was split: TeamMetricsCard moved to
              the Trends page (formerly Analytics), the per-problem
              rich activity feed (CommentsSection + EventSwimlane +
              activity stream) moved into the Incidents row expand
              via `<ProblemActivityFeed>`. Deeplinks `?id=X` redirect
              to `/?focus=X` so old Slack/email shares keep working. */}
          <Route path="/timeline" element={<RedirectTimeline />} />
          <Route path="/detail/:id" element={<RedirectToFocus />} />
        </Routes>
      </Suspense>
      </div>

      {/* Tab icons sourced from the Strato icon set so they match
          the visual language of the rest of the Dynatrace platform.
          Current mapping:
            • Incidents → no icon (lightning bolt EpicIcon was read
                          as decorative emoji noise — the label
                          itself + accent colour on the active tab
                          carry the affordance)
            • Trends    → AnalyticsIcon */}
      <nav className="neo-tabbar">
        <NavLink
          to="/"
          className={({ isActive }) => `neo-tab${isActive ? " neo-tab-active" : ""}`}
          end
          // When there are active problems, expose the count to screen
          // readers via aria-label since the visual badge sits inside
          // an aria-hidden wrapper (icon decoration).
          aria-label={activeCount > 0 ? `Incidents — ${activeCount} active` : undefined}
        >
          {/* Icon-less variant: the badge anchors to the label span
              instead of an icon wrapper. The label span has
              `position: relative` so the absolute-positioned badge
              sits at its top-right corner just like it did over the
              old EpicIcon. */}
          <span className="neo-tab-label-anchor">
            <span>Incidents</span>
            {/* Red count badge — only rendered when there's at least one
                ACTIVE problem so the label doesn't ship a stray "0" pill. */}
            {activeCount > 0 && (
              <span className="neo-tab-badge" aria-hidden="true">{badgeLabel}</span>
            )}
          </span>
        </NavLink>
        {/* "Segments" tab retired in F2 of the UX consolidation —
            segment grouping now lives inside Incidents as the
            "View by: Segment" toggle in the page header. The
            `/segments` route is intentionally kept registered in
            <Routes> so any deeplink (Slack messages, bookmarks,
            old WhatsApp shares) still resolves; only the bottom-nav
            chip disappears. */}
        <NavLink to="/trends" className={({ isActive }) => `neo-tab${isActive ? " neo-tab-active" : ""}`}>
          <span className="neo-tab-icon" aria-hidden="true"><AnalyticsIcon size={18} /></span>
          <span>Trends</span>
        </NavLink>
        {/* "Timeline" tab retired in A3 of the UX consolidation —
            tenant-wide TeamMetricsCard moved to Analytics, the
            per-problem activity feed (Comments + Swimlane + events)
            moved into the Incidents row expand. The `/timeline`
            route stays registered (redirects to `/?focus=<id>`)
            so old deeplinks resolve. */}
      </nav>

      {/* DisplaySettingsPanel moved out of App.tsx — it's now
          rendered INLINE inside each page header next to the
          SegmentSelector (Overview, TrendAnalysis). The pages
          import and render `<DisplaySettingsPanel inline />`
          themselves. */}
    </div>
  );
};

export const App = () => {
  return (
    <ErrorBoundary>
      <DemoModeProvider>
        <IntensityProvider>
          <SegmentsProvider>
            <TimeRangeProvider>
              <CategoryFilterProvider>
                <RefreshSignalProvider>
                  <AppContent />
                </RefreshSignalProvider>
              </CategoryFilterProvider>
            </TimeRangeProvider>
          </SegmentsProvider>
        </IntensityProvider>
      </DemoModeProvider>
    </ErrorBoundary>
  );
};
