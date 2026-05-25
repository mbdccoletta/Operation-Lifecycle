import React, { useEffect, useRef, useState } from "react";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import { useDevice } from "../hooks/useDevice";
import type { Problem } from "../hooks/useProblems";
import {
  formatStartedDate,
  formatDuration,
  getCategoryLabel,
  getStatusLabel,
} from "../utils/formatters";

interface ShareWhatsAppProps {
  /** Full Problem record. The component pulls everything it needs from
   *  here so the receiving WhatsApp message can carry the WHOLE incident
   *  context as plain text — name, severity, timing, affected entities,
   *  root cause — not just a link.
   *
   *  Why the whole object: WhatsApp's in-app browser can't follow the
   *  Dynatrace OAuth flow (WKWebView doesn't carry the system browser's
   *  SSO cookie), so the link often fails for the recipient. The text
   *  body has to stand on its own as a complete incident summary that
   *  any on-call engineer can act on without ever opening the URL. */
  problem: Problem;
}

/** Build a link to the Dynatrace tenant.
 *
 *  CRITICAL: `window.location.origin` from inside an AppEngine app
 *  returns the per-APP SANDBOX origin, e.g.
 *
 *    https://xktbb3yiewy2q2blln7jdl7cslfg7vxv--bwm98081.prod3.apps.dynatrace.com
 *
 *  That hashed subdomain is the iframe sandbox where this app's
 *  bundle is served — NOT the user-facing tenant URL. Sending that
 *  URL to WhatsApp guarantees a 401 because the sandbox host doesn't
 *  serve the OAuth flow; only the tenant URL does. That's why every
 *  attempt with `window.location.origin` failed.
 *
 *  `getEnvironmentUrl()` from the AppEngine SDK returns the real
 *  tenant URL (e.g. `https://bwm98081.apps.dynatrace.com`) regardless
 *  of whether the code runs inside the sandbox iframe. THAT URL is
 *  the OAuth-aware entry point: unauthenticated requests get a
 *  proper HTML redirect to the login page.
 *
 *  Even so, the link will still fail INSIDE WhatsApp's iOS in-app
 *  browser (WKWebView), because WKWebView is sandboxed away from
 *  the system browser's Dynatrace SSO cookie. The "📱 Tip" line in
 *  `buildEncodedText` instructs the recipient to open the message
 *  in Safari/Chrome where the cookie does exist. */
function buildProblemLink(displayId: string | undefined): string | null {
  try {
    const base = getEnvironmentUrl();
    if (!base) return null;
    const root = base.endsWith("/") ? base.slice(0, -1) : base;
    // Deep-link to the specific problem inside this app. Overview.tsx
    // honours `?focus=P-####` and on bootstrap pins / expands / scrolls
    // to the matching row (see Overview.tsx lines ~1810). The OAuth
    // redirect chain preserves the query string across the login bounce,
    // so even an unauthenticated recipient lands directly on the right
    // problem after they sign in.
    //
    // Fall back to the tenant ROOT when displayId is missing — better
    // than a dangling deep-link that 404s. The body text still carries
    // the searchable problem name in that case.
    if (!displayId) return `${root}/`;
    return `${root}/ui/apps/my.problems.hub?focus=${encodeURIComponent(displayId)}`;
  } catch {
    return null;
  }
}

/** Severity → human label. Davis stores severity as a string "1".."5"
 *  on `event.severity` (higher = more critical). The list view doesn't
 *  surface it prominently, but when the recipient can't open the link
 *  it's the single most useful piece of context — a P1 reads very
 *  differently from a P5. We render both the number and a one-word
 *  label so the message is parseable without Davis knowledge. */
function severityLine(sev: string | undefined): string | null {
  if (!sev) return null;
  const n = Number.parseInt(sev, 10);
  if (!Number.isFinite(n)) return `Severity: ${sev}`;
  const label =
    n <= 1 ? "Critical" :
    n === 2 ? "High" :
    n === 3 ? "Medium" :
    n === 4 ? "Low" :
              "Informational";
  return `Severity: ${n} (${label})`;
}

