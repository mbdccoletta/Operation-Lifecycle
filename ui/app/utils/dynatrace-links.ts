import { getAppLink } from "@dynatrace-sdk/navigation";
import { getEnvironmentUrl } from "@dynatrace-sdk/app-environment";
import type { Problem } from "../hooks/useProblems";

// ID of THIS app (Problem Lifecycle). Used by buildAppShareUrl to
// construct a deep-link back to ourselves with `?focus=P-####`.
// Keep this in sync with `app.id` in app.config.json.
const SELF_APP_ID = "my.problems.hub";

/** Build a deep-link to OUR app focused on the given problem.
 *
 *  Used by the "Share link" copy button and by the WhatsApp share
 *  flow — anywhere we want the recipient to land on this exact
 *  problem inside Problem Lifecycle (not the native Davis app, not
 *  the launcher root).
 *
 *  Critical detail: we MUST use `getEnvironmentUrl()` for the host,
 *  not `window.location.origin`. Inside the AppEngine iframe
 *  sandbox, `window.location.origin` is the per-app hashed origin
 *  (e.g. `xktbb3yiewy...prod3.apps.dynatrace.com`) — that URL is
 *  internal and DOESN'T route from outside. The user-visible tenant
 *  URL is what we need (`bwm98081.apps.dynatrace.com`), and only
 *  the SDK exposes it. This bit users in 0.0.66 when the WhatsApp
 *  share kept landing on a sandbox URL the recipient couldn't open;
 *  the Share link button had the same bug until 0.0.97 — see the
 *  TIMEZONE CONVENTION docblock pattern in utils/formatters.ts for
 *  why we centralise this. */
export function buildAppShareUrl(displayId: string | undefined): string | null {
  if (!displayId) return null;
  try {
    const base = getEnvironmentUrl();
    if (!base) return null;
    const root = base.endsWith("/") ? base.slice(0, -1) : base;
    return `${root}/ui/apps/${SELF_APP_ID}?focus=${encodeURIComponent(displayId)}`;
  } catch {
    return null;
  }
}

// App ID of the official Dynatrace problems app. Stable across tenants.
const DAVIS_PROBLEMS_APP_ID = "dynatrace.davis.problems";

/** DQL emits the cardinality part of `event.id` as a SIGNED int64.
 *  When the value's high bit is set it shows up here as a negative
 *  number (e.g. `-1648296689692632665_…V2`). The Davis Problems app
 *  expects the unsigned representation in its URL, so we re-encode
 *  negatives by adding 2^64. The rest of the composite
 *  (`_<timestamp>V<version>`) passes through unchanged. */
const UINT64 = 18446744073709551616n; // 2^64
function normalizeDavisProblemId(raw: string): string {
  if (!raw.startsWith("-")) return raw;
  // Split at the first underscore — only the leading bigint needs the
  // sign flip. If the format is unexpected, fall back to passing the
  // value through verbatim so we never block the link entirely.
  const underscore = raw.indexOf("_");
  const idPart = underscore === -1 ? raw : raw.slice(0, underscore);
  const suffix = underscore === -1 ? "" : raw.slice(underscore);
  try {
    const signed   = BigInt(idPart);
    const unsigned = signed < 0n ? signed + UINT64 : signed;
    return unsigned.toString() + suffix;
  } catch {
    return raw;
  }
}

/** `getAppLink` returns a URL like `/ui/openApp/<appId>` — the
 *  platform's shell-launcher route. Sub-paths under `/ui/openApp/`
 *  are ignored (the shell just opens the app and drops the rest), so
 *  we have to rewrite the prefix to `/ui/apps/<appId>` which is the
 *  canonical deep-link form that respects sub-routes like
 *  `/problem/<id>`. */
