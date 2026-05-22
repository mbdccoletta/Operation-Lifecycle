// Global "refresh tick" — a monotonic integer that bumps every time
// the user (or auto-refresh interval) requests a refresh. Components
// that own their own data sources outside of `useDql`'s cache (the
// per-problem `useComments` document fetcher, `useProblemTimeline`'s
// SDK refetch handle, anything else with local caches) subscribe to
// the tick via `useRefreshTick()` and re-fetch when it changes.
//
// Why a context instead of prop-drilling: any number of expanded
// rows can mount at once (Overview list), each containing
// independent comment + timeline fetchers. Prop-drilling a refresh
// counter to every nested instance is fragile; a context gives a
// single subscription point with no plumbing.
//
// The hook owners just need:
//   const tick = useRefreshTick();
//   useEffect(() => { refetch(); }, [tick]);
//
// …and the page that drives the refresh:
//   const triggerRefresh = useTriggerRefresh();
//   onClick = () => { dataRefetch(); triggerRefresh(); };
import React, { createContext, useCallback, useContext, useState } from "react";

interface RefreshSignal {
  tick: number;
  trigger: () => void;
}

const RefreshSignalContext = createContext<RefreshSignal>({
  tick: 0,
  trigger: () => { /* no-op default — exists so consumers don't crash outside the provider */ },
});

export const RefreshSignalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tick, setTick] = useState(0);
  const trigger = useCallback(() => setTick((n) => n + 1), []);
  return (
    <RefreshSignalContext.Provider value={{ tick, trigger }}>
      {children}
    </RefreshSignalContext.Provider>
  );
};

/** Returns the current refresh tick. Increment = "host page just
 *  refreshed, please re-fetch your local data". */
export function useRefreshTick(): number {
  return useContext(RefreshSignalContext).tick;
}

/** Returns the trigger function — call this whenever the host page
 *  fires its own refetch so subscribers can re-fetch in lockstep. */
export function useTriggerRefresh(): () => void {
  return useContext(RefreshSignalContext).trigger;
}
