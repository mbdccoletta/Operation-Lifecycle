// Fetches all activity events that reference a single Davis problem id
// — comments, Davis CoPilot insights, and workflow / automation runs —
// and normalises them into one chronological feed.
//
// Schema mirrors what the native Davis Problems app does (validated
// against a HAR capture): two parallel queries with DIFFERENT tables
// and DIFFERENT field shapes, so each lives behind its own typed
// record interface here.
//
//   1. Annotations  → `dt.davis.events.snapshots` (CUSTOM_ANNOTATION).
//      Source of *Comments* and *Insights*.
//   2. Workflows    → `dt.system.events` (AUTOMATION_ENGINE provider).
//      Source of *Automation / remediation*.
//
// Both queries are wrapped in their own `useDql` so a failure on one
// (e.g. tenant has Workflows app disabled) doesn't drop the other.

import { useMemo } from "react";
import { useDql } from "@dynatrace-sdk/react-hooks";
import {
  buildAnnotationsQuery,
  buildWorkflowQuery,
  isDavisProblemId,
} from "../utils/problem-timeline-queries";
import { formatDuration } from "../utils/formatters";
import { useDemoMode } from "../contexts/DemoModeContext";

/** Coarse-grained category we surface in the UI. The exact
 *  `annotation.source` string from Davis lands in `sourceLabel` so
 *  users can still see the provenance — `category` is just for
 *  filtering + colour.
 *
 *  `lifecycle` is synthetic — we don't fetch it from DQL, we
 *  derive it from `event.start` / `event.end` on the problem
 *  record itself so the timeline visually anchors when the
 *  problem opened and closed. */
export type TimelineCategory = "comment" | "insight" | "automation" | "lifecycle" | "other";

export interface TimelineEvent {
  /** Stable key for React. Composed from timestamp + source id. */
  key: string;
  /** ISO timestamp of the event. */
  timestamp: string;
  category: TimelineCategory;
  /** Human-readable label for the source (e.g. "Davis CoPilot",
   *  "Problems App", workflow title). */
  sourceLabel: string;
  /** Display name (or fallback uuid prefix) of whoever caused the
   *  event. Empty for system / automation events. */
  actor?: string;
  /** Main body text. Comments → comment text. Insights → summary.
   *  Workflows → workflow title + state. May contain markdown. */
  body: string;
  /** Optional second-line metadata (e.g. "ERROR · run 2d4b0…",
   *  "SUCCESS · standard workflow"). */
  meta?: string;
  /** Optional click-through URL (annotation.url for some Davis
   *  annotation sources). */
  url?: string;
  /** The raw record from DQL — kept so the UI can offer a "show raw"
   *  expander for unrecognised events. */
  raw: Record<string, unknown>;
}

interface AnnotationRecord {
  "annotation.id"?: string;
  "annotation.problem_ids"?: string[] | string;
  "annotation.user_id"?: string | null;
  "annotation.source"?: string;
  "annotation.url"?: string | null;
  "event.name"?: string;
  "event.start"?: string;
  "event.description"?: string;
  [key: string]: unknown;
}

interface WorkflowRecord {
  start_time?: string;
  /** dt.automation_engine.workflow.id — aliased in the DQL `fields`. */
  id?: string;
  title?: string;
  /** State after the run finished: SUCCESS / ERROR / CANCELLED / … */
  state?: string;
  /** STANDARD / SIMPLE / etc. */
  type?: string;
  execution_id?: string;
  [key: string]: unknown;
}

function classifyAnnotation(source: string): TimelineCategory {
  const s = source.toLowerCase();
  // Davis-generated annotations → AI insights / RCA suggestions.
  if (s.includes("davis") || s.includes("copilot") || s.includes("ai")) return "insight";
  // User-authored comments via the Problems App (or our hub mirror).
  if (s.includes("problems app") || s.includes("problem app") || s.includes("hub")) return "comment";
  // Unknown provenance — keep it visible.
  return "other";
}

/** Truncate a UUID to its first segment so the UI can show *some*
 *  attribution without doing a separate /iam/users lookup. */
function shortenUserId(uid: string | null | undefined): string | undefined {
  if (!uid) return undefined;
  return uid.length > 12 ? `User ${uid.slice(0, 8)}` : uid;
}

