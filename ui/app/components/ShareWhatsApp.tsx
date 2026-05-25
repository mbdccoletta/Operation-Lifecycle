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
function buildProblemLink(): string | null {
  try {
    const url = getEnvironmentUrl();
    if (!url) return null;
    // Ensure trailing slash so the URL renders as a clean root link
    // ("…dynatrace.com/" not "…dynatrace.com"); both work but a
    // trailing slash matches what the user types in a browser bar.
    return url.endsWith("/") ? url : `${url}/`;
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
function buildEncodedText(problem: Problem): string {
  const link = buildProblemLink();
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

  return encodeURIComponent(lines.join("\n"));
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
export const ShareWhatsApp: React.FC<ShareWhatsAppProps> = ({ problem }) => {
  const { isMobileOrTablet } = useDevice();
  const encodedText = buildEncodedText(problem);

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