/** Bullet list of affected entities. Pairs ids with names; falls back
 *  to a shortened id when name is missing. Caps at 5 lines + a "+N more"
 *  rollup so the message doesn't bloat past readable length on a
 *  high-blast-radius incident. */
function affectedEntityLines(p: Problem): string[] {
  const ids = p.affected_entity_ids ?? [];
  const names = p.affected_entity_names ?? [];
  if (ids.length === 0) return [];
  const MAX = 5;
  const out: string[] = [];
  out.push(`Affected entities (${ids.length}):`);
  const shown = Math.min(ids.length, MAX);
  for (let i = 0; i < shown; i++) {
    const name = names[i] && names[i]!.trim() ? names[i]! : null;
    const id   = ids[i];
    // Prefer the human name; show the id only when the name is missing
    // (otherwise the line is noisy: "host-app-07  (HOST-1234…)").
    out.push(`  • ${name ?? id}`);
  }
  if (ids.length > MAX) {
    out.push(`  • +${ids.length - MAX} more`);
  }
  return out;
}

/** Root cause line. Optional — when Davis hasn't pinned a root cause
 *  yet, we omit the line entirely rather than render "Root cause:
 *  unknown" (which looks like a finding rather than missing data). */
function rootCauseLine(p: Problem): string | null {
  const name = p.root_cause_entity_name?.trim();
  const id   = p.root_cause_entity_id?.trim();
  if (!name && !id) return null;
  return `Root cause: ${name || id}`;
}

/** Build the share-message body, escaped for the WhatsApp URL.
 *
 *  Message anatomy (in order, top → bottom):
 *    1. 🚨 Problem name — single-line headline.
 *    2. ID + status badge — searchable handle + lifecycle state.
 *    3. Category + severity — what KIND of incident, how bad.
 *    4. Started / Duration — temporal context (when + how long).
 *    5. Affected entities — blast radius (up to 5 + overflow rollup).
 *    6. Root cause — Davis's pinned cause entity, if any.
 *    7. Action prompt + URL — tenant root so the OAuth flow fires
 *       for unauthenticated users (when the recipient ever opens it).
 *    8. "📱 Tip" footer — explains how to recover from WhatsApp's
 *       in-app browser eating the auth flow.
 *
 *  Everything above the URL must be self-sufficient: on-call should
 *  be able to triage off the text alone if the link is unreachable. */
function buildMessageText(problem: Problem): string {
  const link = buildProblemLink(problem.display_id);
  const name     = problem["event.name"];
  const status   = getStatusLabel(problem["event.status"]);
  const category = getCategoryLabel(problem["event.category"]);
  const sev      = severityLine(problem["event.severity"]);
  const started  = problem["event.start"] ? formatStartedDate(problem["event.start"]) : null;
  const duration = problem["event.start"] ? formatDuration(problem["event.start"], problem["event.end"]) : null;
  // "Active" problems have no end → formatDuration uses Date.now(); we
  // append "(ongoing)" so it's clear the clock is still running.
  const durationLine =
    duration && (problem["event.status"] === "ACTIVE" ? `Duration: ${duration} (ongoing)` : `Duration: ${duration}`);

  const lines: string[] = [];
  lines.push(`🚨 Problem: ${name}`);
  if (problem.display_id) lines.push(`ID: ${problem.display_id}`);
  lines.push(`Status: ${status}`);
  lines.push(`Category: ${category}`);
  if (sev) lines.push(sev);
  if (started)      lines.push(`Started: ${started}`);
  if (durationLine) lines.push(durationLine);

  const affected = affectedEntityLines(problem);
  if (affected.length > 0) {
    lines.push("");
    lines.push(...affected);
  }

  const rc = rootCauseLine(problem);
  if (rc) {
    lines.push("");
    lines.push(rc);
  }

  if (link) {
    lines.push("");
    lines.push("Open in Dynatrace (login if prompted, then search by ID in Operation Lifecycle):");
    lines.push(link);
    lines.push("");
    lines.push("📱 Tip: if the link shows an error inside WhatsApp, tap the ⋯ menu (top-right) → \"Open in Safari\" (iOS) or \"Open in Chrome\" (Android). The system browser has your Dynatrace session and will log you in normally.");
  }

  return lines.join("\n");
}