function normaliseAnnotation(r: AnnotationRecord, idx: number): TimelineEvent {
  const source = String(r["annotation.source"] || "Annotation");
  const category = classifyAnnotation(source);
  const ts = String(r["event.start"] || "");
  const body = String(r["event.description"] || r["event.name"] || "(empty)");
  return {
    key: `ann:${r["annotation.id"] || idx}:${ts}`,
    timestamp: ts,
    category,
    sourceLabel: source,
    actor: shortenUserId(r["annotation.user_id"]),
    body,
    url: r["annotation.url"] || undefined,
    raw: r as Record<string, unknown>,
  };
}

function normaliseWorkflow(r: WorkflowRecord, idx: number): TimelineEvent {
  const title  = String(r.title || "Workflow");
  const state  = String(r.state || "").toUpperCase();
  const type   = String(r.type || "").toUpperCase();
  const execId = String(r.execution_id || "");
  const metaParts: string[] = [];
  if (state) metaParts.push(state);
  if (type)  metaParts.push(type.toLowerCase());
  if (execId) metaParts.push(`run ${execId.slice(0, 8)}…`);
  return {
    key: `wf:${r.id || idx}:${r.start_time || ""}`,
    timestamp: String(r.start_time || ""),
    category: "automation",
    sourceLabel: title,
    body: title + (state ? ` · ${stateEmoji(state)} ${state}` : ""),
    meta: metaParts.length ? metaParts.join(" · ") : undefined,
    raw: r as Record<string, unknown>,
  };
}

/** Lightweight visual sigil for the workflow run outcome — keeps the
 *  cell scannable in a long timeline without needing per-state CSS. */
function stateEmoji(state: string): string {
  if (state === "SUCCESS")  return "✓";
  if (state === "ERROR")    return "✕";
  if (state === "CANCELLED" || state === "CANCELED") return "⊘";
  if (state === "RUNNING")  return "…";
  return "·";
}

export interface UseProblemTimelineResult {
  events: TimelineEvent[];
  /** Counts per category — used by the filter chips so we don't have
   *  to scan the array twice in the component. */
  counts: Record<TimelineCategory, number>;
  loading: boolean;
  /** Source-specific errors. Reported separately so the UI can keep
   *  rendering whichever stream did succeed — common case: tenant
   *  hasn't granted `storage:system:read` so Automation 403s while
   *  Comments + Insights still come through fine. */
  annotationsError: Error | null;
  workflowsError: Error | null;
  /** `true` while the Davis problem id fails our format check. The
   *  caller should show an input error rather than firing DQL. */
  invalidId: boolean;
  refetch: () => void;
}

export interface ProblemLifecycle {
  /** ISO timestamp the problem first transitioned to ACTIVE. */
  startIso?: string;
  /** ISO timestamp the problem closed. Null/undefined while ACTIVE. */
  endIso?: string | null;
  /** Human-friendly problem title; rendered as the body for the
   *  "opened" cell so users see *what* started. */
  problemName?: string;
  /** Final status (ACTIVE / CLOSED). Determines the "resolved" vs
   *  "still open" framing on the close cell. */
  status?: string;
  /** Optional event.category, surfaced as the meta line on the
   *  open cell so the lifecycle marker is self-describing. */
  category?: string;
}

export interface UseProblemTimelineOptions {
  /** When `false`, both DQL queries are gated off via `useDql`'s
   *  `enabled` option. Used by `<ProblemTimelineCard>` to skip the
   *  network round-trip for collapsed cards in the multi-problem
   *  stack — see C2 in the perf audit. Defaults to `true`. */
  enabled?: boolean;
}

