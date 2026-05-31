// 0.0.225 — Thin wrapper around Strato's `<SegmentSelector />`
// that auto-clicks the "Show more" button as soon as the dropdown
// opens. The native Davis Problems UX shows every segment inline
// without making the user click "Show more" first; in our app the
// Strato selector renders the "Recently used" sub-view by default
// and parks the full catalog behind a "Show more" toggle. The user
// kept seeing the catalog visually bleed below the panel border
// before clicking the toggle — auto-firing it on open gives the
// expected one-click access to every segment.
//
// Implementation: `onOpenChange(true)` schedules a MutationObserver
// that watches for any `[data-overlay-container]` to mount, then
// looks inside for a button whose text matches /show more/i and
// .click()s it. The observer disconnects after the first hit so
// it doesn't fire on every subsequent re-render. A 1.5 s safety
// timeout guarantees we never leak observers if Strato's mount
// never produces the expected button (e.g. tenants with so few
// segments that the toggle isn't rendered).

import React, { useCallback } from "react";
import { SegmentSelector } from "@dynatrace/strato-components-preview/filters";

export function SegmentSelectorAutoExpand() {
  const onOpenChange = useCallback((isOpen: boolean) => {
    if (!isOpen) return;
    let done = false;
    const tryClick = () => {
      const overlays = document.querySelectorAll<HTMLElement>("[data-overlay-container]");
      for (const overlay of Array.from(overlays)) {
        const buttons = overlay.querySelectorAll<HTMLElement>("button");
        for (const btn of Array.from(buttons)) {
          if (/show more/i.test(btn.textContent || "")) {
            btn.click();
            done = true;
            return true;
          }
        }
      }
      return false;
    };
    // First, an immediate attempt for the case where the dropdown
    // is already in the DOM (cached / re-open without unmount).
    if (tryClick()) return;
    // Otherwise watch for it to appear.
    const observer = new MutationObserver(() => {
      if (done) return;
      if (tryClick()) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Safety net — never observe forever.
    window.setTimeout(() => observer.disconnect(), 1500);
  }, []);

  return <SegmentSelector onOpenChange={onOpenChange} />;
}
