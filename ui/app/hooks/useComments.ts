import { useState, useEffect, useCallback } from "react";
import { documentsClient } from "@dynatrace-sdk/client-document";
import { getCurrentUserDetails } from "@dynatrace-sdk/app-environment";
import { postCommentToDavisProblem } from "../utils/davis-comments";
import { useRefreshTick } from "../contexts/RefreshSignalContext";
import { logger } from "../utils/logger";

export interface Comment {
  problemId: string;
  comment: string;
  author: string;
  timestamp: string;
}

export function useComments(problemId: string, davisProblemId?: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchComments = useCallback(async () => {
    if (!problemId) return;
    setLoading(true);
    try {
      // Defensive: documentsClient filters are an expression string,
      // so anything interpolated needs the single quotes inside
      // `problemId` escaped. The current `display_id` shape is
      // `P-#####` (no quotes) so the escape is a no-op today, but
      // we keep it in place so future id formats (or any path that
      // funnels user input here) can't break out of the literal.
      const escapedId = problemId.replace(/'/g, "\\'");
      // Cap the result page so a problem with hundreds of comments
      // doesn't fan out into hundreds of `getDocument` calls below.
      // See H8 in the perf audit. 50 covers any realistic incident;
      // a future "Load more" affordance can paginate beyond it.
      const MAX_COMMENTS_PER_PROBLEM = 50;
      const response = await documentsClient.listDocuments({
        filter: `type == 'problem-annotation' and name contains '${escapedId}'`,
        pageSize: MAX_COMMENTS_PER_PROBLEM,
      });
      // `full.content` shape varies by SDK version (Blob, PlatformBinary
      // with .get(), plain string, or already-parsed object). Probe each
      // form so the parse keeps working across SDK upgrades.
      const readContent = async (content: unknown): Promise<Comment | null> => {
        if (content == null) return null;
        if (typeof content === "object" && content !== null
            && "get" in content
            && typeof (content as { get?: unknown }).get === "function") {
          try {
            const json = await (content as { get: (t: string) => unknown }).get("json");
            if (json && typeof json === "object") return json as Comment;
            const text = await (content as { get: (t: string) => unknown }).get("text") as Promise<string> | string;
            const t = typeof text === "string" ? text : await (text as Promise<string>);
            return JSON.parse(t) as Comment;
          } catch (e) {
            logger.warn("PlatformBinary read failed", {
              category: "comments",
              error: e instanceof Error ? e.message : String(e),
            });
            return null;
          }
        }
        if (typeof content === "string") {
          return JSON.parse(content) as Comment;
        }
        if (content instanceof Blob
            || content instanceof ArrayBuffer
            || content instanceof ReadableStream) {
          const text = await new Response(content as BodyInit).text();
          return JSON.parse(text) as Comment;
        }
        if (typeof content === "object" && content !== null
            && ("comment" in content || "author" in content)) {
          return content as Comment;
        }
        logger.warn("Unknown content shape from documentsClient", {
          category: "comments",
          shape: content === null ? "null" : typeof content,
        });
        return null;
      };
      // Parallelise the per-doc fetches via a small concurrency
      // pool — sequential awaits were too slow, but unbounded
      // Promise.all could fire 50+ simultaneous HTTP calls (and
      // historically up to ~500 when this list wasn't capped, see
      // H8 in the perf audit). 6 in-flight matches typical Davis
      // SDK throughput without saturating the browser's request
      // queue or the platform's connection limits.
      const CONCURRENCY = 6;
      type Fetched = { doc: typeof response.documents[number]; full: Awaited<ReturnType<typeof documentsClient.getDocument>> | null; error: unknown };
      const fetched: Fetched[] = new Array(response.documents.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const i = cursor++;
          if (i >= response.documents.length) return;
          const doc = response.documents[i];
          try {
            const full = await documentsClient.getDocument({ id: doc.id });
            fetched[i] = { doc, full, error: null };
          } catch (error) {
            fetched[i] = { doc, full: null, error };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, response.documents.length) }, worker),
      );
      const parsed: Comment[] = [];
      let skippedThrow = 0;
      for (const { doc, full, error } of fetched) {
        if (error) {
          skippedThrow++;
          logger.warn("doc fetch failed", {
            category: "comments",
            docName: doc.name,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!full || full.content == null) continue;
        try {
          const c = await readContent(full.content);
          if (c) parsed.push(c);
        } catch (e) {
          skippedThrow++;
          logger.warn("doc parse failed", {
            category: "comments",
            docName: doc.name,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (skippedThrow > 0) {
        logger.warn("fetchComments partially failed", {
          category: "comments",
          parsedCount: parsed.length,
          totalDocs: response.documents.length,
          skipped: skippedThrow,
        });
      }
      parsed.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      // Merge with whatever's already in state instead of replacing.
      // documentsClient.listDocuments has eventual consistency — a
      // doc we created moments ago might not be in this response
      // yet, and a hard replace would erase our optimistic entry.
      setComments((prev) => {
        const seen = new Set(parsed.map((c) => c.timestamp));
        const stillPending = prev.filter((c) => !seen.has(c.timestamp));
        return [...stillPending, ...parsed].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );
      });
    } catch {
      // Network/permission error → keep whatever's currently in
      // state. Wiping to [] would also throw away optimistic entries.
    } finally {
      setLoading(false);
    }
  }, [problemId]);

  const addComment = useCallback(
    async (comment: string, author?: string): Promise<{ ok: boolean; error?: string }> => {
      if (!problemId || !comment.trim()) return { ok: false, error: "empty" };
      setSaving(true);
      // Resolve the author from the platform's OAuth-authenticated
      // identity. Falls back to "Anonymous" only when the SDK runtime
      // isn't reachable.
      let resolvedAuthor = author || "";
      let resolvedUserId = "";
      try {
        const u = getCurrentUserDetails();
        const looksRealId    = u && u.id    && !u.id.startsWith("dt.missing.user");
        const looksRealName  = u && u.name  && !u.name.startsWith("dt.missing.user");
        const looksRealEmail = u && u.email && !u.email.startsWith("dt.missing.user");
        if (looksRealId) resolvedUserId = u.id!;
        if (looksRealName) resolvedAuthor = u.name || resolvedAuthor;
        else if (looksRealEmail) resolvedAuthor = u.email || resolvedAuthor;
      } catch {
        /* SDK not available — keep fallback */
      }
      if (!resolvedAuthor) resolvedAuthor = "Anonymous";
      const docName = `problem-comment-${problemId}-${Date.now()}`;
      const payload: Comment = {
        problemId,
        comment: comment.trim(),
        author: resolvedAuthor,
        timestamp: new Date().toISOString(),
      };
      try {
        // Davis-first: the official Problems app is the source of
        // truth. If we can't post there, we DON'T persist the comment
        // anywhere — preventing drift between hub and Davis.
        if (!davisProblemId) {
          return {
            ok: false,
            error: "Missing davis_problem_id — refresh the page so the long composite id loads, then try again.",
          };
        }
        const sync = await postCommentToDavisProblem({
          problemId: davisProblemId,
          message: comment.trim(),
          userId: resolvedUserId,
          userName: resolvedAuthor,
        });
        if (!sync.ok) {
          logger.warn("Davis post failed — comment NOT saved", {
            category: "comments",
            status: sync.status,
            error: sync.error,
          });
          return {
            ok: false,
            error: sync.status === 403
              ? "Permission denied (problems.write scope missing)"
              : sync.status === 401
                ? "Not authenticated"
                : `Davis API error${sync.status ? ` (${sync.status})` : ""}`,
          };
        }

        // Davis accepted the comment → mirror to our local document
        // store so the UI reflects it without round-tripping through
        // Davis on every read. Optimistic update first; fetchComments
        // later reconciles.
        setComments((prev) => [payload, ...prev]);
        try {
          await documentsClient.createDocument({
            body: {
              name: docName,
              type: "problem-annotation",
              content: new Blob([JSON.stringify(payload)], { type: "application/json" }),
            },
          });
        } catch (e) {
          // Davis succeeded but local cache failed — the comment is
          // safe in Davis. The UI keeps the optimistic entry.
          logger.warn("Local cache write failed (Davis succeeded)", {
            category: "comments",
            error: e instanceof Error ? e.message : String(e),
          });
        }
        await fetchComments();
        return { ok: true };
      } finally {
        setSaving(false);
      }
    },
    [problemId, davisProblemId, fetchComments]
  );

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Subscribe to the global refresh signal — every time the host
  // page (Overview's manual refresh button or auto-refresh tick)
  // fires `triggerRefresh()`, this effect re-runs and re-fetches
  // comments from `documentsClient`. Fixes the regression where
  // posting a comment in tab A wasn't appearing in tab B after
  // refresh (and where the user's own post only showed up after
  // a hard browser reload).
  const refreshTick = useRefreshTick();
  useEffect(() => {
    if (refreshTick === 0) return; // skip the initial mount
    fetchComments();
  }, [refreshTick, fetchComments]);

  return { comments, loading, saving, addComment, refetch: fetchComments };
}
