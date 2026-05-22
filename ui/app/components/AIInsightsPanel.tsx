import React, { useMemo } from "react";
import type { Problem } from "../hooks/useProblems";
import { getCategoryLabel } from "../utils/formatters";

interface AIInsightsPanelProps {
  problems: Problem[];
  loading?: boolean;
}

interface Insight {
  type: "critical" | "warning" | "info" | "success";
  icon: string;
  title: string;
  description: string;
  metric?: string;
}

export const AIInsightsPanel: React.FC<AIInsightsPanelProps> = ({ problems, loading }) => {
  const insights = useMemo<Insight[]>(() => {
    if (!problems.length) return [];
    const result: Insight[] = [];

    const active = problems.filter((p) => p["event.status"] === "ACTIVE");
    const resolved = problems.filter((p) => p["event.status"] === "CLOSED");

    // 1. Root cause correlation
    const rootCauseMap: Record<string, Problem[]> = {};
    active.forEach((p) => {
      if (p.root_cause_entity_id) {
        if (!rootCauseMap[p.root_cause_entity_id]) rootCauseMap[p.root_cause_entity_id] = [];
        rootCauseMap[p.root_cause_entity_id].push(p);
      }
    });
    const correlated = Object.entries(rootCauseMap).filter(([, ps]) => ps.length > 1);
    if (correlated.length > 0) {
      const [entityId, ps] = correlated.sort((a, b) => b[1].length - a[1].length)[0];
      result.push({
        type: "critical",
        icon: "⟁",
        title: "Correlated Failure Detected",
        description: `${ps.length} active incidents share the same root cause entity. Likely cascading failure from ${entityId.split("-")[0]}...`,
        metric: `${ps.length} linked`,
      });
    }

    // 2. Category trend spike
    const catCounts: Record<string, number> = {};
    problems.forEach((p) => { catCounts[p["event.category"]] = (catCounts[p["event.category"]] || 0) + 1; });
    const topCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
    if (topCat && topCat[1] >= 3) {
      const pct = Math.round((topCat[1] / problems.length) * 100);
      result.push({
        type: "warning",
        icon: "△",
        title: `${getCategoryLabel(topCat[0])} Trend Spike`,
        description: `${getCategoryLabel(topCat[0])} represents ${pct}% of all incidents. Consider investigating systemic issues.`,
        metric: `${topCat[1]} incidents`,
      });
    }

    // 3. Long-running active incidents
    const longRunning = active.filter((p) => {
      const hours = (Date.now() - new Date(p["event.start"]).getTime()) / 3600000;
      return hours > 4;
    });
    if (longRunning.length > 0) {
      const maxHours = Math.max(
        ...longRunning.map((p) => (Date.now() - new Date(p["event.start"]).getTime()) / 3600000)
      );
      result.push({
        type: "critical",
        icon: "⏱",
        title: "Extended Incidents",
        description: `${longRunning.length} incident${longRunning.length > 1 ? "s" : ""} open for over 4 hours. Longest running: ${maxHours.toFixed(1)}h.`,
        metric: `${longRunning.length} stale`,
      });
    }

    // 4. Resolution rate
    if (resolved.length > 0 && problems.length > 5) {
      const rate = Math.round((resolved.length / problems.length) * 100);
      result.push({
        type: rate > 70 ? "success" : rate > 40 ? "warning" : "critical",
        icon: rate > 70 ? "✓" : "⚠",
        title: "Resolution Rate",
        description: rate > 70
          ? `Strong resolution rate at ${rate}%. Team is actively managing incidents.`
          : `Resolution rate at ${rate}%. Consider prioritizing incident closure.`,
        metric: `${rate}%`,
      });
    }

    // 5. Blast radius
    const entitySet = new Set<string>();
    active.forEach((p) => p.affected_entity_ids?.forEach((id) => entitySet.add(id)));
    if (entitySet.size > 3) {
      result.push({
        type: "warning",
        icon: "◎",
        title: "Wide Blast Radius",
        description: `${entitySet.size} unique entities affected by active incidents. Impact is spreading across your infrastructure.`,
        metric: `${entitySet.size} entities`,
      });
    }

    // 6. Quiet period
    if (active.length === 0 && problems.length > 0) {
      result.push({
        type: "success",
        icon: "◉",
        title: "All Clear",
        description: "No active incidents. Environment is stable. All recent incidents have been resolved.",
        metric: "0 active",
      });
    }

    return result;
  }, [problems]);

  if (loading) {
    return (
      <div className="sr-ai-panel">
        <div className="sr-ai-header">
          <span className="sr-ai-badge">AI</span>
          <span className="sr-ai-title">Analyzing...</span>
        </div>
        <div className="sr-skeleton" style={{ height: 60 }} />
      </div>
    );
  }

  if (insights.length === 0) return null;

  return (
    <div className="sr-ai-panel">
      <div className="sr-ai-header">
        <span className="sr-ai-badge">AI</span>
        <span className="sr-ai-title">Intelligent Insights</span>
        <span className="sr-ai-count">{insights.length}</span>
      </div>
      <div className="sr-ai-list">
        {insights.map((insight, idx) => (
          <div key={idx} className={`sr-ai-card sr-ai-card-${insight.type}`}>
            <div className="sr-ai-card-icon">{insight.icon}</div>
            <div className="sr-ai-card-body">
              <div className="sr-ai-card-title">{insight.title}</div>
              <div className="sr-ai-card-desc">{insight.description}</div>
            </div>
            {insight.metric && (
              <div className="sr-ai-card-metric">{insight.metric}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
