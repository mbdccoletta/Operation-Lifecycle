import { useEffect, useState } from "react";

/**
 * Device classification aligned with Strato breakpoints:
 *   mobile     0      – 640px
 *   tablet     641px  – 960px
 *   desktop    961px  – 1920px
 *   widescreen 1921px – ∞
 * Reference: design/foundations/layout
 */
export type DeviceClass = "mobile" | "tablet" | "desktop" | "widescreen";

export interface DeviceInfo {
  /** Screen-size class based on Strato breakpoints. */
  device: DeviceClass;
  /** True when the primary pointer is coarse (touch finger / stylus). */
  isTouch: boolean;
  /** Quick aliases. */
  isMobile: boolean;
  isTablet: boolean;
  isMobileOrTablet: boolean;
}

function classify(width: number): DeviceClass {
  if (width <= 640) return "mobile";
  if (width <= 960) return "tablet";
  if (width <= 1920) return "desktop";
  return "widescreen";
}

function detectTouch(): boolean {
  if (typeof window === "undefined") return false;
  // Modern pointer-media query is the most reliable signal of a touch device.
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
  // Fallback: presence of touch events. `Navigator.maxTouchPoints`
  // is part of the lib.dom types since TypeScript 4.4 — no cast
  // needed.
  return ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
}

export function useDevice(): DeviceInfo {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  const [isTouch, setIsTouch] = useState<boolean>(() => detectTouch());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    // Watch for changes in pointer capability (e.g. plugging in a mouse on iPad)
    const mql = window.matchMedia("(pointer: coarse)");
    const onPointerChange = () => setIsTouch(detectTouch());
    if (mql.addEventListener) mql.addEventListener("change", onPointerChange);
    else mql.addListener(onPointerChange);
    return () => {
      window.removeEventListener("resize", onResize);
      if (mql.removeEventListener) mql.removeEventListener("change", onPointerChange);
      else mql.removeListener(onPointerChange);
    };
  }, []);

  const device = classify(width);
  return {
    device,
    isTouch,
    isMobile: device === "mobile",
    isTablet: device === "tablet",
    isMobileOrTablet: device === "mobile" || device === "tablet",
  };
}
