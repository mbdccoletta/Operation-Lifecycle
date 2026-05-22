import React from "react";
import { FilterBar } from "@dynatrace/strato-components-preview/filters";
import { Select, SelectOption, SelectContent } from "@dynatrace/strato-components-preview/forms";

interface ProblemFiltersProps {
  status: string;
  category: string;
  timeframe: string;
  onStatusChange: (value: string) => void;
  onCategoryChange: (value: string) => void;
  onTimeframeChange: (value: string) => void;
}

export const ProblemFilters = ({
  status,
  category,
  timeframe,
  onStatusChange,
  onCategoryChange,
  onTimeframeChange,
}: ProblemFiltersProps) => {
  return (
    <FilterBar onFilterChange={() => {}}>
      <FilterBar.Item name="status" label="Status">
        <Select value={status || null} onChange={(v) => onStatusChange(v || "")}>
          <SelectContent>
            <SelectOption value="">All</SelectOption>
            <SelectOption value="ACTIVE">Active</SelectOption>
            <SelectOption value="CLOSED">Closed</SelectOption>
          </SelectContent>
        </Select>
      </FilterBar.Item>
      <FilterBar.Item name="category" label="Category">
        <Select value={category || null} onChange={(v) => onCategoryChange(v || "")}>
          <SelectContent>
            <SelectOption value="">All</SelectOption>
            <SelectOption value="AVAILABILITY">Availability</SelectOption>
            <SelectOption value="ERROR">Error</SelectOption>
            <SelectOption value="SLOWDOWN">Slowdown</SelectOption>
            <SelectOption value="RESOURCE">Resource</SelectOption>
            <SelectOption value="CUSTOM">Custom</SelectOption>
          </SelectContent>
        </Select>
      </FilterBar.Item>
      <FilterBar.Item name="timeframe" label="Timeframe">
        <Select value={timeframe} onChange={(v) => onTimeframeChange(v || "72h")}>
          <SelectContent>
            <SelectOption value="24h">Last 24 hours</SelectOption>
            <SelectOption value="72h">Last 72 hours</SelectOption>
            <SelectOption value="7d">Last 7 days</SelectOption>
            <SelectOption value="14d">Last 14 days</SelectOption>
            <SelectOption value="30d">Last 30 days</SelectOption>
          </SelectContent>
        </Select>
      </FilterBar.Item>
    </FilterBar>
  );
};