/** Send-via-WhatsApp action. Native button styling matches the other
 *  row actions (Copy ID, Share link, Open Problem App).
 *
 *  Platform handling:
 *    • Mobile / tablet → use the Web Share API (`navigator.share`) when
 *      available. This is the ONLY reliable way to deliver multi-line
 *      text + URL to WhatsApp on iOS: the OS hands the entire payload
 *      to the picked target as a structured share intent. Both
 *      `wa.me/?text=…` (universal link) and `whatsapp://send?text=…`
 *      (custom scheme) were empirically stripping the surrounding text
 *      when the body contained a URL — WhatsApp's URL handler turns the
 *      whole message into a "URL share" type and discards the
 *      neighbouring lines. The Web Share API bypasses that path
 *      entirely because the OS delivers `text` to WhatsApp via its
 *      Share Extension, not through the URL scheme.
 *
 *      Fallback for browsers without `navigator.share` (older Chrome
 *      on Android, in-app browsers that strip the API): we still
 *      navigate to `whatsapp://send?text=…` so the user gets *some*
 *      WhatsApp handoff, even if the body is truncated.
 *
 *      Trade-off: tapping the button on iOS now opens the OS share
 *      sheet first; the user picks "WhatsApp" from the icons row,
 *      then WhatsApp opens with the full text pre-filled. One extra
 *      tap, but it's the only way the body actually arrives.
 *
 *    • Desktop → button that opens an inline disclosure with two
 *      choices: WhatsApp Desktop (`whatsapp://send?text=...` URI
 *      scheme) or WhatsApp Web (`https://web.whatsapp.com/...`).
 *      Both desktop targets preserve the multi-line body fine (the
 *      URL-handler stripping behaviour is iOS-specific), so the
 *      desktop path doesn't need the Web Share API workaround. */
export const ShareWhatsApp: React.FC<ShareWhatsAppProps> = ({ problem }) => {
  const { isMobileOrTablet } = useDevice();
  const messageText = buildMessageText(problem);
  // Mobile path needs the URL separately so it can pre-fill the
  // WhatsApp compose with just the link (body goes via clipboard).
  const problemUrl  = buildProblemLink(problem.display_id);

  if (isMobileOrTablet) {
    return <MobileShareButton messageText={messageText} problemUrl={problemUrl} />;
  }

  // Desktop path — button that toggles a small two-option menu.
  // Desktop WhatsApp doesn't strip body+URL, so we send the whole
  // payload in the URL scheme as before — confirmed working by user
  // testing in 0.0.72.
  return <DesktopShareMenu encodedText={encodeURIComponent(messageText)} />;
};

/** Mobile-only share button.
 *
 *  Background: iOS WhatsApp's URL-scheme handler (`whatsapp://send`
 *  and `wa.me/?text=`) auto-detects URLs in the `text` param and
 *  converts the entire message into a "URL share" type, discarding
 *  the surrounding body. Desktop WhatsApp (Mac/Windows/Web) doesn't
 *  do this — that's why the desktop chooser works perfectly. And
 *  the Web Share API (`navigator.share`) would preserve the body,
 *  but it's gated by the `web-share` permission policy which the
 *  AppEngine iframe shell doesn't grant — calls throw NotAllowedError.
 *
 *  Workaround on mobile (the design that finally works):
 *    1. Try `navigator.share` first — covers the off-chance the
 *       iframe gains the permission later, or the app gets opened
 *       outside an iframe.
 *    2. On failure → copy the FULL message (body + URL + tip) to
 *       the clipboard via `navigator.clipboard.writeText`, then
 *       open WhatsApp with the URL pre-filled in the compose field.
 *    3. Render a fixed-position toast at the bottom of the screen
 *       instructing the user to long-press WhatsApp's compose and
 *       tap "Paste" — that injects the body in the chat as a normal
 *       compose (no URL detection runs on already-typed text), so
 *       the recipient gets the WHOLE message intact.
 *
 *  Why this works: the URL-strip behaviour is a parse-time decision
 *  WhatsApp makes when handling the share intent. Manual paste into
 *  the compose field bypasses that path — the text is already inside
 *  the composer when WhatsApp considers it, so multi-line body + URL
 *  ship together as a normal compose message.
 *
 *  Even if the user forgets to paste, the URL is still in the
 *  compose (from the URL scheme pre-fill), so at the very least the
 *  recipient gets the deep-link. */
