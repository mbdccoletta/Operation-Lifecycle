# Visual language — Problem Lifecycle

Reference for the meanings carried by colours, animations, and badges
across the app. Last updated alongside v0.0.125.

---

## 1 · Colours

### 1.1 — Category accents (Davis problem categories)

Each Davis category has a fixed accent used for: cell title, label dot,
individual dots in drilldown, bubble ring, leader-cell corner-brackets,
filter chip in the FILTERS strip.

| Category | Hex | Davis Sev |
|---|---|---|
| AVAILABILITY | `#3a5fa3` dark slate blue | 🔴 Sev 1 — Critical |
| ERROR | `#e89567` coral | 🟠 Sev 2 — High |
| SLOWDOWN | `#6fa8d8` steel blue | 🟡 Sev 3 — Medium |
| RESOURCE_CONTENTION | `#9c6fb4` plum magenta | 🟡 Sev 3 — Medium |
| CUSTOM_ALERT | `#5fb5c4` soft teal | 🟡 Sev 3 — Medium |
| MONITORING_UNAVAILABLE | `#cbb46a` sand | 🔴 Sev 1 — Critical |

Palette rules:
- **No green** in category accents (reserved for RESOLVED status).
- **No red** in category accents (reserved for ACTIVE status).
- **No yellow** (user-excluded).
- Each hue is ≥ 40° apart from the next so colours stay distinguishable
  on a dense dot grid.

### 1.2 — Semantic colours (status / trend)

These belong to **state**, not category. They pop because the rest of
the canvas wears the desaturated palette above.

| Colour | Hex | Meaning | Where it shows |
|---|---|---|---|
| 🔴 Red | `#ff4d6a` | Active / alarm / rising trend | ACTIVE hub ring, comet trail, trend badge ▲, leader frame on rising cells |
| 🟢 Green | `#22d3a0` | Resolved / recovery / falling trend | RESOLVED hub ring, ▼ DOWN seal, "+N /1h" RESOLVED delta, trend badge ▼ |
| ⚪ Slate | `#94a3b8` | Total / neutral | TOTAL hub ring, neutral cells, no-trend hint |
| 🔵 Electric cyan | `#00d4ff` | "Monitored, calm" | Rising-chip pulse on cells with no new in last 1 h |

### 1.3 — Text / surface

| Element | Dark | Light |
|---|---|---|
| Primary text | `#ffffff` | `#0f172a` |
| Bubble count digit | `#ffffff` | `#0f172a` |
| Bubble label (Rising / Stuck / Total) | `rgba(255,255,255,0.85)` | `rgba(15,23,42,0.85)` |
| Cell title category name | category accent | category accent |
| Surface | `var(--neo-bg)` `#06080d`-ish | `var(--neo-bg)` light slate |

---

## 2 · Animations

### 2.1 — Comet (hub → cell)

**What it is**: a curved trail of dots travelling from the central
ACTIVE ring out to the Rising bubble of a category cell.

**When it fires**:
- The cell's trend is **rising** — `recent > older` (more active now
  than an hour ago).
- The cell has actual rising problems (recent > 0).
- ONLY on the canvas constellation view.

**What it looks like**:
- 32 dots in a flowing comet pattern along a quadratic Bezier.
- Colour: **red** (`#ff4d6a`) — sustains the "alarm, count climbing"
  semantic regardless of which category is feeding.
- Per-dot halo: tinted by category accent (faint, ~30 % alpha) — gives
  a hint of where the comet is going without diluting the red signal.
- Bend direction: outward, away from the layout centre. Bezier control
  point clamped to the target cell's column so the trail never crosses
  into a neighbouring category.

**What it means**: data is flowing INTO that category. Problems are
escalating there. Eye-magnet for the dashboard.

### 2.2 — Bubble rotating ring (per cell)

**What it is**: a dashed ring rotating around one of the sub-bubbles
(Rising / Stuck / Total) inside a category cell.

**When it fires**:
- A chip is selected on the legend strip (Rising / Stuck / Total).
- The cell's trend delta is non-zero (`recent ≠ older`).
- The chip's bubble has `count > 0`.

**What it looks like**:
- Single dashed ring, dash `[6, 5]`, 2.4 px stroke.
- Spins at ~26 px/s (offset rotation).
- Coloured by **trend direction** (NOT category):
  - ▲ Trend rising → **red** (`#ff4d6a`)
  - ▼ Trend falling → **green** (`#22d3a0`)
  - Neutral → no ring (animation suppressed)
- Halo behind the ring via `shadowBlur 10-16 px` pulsing on the sine
  clock → breathing effect.

**What it means**: "this is the chip you selected, and this cell is
currently going in this direction".

### 2.3 — Calm-cell pulse (Rising chip · cyan)

**What it is**: a slow electric-cyan ring breathing around the cell
centre + a tiny core dot.

**When it fires**:
- Rising chip is selected on the legend strip.
- The cell has **zero** active problems opened in the last hour
  (`trend.recent === 0`).
- Constellation view only.

**What it looks like**:
- 1.6 px cyan stroke (`#00d4ff`), alpha breathing 0.30 → 0.75 with
  shadow blur 10-20 px.
- 2 px core dot at the cell centre, also cyan.
- Period ~4.8 s.

**What it means**: this category is being monitored, has no new
arrivals in the last hour. The opposite of an alarm — "all quiet".

### 2.4 — Leader cell frame (corner brackets)

**What it is**: four L-shaped corner brackets framing a cell, with a
matching halo. Looks like HUD targeting reticle.

