import React from "react";

interface HealthRingProps {
  score: number; // 0-100
  activeCount: number;
  resolvedCount: number;
}

export const HealthRing: React.FC<HealthRingProps> = ({ score, activeCount, resolvedCount }) => {
  const size = 160;
  const strokeWidth = 10;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;
  const gap = circumference - progress;

  const getColor = (s: number) => {
    if (s >= 80) return "#34c759";
    if (s >= 50) return "#ff9500";
    return "#ff3b30";
  };

  const color = getColor(score);

  return (
    <div className="cc-health-ring">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--neo-border)"
          strokeWidth={strokeWidth}
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${progress} ${gap}`}
          strokeDashoffset={circumference * 0.25}
          style={{ transition: "stroke-dasharray 1s cubic-bezier(0.4, 0, 0.2, 1)" }}
        />
        {/* Score text */}
        <text
          x={size / 2}
          y={size / 2 - 6}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize="36"
          fontWeight="800"
          fontFamily="-apple-system, BlinkMacSystemFont, SF Pro Display, system-ui"
          letterSpacing="-2"
        >
          {score}
        </text>
        <text
          x={size / 2}
          y={size / 2 + 20}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--neo-text-2)"
          fontSize="10"
          fontWeight="600"
          fontFamily="-apple-system, BlinkMacSystemFont, SF Pro Display, system-ui"
          letterSpacing="1"
        >
          HEALTH
        </text>
      </svg>

      {/* Numeric callouts under the ring — Active in critical-red,
          Resolved in success-green (semantic colours, theme-
          independent). Label colour + the divider go through the
          theme tokens so the chrome flips correctly under light
          mode (the previous hardcoded `#5d6078` label and
          `rgba(255,255,255,0.06)` divider both vanished against
          the white page). */}
      <div style={{ display: "flex", gap: "20px", marginTop: "14px" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "18px", fontWeight: 700, color: "#ff3b30" }}>{activeCount}</div>
          <div style={{ fontSize: "10px", color: "var(--neo-text-2)", fontWeight: 600, letterSpacing: "0.5px" }}>ACTIVE</div>
        </div>
        <div style={{ width: "1px", background: "var(--neo-border)" }} />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "18px", fontWeight: 700, color: "#34c759" }}>{resolvedCount}</div>
          <div style={{ fontSize: "10px", color: "var(--neo-text-2)", fontWeight: 600, letterSpacing: "0.5px" }}>RESOLVED</div>
        </div>
      </div>
    </div>
  );
};
