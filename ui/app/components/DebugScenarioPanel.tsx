// TEMPORARY — debug-only floating panel for previewing trend scenarios in
// the constellation view. Remove this component (and its import in App.tsx)
// when the visualization tuning phase is over.

import React, { useEffect, useRef, useState } from "react";
import { useScenario, Scenario } from "../utils/debugScenario";
import { useDevice } from "../hooks/useDevice";

interface OptionEntry { id: Scenario; label: string; hint: string; }
interface OptionSection { title: string; subtitle?: string; options: OptionEntry[]; }

const SECTIONS: OptionSection[] = [
  {
    title: "Categories",
    options: [
      { id: "real",         label: "Real",         hint: "No override · real data from the tenant" },
      { id: "quiet",        label: "Quiet",        hint: "Sparse · 4 active · tests single-leader UI" },
      { id: "all-rising",   label: "All ▲",        hint: "Every quadrant rising · tests ▲ UP badges" },
      { id: "all-falling",  label: "All ▼",        hint: "Every quadrant falling · tests ▼ DOWN seal" },
      { id: "mixed",        label: "Mixed",        hint: "Half ▲, half ▼ · asymmetric trends" },
      { id: "critical",     label: "Critical",     hint: "Severity-heavy · highlights Criticality mode" },
      { id: "long-running", label: "Long-running", hint: "Old actives (12–48 h) · highlights Open Time mode" },
      { id: "tied",         label: "Tied",         hint: "AVAIL + ERROR tied at 4 · multi-colour highlights" },
      { id: "time-cluster", label: "Cluster",      hint: "8 actives in 1 min · tests bar drill-down" },
      { id: "focused",      label: "Focused",      hint: "ERROR saturated (~200) · dense scatter + top-tier" },
      { id: "stress",       label: "Stress",       hint: "Every quadrant at +15 · heavy load" },
      { id: "xlarge",       label: "XLarge",       hint: "Enterprise scale · ~3.6 K problems · stresses everything" },
      { id: "stress-3k",    label: "Stress 3 K",   hint: "3 000 ACTIVE · ERROR + RES_CONT heavy · validates dense-cell UX" },
    ],
  },
  // Segments section retired in lockstep with `SHOW_SEGMENT_VIEW =
  // false` in Overview.tsx — the segment view is hidden from the UI,
  // so the synthetic segment catalogs in the demo panel exercise a
  // surface the user can't reach. The `seg-*` scenario IDs are kept
  // recognised in the underlying utils/debugScenario.ts switch (and
  // still work via URL deep-link) so re-enabling the view also
  // re-enables their selectors here if we add the section back.
  {
    title: "MTTA",
    subtitle: "synthetic comments stream · open /analytics → Responder velocity",
    options: [
      { id: "mtta-fast",      label: "Fast",       hint: "30 problems · 100% ack · median ~5m, p95 ~30m" },
      { id: "mtta-slow",      label: "Slow",       hint: "30 problems · 100% ack · median ~4h, p95 ~1d" },
      { id: "mtta-mixed",     label: "Mixed",      hint: "50 problems · 90% ack · realistic log-normal spread" },
      { id: "mtta-degrading", label: "Degrading",  hint: "50 problems · MTTA grows over time · burnout curve" },
      { id: "mtta-spotty",    label: "Spotty",     hint: "40 problems · 40% ack · most problems unanswered" },
    ],
  },
];

