// Comments panel embedded inside the inline problem-row body.
//   • Adds a comment → posts to the official Davis Problems API
//     first (source of truth), then caches locally so the in-app UI
//     reflects it without a Davis round-trip on every render.
//   • Renders the current comment list with avatar + name + locale
//     date — matches the layout of the official Davis "Comments and
//     insights" panel.
//   • Comments are append-only: Dynatrace events are immutable in
//     Grail and neither this app nor Davis allows deletion. We focus
//     instead on scaling the list to many entries (count badge,
//     scroll cap, sticky input).

import React, { useEffect, useRef, useState } from "react";
import { useComments } from "../hooks/useComments";

/** Up to 2 uppercase initials from the author name, mirroring the
 *  avatars Davis renders. "Marcelo Coletta" → "MC". Falls back to the
 *  first letter of the only word, or "?" when no name is available. */
function initialsOf(name: string | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Locale-formatted absolute date+time matching what the Davis
 *  Problems app shows under the author name. */
function formatAbsoluteDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    // UTC display — matches native Davis Problems comment timestamps
    // (see TIMEZONE CONVENTION docblock in utils/formatters.ts).
    return d.toLocaleString(undefined, {
      day:      "2-digit", month: "short", year: "numeric",
      hour:     "2-digit", minute: "2-digit",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

interface CommentsSectionProps {
  /** Human-friendly P-#### — used to filter local cached comments. */
  problemId: string;
  /** Long composite Davis problem id (`event.id` from DQL). Required
   *  to mirror the comment back to the official Davis Problems app
   *  — its v2 comments endpoint rejects P-#### with "not a valid
   *  problem ID". When omitted, addComment will fail with a clear
   *  message rather than silently degrading. */
  davisProblemId?: string;
}

export const CommentsSection = ({ problemId, davisProblemId }: CommentsSectionProps) => {
  const { comments, loading, saving, addComment } = useComments(problemId, davisProblemId);
  const [newComment, setNewComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default — keeps the problem row's footer (Copy ID,
  // Share, Open Problem App, etc.) within reach without scrolling.
  // The header still surfaces the comment count so the user knows
  // there's something here. Auto-opens once when the user submits a
  // new comment so they see it land.
  const [open, setOpen] = useState(false);
  // After a successful add, scroll the list area to the top so the
  // freshly-added comment is in view even if the list was scrolled.
  const listRef = useRef<HTMLUListElement | null>(null);
  const prevCount = useRef(comments.length);
  useEffect(() => {
    if (comments.length > prevCount.current && listRef.current) {
      listRef.current.scrollTop = 0;
    }
    prevCount.current = comments.length;
  }, [comments.length]);

  const handleSubmit = async () => {
    if (!newComment.trim()) return;
    setError(null);
    const res = await addComment(newComment);
    if (res.ok) {
      setNewComment("");
      // Keep the list visible after a successful submit so the
      // freshly-added comment lands in front of the user.
      setOpen(true);
    } else {
      setError(res.error || "Failed to post comment to Dynatrace Problems app.");
    }
  };

  // Always render the most recent comment when present. When the
  // section is expanded, also show the full history + input row.
  // Comments are pre-sorted by fetchComments — newest first.
  const visible = open ? comments : comments.slice(0, 1);
  const hiddenCount = open ? 0 : Math.max(0, comments.length - 1);

  const renderItem = (c: typeof comments[number], idx: number) => (
    <li key={`${c.timestamp}-${idx}`} className="neo-comments-item">
      <span
        className="neo-comments-avatar"
        aria-hidden="true"
        title={c.author || "Anonymous"}
      >{initialsOf(c.author)}</span>
      <div className="neo-comments-item-meta">
        <div className="neo-comments-item-head">
          <span className="neo-comments-item-author">{c.author || "Anonymous"}</span>
          <span className="neo-comments-item-time">{formatAbsoluteDateTime(c.timestamp)}</span>
        </div>
        <div className="neo-comments-item-body">{c.comment}</div>
      </div>
    </li>
  );

  return (
    <div className={`neo-comments${open ? " neo-comments-open" : ""}`}>
      <button
        type="button"
        className="neo-comments-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="neo-comments-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="neo-comments-title">Comments &amp; Annotations</span>
        <span
          className="neo-comments-count"
          aria-label={`${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
        >{comments.length}</span>
      </button>

      {/* Input is always visible so the user can drop a quick note
          without expanding the full history first. Submitting flips
          the section open so the new comment lands in front of the
          user. */}
      <div className="neo-comments-input-row">
        <input
          type="text"
          className="neo-comments-input"
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Add a comment..."
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
        <button
          type="button"
          className="neo-comments-add"
          onClick={handleSubmit}
          disabled={saving || !newComment.trim()}
        >
          {saving ? "Saving…" : "Add"}
        </button>
      </div>

      {error && (
        <div className="neo-comments-error" role="alert">
          ⚠ {error} — comment was NOT saved.
        </div>
      )}

      {loading && comments.length === 0 && (
        <div className="neo-comments-empty">Loading comments…</div>
      )}

      {visible.length > 0 && (
        <ul
          ref={listRef}
          className={`neo-comments-list${open && comments.length > 2 ? " neo-comments-list-scroll" : ""}`}
        >
          {visible.map(renderItem)}
        </ul>
      )}

      {/* When collapsed and there are older comments, surface a
          single-line hint that opens the full history. The header
          toggle does the same job, but the link is more discoverable
          when the latest comment is sitting right above it. */}
      {!open && hiddenCount > 0 && (
        <button
          type="button"
          className="neo-comments-show-more"
          onClick={() => setOpen(true)}
        >
          ▾ Show {hiddenCount} older {hiddenCount === 1 ? "comment" : "comments"}
        </button>
      )}

      {!loading && comments.length === 0 && open && (
        <div className="neo-comments-empty">No comments yet.</div>
      )}
    </div>
  );
};
