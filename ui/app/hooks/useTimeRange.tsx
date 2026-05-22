// Shared "user drilled into a sub-window of the chart" state.
// Synced to URL search params (`range_from` / `range_to`) so the
// selection survives page reloads and deep-link sharing.

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

interface TimeRange {
  from: Date;
  to: Date;
}

interface TimeRangeContextType {
  selectedRange: TimeRange | null;
  setSelectedRange: (range: TimeRange | null) => void;
  handleRangeSelect: (from: Date, to: Date) => void;
  clearRange: () => void;
}

const TimeRangeContext = createContext<TimeRangeContextType>({
  selectedRange: null,
  setSelectedRange: () => {},
  handleRangeSelect: () => {},
  clearRange: () => {},
});

export const useTimeRange = () => useContext(TimeRangeContext);

/** Read both search params and try to build a valid TimeRange.
 *  Returns null when either side is missing or unparseable so a
 *  half-filled URL doesn't put the context into a weird state. */
function readRangeFromParams(params: URLSearchParams): TimeRange | null {
  const fromStr = params.get("range_from");
  const toStr   = params.get("range_to");
  if (!fromStr || !toStr) return null;
  const from = new Date(fromStr);
  const to   = new Date(toStr);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return null;
  if (from.getTime() >= to.getTime()) return null;
  return { from, to };
}

export const TimeRangeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Hydrate from URL on first mount only — subsequent writes go
  // through the setters below, which also update the URL.
  const [selectedRange, setSelectedRange] = useState<TimeRange | null>(() =>
    readRangeFromParams(searchParams),
  );

  // After the first render, keep the URL in sync with state. Stored
  // in a ref so the effect doesn't re-run when `searchParams` itself
  // becomes a new reference (it does on every URL update, which
  // would otherwise loop).
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (selectedRange) {
      next.set("range_from", selectedRange.from.toISOString());
      next.set("range_to",   selectedRange.to.toISOString());
    } else {
      next.delete("range_from");
      next.delete("range_to");
    }
    // Only call setSearchParams if something actually changed —
    // otherwise we'd trigger an extra render every state set.
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRange]);

  const handleRangeSelect = useCallback((from: Date, to: Date) => {
    if (!from || !to) {
      setSelectedRange(null);
    } else {
      setSelectedRange({ from, to });
    }
  }, []);

  const clearRange = useCallback(() => {
    setSelectedRange(null);
  }, []);

  return (
    <TimeRangeContext.Provider value={{ selectedRange, setSelectedRange, handleRangeSelect, clearRange }}>
      {children}
    </TimeRangeContext.Provider>
  );
};
