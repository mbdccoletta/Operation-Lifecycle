// Small "copy to clipboard" button that briefly flips its label to
// "✓ Copied!" after a successful click — gives the user immediate
// visual confirmation that their click took effect. Used inline in
// the problem-row action chips (Copy ID, Share link).

import React, { useEffect, useRef, useState } from "react";

interface CopyChipProps {
  /** Text to write into the clipboard. */
  text: string;
  /** Label shown in the resting state. */
  label: string;
  /** Glyph shown before the label in the resting state. */
  icon: string;
  /** Native title attribute (hover tooltip). */
  title?: string;
  /** Extra class applied alongside `.neo-row-act` — lets callers
   *  inherit the row's chip styling without duplicating it. */
  className?: string;
}

export const CopyChip: React.FC<CopyChipProps> = ({ text, label, icon, title, className }) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  // Clear the inflight reset if the component unmounts mid-flash.
  useEffect(() => () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
  }, []);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(text);
    } catch {
      // Older browsers may not expose `navigator.clipboard`. We
      // intentionally don't fall back to `document.execCommand`
      // (it's deprecated) — the user can still copy manually if
      // this happens to fail.
    }
    setCopied(true);
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      className={`neo-row-act${copied ? " neo-row-act-copied" : ""}${className ? " " + className : ""}`}
      onClick={handleClick}
      title={title}
      aria-live="polite"
    >
      <span className="neo-row-act-icon" aria-hidden="true">{copied ? "✓" : icon}</span>
      <span>{copied ? "Copied!" : label}</span>
    </button>
  );
};
