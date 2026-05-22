// Metric-availability chip with a built-in value/range popover.
// Replaces the previous binary on/off chips on the Incidents list so
// the user can constrain the filter to e.g. "MTTA > 1h" or
// "MTTR between 1h and 4h" — not just "MTTA defined".
//
// Layout: chip body is the toggle (click = activate/deactivate),
// trailing caret opens the popover. Active chip shows the current
// bound's compact label inline so the constraint is visible at a
// glance without opening the popover. Outside-click closes the
// popover (`useOnClickOutside`).

import React, { useEffect, useId, useRef, useState } from "react";
import {
  MetricKey,
  MetricBound,
  formatBoundLabel,
  describeBound,
  parseMetricBoundExpression,
  boundToExpression,
} from "../utils/metricBound";
import { METRIC_COLORS } from "./MetricChip";
import { useDevice } from "../hooks/useDevice";

interface Props {
  metric: MetricKey;
  /** Current bound, or `undefined` when the chip is inactive. */
  bound: MetricBound | undefined;
  /** Set a new bound (also activates the chip if it wasn't). Pass
   *  `null` to deactivate. */
  onChange: (next: MetricBound | null) => void;
}

export const MetricFilterChip: React.FC<Props> = ({ metric, bound, onChange }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { isMobileOrTablet } = useDevice();
  const active = !!bound;
  const label = metric.toUpperCase();
  const accent = METRIC_COLORS[metric];
  /** Inline style for the popover — computed from the chip's
   *  bounding rect on open so the panel never overflows the
   *  viewport's right edge. Updated via `useEffect` below. */
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

  // Position the popover using `position: fixed` relative to the
  // viewport, NOT absolute relative to the chip wrap. The chip's
  // bounding rect gives us the vertical anchor (open just below the
  // chip), and we lock the horizontal extent to a 16 px gutter on
  // BOTH sides of the viewport. Result: the popover always fits
  // inside the screen regardless of which chip opened it, and it's
  // wide enough to render the input + APPLY button + cheat sheet
  // comfortably. Trade-off: if the user scrolls the page while the
  // popover is open it stays anchored to its viewport position
  // (the chip drifts away) — fine because the interaction is
  // "tap → read → apply / dismiss", no scroll in between.
  useEffect(() => {
    if (!open || !wrapRef.current) {
      setPopoverStyle({});
      return;
    }
    const VIEWPORT_GUTTER = 16;
    const chipRect = wrapRef.current.getBoundingClientRect();
    setPopoverStyle({
      position: "fixed",
      top: chipRect.bottom + 6,
      left: VIEWPORT_GUTTER,
      right: VIEWPORT_GUTTER,
      width: "auto",
      maxWidth: "none",
    });
  }, [open]);

  // Close popover on outside click + Escape. Doing both here so any
  // caller using this chip gets the dismissal behaviour for free —
  // no need for the host page to register listeners. On mobile the
  // popover renders OUTSIDE the chip wrap (fixed bottom sheet), so
  // we widen the "inside" test to allow taps inside any
  // `.neo-metric-filter-popover` to count as inside.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      // Mobile sheet lives outside the wrap — check the popover
      // element too before deciding the click was "outside".
      const target = e.target as HTMLElement | null;
      if (target && target.closest(".neo-metric-filter-popover")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Single click handler — opens the popover for both inactive and
  // active chips. No more split-button; the entire pill is one
  // surface. Activation happens implicitly when the user applies a
  // bound from inside the popover.
  const handleChipClick = () => setOpen((v) => !v);

  // Remove button (✕) — deactivates without opening the popover.
  // stopPropagation prevents the outer button's onClick from firing.
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(null);
    setOpen(false);
  };

  const handlePresetClick = (next: MetricBound) => {
    onChange(next);
    setOpen(false);
  };

  // Compact bound display for the chip body — `boundToExpression`
  // emits the same syntax the user typed (`>5m`, `1h..4h`), no
  // spaces, no fluff. Empty when chip is inactive OR bound is `any`
  // (then the chip just shows the metric name as confirmation).
  const compactBound = bound && bound.type !== "any" ? boundToExpression(bound) : "";

  return (
    <div
      ref={wrapRef}
      className={`neo-metric-filter-chip-wrap${active ? " neo-metric-filter-chip-wrap-active" : ""}${open ? " neo-metric-filter-chip-wrap-open" : ""}`}
      style={{ ["--metric-accent" as string]: accent }}
    >
      {/* Single chip — entire surface opens the popover. Inactive
          chips show "MTTA +" (ghost). Active chips show
          "MTTA  >5m  ✕" with the ✕ as a nested button (stops event
          propagation) so removing doesn't open the popover. */}
      <button
        type="button"
        className={`neo-metric-filter-chip${active ? " neo-metric-filter-chip-on" : " neo-metric-filter-chip-off"}`}
        onClick={handleChipClick}
        title={active
          ? `${describeBound(metric, bound!)} — click to edit, ✕ to remove`
          : `Tap to add a ${label} filter`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-pressed={active}
      >
        {/* Colored dot prefix — same metric color used in chart
            dots / line strokes / row chip strip. Visual anchor
            that ties the filter chip to the metric it filters. */}
        <span className="neo-metric-filter-chip-dot" aria-hidden="true" />
        <span className="neo-metric-filter-chip-label">{label}</span>
        {active ? (
          <>
            {compactBound && (
              <span className="neo-metric-filter-chip-value">{compactBound}</span>
            )}
            <span
              role="button"
              tabIndex={0}
              className="neo-metric-filter-chip-remove"
              onClick={handleRemove}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleRemove(e as unknown as React.MouseEvent); }}
              title={`Remove ${label} filter`}
              aria-label={`Remove ${label} filter`}
            >
              ✕
            </span>
          </>
        ) : (
          <span className="neo-metric-filter-chip-add" aria-hidden="true">+</span>
        )}
      </button>
      {open && (
        <MetricBoundPopover
          metric={metric}
          bound={bound}
          accent={accent}
          isMobile={isMobileOrTablet}
          style={popoverStyle}
          onPick={handlePresetClick}
          onDismiss={() => setOpen(false)}
        />
      )}
    </div>
  );
};

