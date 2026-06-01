// Futuristic stacked-bar visualizer for problem trends. Each bar shows the
// count of problems in that time bucket split by ACTIVE (top, coral/red)
// and CLOSED (bottom, teal/green). Layered ambient effects (scan sweep,
// breathing baseline, neon glow halos, sparks on hot bars, animated grid)
// keep it visually alive even when the underlying data is static.
import React, { useRef, useEffect, useCallback, useState } from "react";
import { useCurrentTheme } from "@dynatrace/strato-components/core";
import { Skeleton } from "@dynatrace/strato-components/content";
import type { Problem } from "../hooks/useProblems";
import { getCategoryLabel } from "../utils/formatters";
import { usePageVisible } from "../hooks/useUiUtils";
import { useDevice } from "../hooks/useDevice";

interface PulseVisualizerProps {
  data: any[];
  loading?: boolean;
  onRangeSelect?: (from: Date, to: Date) => void;
  /** Fired when the user clicks the "Clear" button on a selected
   *  range. Kept separate from `onRangeSelect` so that handler can
   *  keep its strict `(Date, Date)` contract. */
  onClearRange?: () => void;
  selectedRange?: { from: Date; to: Date } | null;
  /** One marker per active problem belonging to a constellation-leader
   *  category. Each marker carries a time RANGE (start → end) so the
   *  chart's status strip can paint a continuous band across every bar
   *  the problem was active in — including long-running problems whose
   *  start is older than the chart's left edge. `tsEnd` is optional;
   *  callers may omit it for point-in-time markers, in which case the
   *  band covers a single bucket. */
  highlightMarkers?: Array<{ ts: number; tsEnd?: number; color: string }>;
  /** Authoritative list of leader category colors (1 per category that
   *  is currently a constellation leader). Used to render the
   *  guaranteed-visible "LEADERS:" chip strip in the top-left legend
   *  even if per-bar markers can't be drawn for some reason. */
  leaderColors?: string[];
  /** Single-click on a bar fires this with the bar's bucket range so the
   *  caller can drill into the filtered list. Brush-drag still wins when
   *  the cursor moved more than a few pixels. */
  onBarClick?: (from: Date, to: Date) => void;
  /** Optional — raw problem list used to enrich the hover tooltip with
   *  per-bucket category + severity breakdown. When omitted, the
   *  tooltip falls back to the basic Active/Closed/Total summary. */
  problems?: Problem[];
}

interface Bar {
  ts: number;
  active: number;
  closed: number;
  total: number;
}

// Futuristic palette — neon coral for ACTIVE, neon teal for CLOSED.
const COLORS = {
  active: { rgb: "255,77,106", hex: "#ff4d6a" }, // hot incidents
  closed: { rgb: "34,211,160", hex: "#22d3a0" }, // resolved
  // Ambient accent — used for grids, sweep line, frame highlights.
  accent: { rgb: "180,210,255", hex: "#b4d2ff" },
};

