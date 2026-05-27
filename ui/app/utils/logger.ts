// Tiny structured logger.
//
// Why this exists:
//   • Replaces ad-hoc `console.error(...)` scattered across the
//     codebase with a single shape that's easy to grep, easy to
//     redact, and easy to forward (RUM, Sentry, internal beacon)
//     by swapping `emit()` in one place.
//   • Every entry carries the same metadata envelope — app
//     version, session id, ISO timestamp, category — so future
//     log aggregation can correlate without parsing free-form
//     strings.
//   • Keeps the API thin (`info / warn / error`) so calling code
//     stays readable.
//
// Transport: today we log to the browser console. The `emit()`
// function is the single integration seam — point it at
// `@dynatrace-sdk/rum` (or any beacon) later without touching
// any callsite.

// App version — kept in sync with `app.config.json` at the repo
// root. Hardcoded here (rather than imported) to avoid making the
// UI's `rootDir` straddle the parent JSON file, which would
// complicate the dt-app build. Bump this whenever `app.version`
// in app.config.json is bumped — the deploy check below will
// flag a drift in code review if forgotten.
const APP_VERSION = "0.0.172";

export type LogLevel = "info" | "warn" | "error";

export interface LogContext {
  /** Short tag for the source area, e.g. `"useProblems"`,
   *  `"comments"`, `"swimlane"`. Lets a future log dashboard
   *  filter without parsing message text. */
  category: string;
  /** Free-form structured fields. Avoid putting PII or query
   *  payloads here — the redaction pass below assumes everything
   *  is safe to ship. */
  [key: string]: unknown;
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  appVersion: string;
  sessionId: string;
  message: string;
  context: LogContext;
}

// One session id per page load — survives across all hooks but
// rotates on hard refresh. Good middle ground between "every call
// is anonymous" and "the same id persists for weeks".
const SESSION_ID = (() => {
  // Use crypto.randomUUID where available; fall back to a short
  // pseudo-random string for ancient runtimes (test env mainly).
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
  } catch {
    /* swallow — fall through to fallback */
  }
  return `s_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
})();

// Aliased so other modules can read the constant without
// peeking inside this file's internals.
export const APP_VERSION_TAG = APP_VERSION;

function emit(entry: LogEntry): void {
  // Today: console. Later: swap or fan-out to a beacon.
  const tag = `[problems-hub:${entry.context.category}]`;
  const payload = {
    ts: entry.ts,
    sessionId: entry.sessionId,
    appVersion: entry.appVersion,
    ...entry.context,
  };
  // eslint-disable-next-line no-console
  const fn = entry.level === "error" ? console.error
           : entry.level === "warn"  ? console.warn
           : console.info;
  fn(tag, entry.message, payload);
}

function log(level: LogLevel, message: string, context: LogContext): void {
  emit({
    ts: new Date().toISOString(),
    level,
    appVersion: APP_VERSION,
    sessionId: SESSION_ID,
    message,
    context,
  });
}

export const logger = {
  info(message: string, context: LogContext): void {
    log("info", message, context);
  },
  warn(message: string, context: LogContext): void {
    log("warn", message, context);
  },
  error(message: string, context: LogContext): void {
    log("error", message, context);
  },
  /** Session id for the current page load. Stable across the
   *  whole session; used as a correlation id when a single user
   *  action triggers multiple hooks. Useful in bug reports. */
  get sessionId(): string {
    return SESSION_ID;
  },
};
