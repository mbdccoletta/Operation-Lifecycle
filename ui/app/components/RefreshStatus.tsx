// Tiny presentational widget for the refresh toolbar. Shows EITHER:
//   • a live countdown ("next refresh in 28s") when auto-refresh is on,
//   • or a "refreshed Xs ago" stamp when auto-refresh is off.
//
// Owns its own tick state so the parent page doesn't re-render every
// second just to keep this label up to date — important on Overview
// where the parent owns a virtualized list of thousands of rows.
//
// Tick cadence is adaptive: 1s while counting down (we need 1s
// resolution), 30s otherwise (the "ago" label resolves in minutes).
// The interval is paused entirely when the tab is hidden so we don't
// burn cycles for an unseen DOM update.
import React, { useEffect, useState } from "react";
import { usePageVisible } from "../hooks/useUiUtils";

export interface RefreshStatusProps {
  /** Timestamp (ms) of the last completed fetch — anchor for both
   *  the elapsed-since label and the countdown calculation. */
  lastRefreshAt: number;
  /** Auto-refresh interval in seconds. `0` means auto-refresh is off
   *  and the component should fall back to the "refreshed Xs ago"
   *  label. */
  intervalSec: number;
}

function formatAgo(elapsedSec: number): string {
  if (elapsedSec < 60)    return `${elapsedSec}s ago`;
  if (elapsedSec < 3600)  return `${Math.floor(elapsedSec / 60)}m ago`;
  if (elapsedSec < 86400) return `${Math.floor(elapsedSec / 3600)}h ago`;
  return `${Math.floor(elapsedSec / 86400)}d ago`;
}

export function RefreshStatus({ lastRefreshAt, intervalSec }: RefreshStatusProps) {
  const pageVisible = usePageVisible();
  const [now, setNow] = useState<number>(() => Date.now());
  // Tick faster when we're actively counting down so the digit
  // doesn't appear to jump in 30s leaps.
  const cadenceMs = intervalSec > 0 ? 1000 : 30_000;
  useEffect(() => {
    if (!pageVisible) return;
    const t = window.setInterval(() => setNow(Date.now()), cadenceMs);
    return () => window.clearInterval(t);
  }, [cadenceMs, pageVisible]);

  const elapsedSec = Math.max(0, Math.floor((now - lastRefreshAt) / 1000));

  if (intervalSec > 0) {
    const remaining = Math.max(0, intervalSec - elapsedSec);
    return (
      <span
        className="neo-refresh-status"
        title={`Auto-refresh fires every ${intervalSec}s — last refresh ${formatAgo(elapsedSec)}`}
      >
        next refresh in {remaining}s
      </span>
    );
  }

  return (
    <span
      className="neo-refresh-status"
      title="Time since the last successful refresh"
    >
      refreshed {formatAgo(elapsedSec)}
    </span>
  );
}