const PulseVisualizerImpl: React.FC<PulseVisualizerProps> = ({
  data, loading, onRangeSelect, onClearRange, selectedRange, highlightMarkers, leaderColors, onBarClick, problems,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dk = (useCurrentTheme() || "dark") === "dark";
  const { isTouch } = useDevice();
  const [size, setSize] = useState({ w: 400, h: 80 });
  const [brushStart, setBrushStart] = useState<number | null>(null);
  const [brushEnd, setBrushEnd] = useState<number | null>(null);
  const [isBrushing, setIsBrushing] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  /** Continuous animation clock in seconds — drives every ambient effect. */
  const animRef = useRef(0);
  const rafRef  = useRef<number | null>(null);
  /** Pending single-click timeout — gives a brief window for a second
   *  click to land and cancel the drill, turning the gesture into a
   *  double-click (zoom toggle) instead. */
  const clickTimerRef = useRef<number | null>(null);
  /** Set to true on mouseup when the cursor moved enough to count as a
   *  brush drag; the subsequent click event is then ignored so brushing
   *  doesn't also trigger the drill action. */
  const wasBrushingRef = useRef(false);

  // Cancel any pending click timer on unmount.
  useEffect(() => () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const obs = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: Math.max(r.height, 70) });
    });
    if (containerRef.current) obs.observe(containerRef.current);
    if (canvasRef.current) obs.observe(canvasRef.current);
    return () => obs.disconnect();
  }, []);

  // ── Extract bars: timestamp → { active, closed, total } ─────────────────
  // The trend query groups by event.status, so each series carries either
  // ACTIVE or CLOSED counts. We collapse them into per-timestamp buckets.
  const bars: Bar[] = React.useMemo(() => {
    if (!data || data.length === 0) return [];
    const buckets: Record<number, { active: number; closed: number }> = {};

    const classifySeries = (s: any): "active" | "closed" => {
      const dim   = s?.dimensions?.["event.status"] ?? s?.dimensionValues?.["event.status"] ?? null;
      const label = (dim ?? s?.name ?? "").toString().toUpperCase();
      return label.includes("CLOSED") || label.includes("RESOLVED") ? "closed" : "active";
    };

    data.forEach((s: any) => {
      const kind = classifySeries(s);
      s?.datapoints?.forEach((dp: any) => {
        if (dp == null) return;
        const ts = dp.start instanceof Date ? dp.start.getTime() : new Date(dp.start).getTime();
        if (!isFinite(ts)) return;
        const v = Number(dp.value ?? 0);
        if (!isFinite(v)) return;
        buckets[ts] = buckets[ts] || { active: 0, closed: 0 };
        buckets[ts][kind] += v;
      });
    });

    return Object.entries(buckets)
      .map(([ts, b]) => ({
        ts: Number(ts),
        active: b.active,
        closed: b.closed,
        total: b.active + b.closed,
      }))
      .sort((a, b) => a.ts - b.ts);
  }, [data]);

  const visibleBars = React.useMemo(() => {
    if (!selectedRange || bars.length === 0) return bars;
    const fromTs = selectedRange.from.getTime();
    const toTs = selectedRange.to.getTime();
    const filtered = bars.filter((b) => b.ts >= fromTs && b.ts <= toTs);
    return filtered.length >= 2 ? filtered : bars;
  }, [bars, selectedRange]);

  // 0.0.151 — when the chart is fed an ACTIVE-only series (the
  // default since 0.0.147), the tooltip shouldn't list Closed/Total
  // rows that always read zero. Otherwise the bucket "Total" looks
  // like it contradicts the central TOTAL ring (which is cumulative
  // across the timeframe, not a single bucket).
  // 0.0.248 — Reverted from v0.0.247's force-false. With CLOSED
  // bars suppressed the chart looked broken on tenants where the
  // ACTIVE series is tiny compared to the cumulative CLOSED —
  // bars rendered as thin half-disconnected slivers at the top
  // of the frame. User: "voltar versao funcionando".
  const hasClosedSeries = React.useMemo(
    () => bars.some((b) => b.closed > 0),
    [bars],
  );

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t = animRef.current;

    if (visibleBars.length === 0) return;

    // 25 % headroom on the Y axis so saturated charts ("everything
    // active for the whole window") don't render as a solid red
    // wall pressing against the legend. Empty space above tells the
    // user "yes, this is the data; bars just happen to be at the
    // current ceiling." 0.0.109 user feedback.
    const rawMax = Math.max(...visibleBars.map((b) => b.total), 1);
    const maxVal = Math.max(rawMax + 1, Math.ceil(rawMax * 1.25));
    // padT reserves space for the legend at the very top + the
    // status strip (a thin horizontal band, segmented per bar slot,
    // that signals which bars belong to leader categories).
    const padL = 32, padR = 8, padT = 22, padB = 20;
    // Status strip — sits between the legend and the chart body.
    const STRIP_H   = 6;
    const STRIP_TOP = padT - STRIP_H - 2;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const baseY = padT + chartH;

    // ── Ambient backdrop wash ─────────────────────────────────────────────
    // Very faint vertical gradient over the chart body — gives the canvas
    // a slight "depth" without competing with the bars.
    {
      const wash = ctx.createLinearGradient(0, padT, 0, baseY);
      if (dk) {
        wash.addColorStop(0, "rgba(15,23,42,0.0)");
        wash.addColorStop(1, "rgba(99,102,241,0.06)");
      } else {
        wash.addColorStop(0, "rgba(99,102,241,0.0)");
        wash.addColorStop(1, "rgba(99,102,241,0.04)");
      }
      ctx.fillStyle = wash;
      ctx.fillRect(padL, padT, chartW, chartH);
    }

    // ── Cyber grid (horizontal + faint vertical) ──────────────────────────
    const yTicks = 3;
    ctx.font = `500 9px "SF Mono", monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= yTicks; i++) {
      const val = Math.round(maxVal * (yTicks - i) / yTicks);
      const y   = padT + (i / yTicks) * chartH;
      // Horizontal grid line — slightly brighter than before, with a
      // breathing midline accent.
      const isMid = i === Math.floor(yTicks / 2);
      const breath = (Math.sin(t * 1.1) + 1) / 2;
      ctx.strokeStyle = isMid
        ? `rgba(${COLORS.accent.rgb},${(dk ? 0.10 : 0.13) + breath * 0.05})`
        : (dk ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)");
      ctx.lineWidth = isMid ? 0.7 : 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + chartW, y); ctx.stroke();
      ctx.fillStyle = dk ? "rgba(148,163,184,0.55)" : "rgba(100,116,139,0.55)";
      ctx.fillText(`${val}`, padL - 4, y);
    }
    // Faint vertical grid columns — gives the chart a digital-readout feel.
    const vCols = Math.min(8, Math.floor(chartW / 60));
    ctx.strokeStyle = dk ? "rgba(180,210,255,0.04)" : "rgba(60,90,160,0.06)";
    ctx.lineWidth = 0.5;
    for (let i = 1; i < vCols; i++) {
      const x = padL + (i / vCols) * chartW;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, baseY); ctx.stroke();
    }

    // ── X axis time labels ────────────────────────────────────────────────
    const minTs = visibleBars[0].ts;
    const maxTs = visibleBars[visibleBars.length - 1].ts;
    const tsRange = Math.max(1, maxTs - minTs);

    const labelCount = Math.min(6, Math.floor(chartW / 80));
    ctx.font = `500 9px "SF Mono", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= labelCount; i++) {
      const ts  = minTs + (i / labelCount) * tsRange;
      const x   = padL + (i / labelCount) * chartW;
      const d   = new Date(ts);
      // UTC display matches native Davis Problems chart axis (see
      // TIMEZONE CONVENTION in utils/formatters.ts). Using
      // getUTCXxx instead of getXxx keeps cross-app parity for any
      // user not in UTC — Brazil (UTC-3) was previously seeing the
      // axis labelled 3 hours offset from the native chart.
      const lbl = tsRange > 86400000
        ? `${d.getUTCMonth()+1}/${d.getUTCDate()}`
        : `${d.getUTCHours().toString().padStart(2,"0")}:${d.getUTCMinutes().toString().padStart(2,"0")}`;
      ctx.strokeStyle = dk ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)";
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x, baseY + 3); ctx.stroke();
      ctx.fillStyle = dk ? "rgba(148,163,184,0.55)" : "rgba(100,116,139,0.55)";
      ctx.fillText(lbl, x, baseY + 4);
    }

    // ── Bars ─────────────────────────────────────────────────────────────
    const slotW   = chartW / visibleBars.length;
    const GAP_PX  = Math.max(1, Math.min(3, slotW * 0.18));
    const barW    = Math.max(2, slotW - GAP_PX);

    // Breathing baseline — a thin accent line under the bars that pulses
    // subtly with the animation clock. Gives the chart a "live" anchor.
    {
      const breath = (Math.sin(t * 1.4) + 1) / 2;
      ctx.save();
      const baseGrad = ctx.createLinearGradient(padL, 0, padL + chartW, 0);
      const aMid = (dk ? 0.32 : 0.28) + breath * 0.18;
      baseGrad.addColorStop(0, `rgba(${COLORS.accent.rgb},0)`);
      baseGrad.addColorStop(0.5, `rgba(${COLORS.accent.rgb},${aMid})`);
      baseGrad.addColorStop(1, `rgba(${COLORS.accent.rgb},0)`);
      ctx.fillStyle = baseGrad;
      ctx.fillRect(padL, baseY - 0.5, chartW, 1.5);
      ctx.restore();
    }

    // Hex → "r,g,b" tuple converter for canvas rgba() blending.
    const hexToRgb = (hex: string): string => {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
      if (!m) return COLORS.accent.rgb;
      return `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
    };

    // ── Per-bar leader colours ───────────────────────────────────────
    // Highlight model is "status strip + zone wash" (Davis-style):
    //   • A thin segmented strip at the top of the chart marks which
    //     bar slots belong to leader categories, colour-coded by
    //     category.
    //   • A faint vertical colour wash drops from the strip down to
    //     the baseline behind those bars, so the highlighted regions
    //     read as zones of interest without touching the bars.
    const byBar = new Map<number, string[]>();
    if (highlightMarkers && highlightMarkers.length > 0 && visibleBars.length > 0) {
      const minTs = visibleBars[0].ts;
      const maxTs = visibleBars[visibleBars.length - 1].ts;
      const bucketW = visibleBars.length > 1
        ? visibleBars[1].ts - visibleBars[0].ts
        : 60 * 60 * 1000;
      const rangeEnd = maxTs + bucketW;
      for (const m of highlightMarkers) {
        const startTs = m.ts;
        const endTs   = m.tsEnd ?? (m.ts + bucketW);
        // Skip markers entirely outside the visible window.
        if (endTs < minTs || startTs > rangeEnd) continue;
        // Clamp to visible range, then map to bar indices.
        const clampedStart = Math.max(minTs, startTs);
        const clampedEnd   = Math.min(rangeEnd, endTs);
        const startIdx = Math.max(
          0,
          Math.min(visibleBars.length - 1, Math.floor((clampedStart - minTs) / bucketW)),
        );
        const endIdx = Math.max(
          0,
          Math.min(visibleBars.length - 1, Math.floor((clampedEnd - minTs) / bucketW)),
        );
        const rgb = hexToRgb(m.color);
        for (let idx = startIdx; idx <= endIdx; idx++) {
          const list = byBar.get(idx) || [];
          if (!list.includes(rgb)) list.push(rgb);
          byBar.set(idx, list);
        }
      }
    }

    // ── Zone wash (behind bars) for highlighted bar slots ──────────
    // Painted BEFORE the bars so the bars sit on top. Faint gradient
    // from the strip line down to the baseline — strongest at the top,
    // fading toward the bottom — so the bar still reads as the focal
    // element. Multi-leader slots split into vertical colour bands.
    if (byBar.size > 0) {
      byBar.forEach((rgbs, idx) => {
        const xLeft = padL + idx * slotW + GAP_PX / 2;
        const bands = rgbs.length;
        const bandW = barW / bands;
        rgbs.forEach((rgb, bi) => {
          const xb = xLeft + bi * bandW;
          // Very low opacity (~0.05 at the top) — the wash should be
          // perceptible only on careful look, never compete with the
          // bars for attention.
          const grad = ctx.createLinearGradient(0, padT, 0, baseY);
          grad.addColorStop(0, `rgba(${rgb},0.05)`);
          grad.addColorStop(1, `rgba(${rgb},0.01)`);
          ctx.fillStyle = grad;
          ctx.fillRect(xb, padT, bandW, chartH);
        });
      });
    }

    visibleBars.forEach((bar, idx) => {
      const xLeft = padL + idx * slotW + GAP_PX / 2;
      const xMid  = xLeft + barW / 2;
      const isHover = hoverIdx === idx;

      const totalH  = (bar.total  / maxVal) * chartH;
      const closedH = (bar.closed / maxVal) * chartH;
      const activeH = totalH - closedH;

      // Per-bar phase — staggered so the shimmer & glow don't sync up
      // across the chart, giving it a wave-like "neural" feel.
      const phase  = t + idx * 0.18;
      const breath = (Math.sin(phase * 1.6) + 1) / 2;

      // Ambient bar halo — always on (not just hover) for the futuristic feel.
      if (totalH > 1) {
        ctx.save();
        const halo = ctx.createRadialGradient(
          xMid, baseY - totalH / 2, 0,
          xMid, baseY - totalH / 2, Math.max(8, barW * 1.4),
        );
        const haloA = (isHover ? 0.45 : 0.18) + breath * 0.08;
        const haloRgb = activeH > closedH ? COLORS.active.rgb : COLORS.closed.rgb;
        halo.addColorStop(0, `rgba(${haloRgb},${haloA})`);
        halo.addColorStop(1, `rgba(${haloRgb},0)`);
        ctx.fillStyle = halo;
        ctx.fillRect(xLeft - barW, baseY - totalH - barW, barW * 3, totalH + barW * 2);
        ctx.restore();
      }

      // CLOSED segment (bottom) — neon teal
      if (closedH > 0.3) {
        const yClosedTop = baseY - closedH;
        const grad = ctx.createLinearGradient(0, yClosedTop, 0, baseY);
        const a = isHover ? 1.0 : 0.85;
        grad.addColorStop(0, `rgba(${COLORS.closed.rgb},${a})`);
        grad.addColorStop(1, `rgba(${COLORS.closed.rgb},${a * 0.55})`);
        ctx.save();
        ctx.shadowColor = `rgba(${COLORS.closed.rgb},${isHover ? 0.95 : 0.45 + breath * 0.15})`;
        ctx.shadowBlur  = isHover ? 12 : 5 + breath * 4;
        ctx.fillStyle = grad;
        roundedRect(ctx, xLeft, yClosedTop, barW, closedH, { tl: 0, tr: 0, br: 2, bl: 2 });
        ctx.fill();
        ctx.restore();

        // Crisp top cap + animated shimmer slice that sweeps top→bottom
        ctx.fillStyle = `rgba(${COLORS.closed.rgb},${isHover ? 1 : 0.95})`;
        ctx.fillRect(xLeft, yClosedTop - 0.5, barW, 1);

        // Vertical inner scan-line: a thin bright line that slides down
        // within each bar (purely cosmetic, gives a "data flowing" feel).
        if (closedH > 6) {
          const slide = (phase * 0.35) % 1;          // 0..1 loop
          const lineY = yClosedTop + slide * closedH;
          ctx.save();
          ctx.globalAlpha = 0.18 + breath * 0.18;
          ctx.fillStyle = `rgba(${COLORS.closed.rgb},1)`;
          ctx.fillRect(xLeft + 1, lineY, barW - 2, 1);
          ctx.restore();
        }
      }

      // ACTIVE segment (top) — neon coral
      if (activeH > 0.3) {
        const yActiveTop = baseY - totalH;
        const yActiveBot = baseY - closedH;
        const grad = ctx.createLinearGradient(0, yActiveTop, 0, yActiveBot);
        const a = isHover ? 1.0 : 0.9;
        grad.addColorStop(0, `rgba(${COLORS.active.rgb},${a})`);
        grad.addColorStop(1, `rgba(${COLORS.active.rgb},${a * 0.55})`);
        ctx.save();
        ctx.shadowColor = `rgba(${COLORS.active.rgb},${isHover ? 1 : 0.55 + breath * 0.2})`;
        ctx.shadowBlur  = isHover ? 14 : 6 + breath * 5;
        ctx.fillStyle = grad;
        roundedRect(ctx, xLeft, yActiveTop, barW, activeH, { tl: 2, tr: 2, br: 0, bl: 0 });
        ctx.fill();
        ctx.restore();

        // Bright top cap — pulses with breath for an "alive" feel
        const capA = isHover ? 1 : 0.95;
        ctx.save();
        ctx.shadowColor = `rgba(${COLORS.active.rgb},${0.6 + breath * 0.4})`;
        ctx.shadowBlur  = 4 + breath * 4;
        ctx.fillStyle   = `rgba(${COLORS.active.rgb},${capA})`;
        ctx.fillRect(xLeft, yActiveTop - 0.5, barW, 1.2);
        ctx.restore();

        // Rising sparks above the tallest ACTIVE caps — only render for
        // bars whose active height is above the median, so the effect
        // emphasises the "hot" buckets.
        if (activeH > chartH * 0.35) {
          for (let s = 0; s < 2; s++) {
            const sphase = (phase * 0.45 + s * 0.5) % 1;
            if (sphase < 0.05) continue;
            const sy = yActiveTop - sphase * 12;
            const sa = (1 - sphase) * 0.55;
            const sr = 1.3 * (1 - sphase * 0.5);
            ctx.save();
            ctx.shadowColor = `rgba(${COLORS.active.rgb},0.55)`;
            ctx.shadowBlur  = 5;
            ctx.fillStyle   = `rgba(${COLORS.active.rgb},${sa})`;
            ctx.beginPath();
            ctx.arc(xMid + (s === 0 ? -1.5 : 1.5), sy, sr, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
      }
    });

    // ── Top status strip (Davis-style baseline ribbon) ─────────────
    // A thin segmented band that runs across the top of the chart,
    // immediately below the legend. Slots belonging to a leader
    // category are filled in that category's colour; everything else
    // gets a neutral fill, giving the strip a "status track" feel
    // similar to the failure-rate baseline band in the Davis app.
    {
      // Neutral base — same width as the chart body.
      ctx.fillStyle = dk ? "rgba(51,65,85,0.55)" : "rgba(203,213,225,0.70)";
      ctx.fillRect(padL, STRIP_TOP, chartW, STRIP_H);

      // Coloured blocks per highlighted slot.
      if (byBar.size > 0) {
        const pulse = (Math.sin(t * 1.4) + 1) / 2;
        byBar.forEach((rgbs, idx) => {
          const xLeft = padL + idx * slotW + GAP_PX / 2;
          const bands = rgbs.length;
          const bandW = barW / bands;
          rgbs.forEach((rgb, bi) => {
            const xb = xLeft + bi * bandW;
            ctx.save();
            // Status-strip blocks softened further — a thin marker,
            // no glow halo. Plenty visible for identification, not
            // for visual dominance.
            ctx.shadowColor = `rgba(${rgb},${0.18 + pulse * 0.10})`;
            ctx.shadowBlur  = 2 + pulse * 1.5;
            ctx.fillStyle   = `rgba(${rgb},${0.38 + pulse * 0.08})`;
            ctx.fillRect(xb, STRIP_TOP, bandW, STRIP_H);
            ctx.restore();
          });
        });
      }

      // Subtle frame around the strip for crispness.
      ctx.strokeStyle = dk ? "rgba(255,255,255,0.10)" : "rgba(15,23,42,0.10)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(padL + 0.5, STRIP_TOP + 0.5, chartW - 1, STRIP_H - 1);
    }

    // Brush selection overlay
    if (brushStart !== null && brushEnd !== null) {
      const x1 = Math.min(brushStart, brushEnd);
      const x2 = Math.max(brushStart, brushEnd);
      ctx.fillStyle = dk ? "rgba(0,229,255,0.12)" : "rgba(99,102,241,0.12)";
      ctx.fillRect(x1, 0, x2 - x1, h);
      ctx.strokeStyle = dk ? "rgba(0,229,255,0.5)" : "rgba(99,102,241,0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, 0, x2 - x1, h);
    }

    // Selected range overlay (when brush already applied)
    if (selectedRange && !isBrushing) {
      const fromTs = selectedRange.from.getTime();
      const toTs   = selectedRange.to.getTime();
      const x1 = padL + ((fromTs - minTs) / tsRange) * chartW;
      const x2 = padL + ((toTs   - minTs) / tsRange) * chartW;
      ctx.fillStyle = dk ? "rgba(0,229,255,0.08)" : "rgba(99,102,241,0.08)";
      ctx.fillRect(x1, padT, x2 - x1, chartH);
    }

    // ── Hover crosshair + tooltip ──────────────────────────────────────────
    // Skipped on touch devices: the canvas-drawn tooltip is ~180 px
    // wide × ~84 px tall and looks oversized against the ~340 px
    // mobile chart. Touch UX is direct: tap a bar → drill straight
    // into the list. The intermediate "see tooltip → decide → tap
    // again" flow is mouse-cursor-shaped, not finger-shaped.
    if (!isTouch && hoverIdx !== null && visibleBars[hoverIdx]) {
      const bar  = visibleBars[hoverIdx];
      const xLeft = padL + hoverIdx * slotW + GAP_PX / 2;
      const xMid = xLeft + barW / 2;
      const totalH  = (bar.total / maxVal) * chartH;
      const yActiveTop = baseY - totalH;

      // Solid vertical guideline through the hovered bar
      ctx.save();
      ctx.strokeStyle = `rgba(${COLORS.accent.rgb},${dk ? 0.45 : 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xMid, padT);
      ctx.lineTo(xMid, baseY);
      ctx.stroke();
      ctx.restore();

      // Focus marker at the top of the bar — small triangle/diamond
      if (totalH > 1) {
        const mY = yActiveTop - 6;
        ctx.save();
        ctx.shadowColor = `rgba(${COLORS.accent.rgb},0.9)`;
        ctx.shadowBlur = 6;
        ctx.fillStyle = `rgba(${COLORS.accent.rgb},1)`;
        ctx.beginPath();
        ctx.moveTo(xMid, mY);
        ctx.lineTo(xMid + 4, mY - 5);
        ctx.lineTo(xMid - 4, mY - 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      // Tooltip frame with cyber-style corner brackets. Caption matches
      // the new chart semantic: numbers describe how many problems were
      // active AT the bar's bucket time. The footer hint ("Click to
      // open in list") tells the user the bar is interactive when an
      // onBarClick handler is wired up.
      const d = new Date(bar.ts);
      const captionLbl = "ACTIVE AT THIS TIME";
      // UTC display — same rationale as the axis labels above.
      const timeLbl   = `${d.getUTCDate().toString().padStart(2,"0")}/${(d.getUTCMonth()+1).toString().padStart(2,"0")} ${d.getUTCHours().toString().padStart(2,"0")}:${d.getUTCMinutes().toString().padStart(2,"0")} UTC`;
      const activeLbl = `● Active   ${bar.active}`;
      const closedLbl = `● Closed   ${bar.closed}`;
      const totalLbl  = `  Total    ${bar.total}`;
      const clickLbl  = onBarClick ? "→ Click to open in list" : "";

      // ── Per-bucket breakdown (category + severity) ───────────────
      // When the caller passed the raw problem list, we enrich the
      // tooltip with two extra rows: the top categories in the bucket
      // and the severity mix. Filter is overlap-based (matches the
      // 0.0.152 — category + severity breakdown removed from the
      // tooltip. The numbers came from a per-bucket overlap walk on
      // the loaded sample, so they drifted from the Active count
      // (which is the server's authoritative number) — e.g. tooltip
      // showed "Active 8" then "Availability 4 · Slowdown 3 · Error 3"
      // (= 10) for the same bucket. User: "nao precisa mostrar
      // detalhes por categoria no tooltip." Keep the breakdown
      // variables as empty strings so downstream sizing code stays
      // untouched.
      const categoryLbl = "";
      const severityLbl = "";

      ctx.font = `700 12px "SF Mono", monospace`;
      const tw = Math.max(
        ctx.measureText(captionLbl).width,
        ctx.measureText(timeLbl).width,
        ctx.measureText(totalLbl).width,
        ctx.measureText(activeLbl).width,
        ctx.measureText(closedLbl).width,
        clickLbl ? ctx.measureText(clickLbl).width : 0,
      ) + 22;
      // Base height (caption + time + active [+ closed + total]) is
      // 84 when the closed/total rows show, 51 otherwise. Each
      // breakdown row adds 14 px; click hint adds 16 px. When the
      // canvas is too short to fit everything, drop the lowest-
      // priority rows (severity → category) before the click hint
      // so the focal numbers always stay visible.
      const baseH = hasClosedSeries ? 84 : 51;
      const rowH  = 14;
      const hintH = clickLbl ? 16 : 0;
      const availH = h - 4 - (padT + 2);
      let showCategory = !!categoryLbl;
      let showSeverity = !!severityLbl;
      let th = baseH + (showCategory ? rowH : 0) + (showSeverity ? rowH : 0) + hintH;
      if (th > availH && showSeverity) { showSeverity = false; th -= rowH; }
      if (th > availH && showCategory) { showCategory = false; th -= rowH; }
      let tx = xMid + 12;
      let ty = padT + 2;
      if (tx + tw > w - 4) tx = xMid - tw - 12;
      // Clamp vertically — never overflow the canvas bottom.
      if (ty + th > h - 4) ty = Math.max(2, h - 4 - th);

      // Frame fill
      ctx.fillStyle = dk ? "rgba(5,8,15,0.96)" : "rgba(255,255,255,0.98)";
      roundedRect(ctx, tx, ty, tw, th, 4);
      ctx.fill();
      // Frame outline — neon accent
      ctx.strokeStyle = `rgba(${COLORS.accent.rgb},${dk ? 0.45 : 0.35})`;
      ctx.lineWidth = 1;
      roundedRect(ctx, tx, ty, tw, th, 4);
      ctx.stroke();
      // Left edge highlight bar
      ctx.fillStyle = `rgba(${COLORS.active.rgb},0.9)`;
      ctx.fillRect(tx, ty + 1, 2, th - 2);

      // Cyber corner brackets — ⌐ ⌐ ⌐ ⌐ at all 4 corners of the frame.
      ctx.save();
      ctx.strokeStyle = `rgba(${COLORS.accent.rgb},${dk ? 0.85 : 0.7})`;
      ctx.lineWidth = 1.2;
      const cl = 6; // corner-bracket arm length
      ctx.beginPath();
      // top-left
      ctx.moveTo(tx + cl, ty - 1); ctx.lineTo(tx - 1, ty - 1); ctx.lineTo(tx - 1, ty + cl);
      // top-right
      ctx.moveTo(tx + tw - cl, ty - 1); ctx.lineTo(tx + tw + 1, ty - 1); ctx.lineTo(tx + tw + 1, ty + cl);
      // bottom-left
      ctx.moveTo(tx - 1, ty + th - cl); ctx.lineTo(tx - 1, ty + th + 1); ctx.lineTo(tx + cl, ty + th + 1);
      // bottom-right
      ctx.moveTo(tx + tw + 1, ty + th - cl); ctx.lineTo(tx + tw + 1, ty + th + 1); ctx.lineTo(tx + tw - cl, ty + th + 1);
      ctx.stroke();
      ctx.restore();

      // Text content
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      // Caption — explicitly states the semantic so users don't mistake
      // a single bar's count for the constellation hub's ACTIVE / TOTAL.
      ctx.fillStyle = dk ? "rgba(148,163,184,0.95)" : "rgba(100,116,139,0.95)";
      ctx.font = `700 9px "SF Mono", monospace`;
      ctx.fillText(captionLbl, tx + 8, ty + 6);

      // Bucket timestamp — dimmer
      ctx.fillStyle = dk ? "rgba(148,163,184,0.7)" : "rgba(100,116,139,0.7)";
      ctx.font = `500 9px "SF Mono", monospace`;
      ctx.fillText(timeLbl, tx + 8, ty + 19);

      // Active / Closed — focal numbers, color-coded. When the
      // host fed an ACTIVE-only series the Closed/Total rows are
      // suppressed so the tooltip doesn't claim a Total that
      // disagrees with the central ring's cumulative count.
      ctx.font = `700 12px "SF Mono", monospace`;
      ctx.fillStyle = COLORS.active.hex;
      ctx.fillText(activeLbl, tx + 8, ty + 35);
      if (hasClosedSeries) {
        ctx.fillStyle = COLORS.closed.hex;
        ctx.fillText(closedLbl, tx + 8, ty + 51);
        // Total — demoted: thin separator above it + smaller dim text.
        ctx.strokeStyle = dk ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.10)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(tx + 6, ty + 67); ctx.lineTo(tx + tw - 6, ty + 67);
        ctx.stroke();
        ctx.font = `500 10px "SF Mono", monospace`;
        ctx.fillStyle = dk ? "rgba(148,163,184,0.75)" : "rgba(100,116,139,0.75)";
        ctx.fillText(totalLbl, tx + 8, ty + 71);
      }

      // Breakdown rows (category + severity) — only when problems were
      // passed in, the bucket actually has data, AND there's vertical
      // room (see the `availH` clamp above which can disable them).
      // Same dim style as Total so they read as secondary detail, not
      // focal numbers.
      // 0.0.151 — when Closed/Total rows are hidden, the breakdown
      // starts higher up so the tooltip frame doesn't have empty
      // space.
      let cursorY = hasClosedSeries ? ty + 84 : ty + 51;
      if (showCategory) {
        ctx.font = `500 10px "SF Mono", monospace`;
        ctx.fillStyle = dk ? "rgba(180,210,255,0.85)" : "rgba(60,90,160,0.85)";
        ctx.fillText(categoryLbl, tx + 8, cursorY);
        cursorY += 14;
      }
      if (showSeverity) {
        ctx.font = `500 10px "SF Mono", monospace`;
        ctx.fillStyle = dk ? "rgba(255,185,120,0.85)" : "rgba(180,90,20,0.85)";
        ctx.fillText(severityLbl, tx + 8, cursorY);
        cursorY += 14;
      }

      // Click hint at the bottom — only when the bar is clickable.
      if (clickLbl) {
        ctx.font = `600 9px "SF Mono", monospace`;
        ctx.fillStyle = `rgba(${COLORS.accent.rgb},${dk ? 0.85 : 0.7})`;
        ctx.fillText(clickLbl, tx + 8, cursorY + 2);
      }
    }

    // (Magnifier lens ring removed — its dashed circle was visually noisy.)

    // ── Legend (top-LEFT, right after the Y-axis labels) ─────────────────
    // Now includes a "LEADERS:" section that GUARANTEES every highlighted
    // category is represented — useful as a fail-safe when chart markers
    // for a leader cluster together with other categories' markers and
    // some could otherwise be visually hard to spot against the bars.
    {
      ctx.save();
      ctx.font = `600 9px "SF Mono", monospace`;
      ctx.textBaseline = "top";
      // 0.0.151 — drop the CLOSED chip from the top-left legend
      // when the series isn't being rendered (default mode shows
      // ACTIVE only). The user's chip strip already has Status
      // pins for the explicit on/off case.
      const labels = hasClosedSeries
        ? [
            { txt: "ACTIVE", color: COLORS.active.hex },
            { txt: "CLOSED", color: COLORS.closed.hex },
          ]
        : [
            { txt: "ACTIVE", color: COLORS.active.hex },
          ];
      let lx = padL + 6;
      const ly = 2;
      for (let i = 0; i < labels.length; i++) {
        const { txt, color } = labels[i];
        const lDotR = 2.5 + ((Math.sin(t * 1.8 + i) + 1) / 2) * 0.6;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(lx + lDotR, ly + 4, lDotR, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.textAlign = "left";
        ctx.fillStyle = dk ? "rgba(226,232,240,0.7)" : "rgba(15,23,42,0.7)";
        ctx.fillText(txt, lx + lDotR * 2 + 4, ly);
        const ttw = ctx.measureText(txt).width;
        lx += lDotR * 2 + 4 + ttw + 12;
      }

      // Leader chips — one per leader category color. Prefer the
      // authoritative `leaderColors` list (sourced directly from
      // computeLeaderCats) so the strip is accurate even when per-bar
      // marker emission can't reach a category for any edge-case reason.
      // Falls back to deriving from `highlightMarkers` when no explicit
      // list was passed in.
      let uniqueColors: string[] = [];
      if (leaderColors && leaderColors.length > 0) {
        for (const c of leaderColors) {
          if (c && !uniqueColors.includes(c)) uniqueColors.push(c);
        }
      } else if (highlightMarkers && highlightMarkers.length > 0) {
        for (const m of highlightMarkers) {
          if (!uniqueColors.includes(m.color)) uniqueColors.push(m.color);
        }
      }
      if (uniqueColors.length > 0) {
        // Small separator
        ctx.fillStyle = dk ? "rgba(180,210,255,0.18)" : "rgba(60,90,160,0.25)";
        ctx.fillRect(lx, ly + 2, 1, 8);
        lx += 6;
        // "LEADERS:" label
        ctx.fillStyle = dk ? "rgba(226,232,240,0.6)" : "rgba(15,23,42,0.6)";
        ctx.fillText("LEADERS:", lx, ly);
        lx += ctx.measureText("LEADERS:").width + 6;
        // One dot per unique leader color
        uniqueColors.forEach((hex, i) => {
          const dotR = 3 + ((Math.sin(t * 1.6 + i * 0.5) + 1) / 2) * 0.6;
          ctx.fillStyle = hex;
          ctx.shadowColor = hex;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(lx + dotR, ly + 4, dotR, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          lx += dotR * 2 + 5;
        });
      }
      ctx.restore();
    }
  }, [visibleBars, bars, dk, brushStart, brushEnd, isBrushing, selectedRange, hoverIdx, highlightMarkers, leaderColors, problems, isTouch]);

  // ── Animation loop ─────────────────────────────────────────────────────
  // Drives every "alive" effect: sweep, baseline breath, glow pulse, top-cap
  // shimmer, sparks. Two perf-conscious choices vs a naïve loop:
  //   1. Throttled to ~30 FPS — ambient effects don't need more, the
  //      reduction halves canvas draw cost.
  //   2. `draw` is held in a ref so the RAF setup persists across
  //      `draw`-reference changes (every render bumps it because the
  //      deps array is large). No teardown / restart churn.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  // Track page visibility via a ref so the RAF loop reads the
  // latest value WITHOUT triggering the effect to tear down +
  // re-attach the loop on every visibility flip — see C5 + C6 in
  // the perf audit. Skipping the expensive `drawRef.current()`
  // call (Canvas gradients, shadow blurs, trig) when the tab is
  // hidden saves CPU + battery; the RAF reschedule itself is
  // cheap so we keep that on so the loop resumes instantly on
  // tab refocus.
  const pageVisible = usePageVisible();
  const pageVisibleRef = useRef(pageVisible);
  pageVisibleRef.current = pageVisible;
  useEffect(() => {
    const FRAME_INTERVAL = 1000 / 30;
    /** Cap a single dt at 200 ms so the anim clock doesn't jump when
     *  the tab is hidden and then resumes — RAF pauses while hidden
     *  and `now - lastT` would otherwise blow up the first frame
     *  after returning, making the sweep teleport. */
    const DT_CAP = 200;
    let lastT = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - lastT, DT_CAP);
      if (dt >= FRAME_INTERVAL) {
        animRef.current += dt / 1000;
        lastT = now;
        if (pageVisibleRef.current) drawRef.current();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const getSnappedRange = (x1: number, x2: number): { from: Date; to: Date } | null => {
    if (visibleBars.length < 2) return null;
    const c = canvasRef.current;
    const chartW = c ? c.getBoundingClientRect().width : size.w;
    const rel1 = Math.max(0, Math.min(1, x1 / chartW));
    const rel2 = Math.max(0, Math.min(1, x2 / chartW));
    const firstIdx = Math.max(0, Math.min(visibleBars.length - 1, Math.floor(rel1 * (visibleBars.length - 1))));
    const lastIdx = Math.max(0, Math.min(visibleBars.length - 1, Math.ceil(rel2 * (visibleBars.length - 1))));
    if (firstIdx >= lastIdx && firstIdx === lastIdx) {
      return { from: new Date(visibleBars[firstIdx].ts), to: new Date(visibleBars[firstIdx].ts + 3600000) };
    }
    return { from: new Date(visibleBars[firstIdx].ts), to: new Date(visibleBars[lastIdx].ts + 3600000) };
  };

  // Compact summary for screen readers — describes the visible window
  // and the total counts (active + closed) across the bars.
  const a11ySummary = React.useMemo(() => {
    if (!visibleBars || visibleBars.length === 0) return "Activity chart, no data in the selected window.";
    let active = 0, closed = 0;
    for (const b of visibleBars) { active += b.active; closed += b.closed; }
    const from = new Date(visibleBars[0].ts);
    const to   = new Date(visibleBars[visibleBars.length - 1].ts);
    // UTC display in a11y label — keeps screen-reader output aligned
    // with what sighted users see on the chart axis.
    const fmt  = (d: Date) => `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")} UTC`;
    return `Activity chart from ${fmt(from)} to ${fmt(to)} — ${active} active, ${closed} closed across ${visibleBars.length} buckets.`;
  }, [visibleBars]);

  if (loading) {
    return (
      <div className="neo-pulse-loading" role="status" aria-busy="true" aria-label="Loading activity chart">
        <Skeleton width="100%" height="100%" variant="rounded" />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="neo-pulse">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={a11ySummary}
        onMouseDown={(e) => {
          if (!onRangeSelect) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - rect.left;
          setBrushStart(x);
          setBrushEnd(x);
          setIsBrushing(true);
        }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          if (isBrushing) {
            setBrushEnd(mx);
          } else if (visibleBars.length >= 1) {
            const padL = 32, padR = 8;
            const chartW = rect.width - padL - padR;
            const relX   = (mx - padL) / chartW;
            if (mx < padL || mx > rect.width - padR) {
              setHoverIdx(null);
            } else {
              const idx = Math.max(0, Math.min(visibleBars.length - 1, Math.floor(relX * visibleBars.length)));
              setHoverIdx(idx);
            }
          }
        }}
        onMouseUp={() => {
          // Brush-drag only. Single-click drill is handled in `onClick`
          // (with a small delay so a quick second click can cancel it).
          wasBrushingRef.current = false;
          if (isBrushing && brushStart !== null && brushEnd !== null) {
            const x1 = Math.min(brushStart, brushEnd);
            const x2 = Math.max(brushStart, brushEnd);
            if (x2 - x1 > 5) {
              const range = getSnappedRange(x1, x2);
              if (range && onRangeSelect) onRangeSelect(range.from, range.to);
              wasBrushingRef.current = true;
            }
          }
          setIsBrushing(false);
          setBrushStart(null);
          setBrushEnd(null);
        }}
        onClick={() => {
          // Skip the click that arrives right after a brush-drag mouseup.
          if (wasBrushingRef.current) {
            wasBrushingRef.current = false;
            return;
          }
          // Single-click → drill into the list filtered to this bar's
          // bucket window. Delayed by 280 ms so a quick second click
          // (double-click) can land and cancel us, turning the gesture
          // into a zoom toggle instead.
          if (!onBarClick || hoverIdx === null || !visibleBars[hoverIdx]) return;
          const idx  = hoverIdx;
          const bar  = visibleBars[idx];
          const next = visibleBars[idx + 1];
          const bucketW = visibleBars.length > 1
            ? visibleBars[1].ts - visibleBars[0].ts
            : 60 * 60 * 1000;
          const from = new Date(bar.ts);
          const to   = new Date(next ? next.ts : bar.ts + bucketW);
          if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = window.setTimeout(() => {
            clickTimerRef.current = null;
            onBarClick(from, to);
          }, 280);
        }}
        onDoubleClick={() => {
          // Cancel the pending single-click drill — the user is asking
          // for a zoom, not a list drill. The actual zoom toggle is
          // handled by the parent container's onDoubleClick (it bubbles).
          if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
        }}
        onMouseLeave={() => {
          setHoverIdx(null);
          if (isBrushing) {
            setIsBrushing(false);
            setBrushStart(null);
            setBrushEnd(null);
          }
        }}
        /* Touch counterparts of the brush + hover + click handlers.
           Canvas elements don't synthesize click from touch on every
           browser, so onTouchEnd explicitly resolves the gesture
           (brush vs tap) and dispatches accordingly. preventDefault
           on the active brush stops the page from scrolling under
           the user's finger mid-drag. */
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (!t) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const x = t.clientX - rect.left;
          // Pre-arm hover so tap-to-drill has a target index
          // available in onTouchEnd.
          if (visibleBars.length >= 1) {
            const padL = 32, padR = 8;
            const chartW = rect.width - padL - padR;
            const relX = (x - padL) / chartW;
            if (x >= padL && x <= rect.width - padR) {
              const idx = Math.max(0, Math.min(visibleBars.length - 1, Math.floor(relX * visibleBars.length)));
              setHoverIdx(idx);
            }
          }
          if (onRangeSelect) {
            setBrushStart(x);
            setBrushEnd(x);
            setIsBrushing(true);
          }
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (!t) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const mx = t.clientX - rect.left;
          if (isBrushing) {
            // Once we have a brush going, prevent scroll so the
            // user can keep refining the range without the page
            // jumping under their finger.
            if (brushStart !== null && Math.abs(mx - brushStart) > 5) {
              e.preventDefault();
            }
            setBrushEnd(mx);
          }
        }}
        onTouchEnd={() => {
          wasBrushingRef.current = false;
          if (isBrushing && brushStart !== null && brushEnd !== null) {
            const x1 = Math.min(brushStart, brushEnd);
            const x2 = Math.max(brushStart, brushEnd);
            if (x2 - x1 > 5) {
              const range = getSnappedRange(x1, x2);
              if (range && onRangeSelect) onRangeSelect(range.from, range.to);
              wasBrushingRef.current = true;
            } else if (onBarClick && hoverIdx !== null && visibleBars[hoverIdx]) {
              // Tap (drag < 5 px) → drill into the bar under the
              // tap point. No click-delay dance because touch
              // doesn't have a double-click ambiguity.
              const bar  = visibleBars[hoverIdx];
              const next = visibleBars[hoverIdx + 1];
              const bucketW = visibleBars.length > 1
                ? visibleBars[1].ts - visibleBars[0].ts
                : 60 * 60 * 1000;
              const from = new Date(bar.ts);
              const to   = new Date(next ? next.ts : bar.ts + bucketW);
              onBarClick(from, to);
            }
          }
          setIsBrushing(false);
          setBrushStart(null);
          setBrushEnd(null);
        }}
        onTouchCancel={() => {
          setHoverIdx(null);
          setIsBrushing(false);
          setBrushStart(null);
          setBrushEnd(null);
        }}
        style={{
          width: "100%", height: "100%",
          // Pointer when hovering a clickable bar; ew-resize otherwise
          // (signals the brush-drag affordance) when range select is on.
          cursor: hoverIdx !== null && onBarClick
            ? "pointer"
            : onRangeSelect ? "ew-resize" : "default",
        }}
      />
      {selectedRange && onClearRange && (
        <button className="neo-pulse-clear" onClick={onClearRange}>
          ✕ Clear
        </button>
      )}
    </div>
  );
};

// Helper — draws a rounded rectangle path. `r` is either a single number or
// per-corner overrides. Used for bar caps and the tooltip frame.
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  r: number | { tl: number; tr: number; br: number; bl: number },
) {
  const c = typeof r === "number" ? { tl: r, tr: r, br: r, bl: r } : r;
  const max = Math.max(0, Math.min(w / 2, h / 2));
  const tl = Math.min(c.tl, max), tr = Math.min(c.tr, max);
  const br = Math.min(c.br, max), bl = Math.min(c.bl, max);
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.quadraticCurveTo(x, y, x + tl, y);
  ctx.closePath();
}

// Memoized export — props from the Overview page are mostly stable
// (memoised arrays / handlers), so a shallow-equal check on props
// will short-circuit re-renders triggered by neighbouring state
// changes (search box, sort dropdown, etc.) that don't touch the
// chart's inputs.
export const PulseVisualizer = React.memo(PulseVisualizerImpl);