export const DebugScenarioPanel: React.FC = () => {
  const [scenario, setScenario] = useScenario();
  // Mobile / tablet (≤960px) puts the tabbar at the TOP and the
  // mobile rings strip immediately below — together they reserve
  // the upper edge of the viewport. The DEMO panel's bottom-right
  // anchor is then hard to reach (often hidden behind iOS Safari's
  // bottom safe-area bar) so on those viewports we anchor it to
  // the TOP-right instead, just under the tabbar. Desktop stays
  // bottom-right where it has always lived.
  const { isMobileOrTablet } = useDevice();
  // Collapsed by default — the panel was eating ~30 % of the screen
  // on every page load. Users open it explicitly when they need to
  // override data; keeping it minimised by default keeps the actual
  // app the focus.
  const [collapsed, setCollapsed] = useState(true);

  // Click-outside-to-collapse. The listener is only attached while
  // the panel is OPEN — keeps the cost (one document listener) off
  // the table during the 99% of session time when the panel is
  // collapsed, and avoids a needless re-render storm on every
  // mousedown in the app. Uses `mousedown` instead of `click` so
  // the panel collapses BEFORE any subsequent click handler on the
  // outside target runs, matching the standard popover dismissal
  // pattern (Radix, Strato, headlessui all do this).
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (collapsed) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) {
        setCollapsed(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [collapsed]);

  return (
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        // Desktop: bottom-right (natural footer zone for tooling).
        // Mobile/tablet: TOP-right, just under the tabbar — the
        // bottom is reserved for the iOS safe-area + the tabbar's
        // potential bottom variant, and the mobile rings strip
        // occupies the top of the content area. Anchoring to top-
        // right keeps the trigger reachable with one thumb without
        // overlapping the headline rings.
        bottom: isMobileOrTablet ? "auto" : 16,
        right: 16,
        top: isMobileOrTablet ? "calc(56px + env(safe-area-inset-top, 0px))" : "auto",
        zIndex: 9999,
        // Theme tokens — `--neo-surface-2`, `--neo-border` and
        // `--neo-text` auto-flip when `[data-theme="light"]` is set
        // on <html> (see theme.css preamble). The panel used to
        // hardcode `rgba(8,12,22,0.92)` etc. and looked obviously
        // dark on the light page.
        background: "var(--neo-surface-2)",
        border: "1px solid var(--neo-border)",
        borderRadius: 10,
        padding: collapsed ? "6px 10px" : "10px 12px 12px",
        font: '600 11px/1.2 "SF Mono","JetBrains Mono",monospace',
        color: "var(--neo-text)",
        boxShadow: "0 10px 30px rgba(0,0,0,0.32)",
        backdropFilter: "blur(8px) saturate(140%)",
        WebkitBackdropFilter: "blur(8px) saturate(140%)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: collapsed ? 0 : 8,
          cursor: "pointer",
          color: "var(--neo-text-2)",
          letterSpacing: "0.06em",
        }}
        onClick={() => setCollapsed((v) => !v)}
        title="Click to collapse/expand"
      >
        <span style={{ color: "#ff8b3e" }}>◆</span>
        {/* Renamed from "DEBUG" to "DEMO" — the panel ships in the
            bundle for live demos / scenario walk-throughs, not just
            internal debugging. The component file + the underlying
            `useScenario` API still carry the "debug" name for
            backwards compatibility with any URL / localStorage
            references; only the user-visible label changed. */}
        <span>DEMO · scenario</span>
        <span style={{ marginLeft: "auto", opacity: 0.6 }}>{collapsed ? "▸" : "▾"}</span>
      </div>

      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "70vh", overflowY: "auto" }}>
          {SECTIONS.map((sec) => (
            <div key={sec.title} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{
                display: "flex", flexDirection: "column", gap: 1,
                padding: "0 2px 2px", borderBottom: "1px solid var(--neo-border)",
                marginBottom: 2,
              }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.10em", color: "var(--neo-text-2)" }}>
                  {sec.title.toUpperCase()}
                </span>
                {sec.subtitle && (
                  <span style={{ fontSize: 9, fontWeight: 500, color: "var(--neo-text-3)" }}>
                    {sec.subtitle}
                  </span>
                )}
              </div>
              {sec.options.map((opt) => {
                const active = scenario === opt.id;
                return (
                  <button
                    key={opt.id}
                    // Picking a scenario also collapses the panel —
                    // the list was reading as "still open / still
                    // configurable" even after the user committed,
                    // which made it block ~30% of the viewport for
                    // no reason. Collapsing on commit keeps the
                    // chip footprint small until they explicitly
                    // re-open it.
                    onClick={() => { setScenario(opt.id); setCollapsed(true); }}
                    title={opt.hint}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      borderRadius: 6,
                      // Orange accent (#ff8b3e) is the panel's brand
                      // colour; it stays the same in both themes so
                      // the active state is recognisable. Inactive
                      // border uses the theme-aware token.
                      border: `1px solid ${active ? "#ff8b3e" : "var(--neo-border)"}`,
                      background: active ? "rgba(255,139,62,0.18)" : "transparent",
                      color: active ? "#ff8b3e" : "var(--neo-text)",
                      cursor: "pointer",
                      font: "inherit",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                      transition: "background 120ms, border-color 120ms, color 120ms",
                    }}
                  >
                    <span>{opt.label}</span>
                    {/* Hint text used `--neo-text-3` × 0.65 opacity which
                        reads at ~30% contrast on the white light-theme
                        background — almost invisible. Bumped to
                        `--neo-text-2` (slate-600 on light, slate-400
                        on dark) at full opacity so the hint is
                        legible in both themes without overpowering
                        the primary label. */}
                    <span style={{ fontSize: 9, fontWeight: 500, color: "var(--neo-text-2)" }}>{opt.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
