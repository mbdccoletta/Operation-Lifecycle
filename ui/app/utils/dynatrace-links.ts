import { getAppLink } from "@dynatrace-sdk/navigation";
import type { Problem } from "../hooks/useProblems";

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

/** App IDs for the two focussed Davis surfaces we link to on mobile
 *  (where the full native Davis Problems page renders with a broken
 *  layout — see ProblemActions.tsx mobile branch for the user
 *  rationale).
 *
 *  Both IDs are best-effort against the modern Davis app suite. If
 *  a tenant doesn't have one of these apps installed,
 *  buildXxxUrl below returns `null` and the caller skips rendering
 *  the corresponding button. */
const PROBLEM_GRAPH_APP_ID = "dynatrace.davis.problems"; // graph view of Davis Problems (?view=graph)
const DAVIS_COPILOT_APP_ID = "dynatrace.davis.copilot";  // AI explainer (Davis CoPilot)

/** Build a deep-link to the "Problem graph" view inside the modern
 *  Davis Problems app. Same root URL as `buildOfficialProblemUrl`
 *  but appends `?view=graph` so the topology tab is selected on
 *  arrival. Works around the broken mobile layout of the default
 *  /problem/<id> entry point — the graph view renders cleanly on
 *  small viewports because it's mostly canvas, not text-heavy
 *  paragraphs. */
export function buildProblemGraphUrl(problem: Problem | string): string | null {
  const base = buildOfficialProblemUrl(problem);
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("view", "graph");
  return u.toString();
}

/** Build a deep-link to Davis CoPilot with the problem context
 *  pre-loaded. CoPilot's AI then explains the problem in plain
 *  language — the user can read it directly without ever opening
 *  the native Davis Problems detail page.
 *
 *  Returns `null` when the CoPilot app isn't installed in the
 *  tenant (e.g. lower DPS tiers where Davis CoPilot is gated by
 *  licence). Caller renders no button in that case. */
export function buildExplainProblemUrl(problem: Problem | string): string | null {
  const isObj = typeof problem !== "string";
  // Cast via `unknown` first — Problem's narrow shape doesn't index
  // by arbitrary string, and we need to probe both the canonical
  // `davis_problem_id` and the legacy `event.id` (some tenants /
  // SDK versions hand back one but not the other).
  const rec: Record<string, unknown> = isObj
    ? (problem as unknown as Record<string, unknown>)
    : {};
  const id =
    (rec.davis_problem_id as string | undefined)
    || (rec["event.id"] as string | undefined)
    || (typeof problem === "string" ? problem : undefined);
  if (!id) return null;
  let rawLink: string;
  try {
    rawLink = getAppLink(DAVIS_COPILOT_APP_ID);
  } catch {
    return null;
  }
  const u = toCanonicalAppPath(rawLink);
  // Append the problem id as a query param so CoPilot picks up the
  // context. The exact param name varies across CoPilot versions —
  // we set BOTH the canonical `context` and the legacy `problem`
  // so the link works on a wider range of tenants without us
  // having to feature-detect at runtime.
  u.searchParams.set("context", `problem-${id}`);
  u.searchParams.set("problem", id);
  return u.toString();
}
// Make sure unused imports stay live for tree-shaking sanity in
// callers that pull the new helpers but not the old ones.
export { PROBLEM_GRAPH_APP_ID, DAVIS_COPILOT_APP_ID };
