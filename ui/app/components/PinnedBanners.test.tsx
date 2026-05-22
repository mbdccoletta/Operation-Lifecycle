// @vitest-environment jsdom
//
// Tests for the pinned-filter banner stack. Lightweight by design —
// `PinnedBanners` is a dumb renderer with no internal state, so the
// surface area to test is "did the right banner render for the
// right combo of filters, and does ✕ Clear call back the right
// setter?".

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PinnedBanners } from "./PinnedBanners";
import type { Problem } from "../hooks/useProblems";

// Minimal problem fixture — fields not touched by the renderer
// default to safe placeholders. The renderer only reads
// `affected_entity_ids`, `affected_entity_names`,
// `root_cause_entity_id`, `root_cause_entity_name`.
const makeProblem = (overrides: Partial<Problem>): Problem => ({
  "event.name":     "fixture",
  "event.status":   "ACTIVE",
  "event.category": "ERROR",
  "event.start":    "2026-05-01T00:00:00Z",
  affected_entity_ids: [],
  root_cause_entity_id: "",
  display_id: "P-00000000",
  ...overrides,
});

const NO_FILTERS = {
  problems: [],
  pinnedProblemId: null,
  onClearPinnedProblem: () => {},
  entityFilter: null,
  onClearEntityFilter: () => {},
  rceFilter: null,
  onClearRceFilter: () => {},
  statusFilter: null,
  onClearStatusFilter: () => {},
  stuckHoursFilter: null,
  onClearStuckHoursFilter: () => {},
} as const;

describe("PinnedBanners", () => {
  it("renders nothing when no filters are active", () => {
    const { container } = render(<PinnedBanners {...NO_FILTERS} />);
    expect(container.querySelectorAll(".neo-pinned-banner").length).toBe(0);
  });

  it("renders the pinned-problem banner with the id", () => {
    render(<PinnedBanners {...NO_FILTERS} pinnedProblemId="P-12345678" />);
    expect(screen.getByText("Pinned to problem")).toBeInTheDocument();
    expect(screen.getByText("P-12345678")).toBeInTheDocument();
  });

  it("resolves a friendly entity name from the sample list", () => {
    const problems = [
      makeProblem({
        affected_entity_ids:   ["HOST-AB12"],
        affected_entity_names: ["tacocorp"],
      }),
    ];
    render(
      <PinnedBanners
        {...NO_FILTERS}
        problems={problems}
        entityFilter="HOST-AB12"
      />,
    );
    expect(screen.getByText("Affected entity")).toBeInTheDocument();
    expect(screen.getByText("tacocorp")).toBeInTheDocument();
  });

  it("falls back to the raw id when no friendly name is available", () => {
    render(
      <PinnedBanners
        {...NO_FILTERS}
        problems={[]}
        entityFilter="HOST-AB12"
      />,
    );
    expect(screen.getByText("HOST-AB12")).toBeInTheDocument();
  });

  it("renders ACTIVE in red and CLOSED in grey", () => {
    const { rerender, container } = render(
      <PinnedBanners {...NO_FILTERS} statusFilter="ACTIVE" />,
    );
    const dotActive = container.querySelector(".neo-pinned-dot") as HTMLElement;
    expect(dotActive.style.background).toMatch(/rgb\(255, ?77, ?106\)|#ff4d6a/i);

    rerender(<PinnedBanners {...NO_FILTERS} statusFilter="CLOSED" />);
    const dotClosed = container.querySelector(".neo-pinned-dot") as HTMLElement;
    expect(dotClosed.style.background).toMatch(/rgb\(148, ?163, ?184\)|#94A3B8/i);
  });

  it("formats stuck > 24h as a day count", () => {
    render(<PinnedBanners {...NO_FILTERS} stuckHoursFilter={48} />);
    expect(screen.getByText("> 2 d")).toBeInTheDocument();
  });

  it("formats stuck < 24h in hours", () => {
    render(<PinnedBanners {...NO_FILTERS} stuckHoursFilter={6} />);
    expect(screen.getByText("> 6 h")).toBeInTheDocument();
  });

  it("invokes the matching onClear callback when ✕ is clicked", () => {
    const onClearStatusFilter = vi.fn();
    render(
      <PinnedBanners
        {...NO_FILTERS}
        statusFilter="ACTIVE"
        onClearStatusFilter={onClearStatusFilter}
      />,
    );
    const banner = screen.getByText("Status").closest(".neo-pinned-banner") as HTMLElement;
    const clearBtn = within(banner).getByRole("button");
    fireEvent.click(clearBtn);
    expect(onClearStatusFilter).toHaveBeenCalledTimes(1);
  });

  it("renders multiple banners when multiple filters are active", () => {
    render(
      <PinnedBanners
        {...NO_FILTERS}
        pinnedProblemId="P-1"
        statusFilter="ACTIVE"
        stuckHoursFilter={2}
      />,
    );
    expect(screen.getAllByRole("status").length).toBe(3);
  });
});
