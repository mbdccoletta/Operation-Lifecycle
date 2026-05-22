// Small shared hooks reused across pages — kept in one file so it's
// obvious which patterns are blessed (e.g. "this is THE way to delay a
// loading spinner", "this is THE way to gate intervals on tab focus").
import { useEffect, useRef, useState } from "react";

/** True when the document tab is currently visible. Pauses-on-hide
 *  patterns gate background work on this so auto-refresh + animation
 *  loops don't burn CPU / DQL budget when the user isn't looking. */
export function usePageVisible(): boolean {
  const get = () => typeof document === "undefined" ? true : document.visibilityState !== "hidden";
  const [visible, setVisible] = useState<boolean>(get);
  useEffect(() => {
    const onVis = () => setVisible(get());
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  return visible;
}

/** Delays propagating a `true` loading flag until the wait threshold
 *  elapses. The Dynatrace loading-saving pattern says: "Always use a
 *  delay (~500 ms – 1 s) unless you know loading will take a while.
 *  Once shown, keep it for at least ~200 ms so it doesn't flicker."
 *  This hook implements both rules. */
export function useDelayedLoading(loading: boolean, showAfterMs = 500, minVisibleMs = 200): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);
  useEffect(() => {
    if (loading) {
      const t = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, showAfterMs);
      return () => window.clearTimeout(t);
    }
    // not loading — but if we already showed, hold it briefly so it
    // doesn't flicker out the moment the response arrives.
    if (!visible) return;
    const elapsed = shownAt.current ? Date.now() - shownAt.current : minVisibleMs;
    const wait    = Math.max(0, minVisibleMs - elapsed);
    const t = window.setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, wait);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, showAfterMs, minVisibleMs]);
  return visible;
}

/** Debounce a string value (typically a search input) by `delayMs`.
 *  Cheaper alternative to React's `useDeferredValue` for cases where
 *  we want a concrete millisecond cap, not just "low-priority". */
export function useDebouncedValue<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