export function useProblemTimeline(
  davisProblemId: string,
  problemStartIso?: string,
  lifecycle?: ProblemLifecycle,
  opts: UseProblemTimelineOptions = {},
): UseProblemTimelineResult {
  const enabled = opts.enabled ?? true;
  const valid = isDavisProblemId(davisProblemId);
  // 0.0.198 — DPS Tier 5 demo gate. The Timeline page is the most
  // expensive lazy fan-out in the app (one annotations + one
  // workflow DQL per expanded problem). In demo sessions the
  // lifecycle/auto-generated events already give a meaningful
  // story; the live DQL adds nothing but DPS. Gating both
  // useDql calls here also covers the per-row activity feed
  // on Overview when ?demo=1 is on.
  const demo = useDemoMode();

  const annotationsParams = useMemo(() => ({
    query: buildAnnotationsQuery(davisProblemId, problemStartIso),
    requestTimeoutMilliseconds: 30_000,
    dtClientContext: "problems-hub:timeline:annotations",
  }), [davisProblemId, problemStartIso]);

  const workflowParams = useMemo(() => ({
    query: buildWorkflowQuery(davisProblemId, problemStartIso),
    requestTimeoutMilliseconds: 30_000,
    dtClientContext: "problems-hub:timeline:workflows",
  }), [davisProblemId, problemStartIso]);

  const annotationsQuery = useDql<AnnotationRecord>(annotationsParams, {
    // Gates: valid id + caller opted in + not demo. The `enabled`
    // toggle lets the multi-problem stack on the Timeline page
    // skip queries for collapsed cards — otherwise 100 cards =
    // 200 in-flight DQL.
    enabled: valid && enabled && !demo.enabled,
    staleTime: 30_000,
  });
  const workflowQuery = useDql<WorkflowRecord>(workflowParams, {
    enabled: valid && enabled && !demo.enabled,
    staleTime: 30_000,
  });

  // Synthetic lifecycle events derived from the problem record
  // itself. Kept separate from the DQL streams so they appear even
  // when annotations / workflows fail or are empty.
  const lifecycleEvents = useMemo<TimelineEvent[]>(() => {
    if (!lifecycle?.startIso) return [];
    const out: TimelineEvent[] = [];
    const cat = lifecycle.category ? lifecycle.category.replaceAll("_", " ").toLowerCase() : "";
    out.push({
      key: `lifecycle:open:${lifecycle.startIso}`,
      timestamp: lifecycle.startIso,
      category: "lifecycle",
      sourceLabel: "Problem opened",
      body: lifecycle.problemName || "Problem started",
      meta: cat ? `category · ${cat}` : undefined,
      raw: { kind: "lifecycle.open", iso: lifecycle.startIso } as Record<string, unknown>,
    });
    if (lifecycle.endIso) {
      out.push({
        key: `lifecycle:close:${lifecycle.endIso}`,
        timestamp: lifecycle.endIso,
        category: "lifecycle",
        sourceLabel: "Problem resolved",
        body: lifecycle.problemName ? `Resolved · ${lifecycle.problemName}` : "Problem resolved",
        meta: lifecycle.startIso ? `open for ${formatDuration(lifecycle.startIso, lifecycle.endIso) || "—"}` : undefined,
        raw: { kind: "lifecycle.close", iso: lifecycle.endIso } as Record<string, unknown>,
      });
    }
    return out;
  }, [lifecycle?.startIso, lifecycle?.endIso, lifecycle?.problemName, lifecycle?.status, lifecycle?.category]);

  const events = useMemo<TimelineEvent[]>(() => {
    if (!valid) return [];
    const out: TimelineEvent[] = [];
    const annRecords = annotationsQuery.data?.records || [];
    const wfRecords  = workflowQuery.data?.records || [];
    annRecords.forEach((r, i) => out.push(normaliseAnnotation(r, i)));
    wfRecords.forEach((r, i)  => out.push(normaliseWorkflow(r, i + annRecords.length)));
    out.push(...lifecycleEvents);
    out.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return out;
  }, [valid, annotationsQuery.data, workflowQuery.data, lifecycleEvents]);

  const counts = useMemo(() => {
    const c: Record<TimelineCategory, number> = { comment: 0, insight: 0, automation: 0, lifecycle: 0, other: 0 };
    events.forEach((e) => { c[e.category]++; });
    return c;
  }, [events]);

  return {
    events,
    counts,
    loading: !!valid && (annotationsQuery.isLoading || workflowQuery.isLoading),
    annotationsError: annotationsQuery.error || null,
    workflowsError:   workflowQuery.error || null,
    invalidId: !valid && davisProblemId.length > 0,
    refetch: () => {
      annotationsQuery.forceRefetch();
      workflowQuery.forceRefetch();
    },
  };
}
