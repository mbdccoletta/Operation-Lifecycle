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
import { buildAppShareUrl } from "../utils/dynatrace-links";

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

/** Build a link to the problem inside Problem Lifecycle.
 *
 *  Thin wrapper around the shared `buildAppShareUrl` helper in
 *  utils/dynatrace-links.ts so the WhatsApp share + the "Share
 *  link" copy button (in ProblemActions.tsx) emit IDENTICAL URLs.
 *  Single source of truth means a fix there propagates to both
 *  surfaces — historically these drifted (Share link was still
 *  using `window.location.href` while WhatsApp had switched to
 *  `getEnvironmentUrl()` for tenant resolution, see 0.0.97).
 *
 *  Falls back to the tenant ROOT when displayId is missing —
 *  better than a dangling /focus= deep-link that 404s. The WhatsApp
 *  body text still carries the searchable problem name in that
 *  case so the recipient can find it manually.
 *
 *  WhatsApp-specific caveat: even with the tenant URL, the link
 *  still fails INSIDE WhatsApp's iOS in-app browser (WKWebView,
 *  no SSO cookie). The "📱 Tip" line in `buildEncodedText` tells
 *  the recipient to open the link in Safari/Chrome where the
 *  cookie does exist. */
function buildProblemLink(displayId: string | undefined): string | null {
  const url = buildAppShareUrl(displayId);
  if (url) return url;
  // Fallback path — no displayId. Emit the tenant root so the
  // WhatsApp body at least has a recovery URL to the launcher.
  try {
    const base = getEnvironmentUrl();
    if (!base) return null;
    const root = base.endsWith("/") ? base.slice(0, -1) : base;
    return `${root}/`;
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

/** The share message is composed of two SEMANTIC HALVES, returned
 *  separately so the mobile + desktop send paths can mix them
 *  differently:
 *
 *  - body:   problem details (name, ID, status, category, severity,
 *            timing, affected entities, root cause). Self-contained
 *            triage payload — even without the URL, the recipient
 *            knows what the incident is and can search by ID in
 *            their own Dynatrace.
 *  - footer: "Open in Dynatrace:" prompt + URL + the 📱 Tip about
 *            recovering from the WhatsApp in-app browser. Pure
 *            access affordance — only useful if the recipient
 *            wants to actually open the link.
 *
 *  Why split:
 *    Desktop WhatsApp ships body + footer together as one message
 *    via the URL scheme — no problem there.
 *    Mobile WhatsApp (iOS specifically) strips text around a URL
 *    when the share intent arrives via `whatsapp://send?text=…`.
 *    So we send ONLY the body via the scheme (no URL → no strip
 *    trigger) and put the footer (URL + tip) on the CLIPBOARD.
 *    User pastes at the end of compose, and the recipient gets
 *    both halves intact. If user forgets to paste, the recipient
 *    still gets the body — never a "share with nothing in it"
 *    failure mode. */
interface MessageParts {
  body:   string;
  footer: string;
}

function buildMessageParts(problem: Problem): MessageParts {
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

  const bodyLines: string[] = [];
  bodyLines.push(`🚨 Problem: ${name}`);
  if (problem.display_id) bodyLines.push(`ID: ${problem.display_id}`);
  bodyLines.push(`Status: ${status}`);
  bodyLines.push(`Category: ${category}`);
  if (sev) bodyLines.push(sev);
  if (started)      bodyLines.push(`Started: ${started}`);
  if (durationLine) bodyLines.push(durationLine);

  const affected = affectedEntityLines(problem);
  if (affected.length > 0) {
    bodyLines.push("");
    bodyLines.push(...affected);
  }

  const rc = rootCauseLine(problem);
  if (rc) {
    bodyLines.push("");
    bodyLines.push(rc);
  }

  // Footer = the access-affordance half. Empty when no URL could be
  // resolved (rare — getEnvironmentUrl can fail). The leading blank
  // line lives in the footer (not the body) so when desktop emits
  // "body + '\n' + footer" the visual separator appears cleanly,
  // and when mobile sends body alone the body doesn't end with
  // dangling whitespace.
  const footerLines: string[] = [];
  if (link) {
    footerLines.push("Open in Dynatrace (login if prompted, then search by ID in Problem Lifecycle):");
    footerLines.push(link);
    footerLines.push("");
    footerLines.push("📱 Tip: if the link shows an error inside WhatsApp, tap the ⋯ menu (top-right) → \"Open in Safari\" (iOS) or \"Open in Chrome\" (Android). The system browser has your Dynatrace session and will log you in normally.");
  }

  return {
    body:   bodyLines.join("\n"),
    footer: footerLines.join("\n"),
  };
}

/** Convenience for the desktop path which sends both halves in one
 *  shot — same payload the previous single-string buildMessageText
 *  used to return. */
function buildFullMessageText(problem: Problem): string {
  const { body, footer } = buildMessageParts(problem);
  return footer ? `${body}\n\n${footer}` : body;
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

  if (isMobileOrTablet) {
    // Mobile path: body in compose, footer (URL + tip) in clipboard.
    // See MobileShareButton docblock for the rationale — short version,
    // iOS WhatsApp's URL-scheme handler strips text around URLs, so we
    // route the URL-bearing half through the clipboard instead of
    // through the `text=` param.
    const { body, footer } = buildMessageParts(problem);
    return <MobileShareButton bodyText={body} clipboardText={footer} />;
  }

  // Desktop path — button that toggles a small two-option menu.
  // Desktop WhatsApp doesn't strip body+URL, so we send the whole
  // payload in the URL scheme as before — confirmed working by user
  // testing in 0.0.72.
  const fullText = buildFullMessageText(problem);
  return <DesktopShareMenu encodedText={encodeURIComponent(fullText)} />;
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
const MobileShareButton: React.FC<{
  /** Plain-text incident summary that goes into the WhatsApp
   *  compose field. Contains NO URL — that's deliberate, so iOS
   *  WhatsApp's URL-handler heuristic doesn't fire and strip the
   *  body. The recipient sees the full triage payload immediately
   *  when the message arrives. */
  bodyText: string;
  /** "Open in Dynatrace: <URL>" + Tip footer. Goes onto the
   *  clipboard so the user can append it to the compose with a
   *  long-press → Paste. If they forget to paste, the body still
   *  carries enough info (problem name, ID, severity, etc.) for
   *  the recipient to triage — they just don't get the deep-link. */
  clipboardText: string;
}> = ({ bodyText, clipboardText }) => {
  // `clipboardReady` controls the confirmation modal. We show it
  // AFTER the clipboard write succeeds and BEFORE opening WhatsApp,
  // so the user always sees the "paste in WhatsApp" instructions
  // and explicitly acknowledges before leaving the app.
  const [clipboardReady, setClipboardReady] = useState(false);
  // Body pre-filled in compose via the URL scheme. iOS WhatsApp
  // strips text when a URL is detected in `text=`, but the body
  // we send here is plain-text only — no URL → no strip trigger.
  const whatsappHref = `whatsapp://send?text=${encodeURIComponent(bodyText)}`;

  const openWhatsapp = () => {
    setClipboardReady(false);
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

  const onClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();

    // Plan A — Web Share API. Works only if the iframe was embedded
    // with `allow="web-share"`. AppEngine doesn't currently set
    // that, so this almost always falls through to plan B; but if
    // the embedding ever changes we'll get the "perfect" path back
    // for free. We hand the OS the FULL text (body + footer) here
    // because the Web Share API doesn't suffer from the URL-strip
    // bug — the OS preserves the payload verbatim.
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({
          text: clipboardText ? `${bodyText}\n\n${clipboardText}` : bodyText,
        });
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

    // Plan B — copy ONLY the footer (URL + tip) to clipboard. Body
    // is already going via the URL scheme (no URL in it → no iOS
    // strip), so the clipboard only needs to carry the missing half.
    // User pastes at the end of compose to complete the message.
    let clipboardOk = false;
    try {
      if (clipboardText && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        clipboardOk = true;
      }
    } catch {
      // Clipboard API may reject (insecure context, permission, etc.).
    }

    if (clipboardOk) {
      // Show the modal — user reads the instructions, taps "Open
      // WhatsApp" when ready, and the click handler launches the
      // scheme then.
      setClipboardReady(true);
    } else {
      // Clipboard failed OR no footer to copy (rare). Skip the modal
      // and just open WhatsApp with the body pre-filled — recipient
      // still gets the triage payload, just without the deep-link.
      openWhatsapp();
    }
  };

  const onCancel = () => setClipboardReady(false);

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
      {clipboardReady && (
        <PasteInstructionsModal
          onConfirm={openWhatsapp}
          onCancel={onCancel}
        />
      )}
    </>
  );
};

/** Modal shown after clipboard copy succeeds, BEFORE WhatsApp launches.
 *  Blocks until the user taps "Open WhatsApp" or dismisses, so the
 *  paste-into-WhatsApp instruction is impossible to miss.
 *
 *  Why a blocking modal instead of a toast: the previous toast
 *  auto-dismissed after 7 s and users found themselves already inside
 *  WhatsApp before they'd read it — they'd send the URL-only message
 *  not realizing the full body was sitting in their clipboard. A
 *  blocking modal forces the read.
 *
 *  Implementation notes:
 *    • Backdrop click cancels (matches platform "tap outside to
 *      dismiss" conventions for modals).
 *    • Escape key cancels (keyboard parity for tablet users with
 *      external keyboards).
 *    • Primary action is the GREEN "Open WhatsApp" button so it
 *      reads as the obvious next step, not a destructive choice. */
const PasteInstructionsModal: React.FC<{
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ onConfirm, onCancel }) => {
  // Escape-key handler — close the modal without launching WhatsApp.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="neo-share-wa-modal-backdrop"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="neo-share-wa-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="neo-share-wa-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="neo-share-wa-modal-icon" aria-hidden="true">🔗</div>
        <h3 id="neo-share-wa-modal-title" className="neo-share-wa-modal-title">
          Dynatrace link copied to clipboard
        </h3>
        <p className="neo-share-wa-modal-intro">
          WhatsApp will open with the <strong>problem summary already
          filled in</strong> (name, ID, severity, timing, affected entities,
          root cause). To complete the message with the deep-link, follow
          these steps after tapping <strong>Open WhatsApp</strong>:
        </p>
        <ol className="neo-share-wa-modal-steps">
          <li>Pick a contact or group</li>
          <li>
            <strong>Long-press at the end of the pre-filled message</strong>
          </li>
          <li>
            Tap <em>Paste</em> — the Dynatrace link will be appended
          </li>
          <li>Tap <em>Send</em></li>
        </ol>
        <p className="neo-share-wa-modal-foot">
          If you skip the paste step, the recipient still gets the full
          incident summary — they just won't have the one-click link to
          open it in Dynatrace.
        </p>
        <div className="neo-share-wa-modal-actions">
          <button
            type="button"
            className="neo-share-wa-modal-btn neo-share-wa-modal-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="neo-share-wa-modal-btn neo-share-wa-modal-btn-primary"
            onClick={onConfirm}
            autoFocus
          >
            Open WhatsApp
          </button>
        </div>
      </div>
    </div>
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