function toCanonicalAppPath(rawLink: string): URL {
  const u = new URL(rawLink, window.location.origin);
  u.pathname = u.pathname.replace(/\/ui\/openApp\//, "/ui/apps/");
  return u;
}

/**
 * Builds the deep-link URL to the official Davis Problems app for the
 * supplied problem.
 *
 * The Davis app routes individual problems under `/problem/<event.id>`
 * where `event.id` is the long composite identifier (e.g.
 * `3024535536893773453_1779198660000V2`) — NOT the human-friendly
 * `display_id` (P-####). We carry `event.id` through from DQL and use
 * it here; fall back to `display_id` only when `event.id` is missing
 * (unusual — but better than a broken link).
 *
 * The URL also receives `from` / `to` query params so the timeline
 * view inside Davis defaults to a sensible window. The `now()`
 * literals match what the official UI uses.
 *
 * Uses `getAppLink` so the URL resolves correctly on whichever tenant
 * the user is on. Returns `null` when no usable id is available or
 * the SDK can't resolve the Davis app (e.g. it isn't installed).
 */
export function buildOfficialProblemUrl(problem: Problem | string): string | null {
  // String argument = legacy callers passing a bare display_id (which
  // can't actually deep-link to a specific problem; the official Davis
  // route doesn't accept P-#### in the path). Treat it as "no
  // composite id available" so the caller falls back gracefully.
  const isObj = typeof problem !== "string";
  const p: Pick<Problem, "davis_problem_id" | "display_id"> & Record<string, unknown> =
    isObj ? (problem as Problem) : ({ display_id: problem as string } as Pick<Problem, "display_id">);
  // Be defensive about the field name: some tenants/SDK versions may
  // hand back the raw `event.id` key instead of the aliased
  // `davis_problem_id`. Try both before giving up.
  const rec = p as Record<string, unknown>;
  // Probe every candidate exposed in DQL (one is enough), then fall
  // back to the dotted raw key in case the alias is missing.
  const id =
    (rec.davis_problem_id as string | undefined)
    || (rec["event.id"] as string | undefined);
  if (!id || typeof id !== "string") return null;
  // Davis URL routes accept the raw signed-int64 form verbatim. The
  // alternative was converting to unsigned via 2^64 but that produced
  // "Problem not found" pages — confirmed empirically.
  let rawLink: string;
  try {
    rawLink = getAppLink(DAVIS_PROBLEMS_APP_ID);
  } catch {
    return null;
  }
  const u = toCanonicalAppPath(rawLink);
  u.pathname = u.pathname.replace(/\/$/, "") + "/problem/" + encodeURIComponent(id);
  // Same expressions the official Davis UI emits when navigating.
  if (!u.searchParams.has("from")) u.searchParams.set("from", "now()-7d");
  if (!u.searchParams.has("to"))   u.searchParams.set("to",   "now()");
  return u.toString();
}

/**
 * @deprecated Prefer rendering an `<a target="_blank" href>` with
 * `buildOfficialProblemUrl` so the browser treats the navigation as a
 * real user click — the AppEngine iframe is sandboxed without
 * `allow-top-navigation`, so `window.open(url, "_top")` is rejected
 * by the browser. As a fallback this helper now uses `_blank` which
 * the sandbox does allow (via the granted popup permission).
 */
export function openOfficialProblem(problem: Problem | string): void {
  const url = buildOfficialProblemUrl(problem);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// (The `sendOpenProblemIntent` / `buildOpenProblemIntentLink`
// helpers that used to live here were dead code — empirically the
// Davis app doesn't declare a matching intent, so we render an
// `<a href={buildOfficialProblemUrl(problem)} target="_blank">`
// instead, which the sandbox lets through via `allow-popups`.)

// HISTORY — deep-link drilldowns that DIDN'T work
// ────────────────────────────────────────────────
// 0.0.93 added `buildProblemGraphUrl()` (Davis Problems with
// `?view=graph`) and 0.0.93→94 kept `buildExplainProblemUrl()`
// (Davis CoPilot with `?context=problem-X` + `?problem=X`).
// Empirically NEITHER param is honoured by the target apps:
//   • Graph view → user lands on the standard /problem/<id> page,
//     same broken-on-mobile layout the workaround was meant to
//     avoid.
//   • CoPilot context → user lands on CoPilot's home screen with
//     no problem context loaded, defeating the "explain THIS
//     problem" UX.
// Both helpers removed in 0.0.95. The only Davis surface we
// deep-link to is the standard `buildOfficialProblemUrl()` above,
// which works (correct destination) even if the mobile rendering
// of that destination is rough. If Davis ever exposes officially
// documented context query params for CoPilot or a graph-view
// route for Problems, we can re-add focused helpers — but until
// then, ship what works and don't paper over broken UX with
// links that go to the wrong place.
