// ─── TIMEZONE CONVENTION ─────────────────────────────────────────
// Most internal timestamp displays still render in **UTC** to match
// the legacy native Davis Problems list (chart axis labels, comment
// timestamps, swimlane, sparkline, ProblemTimelineCard tooltips
// that explicitly say "UTC"). On-call engineers cross-referencing
// our app against the native UI find this useful.
//
// HOWEVER — `formatStartedDate` (used by the "Started" column in
// the list and by ShareWhatsApp) switched to LOCAL in v0.0.183.
// The Strato problem-detail header already renders local time, so
// keeping the list UTC produced a confusing 3-hour gap inside our
// own app between the "Started" column and the "Duration" column
// on the same row. User: "Started está errado, faz 17 min que foi
// aberto."
//
// Rule of thumb for new surfaces:
//   • Tooltip / metadata explicitly labelled "UTC" → keep UTC.
//   • Inline value next to a "duration" / "elapsed" reading → use
//     LOCAL so the math reads correctly at a glance.
// ─────────────────────────────────────────────────────────────────
export function formatDate(isoString: string): string {
  if (!isoString) return "";
  return new Date(isoString).toLocaleString(undefined, { timeZone: "UTC" });
}

export function formatRelativeTime(isoString: string): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    AVAILABILITY: "Availability",
    ERROR: "Error",
    SLOWDOWN: "Slowdown",
    RESOURCE: "Resource",
    RESOURCE_CONTENTION: "Resource Contention",
    CUSTOM: "Custom",
  };
  return labels[category] || category;
}

export function getStatusLabel(status: string): string {
  return status === "ACTIVE" ? "Active" : "Closed";
}

export function getCategoryColor(category: string): string {
  const colors: Record<string, string> = {
    AVAILABILITY: "critical",
    ERROR: "warning",
    SLOWDOWN: "neutral",
    RESOURCE: "info",
    CUSTOM: "success",
  };
  return colors[category] || "neutral";
}

// Unicode glyph used in the list view to mirror Dynatrace's category icons.
// Pure text so we don't need to ship an icon set.
export function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    AVAILABILITY:           "⊘",
    ERROR:                  "⊗",
    SLOWDOWN:               "◷",
    RESOURCE_CONTENTION:    "▤",
    CUSTOM_ALERT:           "◆",
    MONITORING_UNAVAILABLE: "◎",
  };
  return icons[category] || "●";
}

