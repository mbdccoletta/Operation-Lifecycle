// Floating display-settings panel — globally rendered alongside the
// app routes so the user can dial intensity / font size from ANY
// page (Incidents, Trends, etc) without having to navigate back to
// a settings screen. Collapsed by default to a compact chip;
// clicking it opens a JS-positioned popover beneath the chip.
//
// 0.0.245 — Removed the Strato Modal mobile path. User feedback:
// the modal opened in the centre of the screen, breaking the
// expectation set by TimeframeSelector / SegmentSelector (which
// drop dropdowns under their chip) and carried a heavy shadow
// that "parece estar flutuando". The popover is now JS-positioned
// against the trigger chip's bounding rect with a 16 px viewport
// gutter — same pattern the MetricChip popover uses (see
// `.neo-metric-popover` in v0.0.221). No shadow, plain border,
// drops directly under the chip on every viewport.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useIntensity, type FontScale, type Intensity } from "../contexts/IntensityContext";

// Two user-facing controls:
//   • Font size (small / normal / large) — scales every text
//     element + canvas-rendered text in lockstep.
//   • Contrast (normal / high) — toggles a global filter that
//     boosts saturation + contrast for low-contrast monitors or
//     accessibility needs. Maps to the `intensity` field in
//     IntensityContext (the legacy "subtle" value is no longer
//     surfaced from this panel).

const FONTSCALES: { id: FontScale; label: string; hint: string }[] = [
  { id: "small",  label: "Small",  hint: "0.92× — denser layout" },
  { id: "normal", label: "Normal", hint: "1.00× — default" },
  { id: "large",  label: "Large",  hint: "1.12× — easier to read" },
];

// "subtle" stays in the Intensity type for backwards-compat with
// any old localStorage entries but the UI never sets it.
const CONTRASTS: { id: Intensity; label: string; hint: string }[] = [
  { id: "normal", label: "Normal", hint: "Default colour intensity" },
  { id: "medium", label: "Medium", hint: "Slight bump in saturation + contrast" },
  { id: "bold",   label: "High",   hint: "Strong boost in saturation + contrast" },
];

interface DisplaySettingsPanelProps {
  /** When true, the panel renders as a normal inline chip
   *  (no `position: fixed`) so it can be placed inside a page
   *  header next to other controls. Default keeps the floating
   *  bottom-/top-right behaviour for callers that need a global
   *  overlay. */
  inline?: boolean;
}

export const DisplaySettingsPanel: React.FC<DisplaySettingsPanelProps> = ({ inline = false }) => {
  const { fontScale, setFontScale, intensity, setIntensity } = useIntensity();
  // Map the stored `intensity` value to one of the 3 picker
  // options. "subtle" (legacy, no longer exposed) folds into
  // "normal" so old localStorage entries don't leave users with
  // no button highlighted.
  const contrastActive: Intensity =
    intensity === "bold" ? "bold" :
    intensity === "medium" ? "medium" :
    "normal";
  const [collapsed, setCollapsed] = useState(true);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popPos, setPopPos] = useState<{ left: number; top: number; maxWidth: number } | null>(null);

  // Click outside → collapse. Tracks BOTH the trigger and the
  // popover; clicking inside either keeps the panel open.
  useEffect(() => {
    if (collapsed) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      const insideTrigger = !!(triggerRef.current && t && triggerRef.current.contains(t));
      const insidePopover = !!(popoverRef.current && t && popoverRef.current.contains(t));
      if (!insideTrigger && !insidePopover) setCollapsed(true);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [collapsed]);

  // Measure the trigger rect to position the popover. Re-measures
  // on resize + scroll so the popover follows the chip if the
  // page layout shifts. Uses position: fixed so the popover stays
  // anchored even when the trigger is inside an overflow-clipped
  // ancestor.
  useLayoutEffect(() => {
    if (collapsed) { setPopPos(null); return; }
    const compute = () => {
      const trig = triggerRef.current;
      if (!trig) return;
      const r = trig.getBoundingClientRect();
      const GUTTER = 16; // px from viewport edge
      const vw = window.innerWidth;
      const POPOVER_W = 280;
      // Anchor left edge of popover to the chip's left, clamped
      // so the right edge stays inside the viewport.
      let left = r.left;
      const maxLeft = vw - GUTTER - POPOVER_W;
      if (left > maxLeft) left = maxLeft;
      if (left < GUTTER) left = GUTTER;
      const maxWidth = Math.min(POPOVER_W, vw - 2 * GUTTER);
      const top = r.bottom + 4;
      setPopPos({ left, top, maxWidth });
    };
    compute();
    const onChange = () => compute();
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange, true);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange, true);
    };
  }, [collapsed]);

  // Body content (Contrast + Font size sections). Plain JSX so
  // the inline expansion and the popover share the same markup.
  const body = (
    <>
      <section className="neo-display-panel-section">
        <div className="neo-display-panel-section-title">Contrast</div>
        <div className="neo-display-panel-section-hint">
          Pump up colour intensity across the app
        </div>
        <div className="neo-display-panel-buttons" role="group" aria-label="Contrast">
          {CONTRASTS.map((opt) => {
            const active = contrastActive === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`neo-display-panel-btn${active ? " neo-display-panel-btn-active" : ""}`}
                onClick={() => setIntensity(opt.id)}
                title={opt.hint}
                aria-pressed={active}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>
      <section className="neo-display-panel-section">
        <div className="neo-display-panel-section-title">Font size</div>
        <div className="neo-display-panel-section-hint">
          Scales every element (text, padding, icons) in lockstep
        </div>
        <div className="neo-display-panel-buttons" role="group" aria-label="Font size">
          {FONTSCALES.map((opt) => {
            const active = fontScale === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                className={`neo-display-panel-btn${active ? " neo-display-panel-btn-active" : ""}`}
                onClick={() => setFontScale(opt.id)}
                title={opt.hint}
                aria-pressed={active}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>
    </>
  );

  return (
    <div
      className={`neo-display-panel${inline ? " neo-display-panel-inline" : ""}`}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <button
        ref={triggerRef}
        type="button"
        className="neo-display-panel-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Open display settings" : "Close display settings"}
        aria-expanded={!collapsed}
      >
        <span className="neo-display-panel-glyph" aria-hidden="true">Aa</span>
        <span>Display</span>
        <span className="neo-display-panel-caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {/* JS-positioned popover — anchored under the chip via
          fixed coordinates so it never clips out of a parent
          (grid cell, overflow:hidden ancestor, etc.). */}
      {!collapsed && popPos && (
        <div
          ref={popoverRef}
          className="neo-display-panel-body neo-display-panel-popover"
          style={{
            position: "fixed",
            left: popPos.left,
            top: popPos.top,
            width: popPos.maxWidth,
            maxWidth: popPos.maxWidth,
            zIndex: 100000,
          }}
          role="dialog"
          aria-label="Display settings"
        >
          {body}
        </div>
      )}
    </div>
  );
};
