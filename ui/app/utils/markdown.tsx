// Tiny inline-markdown renderer. We only need this on the timeline
// cells, so a 5-token grammar covers >95% of the comments people
// actually write:
//   `code`              → <code>…</code>
//   **bold**            → <strong>…</strong>
//   *italic* / _italic_ → <em>…</em>
//   ~~strike~~          → <del>…</del>
//   [text](url)         → <a target="_blank">…</a>      (only http(s):// urls)
//
// Multi-line input is split on \n and rendered as paragraphs. Lines
// that begin with `> ` become a blockquote.
//
// We intentionally do NOT pull in a full markdown lib — every byte
// counts here (route-split, but still loaded by an active user), and
// we accept the trade-off that headings / lists / tables fall through
// as plain text. Run-of-the-mill comments don't use them.
//
// Security: every match is escaped via React's children semantics —
// we never dangerouslySetInnerHTML — so even a hostile comment can't
// inject HTML. URLs go through a strict allowlist (http/https only)
// before being attached as `href` to keep `javascript:` payloads out.

import React from "react";

const TOKEN_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/[^\s)]+)\))/g;

function isSafeUrl(url: string): boolean {
  // Allow only http(s). Reject anything starting with javascript:, data:,
  // file:, vbscript:, etc. The regex above already constrains to
  // http(s) but we double-check defensively.
  return /^https?:\/\//i.test(url);
}

function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  // Reset regex state — TOKEN_RE has /g so it remembers lastIndex
  // across calls, which would skip tokens on subsequent renders.
  TOKEN_RE.lastIndex = 0;
  let i = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push(text.slice(lastIndex, m.index));
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={i++} className="md-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("~~")) {
      out.push(<del key={i++}>{tok.slice(2, -2)}</del>);
    } else if (tok.startsWith("[")) {
      // [label](url)
      const labelEnd = tok.indexOf("]");
      const label = tok.slice(1, labelEnd);
      const url = tok.slice(labelEnd + 2, -1);
      if (isSafeUrl(url)) {
        out.push(
          <a key={i++} href={url} target="_blank" rel="noopener noreferrer" className="md-link">{label}</a>
        );
      } else {
        out.push(tok); // unsafe → leave as text
      }
    } else {
      // *italic* / _italic_
      out.push(<em key={i++}>{tok.slice(1, -1)}</em>);
    }
    lastIndex = m.index + tok.length;
  }
  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }
  return out;
}

/** Render a markdown-ish string into React nodes. See file header
 *  for the supported subset. */
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;
  // Split on newlines and emit each line as its own paragraph / quote.
  // Empty lines act as visual separators between paragraphs.
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, idx) => {
        if (!line.trim()) return <div key={idx} className="md-blank" aria-hidden="true" />;
        if (line.startsWith("> ")) {
          return <blockquote key={idx} className="md-quote">{renderInline(line.slice(2))}</blockquote>;
        }
        return <p key={idx} className="md-p">{renderInline(line)}</p>;
      })}
    </>
  );
}
