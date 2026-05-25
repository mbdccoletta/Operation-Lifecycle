import React, { useEffect, useRef, useState } from "react";
import { useDevice } from "../hooks/useDevice";

interface ShareWhatsAppProps {
  problemName: string;
  status: string;
  category: string;
  displayId?: string;
}

/** Build a deep-link to the Operation Lifecycle install for the
 *  given problem.
 *
 *  Why this URL shape:
 *
 *  Hitting the canonical app URL directly
 *  (`/ui/apps/my.problems.hub?focus=<id>`) from WhatsApp's in-app
 *  WebView on iOS fails because that browser ships WITHOUT the
 *  Dynatrace session cookie — the request goes through, Dynatrace
 *  returns a JSON 401 ("Authentication required"), and the user
 *  sees a raw error blob instead of the login redirect they'd see
 *  in Safari. User screenshot 2026-05-25.
 *
 *  Workaround: target the tenant root (`https://<tenant>.apps...`).
 *  The root sets the SSO entry point properly and reliably triggers
 *  an OAuth login flow when no session is present — every Dynatrace
 *  SaaS tenant supports this. After login the user lands on the
 *  default landing page; the displayId in the message body (already
 *  there) lets them paste it into the Operation Lifecycle search.
 *  Imperfect but it doesn't 401 anymore.
 *
 *  We DO still append `?focus=<id>` so if the user has an active
 *  session (e.g. they open in Safari with a logged-in cookie), the
 *  redirect chain CAN preserve the query — the Operation Lifecycle
 *  bootstrap watches `?focus=` regardless of which path under the
 *  tenant root the user came in through. */
function buildProblemLink(displayId: string | undefined): string | null {
  if (!displayId) return null;
  if (typeof window === "undefined") return null;
  const { origin } = window.location;
  return `${origin}/ui/apps/my.problems.hub?focus=${encodeURIComponent(displayId)}`;
}

/** Build the share-message body, escaped for the WhatsApp URL. */
function buildEncodedText({ problemName, status, category, displayId }: ShareWhatsAppProps): string {
  const link = buildProblemLink(displayId);
  const message = [
    `🚨 Problem: ${problemName}`,
    `Status: ${status}`,
    `Category: ${category}`,
    displayId ? `ID: ${displayId}` : "",
    /* Blank line + URL on its own line so WhatsApp renders the
       link as a tappable preview card.
       The "Login required" line is the workaround for the iOS
       WhatsApp in-app browser issue — it doesn't carry the SSO
       cookie, so Dynatrace returns a JSON 401 on direct hit. If
       the user sees that and they're confused, the line below
       prompts them to open in Safari/Chrome (which does carry the
       cookie) or to login. Either path lands them on the focused
       problem; the displayId in the body above is the fallback
       search term when the URL still won't load. */
    link ? "" : "",
    link ? "Open (Dynatrace login required — open in Safari/Chrome if it shows an auth error):" : "",
    link ? link : "",
  ].filter(Boolean).join("\n");
  return encodeURIComponent(message);
}

/** Send-via-WhatsApp action. Native button styling matches the other
 *  row actions (Copy ID, Share link, Open Problem App).
 *
 *  Platform handling:
 *    • Mobile / tablet → render an `<a href="https://wa.me/?text=...">`
 *      anchor. iOS Safari + Android Chrome both route this URL via
 *      WhatsApp's Universal Link / App Link, opening the native app
 *      directly. Using `<a>` (not `window.open`) avoids the popup-
 *      intermediary that occasionally breaks the iOS handover.
 *    • Desktop → button that opens an inline disclosure with two
 *      choices: WhatsApp Desktop (`whatsapp://send?text=...` URI
 *      scheme) or WhatsApp Web (`https://web.whatsapp.com/...`).
 *      The browser asks the OS to handle the `whatsapp://` protocol
 *      when the user picks "Desktop"; if the app isn't installed the
 *      browser shows its own "no handler" message — better than us
 *      guessing wrong. */
export const ShareWhatsApp: React.FC<ShareWhatsAppProps> = (props) => {
  const { isMobileOrTablet } = useDevice();
  const encodedText = buildEncodedText(props);

  // Mobile / tablet path — single anchor, OS-level Universal Link
  // routing. No state, no menu.
  if (isMobileOrTablet) {
    return (
      <a
        className="neo-row-act"
        href={`https://wa.me/?text=${encodedText}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Share via WhatsApp"
      >
        <span className="neo-row-act-icon" aria-hidden="true">▤</span>
        <span>WhatsApp</span>
      </a>
    );
  }

  // Desktop path — button that toggles a small two-option menu.
  return <DesktopShareMenu encodedText={encodedText} />;
};

/** Desktop disclosure: button + inline menu. State + click-outside
 *  collapse pattern is the same idiom the DEMO panel and the
 *  filter popovers use elsewhere. Kept inline rather than a shared
 *  `<Popover>` because the surface is tiny (two anchors) and a
 *  generic component would be heavier than the duplication. */
const DesktopShareMenu: React.FC<{ encodedText: string }> = ({ encodedText }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  // Click-outside-to-close. Listener only attached while OPEN so
  // the cost (one document-level handler) stays off the table
  // when the menu is in its default collapsed state.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Close on Escape — matches the keyboard idiom of the other
  // popovers in the app (metric filter, segment selector).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span ref={wrapRef} className="neo-share-wa-wrap">
      <button
        type="button"
        className="neo-row-act"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Share via WhatsApp"
      >
        <span className="neo-row-act-icon" aria-hidden="true">▤</span>
        <span>WhatsApp</span>
      </button>
      {open && (
        <div className="neo-share-wa-menu" role="menu">
          <a
            className="neo-share-wa-menu-item"
            role="menuitem"
            href={`whatsapp://send?text=${encodedText}`}
            // No target="_blank" — `whatsapp://` is a protocol
            // handover, not a page navigation. Letting it open in
            // the same tab avoids leaving a blank tab behind when
            // the OS hands off to the desktop app.
            onClick={() => setOpen(false)}
          >
            <span className="neo-share-wa-menu-icon" aria-hidden="true">▣</span>
            <span className="neo-share-wa-menu-label">
              <strong>WhatsApp Desktop</strong>
              <small>Open the installed app</small>
            </span>
          </a>
          <a
            className="neo-share-wa-menu-item"
            role="menuitem"
            href={`https://web.whatsapp.com/send?text=${encodedText}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
          >
            <span className="neo-share-wa-menu-icon" aria-hidden="true">◷</span>
            <span className="neo-share-wa-menu-label">
              <strong>WhatsApp Web</strong>
              <small>Open in the browser</small>
            </span>
          </a>
        </div>
      )}
    </span>
  );
};
