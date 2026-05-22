import React, { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useProblems } from "../hooks/useProblems";
import { useTimeRange } from "../hooks/useTimeRange";
import { getCategoryLabel, formatRelativeTime } from "../utils/formatters";

const CATEGORY_COLORS: Record<string, string> = {
  AVAILABILITY: "#E5484D",
  ERROR: "#DC671E",
  SLOWDOWN: "#3B82F6",
  RESOURCE: "#8B5CF6",
  RESOURCE_CONTENTION: "#8B5CF6",
  CUSTOM: "#6366F1",
};

export const Timeline = () => {
  const navigate = useNavigate();
  const [timeframe, setTimeframe] = useState("72h");
  const { selectedRange } = useTimeRange();

  const problemsFilter = useMemo(() => {
    if (selectedRange) {
      return {
        status: "",
        category: "",
        timeframe,
        from: selectedRange.from.toISOString(),
        to: selectedRange.to.toISOString(),
      };
    }
    return { status: "", category: "", timeframe };
  }, [timeframe, selectedRange]);

  const { problems, loading } = useProblems(problemsFilter);

  const timeline = useMemo(() => {
    return [...problems].sort(
      (a, b) => new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime()
    );
  }, [problems]);

  const activeCount = useMemo(() => timeline.filter(p => p["event.status"] === "ACTIVE").length, [timeline]);
  const resolvedCount = useMemo(() => timeline.filter(p => p["event.status"] === "CLOSED").length, [timeline]);

  // Group by date
  const grouped = useMemo(() => {
    const groups: Record<string, typeof problems> = {};
    timeline.forEach((p) => {
      const date = new Date(p["event.start"]).toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
      if (!groups[date]) groups[date] = [];
      groups[date].push(p);
    });
    return Object.entries(groups);
  }, [timeline]);

  return (
    <div className="sr-page">
      <div className="sr-topbar">
        <h1>Event Stream</h1>
        {!loading && timeline.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              fontFamily: "var(--sr-mono)", fontSize: 11, color: "var(--sr-text-3)",
              letterSpacing: "-0.3px"
            }}>
              {timeline.length} events
            </span>
          </div>
        )}
      </div>

      {/* Timeframe */}
      <div style={{ padding: "12px 0 4px" }}>
        <div className="sr-segment">
          {["24h", "72h", "7d", "14d", "30d"].map((tf) => (
            <button
              key={tf}
              className={`sr-segment-btn${timeframe === tf ? " sr-segment-btn-active" : ""}`}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {/* Status summary bar */}
      {!loading && timeline.length > 0 && (
        <div className="sr-status-bar">
          <div className="sr-status-bar-seg"
            style={{ width: `${(activeCount / timeline.length) * 100}%`, background: "var(--sr-critical)" }} />
          <div className="sr-status-bar-seg"
            style={{ width: `${(resolvedCount / timeline.length) * 100}%`, background: "var(--sr-success)" }} />
        </div>
      )}

      {/* Legend */}
      {!loading && timeline.length > 0 && (
        <div style={{
          padding: "4px 12px 8px", display: "flex", gap: 14,
          alignItems: "center", fontFamily: "var(--sr-mono)", fontSize: 10,
          letterSpacing: "-0.3px"
        }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--sr-critical)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--sr-critical)", boxShadow: "0 0 4px var(--sr-critical)" }} />
            {activeCount} active
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--sr-success)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--sr-success)", boxShadow: "0 0 4px var(--sr-success)" }} />
            {resolvedCount} resolved
          </span>
        </div>
      )}

      {/* Timeline */}
      {loading ? (
        <div style={{ padding: "0 12px", display: "flex", flexDirection: "column", gap: 12 }}>
          {[1,2,3,4,5].map(i => (
            <div key={i} className="sr-skeleton" style={{ height: 48 }} />
          ))}
        </div>
      ) : timeline.length === 0 ? (
        <div className="sr-empty">
          <div className="sr-empty-text">no events in {timeframe}</div>
        </div>
      ) : (
        grouped.map(([date, items]) => (
          <div key={date} className="sr-section">
            <div className="sr-section-head">
              <span className="sr-section-title">{date}</span>
              <span className="sr-section-badge">{items.length}</span>
            </div>
            <div className="sr-timeline">
              {items.map((p, idx) => {
                const isActive = p["event.status"] === "ACTIVE";
                const color = isActive ? "var(--sr-critical)" : "var(--sr-success)";
                const catColor = CATEGORY_COLORS[p["event.category"]] || "#6366F1";
                const time = new Date(p["event.start"]).toLocaleTimeString("en-US", {
                  hour: "2-digit", minute: "2-digit", hour12: false
                });
                return (
                  <div
                    key={idx}
                    className="sr-timeline-item"
                    style={{ cursor: "pointer", animationDelay: `${idx * 30}ms` }}
                    onClick={() => navigate(`/?focus=${p.display_id}`)}
                  >
                    <span className="sr-timeline-dot" style={{ background: color, color }} />
                    <div className="sr-timeline-content">
                      <div className="sr-timeline-text">{p["event.name"]}</div>
                      <div className="sr-timeline-time">
                        <span style={{ marginRight: 6 }}>{time}</span>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 3, marginRight: 6,
                        }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: catColor }} />
                          {getCategoryLabel(p["event.category"])}
                        </span>
                        {formatRelativeTime(p["event.start"])}
                        <span style={{ marginLeft: 4, opacity: 0.6 }}>
                          {isActive ? "● active" : "○ closed"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
};