**When it fires**:
- A legend chip is selected (Rising / Stuck / Total).
- This cell has the highest count for the selected subset (ties get
  the frame too).
- Constellation view only.

**What it looks like**:
- Brackets on each of the 4 corners; arm length ~12 % of the smaller
  cell side, clamped to 14-30 px.
- Tick marks at each side midpoint, 1.5 px stroke.
- Pulse alpha 0.7 → 1.0 on the sine clock.
- Colour: **category accent**, brightened by YIQ-luminance for dark
  accents (so AVAILABILITY's slate-blue still reads as a frame on the
  dark canvas).
- Halo: shadowBlur 12-18 px in the category accent.

**What it means**: this category currently leads the chip's metric.
Most problems opened in the last hour (Rising) / most stuck > 1 h
(Stuck) / largest active count (Total). The "where the worst is"
indicator.

### 2.5 — ▲ UP / ▼ DOWN seal (cell top-right corner)

**What it is**: small text badge with an animated arrow.

| Variant | When | Colour | Animation |
|---|---|---|---|
| ★ TOP | Rising-mode leader cell | category accent | static glow |
| ▲ UP | Rising-mode leader cell with positive trend | red `#ff4d6a` | bobbing arrow |
| ▼ DOWN | Falling cell (`recent < older`) | green `#22d3a0` | breathing glow |

Constellation view only. Suppressed inside the enlarged-quadrant modal
(which prints the trend in its HTML header instead, so the canvas
seal would have been redundant).

---

## 3 · Central hub rings (TOTAL / ACTIVE / RESOLVED)

Three large circles at the centre of the constellation. Each shows:
- A big count (TOTAL, ACTIVE, RESOLVED) — derived from the
  count-query overrides so the numbers match native Davis.
- A delta line: `▲ +N /1h` (red) or `▼ -N` (green) or `— neutral`.

**Click behaviour** (v0.0.118):
- **TOTAL** → drills to LIST view with no status filter.
- **ACTIVE** → drills to LIST view with `status = ACTIVE`.
- **RESOLVED** → drills to LIST view with `status = CLOSED`.

The 6 per-category tiles in the RESOLVED zone at the bottom strip are
also clickable — each drills to LIST with the category pinned +
`status = CLOSED`.

---

## 4 · Bubble system (per category cell)

Each cell has up to 3 sub-bubbles arranged left → right:

| Bubble | Predicate | Visible when |
|---|---|---|
| **Rising** | `event.status === "ACTIVE"` AND `event.start ≥ now − 1 h` | bubble count > 0 |
| **Stuck** | `event.status === "ACTIVE"` AND `event.start < now − 1 h` | bubble count > 0 |
| **Total** | `event.status === "ACTIVE"` (all active) | count > 0 |

The three modes are mutually exclusive for Rising + Stuck (a problem
is one or the other based on age). Total is the sum and overlaps with
both.

Bubble visual layers (outside → in):
1. Halo (radial gradient, accent at ~33 % alpha) — depth.
2. Coloured ring stroke in category accent.
3. Inner dark backplate — contrast for the number.
4. Big count digit — **white in dark, slate in light** (theme-neutral).
5. Label below — same neutral fill at 85 % alpha.

The dashed rotating ring (§ 2.2) sits OUTSIDE the bubble ring when a
chip selects this mode.

---

## 5 · Histogram (top of page)

`PulseVisualizer` bar chart of active count over the timeframe window.

Bars stacked: active (red) + closed (green). Mouseover surfaces a
tooltip with the exact counts; click-drag brushes a sub-range that
filters the list below.

---

## 6 · Chip strip legend (v0.0.125)

A single strip at the top of the page (above both view modes):

| Chip | Hint | What it does — constellation | What it does — list |
|---|---|---|---|
| **Rising** | Problems opened in the last hour | Highlights the Rising bubble in every cell + corner-brackets the leader | Filters rows to active problems with `event.start ≥ now − 1 h` |
| **Stuck** | Problems active for more than 4 hours | Same as above for the Stuck bubble | Filters rows to active problems with `event.start < now − 1 h` |
| **Total** | Highlight categories with the most active problems | Highlights the Total bubble + corner-brackets the leader by total active | Hidden — chip not shown in list mode |

Default state:
- Constellation (desktop): **Rising** pre-selected.
- List (any device, or constellation on mobile): no chip selected.
- Switching from constellation to list clears the selection.

---

## 7 · Quick reference — "what does this mean?"

| User sees | Meaning |
|---|---|
| Red comet flowing into a cell | Problems are escalating in that category right now |
| Red ring around a Rising bubble | Cell is climbing AND chip selected matches that bubble |
| Green ring around a Stuck bubble | Cell is recovering (more were active 1 h ago than now) |
| Cyan pulse at cell centre | Rising chip on, but this category has no new arrivals |
| Corner brackets around a cell | This category leads the selected metric (Rising / Stuck / Total) |
| ▲ UP badge top-right | This is a Rising leader with positive trend |
| ▼ DOWN badge top-right | Trend is falling — green = good news, situation improving |
| Number in white inside bubble | Count is presented as a metric, not as a category identifier |
| Category name in accent colour | Category identity (click → opens enlarged drilldown) |
| Central ACTIVE ring red, RESOLVED green | Universal status colours — ACTIVE is the alarm, RESOLVED the relief |

---

*Source files:* see `ui/app/components/ConstellationView.tsx`
(`drawQuadrantLabel`, bubble pass, comet pass, leader frame),
`ui/app/utils/grouping.ts` (category palette + Davis severity map),
`ui/app/pages/Overview.tsx` (chip strip + view modes).