// ── Popover ─────────────────────────────────────────────────────────
// Single text-input expression: user types `>5m`, `<2s`, `>10d`,
// `1h..4h`, `>1h <4h`, `any` — `parseMetricBoundExpression` figures
// out the rest. Quick-tap chips below the input cover the 3 most
// common shortcuts. No more 8-button preset grid + 2-input range
// fork — the previous layout was so dense that users couldn't find
// the right control fast.

interface PopoverProps {
  metric: MetricKey;
  bound: MetricBound | undefined;
  accent: string;
  isMobile: boolean;
  /** Inline positioning style computed by the chip wrapper — picks
   *  left or right anchor + viewport-aware max-width so the panel
   *  never overflows the screen edge. */
  style: React.CSSProperties;
  onPick: (b: MetricBound) => void;
  onDismiss: () => void;
}

const MetricBoundPopover: React.FC<PopoverProps> = ({ metric, bound, accent, isMobile, style, onPick, onDismiss }) => {
  const titleId = useId();
  // Pre-fill with the current bound's expression so the user can
  // edit-in-place instead of re-typing from scratch. The expression
  // round-trips through `parseMetricBoundExpression` cleanly so what
  // shows here is exactly what the user would type to match.
  const [text, setText] = useState<string>(() => bound ? boundToExpression(bound) : "");
  const [error, setError] = useState<string | null>(null);

  const apply = (rawText: string) => {
    const next = parseMetricBoundExpression(rawText);
    if (next === null) {
      setError(`Couldn't parse "${rawText}". Try >5 (= 5m), >5m, <2s, >10d, or 1h..4h.`);
      return;
    }
    setError(null);
    onPick(next);
  };

  const popoverEl = (
    <div
      className={`neo-metric-filter-popover${isMobile ? " neo-metric-filter-popover-sheet" : ""}`}
      role="dialog"
      aria-labelledby={titleId}
      style={style}
    >
      <header className="neo-metric-filter-popover-header" style={{ ["--metric-accent" as string]: accent }}>
        <span id={titleId} className="neo-metric-filter-popover-title">
          {metric.toUpperCase()} filter
        </span>
        {/* No "Off" button — deactivation is now done by tapping
            the chip body itself (toggle pattern). Keeps the popover
            focused on the one task it has left: editing the bound. */}
      </header>

      {/* Single expression input — the whole filter UI collapses to
          this one field. Press Enter or tap Apply to commit. */}
      <div className="neo-metric-filter-popover-section">
        <label className="neo-metric-filter-popover-expr">
          <input
            type="text"
            value={text}
            placeholder=">5   1h..4h   >=1h <=4h"
            onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") apply(text); }}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            inputMode="text"
            aria-label="Filter expression"
          />
          <button
            type="button"
            className="neo-metric-filter-popover-apply-mini"
            onClick={() => apply(text)}
            title="Apply (Enter)"
            aria-label="Apply"
          >Apply</button>
        </label>
        {error && <div className="neo-metric-filter-popover-error">{error}</div>}
        {/* Syntax reference rendered as a semantic <dl> (definition
            list) — term + definition is the canonical HTML pattern
            for "label: examples" data. <kbd> tags inside mark each
            token as "syntax / keypress" content so screen readers
            announce them as code and the browser styles them with
            a code-block tint. Operators include both strict (>, <)
            and inclusive (>=, <=) — the latter is what most query
            languages (Prometheus, Datadog, Grafana) default to. */}
        <dl className="neo-metric-filter-popover-syntax">
          <dt>Operator</dt>
          <dd>
            <kbd>&gt;5</kbd>
            <kbd>&lt;30m</kbd>
            <kbd>&gt;=1h</kbd>
            <kbd>&lt;=2d</kbd>
          </dd>
          <dt>Range</dt>
          <dd>
            <kbd>1h..4h</kbd>
            <kbd>1h to 4h</kbd>
            <kbd>&gt;1h &lt;4h</kbd>
          </dd>
          <dt>Composite</dt>
          <dd>
            <kbd>1h30m</kbd>
            <kbd>2d12h</kbd>
            <kbd>1.5h</kbd>
          </dd>
          <dt>Units</dt>
          <dd>
            <kbd>ms</kbd>
            <kbd>s</kbd>
            <kbd>m</kbd>
            <kbd>h</kbd>
            <kbd>d</kbd>
            <kbd>w</kbd>
            <span className="neo-metric-filter-popover-syntax-note">(bare number = minutes)</span>
          </dd>
        </dl>
      </div>
    </div>
  );
  // On mobile, pair the sheet with a translucent backdrop that
  // dismisses on tap — fixed-positioned alongside the sheet so they
  // sit at the document level, outside the metric-filter strip's
  // overflow-x clipping context.
  if (isMobile) {
    return (
      <>
        <div
          className="neo-metric-filter-popover-backdrop"
          onClick={onDismiss}
          aria-hidden="true"
        />
        {popoverEl}
      </>
    );
  }
  return popoverEl;
};
