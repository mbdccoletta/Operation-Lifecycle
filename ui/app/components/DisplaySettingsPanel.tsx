// Floating display-settings panel — globally rendered alongside the
// app routes so the user can dial intensity / font size from ANY
// page (Incidents, Trends, etc) without having to navigate back to
// a settings screen. Collapsed by default to a compact chip;
// clicking it opens an inline panel with two 3-button toggles.
//
// 0.0.243 — On narrow viewports (<=420 px, Z Fold cover and small
// phones) the inline expansion overflows the grid cell and gets
// clipped. The panel now renders its body inside a Strato `Modal`
// when the viewport is narrow, keeping the design-system pattern
// the user asked for ("Utilizar componente strato no Display
// para manter padrao").

import React, { useEffect, useRef, useState } from "react";
import { Modal } from "@dynatrace/strato-components-preview/overlays";
import { useIntensity, type FontScale, type Intensity } from "../contexts/IntensityContext";
import { useDevice } from "../hooks/useDevice";

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
  const { isMobile, forcedMobileByUA } = useDevice();
  // 0.0.243 — Use Strato Modal when on a narrow viewport so the
  // panel body never clips out of its grid cell. Reuses the
  // existing `isMobile` flag plus the UA override so the
  // experience matches the user's device type (Strato pattern
  // = consistent design system).
  const useModal = isMobile || forcedMobileByUA;
  // Map the stored `intensity` value to one of the 3 picker
  // options. "subtle" (legacy, no longer exposed) folds into
  // "normal" so old localStorage entries don't leave users with
  // no button highlighted.
  const contrastActive: Intensity =
    intensity === "bold" ? "bold" :
    intensity === "medium" ? "medium" :
    "normal";
  const [collapsed, setCollapsed] = useState(true);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Click outside → collapse. Listener only attached while the
  // panel is open AND we're rendering inline (the Modal handles
  // its own dismissal). Skipped in modal mode to avoid double-
  // handling clicks.
  useEffect(() => {
    if (collapsed) return;
    if (useModal) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (panelRef.current && t && !panelRef.current.contains(t)) {
        setCollapsed(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [collapsed, useModal]);

  // Body content shared between the inline expansion and the
  // mobile Modal. Extracted so the two modes don't drift.
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
      ref={panelRef}
      className={`neo-display-panel${inline ? " neo-display-panel-inline" : ""}`}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <button
        type="button"
        className="neo-display-panel-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Open display settings" : "Close display settings"}
        aria-expanded={!collapsed}
      >
        {/* Sun-and-text glyph "Aa" reads as the universal "text
            size / display" icon. Kept text-only (no SVG) to match
            the app's chip-style affordance. */}
        <span className="neo-display-panel-glyph" aria-hidden="true">Aa</span>
        <span>Display</span>
        <span className="neo-display-panel-caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {/* Desktop / tablet: inline expansion under the chip */}
      {!collapsed && !useModal && (
        <div className="neo-display-panel-body">{body}</div>
      )}
      {/* Mobile / UA-forced mobile: Strato Modal — keeps the
          panel within the viewport regardless of where the chip
          itself was placed in the wrapping grid. */}
      <Modal
        show={!collapsed && useModal}
        title="Display"
        size="small"
        onDismiss={() => setCollapsed(true)}
        dismissible
      >
        <div className="neo-display-panel-body neo-display-panel-body-modal">{body}</div>
      </Modal>
    </div>
  );
};
