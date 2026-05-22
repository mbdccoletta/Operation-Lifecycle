import React, { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { useCurrentTheme } from "@dynatrace/strato-components/core";
import type { Problem } from "../hooks/useProblems";
import { usePageVisible } from "../hooks/useUiUtils";
import type { Grouping } from "../utils/grouping";
import { CATEGORY_GROUPINGS, resolveByCategory } from "../utils/grouping";

interface CategoryRadarChartProps {
  problems: Problem[];
  /** Fires with the grouping id when an axis label is clicked. */
  onCategoryClick?: (groupingId: string) => void;
  /** Which groupings to render (one axis per grouping). Defaults to the
   *  Davis problem categories. */
  groupings?: Grouping[];
  /** Resolves a problem to a grouping id. Defaults to event.category. */
  resolveGrouping?: (problem: Problem) => string | null;
}

function hexToRgb(h: string) { return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }; }
function rgba(c: { r: number; g: number; b: number }, a: number) { return `rgba(${c.r},${c.g},${c.b},${a})`; }
function lighten(c: { r: number; g: number; b: number }, v: number) { return { r: Math.min(255, c.r + v), g: Math.min(255, c.g + v), b: Math.min(255, c.b + v) }; }

const R_RATIO = 0.34;

export const CategoryRadarChart = ({
  problems,
  onCategoryClick,
  groupings = CATEGORY_GROUPINGS,
  resolveGrouping = resolveByCategory,
}: CategoryRadarChartProps) => {
  const radarRef = useRef<HTMLCanvasElement>(null);
  const connectorRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dk = useCurrentTheme() === "dark";
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [anim, setAnim] = useState(0);
  const [size, setSize] = useState(320);

  const data = useMemo(() => {
    return groupings.map((g) => {
      const active   = problems.filter((p) => resolveGrouping(p) === g.id && p["event.status"] === "ACTIVE").length;
      const resolved = problems.filter((p) => resolveGrouping(p) === g.id && p["event.status"] === "CLOSED").length;
      return { category: g.id, label: g.label, active, resolved, total: active + resolved, color: g.color };
    });
  }, [problems, groupings, resolveGrouping]);

  const maxVal = Math.max(...data.map((d) => Math.max(d.active, d.resolved)), 1);
  const N = groupings.length;
  const SEG = (Math.PI * 2) / N;

  // Entry animation
  useEffect(() => {
    const start = performance.now();
    const duration = 1400;
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setAnim(ease);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Resize
  useEffect(() => {
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 320;
      setSize(Math.min(w, 380));
    });
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // ─── Draw main radar ───
  const drawRadar = useCallback(() => {
    const c = radarRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    c.style.width = size + "px"; c.style.height = size + "px";
    ctx.scale(dpr, dpr);
    const cx = size / 2, cy = size / 2, R = size * R_RATIO;
    ctx.clearRect(0, 0, size, size);

    // Outer pulsing ring effect
    const pulsePhase = (Date.now() / 2000) % 1;
    const pulseAlpha = 0.08 + Math.sin(pulsePhase * Math.PI * 2) * 0.04;
    ctx.beginPath(); ctx.arc(cx, cy, R + 8, 0, Math.PI * 2);
    ctx.strokeStyle = dk ? `rgba(0,229,255,${pulseAlpha})` : `rgba(91,106,207,${pulseAlpha})`;
    ctx.lineWidth = 1.5; ctx.stroke();

    // Concentric ring backgrounds (color-coded bands with neon tinting)
    const bandColors = ["#CD3C44", "#DC671E", "#EEA746", "#5B6ACF", "#36B37E"];
    for (let i = 4; i >= 0; i--) {
      const outerR = ((i + 1) / 5) * R;
      const b = hexToRgb(bandColors[i]);
      ctx.beginPath();
      ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
      ctx.fillStyle = rgba(b, dk ? 0.045 : 0.035);
      ctx.fill();
    }

    // Ring borders with subtle glow
    for (let i = 1; i <= 5; i++) {
      const rr = (i / 5) * R;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = dk ? "rgba(0,229,255,0.12)" : "rgba(91,106,207,0.10)";
      ctx.lineWidth = i === 5 ? 1.8 : 0.7;
      ctx.setLineDash(i === 5 ? [] : [3, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Sector dividing lines (neon style)
    for (let i = 0; i < N; i++) {
      const a = i * SEG - Math.PI / 2;
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(0.3, dk ? "rgba(0,229,255,0.08)" : "rgba(91,106,207,0.06)");
      grad.addColorStop(1, dk ? "rgba(0,229,255,0.15)" : "rgba(91,106,207,0.10)");
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // Scanning beam (rotating radar sweep)
    const scanAngle = (Date.now() / 3000) * Math.PI * 2;
    const scanGrad = ctx.createConicGradient(scanAngle, cx, cy);
    scanGrad.addColorStop(0, dk ? "rgba(0,229,255,0.06)" : "rgba(91,106,207,0.04)");
    scanGrad.addColorStop(0.08, "transparent");
    scanGrad.addColorStop(1, "transparent");
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = scanGrad; ctx.fill();

    // Hub geometry
    const hR = Math.max(size * 0.09, 38);
    const dotSizeBase = Math.max(size * 0.018, 9);
    const hubR = hR + 6 + dotSizeBase + 4;

    // ── Active polygon with neon glow ──
    if (anim > 0) {
      ctx.save();
      ctx.shadowColor = "rgba(205,60,68,0.4)";
      ctx.shadowBlur = 12;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const v = (data[i].active / maxVal) * anim;
        const blipR = hubR + v * (R - hubR);
        const midA = i * SEG + SEG / 2 - Math.PI / 2;
        const px = cx + Math.cos(midA) * blipR;
        const py = cy + Math.sin(midA) * blipR;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = dk ? "rgba(205,60,68,0.14)" : "rgba(205,60,68,0.10)";
      ctx.fill();
      ctx.strokeStyle = dk ? "rgba(205,60,68,0.7)" : "rgba(205,60,68,0.55)";
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    // ── Resolved polygon with neon glow (dashed) ──
    if (anim > 0) {
      ctx.save();
      ctx.shadowColor = "rgba(54,179,126,0.35)";
      ctx.shadowBlur = 10;
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const v = (data[i].resolved / maxVal) * anim;
        const blipR = hubR + v * (R - hubR);
        const midA = i * SEG + SEG / 2 - Math.PI / 2;
        const px = cx + Math.cos(midA) * blipR;
        const py = cy + Math.sin(midA) * blipR;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = dk ? "rgba(54,179,126,0.10)" : "rgba(54,179,126,0.07)";
      ctx.fill();
      ctx.strokeStyle = dk ? "rgba(54,179,126,0.65)" : "rgba(54,179,126,0.50)";
      ctx.lineWidth = 2.2;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Center hub with futuristic glow ──
    ctx.save();
    ctx.shadowColor = dk ? "rgba(0,229,255,0.2)" : "rgba(91,106,207,0.15)";
    ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(cx, cy, hR + 6, 0, Math.PI * 2);
    ctx.strokeStyle = dk ? "rgba(0,229,255,0.12)" : "rgba(91,106,207,0.08)";
    ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();

    ctx.beginPath(); ctx.arc(cx, cy, hR, 0, Math.PI * 2);
    ctx.fillStyle = dk ? "rgba(8,14,30,0.96)" : "rgba(255,255,255,0.97)";
    ctx.fill();
    ctx.strokeStyle = dk ? "rgba(0,229,255,0.15)" : "rgba(91,106,207,0.10)";
    ctx.lineWidth = 1.2; ctx.stroke();

    // Progress arc
    const totalActive = data.reduce((s, d) => s + d.active, 0);
    const totalAll = data.reduce((s, d) => s + d.total, 0);
    const ratio = totalAll > 0 ? totalActive / totalAll : 0;
    const ps = -Math.PI / 2, pe = ps + (Math.PI * 2) * ratio * anim;
    ctx.beginPath(); ctx.arc(cx, cy, hR + 3, ps, pe);
    ctx.strokeStyle = totalActive > 0 ? "#CD3C44" : "#36B37E";
    ctx.lineWidth = 3; ctx.lineCap = "round";
    ctx.globalAlpha = 0.65 * anim; ctx.stroke(); ctx.globalAlpha = 1; ctx.lineCap = "butt";

    // Center text
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = totalActive > 0 ? "#CD3C44" : "#36B37E";
    ctx.font = `800 ${Math.max(size * 0.05, 18)}px system-ui,sans-serif`;
    ctx.fillText(String(Math.round(totalActive * anim)), cx, cy - hR * 0.22);
    ctx.fillStyle = dk ? "#7878a0" : "#888";
    ctx.font = `700 ${Math.max(size * 0.018, 8)}px system-ui,sans-serif`;
    ctx.fillText("ACTIVE", cx, cy + hR * 0.15);
    ctx.fillStyle = dk ? "#c0c0e0" : "#555";
    ctx.font = `700 ${Math.max(size * 0.022, 9)}px system-ui,sans-serif`;
    ctx.fillText(`of ${totalAll}`, cx, cy + hR * 0.52);

    // ── Blips ──
    for (let i = 0; i < N; i++) {
      const midA = i * SEG + SEG / 2 - Math.PI / 2;
      const color = data[i].color;
      const cb = hexToRgb(color);
      const act = activeIdx === i;
      const dim = activeIdx !== null && !act;

      // Active blip
      const va = (data[i].active / maxVal) * anim;
      const raA = hubR + va * (R - hubR);
      const axp = cx + Math.cos(midA) * raA;
      const ayp = cy + Math.sin(midA) * raA;
      const dotSize = act ? Math.max(size * 0.022, 11) : Math.max(size * 0.018, 9);

      if (data[i].active > 0) {
        if (act) {
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = 18;
          ctx.beginPath(); ctx.arc(axp, ayp, dotSize + 3, 0, Math.PI * 2);
          ctx.fillStyle = rgba(cb, 0.15); ctx.fill();
          ctx.restore();
        }
        // Outer ring
        ctx.beginPath(); ctx.arc(axp, ayp, dotSize + 2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(hexToRgb("#CD3C44"), dim ? 0.2 : dk ? 0.6 : 0.45);
        ctx.fill();
        // Gradient blip
        const grad = ctx.createRadialGradient(axp - dotSize * 0.3, ayp - dotSize * 0.3, 0, axp, ayp, dotSize);
        grad.addColorStop(0, rgba(lighten(cb, dk ? 80 : 90), dim ? 0.4 : 1));
        grad.addColorStop(0.6, rgba(cb, dim ? 0.35 : 1));
        grad.addColorStop(1, rgba(hexToRgb("#CD3C44"), dim ? 0.3 : 0.9));
        ctx.beginPath(); ctx.arc(axp, ayp, dotSize, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
        ctx.strokeStyle = act ? rgba(lighten(cb, 100), 1) : rgba(lighten(cb, 60), dim ? 0.15 : 0.7);
        ctx.lineWidth = act ? 2.5 : 1.5; ctx.stroke();
        // Score text
        if (dotSize >= 8) {
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#fff";
          ctx.font = `800 ${Math.max(dotSize * 0.85, 7)}px system-ui,sans-serif`;
          ctx.globalAlpha = dim ? 0.4 : 1;
          ctx.fillText(String(data[i].active), axp, ayp + 0.5);
          ctx.globalAlpha = 1;
        }
      }

      // Resolved blip
      const vr = (data[i].resolved / maxVal) * anim;
      const rrR = hubR + vr * (R - hubR);
      const rxp = cx + Math.cos(midA) * rrR;
      const ryp = cy + Math.sin(midA) * rrR;

      if (data[i].resolved > 0) {
        const greenB = hexToRgb("#36B37E");
        if (act) {
          ctx.save();
          ctx.shadowColor = "#36B37E";
          ctx.shadowBlur = 14;
          ctx.beginPath(); ctx.arc(rxp, ryp, dotSize + 2, 0, Math.PI * 2);
          ctx.fillStyle = rgba(greenB, 0.12); ctx.fill();
          ctx.restore();
        }
        ctx.beginPath(); ctx.arc(rxp, ryp, dotSize + 2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(greenB, dim ? 0.15 : dk ? 0.5 : 0.4);
        ctx.fill();
        const gGrad = ctx.createRadialGradient(rxp - dotSize * 0.3, ryp - dotSize * 0.3, 0, rxp, ryp, dotSize);
        gGrad.addColorStop(0, rgba(lighten(greenB, 80), dim ? 0.4 : 1));
        gGrad.addColorStop(1, rgba(greenB, dim ? 0.3 : 0.9));
        ctx.beginPath(); ctx.arc(rxp, ryp, dotSize, 0, Math.PI * 2);
        ctx.fillStyle = gGrad; ctx.fill();
        ctx.strokeStyle = rgba(lighten(greenB, 60), dim ? 0.15 : 0.7);
        ctx.lineWidth = 1.5; ctx.stroke();
        if (dotSize >= 8) {
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = "#fff";
          ctx.font = `800 ${Math.max(dotSize * 0.85, 7)}px system-ui,sans-serif`;
          ctx.globalAlpha = dim ? 0.4 : 1;
          ctx.fillText(String(data[i].resolved), rxp, ryp + 0.5);
          ctx.globalAlpha = 1;
        }
      }
    }
  }, [data, maxVal, N, SEG, dk, anim, activeIdx, size]);

  // ─── Draw connector lines ───
  const drawConnectors = useCallback(() => {
    const c = connectorRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr; c.height = size * dpr;
    c.style.width = size + "px"; c.style.height = size + "px";
    ctx.scale(dpr, dpr);
    const cx = size / 2, cy = size / 2, R = size * R_RATIO;
    const labelR = R + size * 0.085;
    ctx.clearRect(0, 0, size, size);

    const hR = Math.max(size * 0.09, 38);
    const dotSizeBase = Math.max(size * 0.018, 9);
    const hubR = hR + 6 + dotSizeBase + 4;

    for (let i = 0; i < N; i++) {
      const midA = i * SEG + SEG / 2 - Math.PI / 2;
      const cos = Math.cos(midA), sin = Math.sin(midA);
      const act = activeIdx === i, dim = activeIdx !== null && !act;
      const color = data[i].color;

      // Blip position (active takes priority for connector start)
      const va = (Math.max(data[i].active, data[i].resolved) / maxVal) * anim;
      const blipR = hubR + va * (R - hubR);
      const blipDotSize = act ? Math.max(size * 0.022, 11) : Math.max(size * 0.018, 9);
      const startR = blipR + blipDotSize + 4;

      const isR = cos > 0.15, isL = cos < -0.15;
      const lx = cx + cos * labelR, ly = cy + sin * labelR;
      const labelH = 32;
      const stopR = labelR - labelH / 2 - 6;

      const alpha = dim ? 0.2 : act ? 0.9 : 0.55;

      // Dashed connector line
      if (startR < stopR) {
        const sx = cx + cos * startR, sy = cy + sin * startR;
        const ex = cx + cos * stopR, ey = cy + sin * stopR;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
        ctx.strokeStyle = color; ctx.globalAlpha = alpha;
        ctx.setLineDash([5, 4]); ctx.lineWidth = act ? 2.5 : 1.8; ctx.stroke(); ctx.setLineDash([]);
      }

      // Solid bar below label
      const barY = ly + labelH / 2 + 3;
      const barW = act ? 55 : 40;
      const barStartX = isR ? lx : isL ? lx - barW : lx - barW / 2;
      ctx.beginPath(); ctx.moveTo(barStartX, barY); ctx.lineTo(barStartX + barW, barY);
      ctx.strokeStyle = color; ctx.globalAlpha = act ? 0.8 : 0.4;
      ctx.lineWidth = act ? 3 : 2; ctx.lineCap = "round"; ctx.stroke(); ctx.lineCap = "butt";
      ctx.globalAlpha = 1;
    }
  }, [data, maxVal, N, SEG, anim, activeIdx, size]);

  useEffect(() => { drawRadar(); drawConnectors(); }, [drawRadar, drawConnectors]);

  // Continuous animation for scanning effects — skip the draw
  // call while the tab is hidden, and hold `drawRadar` in a ref
  // so this effect doesn't tear down + restart the RAF loop on
  // every render (the function changes whenever its many deps do).
  // See C5 + C6 in the perf audit.
  const pageVisible = usePageVisible();
  const pageVisibleRef = useRef(pageVisible);
  pageVisibleRef.current = pageVisible;
  const drawRadarRef = useRef(drawRadar);
  drawRadarRef.current = drawRadar;
  useEffect(() => {
    if (anim < 1) return;
    let raf: number;
    const loop = () => {
      if (pageVisibleRef.current) drawRadarRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anim]);

  // Hit test for click
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const cx = size / 2, cy = size / 2;
    const angle = Math.atan2(my - cy, mx - cx);
    let a = angle + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const idx = Math.floor(a / SEG);
    const dist = Math.sqrt((mx - cx) ** 2 + (my - cy) ** 2);
    const R = size * R_RATIO;
    if (dist < R * 1.3 && idx >= 0 && idx < N) {
      setActiveIdx(activeIdx === idx ? null : idx);
    } else {
      setActiveIdx(null);
    }
  }, [size, SEG, N, activeIdx]);

  if (data.every((d) => d.total === 0)) {
    return (
      <div style={{ textAlign: "center", padding: 40, color: "var(--sr-text-3)", fontSize: 13 }}>
        No category data
      </div>
    );
  }

  const R = size * R_RATIO;
  const labelR = R + size * 0.085;
  const fs1 = Math.max(size * 0.028, 11);
  const fs2 = Math.max(size * 0.022, 10);

  return (
    <div ref={containerRef} style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      {/* Chart area with stacked layers — exactly like Pulse */}
      <div
        style={{ position: "relative", width: size, height: size, flexShrink: 0, cursor: "pointer" }}
        onClick={handleClick}
      >
        {/* Layer 1: Connector lines */}
        <canvas ref={connectorRef} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, width: size, height: size, pointerEvents: "none" }} />
        {/* Layer 2: Main radar */}
        <canvas ref={radarRef} role="img" aria-label="Category radar chart" style={{ position: "absolute", top: 0, left: 0, width: size, height: size }} />
        {/* Layer 3: HTML labels (positioned around the radar like Pulse ChartLabels) */}
        {data.map((item, i) => {
          const midA = i * SEG + SEG / 2 - Math.PI / 2;
          const cos = Math.cos(midA), sin = Math.sin(midA);
          const x = size / 2 + cos * labelR, y = size / 2 + sin * labelR;
          const isR = cos > 0.15, isL = cos < -0.15;
          const act = activeIdx === i, dim = activeIdx !== null && !act;

          return (
            <div
              key={item.category}
              onClick={(e) => { e.stopPropagation(); setActiveIdx(act ? null : i); onCategoryClick?.(item.category); }}
              style={{
                position: "absolute",
                left: isR ? x : isL ? undefined : x,
                right: isL ? size - x : undefined,
                top: y,
                transform: `translateY(-50%)${!isR && !isL ? " translateX(-50%)" : ""}`,
                textAlign: isR ? "left" : isL ? "right" : "center",
                pointerEvents: "auto",
                whiteSpace: "nowrap",
                transition: "opacity 0.3s",
                opacity: dim ? 0.4 : 1,
                cursor: "pointer",
              }}
            >
              <div style={{
                fontSize: fs1, fontWeight: 800, lineHeight: 1.2, marginBottom: 2,
                color: act ? item.color : (dk ? "#f0f0f8" : "#1a1a2e"),
                textShadow: dk ? "0 1px 4px rgba(0,0,0,0.7)" : "0 1px 3px rgba(255,255,255,0.8)",
              }}>{item.label}</div>
              <div style={{
                fontSize: fs2, fontWeight: 700, lineHeight: 1.2,
                color: item.color,
                textShadow: dk ? "0 1px 3px rgba(0,0,0,0.6)" : "0 1px 2px rgba(255,255,255,0.7)",
              }}>
                {Math.round(item.active * anim)}A · {Math.round(item.resolved * anim)}R
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 4, borderRadius: 2, background: "#CD3C44" }} />
          <span style={{ fontSize: 11, color: "var(--sr-text-2)" }}>Active</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 4, borderRadius: 2, background: "#36B37E" }} />
          <span style={{ fontSize: 11, color: "var(--sr-text-2)" }}>Resolved</span>
        </div>
      </div>
    </div>
  );
};
