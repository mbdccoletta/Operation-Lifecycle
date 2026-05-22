// Display-settings context — bundles two user preferences that
// affect how the whole app renders:
//
//   • `intensity` — how prominent highlights, status pills, focus
//     rings and accent washes feel. Three levels (subtle / normal /
//     bold) drive a set of CSS variables consumed by theme.css.
//
//   • `fontScale` — overall size of text and UI chrome. Three
//     levels (small / normal / large) map to a CSS `zoom` multiplier
//     on a global wrapper so EVERY size (font, padding, icon) scales
//     in lockstep. The user can dial it up for low-vision /
//     screen-share situations without us touching individual `px`
//     values.
//
// Both prefs persist in localStorage and mirror to `data-*`
// attributes on `<html>` so CSS rules can react via selectors. The
// provider also computes a single `displayClass` consumers can
// pin on the root wrapper they want zoomed (since `zoom` propagates
// to descendants but stops at iframes).

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

// `medium` was added later as a halfway step between `normal` and
// `bold` so users who find Bold too saturated can still pump
// contrast a notch. `subtle` is retained for backwards-compat
// with old localStorage entries but no longer exposed in the
// Display panel UI.
export type Intensity = "subtle" | "normal" | "medium" | "bold";
export type FontScale = "small" | "normal" | "large";

const STORAGE_INTENSITY = "lifecycle.intensity";
const STORAGE_FONTSCALE = "lifecycle.fontScale";
const DEFAULT_INTENSITY: Intensity = "normal";
const DEFAULT_FONTSCALE: FontScale = "normal";

const INTENSITIES: Intensity[] = ["subtle", "normal", "medium", "bold"];
const FONTSCALES: FontScale[]   = ["small",  "normal", "large"];

function readStored<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as string[]).includes(v)) return v as T;
  } catch {
    // localStorage may throw under restrictive policies. Default
    // keeps the app usable.
  }
  return fallback;
}

interface Ctx {
  intensity: Intensity;
  setIntensity: (v: Intensity) => void;
  fontScale: FontScale;
  setFontScale: (v: FontScale) => void;
}

const IntensityCtx = createContext<Ctx>({
  intensity: DEFAULT_INTENSITY,
  setIntensity: () => undefined,
  fontScale: DEFAULT_FONTSCALE,
  setFontScale: () => undefined,
});

export const IntensityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [intensity, setIntensityRaw] = useState<Intensity>(
    () => readStored(STORAGE_INTENSITY, INTENSITIES, DEFAULT_INTENSITY),
  );
  const [fontScale, setFontScaleRaw] = useState<FontScale>(
    () => readStored(STORAGE_FONTSCALE, FONTSCALES, DEFAULT_FONTSCALE),
  );

  // Mirror both prefs to <html> attributes. Done in an effect so the
  // DOM mutation isn't run during render.
  useEffect(() => {
    document.documentElement.setAttribute("data-intensity", intensity);
  }, [intensity]);

  useEffect(() => {
    document.documentElement.setAttribute("data-font-scale", fontScale);
  }, [fontScale]);

  const setIntensity = useCallback((v: Intensity) => {
    setIntensityRaw(v);
    try { localStorage.setItem(STORAGE_INTENSITY, v); } catch { /* see readStored */ }
  }, []);

  const setFontScale = useCallback((v: FontScale) => {
    setFontScaleRaw(v);
    try { localStorage.setItem(STORAGE_FONTSCALE, v); } catch { /* see readStored */ }
  }, []);

  const value = useMemo<Ctx>(
    () => ({ intensity, setIntensity, fontScale, setFontScale }),
    [intensity, setIntensity, fontScale, setFontScale],
  );
  return <IntensityCtx.Provider value={value}>{children}</IntensityCtx.Provider>;
};

export function useIntensity(): Ctx {
  return useContext(IntensityCtx);
}
