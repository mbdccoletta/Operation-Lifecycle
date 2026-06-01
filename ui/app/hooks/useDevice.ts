import { useEffect, useState } from "react";

/**
 * Device classification aligned with Strato breakpoints:
 *   mobile     0      – 640px
 *   tablet     641px  – 960px
 *   desktop    961px  – 1920px
 *   widescreen 1921px – ∞
 * Reference: design/foundations/layout
 *
 * 0.0.227 — Mobile-UA override. When the user agent identifies as a
 * mobile/tablet platform (iOS, Android, etc.) we collapse the
 * classification to "mobile" regardless of viewport width. Rationale:
 * a phone or tablet user gets the touch-first, compact layout we built
 * for them, even when the viewport is wide (landscape phone, foldable
 * unfolded, Samsung DeX, Chrome DevTools tablet emulation, etc.). User
 * reported that Samsung Galaxy Tab S4 emulation showed the segment
 * selector overlapping in the desktop layout — mobile layout has its
 * own non-overlapping pattern (bottom sheet) which sidesteps the issue.
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
  /** True when the UA-based override forced this device to "mobile"
   *  even though the viewport would otherwise classify higher.
   *  Useful for diagnostics and conditional logging. */
  forcedMobileByUA: boolean;
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

/**
 * Detect whether the browser is a mobile/tablet platform browser,
 * regardless of current viewport size. Combines three signals:
 *
 *  1. `navigator.userAgentData.mobile` (Client Hints API, Chromium 90+).
 *     The most reliable when present.
 *  2. UA-string match for phones and tablets that openly identify
 *     themselves: iPhone, iPad, iPod, Android (phone or tablet),
 *     Windows Phone, BlackBerry, Opera Mini/Mobi.
 *  3. iPadOS-as-Mac heuristic: iPadOS 13+ reports a Macintosh UA but
 *     ships with `maxTouchPoints > 1` and a coarse pointer. Catch
 *     that combo so iPads still pick up mobile layout.
 *
 * Returns false on any non-browser environment (SSR test, etc.).
 */
function detectMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // (1) Client Hints API
  type UADWithMobile = { mobile?: boolean; platform?: string };
  const uad = (navigator as { userAgentData?: UADWithMobile }).userAgentData;
  if (uad && uad.mobile === true) return true;
  // (2) UA-string patterns
  const ua = (navigator.userAgent || "").toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  if (/android/.test(ua)) return true; // covers phones AND tablets
  if (/windows phone|iemobile/.test(ua)) return true;
  if (/blackberry|bb10/.test(ua)) return true;
  if (/opera mini|opera mobi/.test(ua)) return true;
  // (3) iPadOS-as-Mac
  if (
    /macintosh/.test(ua) &&
    "maxTouchPoints" in navigator &&
    (navigator as Navigator).maxTouchPoints > 1
  ) {
    return true;
  }
  return false;
}

export function useDevice(): DeviceInfo {
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  const [isTouch, setIsTouch] = useState<boolean>(() => detectTouch());
  // UA-based mobile detection runs once. The user agent does not change
  // mid-session, so a single read at mount time is sufficient.
  const [forcedMobile] = useState<boolean>(() => detectMobilePlatform());

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

  // Mirror the UA override to the document root so CSS rules (which
  // can't read React state) can opt into the same forced-mobile
  // collapse via the `:root[data-force-mobile]` selector. Single
  // write on mount — `forcedMobile` is captured from UA which can't
  // change inside one session. Idempotent in StrictMode.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (forcedMobile) {
      document.documentElement.setAttribute("data-force-mobile", "ua");
    }
    return () => {
      if (forcedMobile) {
        document.documentElement.removeAttribute("data-force-mobile");
      }
    };
  }, [forcedMobile]);

  const widthClass = classify(width);
  // UA override: if the UA says we're on a mobile/tablet platform,
  // collapse to "mobile" no matter how wide the viewport reports.
  const device: DeviceClass = forcedMobile ? "mobile" : widthClass;
  // Width *would have been* something larger but we forced it down —
  // tag the result so callers can log / debug if curious.
  const forcedMobileByUA = forcedMobile && widthClass !== "mobile";
  return {
    device,
    isTouch,
    isMobile: device === "mobile",
    isTablet: device === "tablet",
    isMobileOrTablet: device === "mobile" || device === "tablet",
    forcedMobileByUA,
  };
}
