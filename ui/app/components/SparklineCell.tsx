import React, { useRef, useEffect, useCallback, useState } from "react";
import { useCurrentTheme } from "@dynatrace/strato-components/core";

interface SparklineCellProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  showArea?: boolean;
}

export const SparklineCell: React.FC<SparklineCellProps> = ({
  values,
  width = 80,
  height = 28,
  color,
  showArea = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dk = useCurrentTheme() === "dark";
  const lineColor = color || (dk ? "#00E5FF" : "#5B6ACF");

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c || values.length < 2) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    c.style.width = width + "px";
    c.style.height = height + "px";
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;

    const coords = values.map((v, i) => ({
      x: pad + (i / (values.length - 1)) * w,
      y: pad + (1 - (v - min) / range) * h,
    }));

    // Area
    if (showArea) {
      ctx.beginPath();
      ctx.moveTo(coords[0].x, coords[0].y);
      for (let i = 1; i < coords.length; i++) {
        const prev = coords[i - 1], curr = coords[i];
        const cpx = (prev.x + curr.x) / 2;
        ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
      }
      ctx.lineTo(coords[coords.length - 1].x, height);
      ctx.lineTo(coords[0].x, height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, lineColor + "30");
      grad.addColorStop(1, lineColor + "05");
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Line
    ctx.beginPath();
    ctx.moveTo(coords[0].x, coords[0].y);
    for (let i = 1; i < coords.length; i++) {
      const prev = coords[i - 1], curr = coords[i];
      const cpx = (prev.x + curr.x) / 2;
      ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // End dot
    const last = coords[coords.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
  }, [values, width, height, lineColor, dk, showArea]);

  useEffect(() => { draw(); }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block" }}
    />
  );
};
