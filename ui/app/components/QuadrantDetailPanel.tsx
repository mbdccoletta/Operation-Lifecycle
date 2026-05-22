import React, { useMemo } from "react";
import type { Problem } from "../hooks/useProblems";
import { getCategoryLabel, formatRelativeTime } from "../utils/formatters";

interface QuadrantDetailPanelProps {
  category: string;
  problems: Problem[];
  onClose: () => void;
  onSelectProblem: (problem: Problem) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  AVAILABILITY:           "#a3e635",
  ERROR:                  "#ff8b3e",
  SLOWDOWN:               "#4da6ff",
  RESOURCE_CONTENTION:    "#a855f7",
  CUSTOM_ALERT:           "#6ee7b7",
  MONITORING_UNAVAILABLE: "#f59e0b",
};

function formatDuration(start: string): string {
  const ms = Date.now() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export const QuadrantDetailPanel: React.FC<QuadrantDetailPanelProps> = ({
  category,
  problems,
  onClose,
  onSelectProblem,
}) => {
  const items = useMemo(() => {
    const filtered = problems.filter((p) => p["event.category"] === category);
    // Active first, then by start time desc
    return filtered.sort((a, b) => {
      const aActive = a["event.status"] === "ACTIVE" ? 0 : 1;
      const bActive = b["event.status"] === "ACTIVE" ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b["event.start"]).getTime() - new Date(a["event.start"]).getTime();
    });
  }, [problems, category]);

  const activeCount   = items.filter((p) => p["event.status"] === "ACTIVE").length;
  const resolvedCount = items.length - activeCount;
  const accentColor   = CATEGORY_COLORS[category] || "#94a3b8";

  return (
    <div className="neo-qpanel-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <aside
        className="neo-qpanel"
        style={{ ["--qpanel-accent" as string]: accentColor }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="neo-qpanel-header">
          <div className="neo-qpanel-title-block">
            <span className="neo-qpanel-dot" />
            <div>
              <div className="neo-qpanel-title">{getCategoryLabel(category)}</div>
              <div className="neo-qpanel-subtitle">
                {activeCount} active · {resolvedCount} resolved · {items.length} total
              </div>
            </div>
          </div>
          <button className="neo-qpanel-close" onClick={onClose} title="Close panel">✕</button>
        </header>

        <div className="neo-qpanel-list">
          {items.length === 0 && (
            <div className="neo-qpanel-empty">No incidents in this category for the selected timeframe.</div>
          )}
          {items.map((p) => {
            const isActive = p["event.status"] === "ACTIVE";
            const entityCount = p.affected_entity_ids?.length || 0;
            return (
              <button
                key={p.display_id}
                className={`neo-qpanel-item${isActive ? " neo-qpanel-item-active" : ""}`}
                onClick={() => onSelectProblem(p)}
              >
                <div className="neo-qpanel-item-head">
                  <span className={`neo-qpanel-status ${isActive ? "neo-qpanel-status-active" : "neo-qpanel-status-closed"}`}>
                    {isActive ? "Active" : "Closed"}
                  </span>
                  <span className="neo-qpanel-item-id">{p.display_id}</span>
                  <span className="neo-qpanel-item-age">{formatDuration(p["event.start"])}</span>
                </div>
                <div className="neo-qpanel-item-name">{p["event.name"]}</div>
                <div className="neo-qpanel-item-meta">
                  <span>{formatRelativeTime(p["event.start"])}</span>
                  {entityCount > 0 && <span>· {entityCount} {entityCount === 1 ? "entity" : "entities"}</span>}
                  {p.root_cause_entity_id && <span>· Root: {p.root_cause_entity_id.split("-")[0]}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
};
