// DQL builders for the per-problem timeline page. Two parallel
// queries — see useProblemTimeline for why we keep them separate.
//
// The schemas below were reverse-engineered from a HAR capture of the
// official Davis Problems app. We mirror them exactly so behaviour
// matches the native UI.
//
// Davis problem ids carry the shape `<bigint>_<bigint>V<digit>`
// (possibly with a leading minus). They never contain quotes or
// whitespace, but we still gate every concatenation behind a strict
// regex so a URL-supplied id can't slip arbitrary DQL into the
// interpolated string.

const DAVIS_PROBLEM_ID_RE = /^-?\d+_\d+V\d+$/;
const DISPLAY_ID_RE = /^P-\d+$/;
/** Strict ISO-8601 (`YYYY-MM-DDTHH:MM:SS(.sss)?Z`). Matches the form
 *  produced by `Date.prototype.toISOString` and rejects hand-edited
 *  strings — the same shape we accept in dql-queries.ts. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export function isDavisProblemId(s: string): boolean {
  return typeof s === "string" && DAVIS_PROBLEM_ID_RE.test(s);
}

export function isDisplayId(s: string): boolean {
  return typeof s === "string" && DISPLAY_ID_RE.test(s);
}

function isIso(s: string | undefined): s is string {
  return !!s && ISO_RE.test(s);
}

/** Davis app caps annotation lookups at `problem.start` → now (rather
 *  than a rolling 30d) so the query window matches the problem's life.
 *  We fall back to 30d when the problem hasn't been resolved yet. */
const FALLBACK_WINDOW = "now() - 30d";

/** Look up a single problem by either its long Davis composite id OR
 *  its human-friendly `P-####` display id. Both branches go through
 *  the same set of validated regexes — the catch-all `false`
 *  predicate is what guarantees we never concatenate an unchecked
 *  string into DQL. */
export function buildProblemLookupQuery(input: string): string {
  const trimmed = (input || "").trim();
  if (isDavisProblemId(trimmed)) {
    return [
      `fetch dt.davis.problems, from: ${FALLBACK_WINDOW}`,
      `| filter event.id == "${trimmed}"`,
      `| fields event.name, event.status, event.category, event.start, event.end,`,
      `         display_id, davis_problem_id = event.id`,
      `| sort event.start desc`,
      `| limit 1`,
    ].join("\n");
  }
  if (isDisplayId(trimmed)) {
    return [
      `fetch dt.davis.problems, from: ${FALLBACK_WINDOW}`,
      `| filter display_id == "${trimmed}"`,
      `| fields event.name, event.status, event.category, event.start, event.end,`,
      `         display_id, davis_problem_id = event.id`,
      `| sort event.start desc`,
      `| limit 1`,
    ].join("\n");
  }
  return `fetch dt.davis.problems | filter false | limit 0`;
}

/** Annotations stream — comments and Davis-generated insights.
 *
 *  Mirrors the query the official Problems app sends verbatim:
 *
 *    fetch dt.davis.events.snapshots, from: <problem.start>, to: now()
 *    | filter event.type == "CUSTOM_ANNOTATION"
 *          and in(annotation.problem_ids, "<id>")
 *          and isNotNull(annotation.id) and isNotNull(annotation.problem_ids)
 *          and isNotNull(annotation.source) and isNotNull(event.name)
 *    | fields annotation.id, annotation.problem_ids, annotation.user_id,
 *             event.name, event.start, event.description,
 *             annotation.source, annotation.url
 *    | dedup annotation.id, sort: { event.start desc }
 *    | filter isNotNull(event.description)
 *    | sort event.start desc
 *
 *  Three things to know about this schema:
 *
 *  • The table is `dt.davis.events.snapshots`, NOT plain `events`.
 *    Davis writes every state transition / annotation here.
 *  • `annotation.problem_ids` is an ARRAY — use `in(array, value)`,
 *    not `contains(string, substring)`.
 *  • The body lives in `event.description`, NOT `dt.event.description`.
 */
