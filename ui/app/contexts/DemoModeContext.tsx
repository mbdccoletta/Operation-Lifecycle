// Demo-mode context.
//
// Tracks whether the app should render synthetic data instead of
// hitting Grail. Activated by the URL param `?demo=1` — there is no
// in-app toggle by design (so the demo can't accidentally leak into
// a recorded session for a real customer).
//
// The provider snapshots the URL at mount; subsequent SPA navigation
// keeps the same value. To turn demo off, the user removes `?demo=1`
// from the URL and hard-refreshes.
//
// Consumed by every data-fetching hook (`useProblems`,
// `useStatusCategoryCounts`, etc.) — they branch to `demoData.ts`
// when `enabled === true`. The DemoMode badge below the main heading
// gives a visual signal so anyone watching the screen knows they are
// looking at synthetic data, not the customer's tenant.

import React, { createContext, useContext, useMemo, type ReactNode } from "react";

interface DemoModeValue {
  /** When true, every data hook returns demo data and skips its
   *  underlying DQL call. */
  enabled: boolean;
}

const DemoModeContext = createContext<DemoModeValue>({ enabled: false });

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const value = useMemo<DemoModeValue>(() => {
    if (typeof window === "undefined") return { enabled: false };
    try {
      const params = new URLSearchParams(window.location.search);
      return { enabled: params.get("demo") === "1" };
    } catch {
      // Malformed URL or non-browser environment — silently disable.
      return { enabled: false };
    }
  }, []);
  return (
    <DemoModeContext.Provider value={value}>
      {children}
    </DemoModeContext.Provider>
  );
}

/** Read the demo flag. Safe at any depth below `DemoModeProvider`. */
export function useDemoMode(): DemoModeValue {
  return useContext(DemoModeContext);
}