const MobileShareButton: React.FC<{ messageText: string; problemUrl: string | null }> = ({
  messageText,
  problemUrl,
}) => {
  const [showHint, setShowHint] = useState(false);
  const hintTimeoutRef = useRef<number | null>(null);
  // The URL scheme used to open WhatsApp. When we have a deep-link
  // URL, pre-fill the compose with it so the user gets SOMETHING in
  // the message even if they skip the paste step. When we don't,
  // open WhatsApp's empty share intent so the user can paste freely.
  const whatsappHref = problemUrl
    ? `whatsapp://send?text=${encodeURIComponent(problemUrl)}`
    : "whatsapp://send";

  // Cancel any pending hint-hide timeout on unmount.
  useEffect(() => () => {
    if (hintTimeoutRef.current) window.clearTimeout(hintTimeoutRef.current);
  }, []);

  const openWhatsapp = () => {
    // Programmatic anchor click — same as the user tapping the
    // original `<a>`. Using window.location.href would navigate
    // THIS iframe to the protocol scheme, which AppEngine's sandbox
    // blocks (no top-level nav permission). A real anchor click
    // bubbles to the browser's URL-scheme dispatcher and reliably
    // opens WhatsApp.
    const a = document.createElement("a");
    a.href = whatsappHref;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const flashHint = () => {
    setShowHint(true);
    if (hintTimeoutRef.current) window.clearTimeout(hintTimeoutRef.current);
    // 7 s is long enough for the user to read the hint, switch to
    // WhatsApp, pick a contact, and reach the compose field before
    // the toast self-dismisses.
    hintTimeoutRef.current = window.setTimeout(() => setShowHint(false), 7000);
  };

  const onClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Plan A — Web Share API. Works only if the iframe was embedded
    // with `allow="web-share"`. AppEngine doesn't currently set
    // that, so this almost always falls through to plan B; but if
    // the embedding ever changes we'll get the "perfect" path back
    // for free.
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ text: messageText });
        return;
      } catch (err: unknown) {
        const name = (err as { name?: string })?.name;
        // User cancelled the iOS share sheet → bail without re-opening
        // WhatsApp behind their back.
        if (name === "AbortError") return;
        // Anything else (NotAllowedError from iframe restriction,
        // etc.) → fall through to Plan B.
      }
    }

    // Plan B — copy full body to clipboard, open WhatsApp with URL
    // pre-filled. User long-presses + pastes to inject the body.
    let clipboardOk = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(messageText);
        clipboardOk = true;
      }
    } catch {
      // Clipboard API may reject (insecure context, permission, etc.).
      // We continue anyway — the user at least gets the URL via the
      // WhatsApp scheme; they lose the body if clipboard failed.
    }

    if (clipboardOk) flashHint();
    openWhatsapp();
  };

  return (
    <>
      <a
        className="neo-row-act"
        href={whatsappHref}
        onClick={onClick}
        target="_blank"
        rel="noopener noreferrer"
        title="Share via WhatsApp"
      >
        <span className="neo-row-act-icon" aria-hidden="true">▤</span>
        <span>WhatsApp</span>
      </a>
      {showHint && (
        <div className="neo-share-wa-toast" role="status" aria-live="polite">
          <span className="neo-share-wa-toast-icon" aria-hidden="true">📋</span>
          <span className="neo-share-wa-toast-body">
            <strong>Details copied to clipboard</strong>
            <br />
            Long-press WhatsApp's message field and tap <em>Paste</em> to include the full incident summary before sending.
          </span>
        </div>
      )}
    </>
  );
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
