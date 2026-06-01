// Demo-mode context.
//
// Tracks whether the app should render synthetic data instead of
// hitting Grail. Activated by the URL param `?demo=1` AND the host
// matching the BWM lab tenant allow-list — there is no in-app toggle
// by design (so the demo can't accidentally leak into a recorded
// session for a real customer).
//
// 0.0.282 — tenant gating. The `?demo=1` URL param alone is no
// longer sufficient: the provider also checks `window.location.
// hostname` against the BWM allow-list. On any other tenant
// (Bradesco prod, future production customers, etc.) the param is
// silently ignored and the app stays in live-data mode. This makes
// demo mode safe to ship in the same bundle that runs in customer
// tenants — the bundle has no compile-time tenant split, but the
// runtime guard prevents accidental activation outside the lab.
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
//
// Write-path contract:
//   • `useComments` short-circuits its Davis + document writes in
//     demo mode so a demo session can't post a real CUSTOM_ANNOTATION
//     event or create a real document on the lab tenant. The
//     optimistic UI still updates so the demo flow feels authentic.

import React, { createContext, useContext, useMemo, type ReactNode } from "react";

/** Hostnames where demo mode is permitted to activate. Substring match
 *  on `window.location.hostname`. Keep this list narrow — every entry
 *  is a tenant where it's OK for `?demo=1` to swap real data for
 *  synthetic. Add new lab tenants here; never customer prod hosts. */
const DEMO_ALLOWED_HOST_PATTERNS = [
  "bwm",          // BWM lab tenant (bwm98081.apps.dynatrace.com)
  "localhost",    // local `npx dt-app dev`
  "127.0.0.1",    // local dev fallback
] as const;

function isDemoAllowedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return DEMO_ALLOWED_HOST_PATTERNS.some((p) => h.includes(p));
}

interface DemoModeValue {
  /** When true, every data hook returns demo data and skips its
   *  underlying DQL call AND every write hook short-circuits to a
   *  local-only optimistic update. */
  enabled: boolean;
}

const DemoModeContext = createContext<DemoModeValue>({ enabled: false });

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const value = useMemo<DemoModeValue>(() => {
    if (typeof window === "undefined") return { enabled: false };
    try {
      const params = new URLSearchParams(window.location.search);
      const flag = params.get("demo") === "1";
      if (!flag) return { enabled: false };
      // Tenant gate — both conditions must hold.
      const hostOk = isDemoAllowedHost(window.location.hostname);
      if (!hostOk) {
        // Log so a curious lab visitor inspecting the console
        // understands why their `?demo=1` is being ignored.
        // eslint-disable-next-line no-console
        console.info(
          "[problems-hub] demo=1 ignored: host %s not in allow-list %o",
          window.location.hostname,
          DEMO_ALLOWED_HOST_PATTERNS,
        );
        return { enabled: false };
      }
      return { enabled: true };
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
