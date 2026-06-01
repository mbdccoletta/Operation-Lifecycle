// 0.0.253 — Floating debug panel for the hub-band Aurora HUD
// backdrop. Lets the operator toggle the effect on/off and pick
// between 4 animation variants via clickable buttons instead of
// typing into the devtools console.
//
// Renders ONLY when the URL carries `?hubDebug=1` (or
// `?hubDebug=true`). On any other URL the panel renders nothing,
// so end-users never see it.
//
// State is mirrored to `window.__hubGrid` / `window.__hubAnim`
// so the rendering side of ConstellationView (which reads those
// globals per frame) picks the change up instantly. Also
// persisted to localStorage so the choice survives a reload.

import React, { useEffect, useState } from "react";

type AnimVariant = 1 | 2 | 3 | 4;

const ANIM_VARIANTS: Array<{ id: AnimVariant; label: string; hint: string }> = [
  { id: 1, label: "Wave",   hint: "Crest travels L→R (6 s)" },
  { id: 2, label: "Radial", hint: "Pulse from centre (5 s)" },
  { id: 3, label: "Breath", hint: "Whole grid breathes (4 s)" },
  { id: 4, label: "Static", hint: "No animation" },
];

function isDebugActive(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const p = new URLSearchParams(window.location.search).get("hubDebug");
    if (p === "1" || p === "true") return true;
    try {
      const ls = window.localStorage?.getItem("hubDebug");
      if (ls === "1" || ls === "true") return true;
    } catch { /* private mode */ }
    return false;
  } catch { return false; }
}

function readInitialOn(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const g = (window as unknown as { __hubGrid?: boolean | string }).__hubGrid;
    if (g === true || g === "true" || g === "1") return true;
    if (g === false || g === "false" || g === "0") return false;
    try {
      const ls = window.localStorage?.getItem("hubGrid");
      if (ls === "1" || ls === "true") return true;
    } catch { /* private mode */ }
    return false;
  } catch { return false; }
}

function readInitialAnim(): AnimVariant {
  try {
    if (typeof window === "undefined") return 1;
    const g = (window as unknown as { __hubAnim?: number | string }).__hubAnim;
    const candidates: Array<unknown> = [g];
    try { candidates.push(window.localStorage?.getItem("hubAnim")); } catch { /* private mode */ }
    for (const raw of candidates) {
      const v = String(raw).toLowerCase();
      if (v === "1" || v === "wave") return 1;
      if (v === "2" || v === "radial") return 2;
      if (v === "3" || v === "breath") return 3;
      if (v === "4" || v === "static") return 4;
    }
    return 1;
  } catch { return 1; }
}

export const HubBackdropDebugPanel: React.FC = () => {
  const [visible, setVisible] = useState<boolean>(() => isDebugActive());
  const [on, setOn] = useState<boolean>(() => readInitialOn());
  const [anim, setAnim] = useState<AnimVariant>(() => readInitialAnim());
  const [collapsed, setCollapsed] = useState<boolean>(false);

  // Mirror state → window globals + localStorage so the canvas
  // picks the changes up on its next frame.
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __hubGrid?: boolean }).__hubGrid = on;
    try { window.localStorage?.setItem("hubGrid", on ? "1" : "0"); } catch { /* private mode */ }
  }, [on]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __hubAnim?: number }).__hubAnim = anim;
    try { window.localStorage?.setItem("hubAnim", String(anim)); } catch { /* private mode */ }
  }, [anim]);

  if (!visible) return null;

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    bottom: 80, // sit above the mobile tabbar
    right: 12,
    zIndex: 99000,
    background: "rgba(8,12,22,0.92)",
    border: "1px solid rgba(120,180,255,0.45)",
    borderRadius: 8,
    padding: collapsed ? "4px 10px" : "10px 12px",
    boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
    color: "rgba(220,230,250,0.95)",
    font: "600 11px/1.3 'Roboto Mono','SF Mono',monospace",
    letterSpacing: "0.04em",
    userSelect: "none",
    minWidth: collapsed ? "auto" : 200,
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: collapsed ? 0 : 8,
  };
  const toggleStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "5px 8px",
    background: active ? "rgba(120,180,255,0.20)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "rgba(120,180,255,0.65)" : "rgba(255,255,255,0.10)"}`,
    borderRadius: 4,
    color: active ? "rgba(220,230,250,1)" : "rgba(180,190,210,0.85)",
    font: "inherit",
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms",
  });
  const onOffStyle: React.CSSProperties = {
    ...toggleStyle(on),
    flex: "0 0 auto",
    padding: "4px 10px",
    minWidth: 44,
    textAlign: "center" as const,
  };

  return (
    <div style={panelStyle} role="region" aria-label="Hub backdrop debug">
      <div style={headerStyle}>
        <span style={{ opacity: 0.7, letterSpacing: "0.10em", textTransform: "uppercase" }}>
          Hub Backdrop
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(220,230,250,0.6)",
            cursor: "pointer",
            font: "inherit",
            padding: "0 4px",
          }}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          type="button"
          onClick={() => setVisible(false)}
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(220,230,250,0.6)",
            cursor: "pointer",
            font: "inherit",
            padding: "0 4px",
          }}
          title="Hide panel (re-open with ?hubDebug=1)"
        >
          ×
        </button>
      </div>
      {!collapsed && (
        <>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setOn(!on)}
              style={onOffStyle}
              aria-pressed={on}
              title="Toggle the hub backdrop"
            >
              {on ? "ON" : "OFF"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {ANIM_VARIANTS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAnim(opt.id)}
                style={toggleStyle(anim === opt.id)}
                aria-pressed={anim === opt.id}
                title={opt.hint}
              >
                {opt.id} · {opt.label}
              </button>
            ))}
          </div>
          <div style={{
            marginTop: 8,
            paddingTop: 6,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            fontSize: 9,
            opacity: 0.55,
            letterSpacing: "0.02em",
          }}>
            {ANIM_VARIANTS.find((v) => v.id === anim)?.hint}
          </div>
        </>
      )}
    </div>
  );
};
