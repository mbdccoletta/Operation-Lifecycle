# Design System — Agent Rules

You are building UI that must match the **Problem Lifecycle** visual identity.
Follow these rules deterministically. The single source of truth for values is
`./design-tokens.css` — import it once at app root and consume only `--neo-*`
aliases. Do not hardcode hex for surfaces/text.

## SETUP (do this first)

1. Copy `design-tokens.css` into the new app and import it at the root entry:
   `import "./design-kit/design-tokens.css";`
2. Set `data-theme` (`light`/dark default), optional `data-font-scale`
   (`small`/`normal`/`large`), optional `data-intensity` on the root wrapper.

## HARD RULES

- ALWAYS use `var(--neo-*)` for surfaces, borders, text. NEVER hardcode
  `#fff`/`#000`/slate hex for these.
- ALWAYS color ACTIVE/open = `var(--neo-status-active)` (#ff4d6a, red) and
  RESOLVED/closed = `var(--neo-status-resolved)` (#22d3a0, green). NEVER invert.
- ALWAYS use `--neo-mono` (JetBrains Mono) for numbers/KPIs/IDs, with
  `font-variant-numeric: tabular-nums`. Use `--neo-sans` for body text.
- ALWAYS use `--neo-transition` (`cubic-bezier(0.16,1,0.3,1)`) for transitions
  and `transform: scale(0.98)` on `:active`.
- ALWAYS pass `dtClientContext: "<app-id>:<surface>"` to every `useDql` call —
  it makes usage queryable later via `dt.system.events`
  (`event.kind == "QUERY_EXECUTION_EVENT"`, filter `client.application_context`).
- PREFER official Strato components (`TimeframeSelector`, `SegmentSelector`,
  `Select`, `Button`, `TextArea`, `Chip`, `ProgressCircle`, `@dynatrace/strato-icons`)
  over custom reimplementations.
- NEVER apply `filter:` to an ancestor of a `position: fixed` element — it
  creates a stacking context and breaks fixed positioning. Apply to an inner
  wrapper instead.
- For SVG charts with `preserveAspectRatio="none"`, NEVER force `aspect-ratio`
  on the wrapper (it stretches the viewBox). Use `width:100%; height:auto`.

## TOKEN MAP (flat reference — values live in design-tokens.css)

### Surfaces
`--neo-bg` page · `--neo-surface` card · `--neo-surface-2` elevated ·
`--neo-surface-hover` hover · `--neo-border` border ·
`--neo-border-active` focus/active border (#6366f1).

### Text
`--neo-text` primary · `--neo-text-2` secondary · `--neo-text-3` metadata/disabled.

### Status / semantic
`--neo-status-active` #ff4d6a · `--neo-status-resolved` #22d3a0 ·
`--neo-critical` #ef4444 · `--neo-warning` #f59e0b · `--neo-good` #60a5fa ·
`--neo-success` #22c55e · `--neo-accent` #6366f1 (indigo, primary) ·
`--neo-purple` #a855f7 · `--neo-cyan` #22d3ee.
Each has a matching `*-bg` container tint at 0.08 alpha.

### Metric series
`--neo-metric-mtta` #818CF8 · `--neo-metric-mttr` #FB923C ·
`--neo-metric-mtbf` #34D399 · `--neo-metric-mttf` #22D3EE.

### Davis categories
availability #3a5fa3 · error #e89567 · slowdown #6fa8d8 ·
resource-contention #9c6fb4 · custom-alert #5fb5c4 ·
monitoring-unavailable #cbb46a. (Token prefix `--neo-cat-*`.)

### Type scale (× `--neo-fs-mult`)
xs 12 · sm 14 · md 16 · lg 20 · xl 24 · xxl 32.
Weights: regular 400 · medium 500 · bold 700.
Line-heights: tight 1.25 · base 1.43 · relaxed 1.5.

### Shape / motion
radius 12px (`--neo-radius`) · radius-sm 8px (`--neo-radius-sm`) · pills 999px ·
easing `--neo-transition`. Durations: 120ms hover · 80ms press · 0.5s page fade.

## COMPONENT RECIPES (copy verbatim, swap accent color per variant)

### Card / panel
```css
.card { background: var(--neo-surface); border: 1px solid var(--neo-border);
        border-radius: var(--neo-radius); padding: 10px 12px; }
```

### KPI card with accent bar (the "AT A GLANCE" pattern)
```css
.kpi { background: transparent; border: 1px solid var(--neo-border);
       border-bottom-width: 2px; border-radius: var(--neo-radius);
       padding: 10px 6px; display: flex; flex-direction: column;
       align-items: center; gap: 4px; text-align: center;
       transition: border-color 120ms, background 120ms, transform 80ms; }
.kpi:active { transform: scale(0.98); }
.kpi-label { font: 600 11px var(--neo-mono); letter-spacing: 0.08em;
             text-transform: uppercase; color: var(--neo-text-3); }
.kpi-value { font: 800 24px var(--neo-mono); letter-spacing: -0.5px;
             color: var(--neo-text); font-variant-numeric: tabular-nums; }
/* variant: set border-bottom-color + label color to the accent.
   selected state: background = accent @0.08, border-color = accent @0.55 */
.kpi-active   { border-bottom-color: color-mix(in srgb, var(--neo-status-active) 65%, transparent); }
.kpi-active.is-active { background: color-mix(in srgb, var(--neo-status-active) 8%, transparent);
                        border-color: color-mix(in srgb, var(--neo-status-active) 55%, transparent); }
```

### Chip / filter pill
```css
.chip { display: inline-flex; align-items: center; padding: 3px 10px;
        border-radius: 999px; background: var(--neo-surface);
        border: 1px solid var(--neo-border); color: var(--neo-text);
        font: 600 11px var(--neo-sans); cursor: pointer;
        transition: background 120ms, border-color 120ms, color 120ms; }
.chip.is-active { background: color-mix(in srgb, var(--neo-accent) 20%, transparent);
                  border-color: var(--neo-accent); color: #a5b4fc; }
```

### Trend pill (`▲ +N /1h` / `▼ -N` / `— quiet`)
```css
.trend { font: 600 11px var(--neo-mono); letter-spacing: -0.2px;
         display: inline-flex; align-items: center; gap: 3px; }
.trend-good    { color: var(--neo-status-resolved); } /* rising-is-good */
.trend-bad     { color: var(--neo-status-active);   } /* rising-is-bad  */
.trend-neutral { color: var(--neo-text-3); opacity: 0.65; }
```
Rule: cumulative metrics (Total/Resolved) → **rate** mode (always ▲, color =
good/bad). Bidirectional metrics (Active) → **delta** mode (signed ▲/▼). Zero → `— quiet`.

### Header (sticky)
```css
.header { position: sticky; top: 0; z-index: 100; display: flex;
          align-items: center; justify-content: space-between; gap: 12px;
          padding: 6px 16px; background: var(--neo-bg); }
```

### Tabbar (bottom desktop → top mobile ≤720px)
```css
.tabbar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 200;
          background: rgba(5,8,15,0.92); backdrop-filter: blur(20px) saturate(1.8);
          border-top: 1px solid var(--neo-border); display: flex;
          justify-content: space-around; align-items: center;
          padding: 8px 0 max(8px, env(safe-area-inset-bottom)); }
[data-theme="light"] .tabbar { background: rgba(248,250,252,0.92); }
@media (max-width: 720px) {
  .tabbar { bottom: auto; top: 0; border-top: none;
            border-bottom: 1px solid var(--neo-border); }
}
```

## RESPONSIVE RULES

- Breakpoints: 420 (Z Fold cover) · 640 (mobile) · 720 (tabbar flip) ·
  960 (tablet/intermediate) · 1023 · 1200 · 1500.
- Foldables: target `@media (vertical-viewport-segments: 2)` /
  `(horizontal-viewport-segments: 2)`, not specific widths.
- Header packing: `display:flex; flex-wrap:wrap; justify-content:flex-start`
  with children `flex: 0 0 auto`. Use explicit `order` + an
  `::after { flex-basis:100%; }` pseudo to force row breaks between clusters.
- Mobile by UA: combine Client Hints + UA-regex, set `data-force-mobile` on
  `documentElement`, mirror rules with a non-`@media` selector so they win on
  wide viewports (tablet served as mobile).
- Keep the SAME page-wrapper `padding-top` across all pages so a sticky header
  docks identically against the fixed tabbar everywhere.

## FILES IN THIS KIT
- `design-tokens.css` — importable source of truth (this is what you ship).
- `CLAUDE.md` — this file (agent rules). Place at the new app's repo root or
  a `design-kit/` folder so Claude Code auto-loads it.