export function buildAnnotationsQuery(davisProblemId: string, problemStartIso?: string): string {
  if (!isDavisProblemId(davisProblemId)) {
    return `fetch dt.davis.events.snapshots\n| filter false\n| limit 0`;
  }
  const from = isIso(problemStartIso) ? `"${problemStartIso}"` : FALLBACK_WINDOW;
  return [
    `fetch dt.davis.events.snapshots, from: ${from}, to: now()`,
    `| filter event.type == "CUSTOM_ANNOTATION"`,
    `      and in(annotation.problem_ids, "${davisProblemId}")`,
    `      and isNotNull(annotation.id) and isNotNull(annotation.problem_ids)`,
    `      and isNotNull(annotation.source) and isNotNull(event.name)`,
    `| fields annotation.id, annotation.problem_ids, annotation.user_id,`,
    `         event.name, event.start, event.description,`,
    `         annotation.source, annotation.url`,
    `| dedup annotation.id, sort: { event.start desc }`,
    `| filter isNotNull(event.description)`,
    `| sort event.start desc`,
    `| limit 500`,
  ].join("\n");
}

/** Workflow / automation stream — runs triggered by the problem.
 *
 *  Mirrors the official query:
 *
 *    fetch dt.system.events, from: <problem.start>, to: coalesce(+2h, now())
 *    | filter event.provider == "AUTOMATION_ENGINE"
 *    | filter event.type == "WORKFLOW_EXECUTION"
 *    | filter dt.automation_engine.workflow_execution.trigger.type == "Event"
 *    | filter dt.automation_engine.workflow_execution.trigger.event.id == "<id>"
 *         OR in(dt.automation_engine.workflow_execution.trigger.event.id, array("<id-without-V*>"))
 *    | filter dt.automation_engine.is_draft == false
 *    | filter dt.automation_engine.state.is_final == true
 *    | fields start_time,
 *             id = dt.automation_engine.workflow.id,
 *             title = dt.automation_engine.workflow.title,
 *             state = dt.automation_engine.state,
 *             type = dt.automation_engine.workflow.type,
 *             execution_id = dt.automation_engine.workflow_execution.id
 *    | dedup id, sort: { start_time desc }
 *    | limit 10
 *
 *  Notes:
 *  • Different table: `dt.system.events`.
 *  • The link to the problem is via the trigger event id — including
 *    a fallback that drops the trailing `V<n>` (some triggers carry
 *    the raw cardinality + timestamp without the version suffix).
 *  • Only finalised, non-draft executions show up. */
export function buildWorkflowQuery(davisProblemId: string, problemStartIso?: string): string {
  if (!isDavisProblemId(davisProblemId)) {
    return `fetch dt.system.events\n| filter false\n| limit 0`;
  }
  const from = isIso(problemStartIso) ? `"${problemStartIso}"` : FALLBACK_WINDOW;
  // Strip the trailing `V<digits>` — Davis Workflows sometimes
  // receives the raw `<cardinality>_<timestamp>` form in the trigger.
  // The regex is anchored so we never alter the middle of the id.
  const idNoVersion = davisProblemId.replace(/V\d+$/, "");
  return [
    `fetch dt.system.events, from: ${from}, to: coalesce(+2h, now())`,
    `| filter event.provider == "AUTOMATION_ENGINE"`,
    `| filter event.type == "WORKFLOW_EXECUTION"`,
    `| filter dt.automation_engine.workflow_execution.trigger.type == "Event"`,
    `| filter dt.automation_engine.workflow_execution.trigger.event.id == "${davisProblemId}"`,
    `      or in(dt.automation_engine.workflow_execution.trigger.event.id, array("${idNoVersion}"))`,
    `| filter dt.automation_engine.is_draft == false`,
    `| filter dt.automation_engine.state.is_final == true`,
    `| fields start_time,`,
    `         id = dt.automation_engine.workflow.id,`,
    `         title = dt.automation_engine.workflow.title,`,
    `         state = dt.automation_engine.state,`,
    `         type = dt.automation_engine.workflow.type,`,
    `         execution_id = dt.automation_engine.workflow_execution.id`,
    `| dedup id, sort: { start_time desc }`,
    `| limit 50`,
  ].join("\n");
}
