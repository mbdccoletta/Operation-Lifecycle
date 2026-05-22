// PreviewShell — the chrome around the pilot of the proposed 2-tab
// information architecture (Live + Trends). Designed to live next to
// the current app so the user can A/B test the new IA without losing
// anything that already works.
//
// Why it's a wrapper instead of a feature flag inside the existing
// shell: this keeps the blast radius nil. None of the current routes
// or components change — the pilot mounts fresh under /preview and
// composes the existing pages/components in a new layout.
//
// Entry: the floating "🧪 Preview new layout" button in App.tsx
// brings the user here. Exit: the banner at the top of every pilot
// page links back to "/".
import React from "react";
import { NavLink, Outlet, Link } from "react-router-dom";
import { EpicIcon, AnalyticsIcon } from "@dynatrace/strato-icons";
import { useActiveProblemsCount } from "../../hooks/useActiveProblemsCount";

export const PreviewShell = () => {
  const { count: activeCount } = useActiveProblemsCount();
  const badgeLabel = activeCount > 99 ? "99+" : String(activeCount);

  return (
    <div className="neo-preview-shell">
      {/* Sticky banner — always visible, makes it obvious the user
          is in pilot mode and gives a one-click exit. Kept slim so
          it doesn't eat mobile viewport. */}
      <div className="neo-preview-banner" role="status" aria-live="polite">
        <span className="neo-preview-banner-tag" aria-hidden="true">PREVIEW</span>
        <span className="neo-preview-banner-msg">
          New 2-tab layout — Segments became a filter, Timeline merged into Live, Analytics renamed to Trends.
        </span>
        <Link to="/" className="neo-preview-banner-exit" aria-label="Exit preview and return to current app">
          ← Exit preview
        </Link>
      </div>

      <Outlet />

      {/* Pilot bottom-nav — only 2 tabs. The point of the pilot is
          to validate that two tabs (Live / Trends) cover everything
          the current four tabs do. */}
      <nav className="neo-tabbar neo-tabbar-preview">
        <NavLink
          to="/preview/live"
          className={({ isActive }) => `neo-tab${isActive ? " neo-tab-active" : ""}`}
          aria-label={activeCount > 0 ? `Live — ${activeCount} active` : "Live"}
        >
          <span className="neo-tab-icon" aria-hidden="true">
            <EpicIcon size={18} />
            {activeCount > 0 && <span className="neo-tab-badge">{badgeLabel}</span>}
          </span>
          <span>Live</span>
        </NavLink>
        <NavLink
          to="/preview/trends"
          className={({ isActive }) => `neo-tab${isActive ? " neo-tab-active" : ""}`}
        >
          <span className="neo-tab-icon" aria-hidden="true"><AnalyticsIcon size={18} /></span>
          <span>Trends</span>
        </NavLink>
      </nav>
    </div>
  );
};
