// Mirrors problems-hub comments onto the same data stream the
// official Davis Problems app uses. Confirmed via HAR capture:
//
//   POST /platform/classic/environment-api/v2/events/ingest
//   {
//     "eventType": "CUSTOM_ANNOTATION",
//     "title":     "Comment on problem",
//     "startTime": <ms>,
//     "endTime":   <ms>,
//     "properties": {
//       "annotation.id":          "<uuid>",
//       "annotation.source":      "Problems App",
//       "annotation.problem_ids": "<davis problem id>",
//       "annotation.user_id":     "<user uuid>",
//       "dt.event.description":   "<comment text>"
//     }
//   }
//
// The legacy `POST /api/v2/problems/<id>/comments` endpoint we used
// before silently stored entries in a separate, unrelated store that
// the new Davis Problems UI never reads from — which is why every
// comment we posted via that path was invisible there.
//
// Required scope (declare in app.config.json):
//   environment-api:events:write
// (The platform tells us the exact name in its 403 response if we
// guess wrong — adjust to match.)

import { httpClient } from "@dynatrace-sdk/http-client";
import { logger } from "./logger";

const INGEST_PATH = "/platform/classic/environment-api/v2/events/ingest";

export interface DavisCommentInput {
  /** The LONG Davis problem id (e.g. `-1648...V2`), NOT the P-####
   *  display id. Used as `annotation.problem_ids`. */
  problemId: string;
  /** Body of the comment. Stored as `dt.event.description`. */
  message: string;
  /** Optional UUID of the authoring user. Davis renders the author
   *  using its own user lookup; we just pass through what we have. */
  userId?: string;
  /** Optional display name for the author. Sent as a fallback only —
   *  Davis usually resolves the OAuth identity itself. */
  userName?: string;
}

export interface DavisCommentResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Crypto-strong UUID for `annotation.id`. Falls back to a
 *  Math.random hex string if `crypto.randomUUID` isn't available
 *  (older browsers / SSR). */
function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 8-4-4-4-12 fallback
  const rnd = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `${rnd().slice(0, 8)}-${rnd().slice(0, 4)}-4${rnd().slice(1, 4)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${rnd().slice(1, 4)}-${rnd()}${rnd().slice(0, 4)}`;
}

export async function postCommentToDavisProblem(input: DavisCommentInput): Promise<DavisCommentResult> {
  const { problemId, message, userId, userName } = input;
  if (!problemId || !message.trim()) {
    return { ok: false, error: "missing problemId or message" };
  }
  const now = Date.now();
  const properties: Record<string, string> = {
    "annotation.id": uuid(),
    "annotation.source": "Problems App",
    "annotation.problem_ids": problemId,
    "dt.event.description": message.trim(),
  };
  if (userId) properties["annotation.user_id"] = userId;
  if (userName) properties["annotation.user_name"] = userName;

  try {
    const res = await httpClient.send({
      url: INGEST_PATH,
      method: "POST",
      requestBodyType: "json",
      body: {
        eventType: "CUSTOM_ANNOTATION",
        title: "Comment on problem",
        startTime: now,
        endTime: now,
        properties,
      },
      statusValidator: (s: number) => s >= 200 && s < 300,
    });
    return { ok: true, status: res.status };
  } catch (e) {
    const err = e as {
      name?: string;
      message?: string;
      response?: { status?: number; body?: (t?: string) => Promise<unknown> };
    };
    const status = err?.response?.status;
    let serverDetail: string | undefined;
    if (err?.response && typeof err.response.body === "function") {
      try {
        const t = await err.response.body("text");
        serverDetail = typeof t === "string" ? t : JSON.stringify(t);
      } catch {
        /* ignore */
      }
    }
    logger.warn("CUSTOM_ANNOTATION ingest failed", {
      category: "davis-comments",
      status,
      serverDetail,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status,
      error: `HTTP ${status}${serverDetail ? " — " + serverDetail.slice(0, 240) : ""}`,
    };
  }
}

