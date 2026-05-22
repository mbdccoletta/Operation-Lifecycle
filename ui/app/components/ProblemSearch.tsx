// Shared search-by-text affordance for any list of problems
// (Incidents, Timeline, future Trends). Drop-in input + clear
// button with the project's existing `.neo-search` styling. The
// caller owns the debouncing — we deliberately don't bake it in
// here because the right debounce delay depends on the consumer
// (Overview uses 150 ms via `useDebouncedValue`).
//
// What the search MATCHES (when the consumer hooks the value into
// its own filter memo): `event.name` + `display_id`. We intentionally
// DON'T match `event.category` here — the category chip strip is
// the dedicated UI for that, and including the category in text
// search caused false positives (typing "Low" matched every
// Slowdown problem because "slowdown".includes("low")). Pages can
// also reserve a few magic keywords ("active", "closed") for
// status shortcuts.
import React from "react";

export interface ProblemSearchProps {
  value: string;
  onChange: (next: string) => void;
  /** Defaults to "Search by name or ID…" — reflects the actual
   *  match surface (category was removed to fix false positives
   *  like "Low" matching every "Slowdown" problem). */
  placeholder?: string;
  /** `true` to apply the slimmer `.neo-search-inline` variant
   *  (smaller padding, fits inside a list-actions row). */
  inline?: boolean;
  /** Optional aria-label override; defaults to "Search". */
  ariaLabel?: string;
}

export const ProblemSearch = ({
  value,
  onChange,
  placeholder = "Search by name or ID…",
  inline = false,
  ariaLabel = "Search",
}: ProblemSearchProps) => {
  return (
    <div className={`neo-search${inline ? " neo-search-inline" : ""}`}>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
      />
      {/* Clear button — appears only when there's text to clear.
          Sits inside the input rail (positioned via CSS) so it
          doesn't add extra width to the layout. */}
      {value.length > 0 && (
        <button
          type="button"
          className="neo-search-clear"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
};