// Formats event.start into the same shape Dynatrace uses in the list
// (locale-aware date + 24-hour time).
//
// 0.0.183 — switched to LOCAL timezone. Originally this forced UTC
// to match the native Davis Problems convention, but the Strato
// problem-detail header (rendered by the platform component
// library) shows local time, so cross-referencing list ↔ detail
// inside our own app surfaced a 3-hour discrepancy that
// dominated the user's confusion. User: "Started está errado, faz
// 17 min que foi aberto." Local time keeps "Started …" lined up
// with the "Duration: 17 min" column on the same row.
//
// Tooltips on the Problem Timeline page that explicitly say "UTC"
// in their text (ProblemTimelineCard L131/L152/L242) stay in UTC
// since they are LABELLED — those carry the cross-tenant reference
// case described in the file header.
export function formatStartedDate(isoString: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleString(undefined, {
    day:    "numeric",
    month:  "short",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

// Long-form duration matching Dynatrace's list view: "1 min", "1 h 33 min",
// "3 d 14 h", "2 w 4 d". Uses the largest two units only.
export function formatDuration(startIso: string, endIso?: string): string {
  if (!startIso) return "";
  const start = new Date(startIso).getTime();
  const end   = endIso ? new Date(endIso).getTime() : Date.now();
  const ms    = Math.max(0, end - start);
  const mins  = Math.floor(ms / 60000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const restMin = mins % 60;
    return restMin > 0 ? `${hours} h ${restMin} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    const restH = hours % 24;
    return restH > 0 ? `${days} d ${restH} h` : `${days} d`;
  }
  const weeks = Math.floor(days / 7);
  const restD = days % 7;
  return restD > 0 ? `${weeks} w ${restD} d` : `${weeks} w`;
}

/** Compact "Nd Nh Nm" duration formatter that takes raw milliseconds
 *  instead of ISO strings — used by the per-problem metric chips
 *  and the TeamMetricsCard tooltip, both of which already have ms
 *  in hand and don't need the ISO round-trip.
 *
 *  Returns "—" for any non-finite, negative, or null input so
 *  callers can render the result directly without guards. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const restM = min % 60;
    return restM > 0 ? `${hr} h ${restM} m` : `${hr} h`;
  }
  const d = Math.floor(hr / 24);
  const restH = hr % 24;
  return restH > 0 ? `${d} d ${restH} h` : `${d} d`;
}

/** Inverse of `formatDurationMs` — parses lightweight human-typed
 *  durations into milliseconds. Accepts a single unit-suffixed token
 *  ("5m", "1.5h", "2d", "30s", "100ms") OR a compound form with up
 *  to two tokens ("1h 30m", "1d 6h"). Whitespace is optional.
 *
 *  Returns `null` for unparseable input so callers can keep the
 *  user's text in the input box while suppressing the filter until
 *  it becomes valid. Used by the metric value/range filter popover
 *  on the Incidents list.
 *
 *  Why a dedicated parser instead of relying on a duration library?
 *  This UI only needs single-token + simple compound forms; pulling
 *  a dep (or a 5 KB date-fns subpath) just for that is overkill. */
export function parseDurationMs(text: string): number | null {
  if (!text) return null;
  const cleaned = text.trim().toLowerCase();
  if (!cleaned) return null;
  // Match every "<number><unit>" pair anywhere in the string.
  // Allow `ms`, `s`, `m`, `h`, `d`, `w`. Reject tokens that don't
  // include a unit (no bare "30") — without a unit we'd have to
  // guess minutes vs hours and silently mis-filter the user's data.
  const tokenRe = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\b/g;
  const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  let total = 0;
  let matched = 0;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    // Reject if there's non-whitespace between tokens — e.g.
    // "1h foo 2m" would otherwise sum to 1h2m, hiding typos.
    const gap = cleaned.slice(lastEnd, match.index);
    if (gap.trim().length > 0) return null;
    total += parseFloat(match[1]) * UNIT_MS[match[2]];
    lastEnd = tokenRe.lastIndex;
    matched++;
  }
  // Trailing junk after the last token → invalid.
  if (cleaned.slice(lastEnd).trim().length > 0) return null;
  if (matched === 0) return null;
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

// Classifies a problem's impact band(s) based on the affected entity IDs.
// Mirrors the Davis Problems app, which groups entities into three buckets:
//   • Frontends      — APPLICATION* (web / mobile / generic application)
//   • Services       — SERVICE*
//   • Infrastructure — everything else (HOST, PROCESS_GROUP*, DISK, …)
// Returns the primary impact + extra count + total list so the UI can
// render "Frontends + 1" the same way Davis does.
export function getImpacts(entityIds?: string[]): string[] {
  if (!entityIds || entityIds.length === 0) return [];
  const seen = new Set<string>();
  for (const id of entityIds) {
    const t = entityTypeOf(id);
    if (t.startsWith("APPLICATION") || t === "WEB_APPLICATION" || t === "MOBILE_APPLICATION") {
      seen.add("Frontends");
    } else if (t.startsWith("SERVICE")) {
      seen.add("Services");
    } else {
      seen.add("Infrastructure");
    }
  }
  // Stable display order — most user-facing buckets first.
  const order = ["Frontends", "Services", "Infrastructure"];
  return Array.from(seen).sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
const IMPACT_ICONS: Record<string, string> = {
  Frontends:      "◎",
  Services:       "⌬",
  Infrastructure: "☁",
};
// Backwards-compatible signature — derives impact from IDs and returns
// the primary bucket plus how many additional buckets are present.
export function getImpactLabel(entityIds?: string[]): { label: string; icon: string; extra: number } | null {
  const impacts = getImpacts(entityIds);
  if (impacts.length === 0) return null;
  return { label: impacts[0], icon: IMPACT_ICONS[impacts[0]] || "☁", extra: impacts.length - 1 };
}

// Extract the entity type from a Dynatrace monitored-entity ID. Entity IDs
// follow the pattern "<TYPE>-<HEX>" (e.g. "SERVICE-9E03EFC8...").
export function entityTypeOf(id: string): string {
  if (!id) return "OTHER";
  const dash = id.indexOf("-");
  return dash > 0 ? id.slice(0, dash) : "OTHER";
}

// Compact display ID for a Dynatrace entity (last segment, first 8 chars)
// — keeps the UI readable while remaining a stable identifier.
export function shortEntityId(id: string): string {
  if (!id) return "";
  const dash = id.lastIndexOf("-");
  const tail = dash > 0 ? id.slice(dash + 1) : id;
  return tail.length > 8 ? tail.slice(0, 8) : tail;
}

// Human-readable label for the entity type (Title Case, no underscores).
export function entityTypeLabel(type: string): string {
  if (!type) return "Other";
  return type
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Unicode glyph used in the list view to mark each entity-type group header.
export function entityTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    SERVICE:                  "◆",
    APPLICATION:              "◎",
    WEB_APPLICATION:          "◎",
    MOBILE_APPLICATION:       "◎",
    HOST:                     "▤",
    HOST_GROUP:               "▤",
    PROCESS_GROUP:            "⌂",
    PROCESS_GROUP_INSTANCE:   "⌂",
    DATABASE:                 "◫",
    DATABASE_SERVICE:         "◫",
    KUBERNETES_CLUSTER:       "⬢",
    KUBERNETES_NODE:          "⬡",
    CONTAINER_GROUP:          "▣",
    DISK:                     "◉",
    NETWORK_INTERFACE:        "◈",
    SYNTHETIC_TEST:           "◐",
    SYNTHETIC_TEST_STEP:      "◐",
  };
  return icons[type] || "●";
}
