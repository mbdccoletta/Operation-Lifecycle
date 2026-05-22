// @vitest-environment jsdom
//
// Behaviour tests for the shared filter context. The two pieces
// we MUST keep coherent across changes:
//
//   1. `setStatus` (idempotent) vs `toggleStatus` (toggle) — the
//      bug we just fixed where the chip-click setter accidentally
//      cleared the value on URL re-hydration (because the URL
//      effect would call `setStatus(currentValue)` and the toggle
//      semantic would interpret that as "clear").
//
//   2. `clearAll` clears BOTH the categories Set and the status
//      scalar in one call — the strip's `✕ Clear` button depends
//      on this.

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import {
  CategoryFilterProvider,
  useCategoryFilter,
} from "./CategoryFilterContext";

// Probe component — exposes the context's surface as readable DOM
// strings + clickable buttons so we can drive it from RTL.
const Probe: React.FC = () => {
  const ctx = useCategoryFilter();
  return (
    <div>
      <span data-testid="status">{String(ctx.status)}</span>
      <span data-testid="cats">{Array.from(ctx.filter).sort().join(",")}</span>
      <button onClick={() => ctx.setStatus("ACTIVE")}>setActive</button>
      <button onClick={() => ctx.setStatus("CLOSED")}>setClosed</button>
      <button onClick={() => ctx.setStatus(null)}>setNull</button>
      <button onClick={() => ctx.toggleStatus("ACTIVE")}>toggleActive</button>
      <button onClick={() => ctx.toggleStatus("CLOSED")}>toggleClosed</button>
      <button onClick={() => ctx.toggle("ERROR")}>toggleERROR</button>
      <button onClick={() => ctx.toggle("AVAILABILITY")}>toggleAVAILABILITY</button>
      <button onClick={() => ctx.clear()}>clearCats</button>
      <button onClick={() => ctx.clearAll()}>clearAll</button>
    </div>
  );
};

const renderProbe = () =>
  render(
    <CategoryFilterProvider>
      <Probe />
    </CategoryFilterProvider>,
  );

describe("CategoryFilterContext — status semantics", () => {
  it("starts with status=null", () => {
    renderProbe();
    expect(screen.getByTestId("status").textContent).toBe("null");
  });

  it("setStatus is idempotent (passing the same value DOES NOT clear)", () => {
    renderProbe();
    fireEvent.click(screen.getByText("setActive"));
    expect(screen.getByTestId("status").textContent).toBe("ACTIVE");
    // Re-applying the same value must NOT toggle off — this is
    // the URL-hydration safety property.
    fireEvent.click(screen.getByText("setActive"));
    expect(screen.getByTestId("status").textContent).toBe("ACTIVE");
  });

  it("setStatus(null) clears", () => {
    renderProbe();
    fireEvent.click(screen.getByText("setActive"));
    fireEvent.click(screen.getByText("setNull"));
    expect(screen.getByTestId("status").textContent).toBe("null");
  });

  it("toggleStatus turns the value on", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleActive"));
    expect(screen.getByTestId("status").textContent).toBe("ACTIVE");
  });

  it("toggleStatus re-applied to the same value clears", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleActive"));
    fireEvent.click(screen.getByText("toggleActive"));
    expect(screen.getByTestId("status").textContent).toBe("null");
  });

  it("toggleStatus to a DIFFERENT value replaces (mutually exclusive)", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleActive"));
    fireEvent.click(screen.getByText("toggleClosed"));
    expect(screen.getByTestId("status").textContent).toBe("CLOSED");
  });
});

describe("CategoryFilterContext — category semantics", () => {
  it("toggle adds a category", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleERROR"));
    expect(screen.getByTestId("cats").textContent).toBe("ERROR");
  });

  it("toggle removes the same category on second click", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleERROR"));
    fireEvent.click(screen.getByText("toggleERROR"));
    expect(screen.getByTestId("cats").textContent).toBe("");
  });

  it("multiple categories accumulate", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleERROR"));
    fireEvent.click(screen.getByText("toggleAVAILABILITY"));
    expect(screen.getByTestId("cats").textContent).toBe("AVAILABILITY,ERROR");
  });
});

describe("CategoryFilterContext — clear semantics", () => {
  it("clear() empties categories but leaves status untouched", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleERROR"));
    fireEvent.click(screen.getByText("setActive"));
    fireEvent.click(screen.getByText("clearCats"));
    expect(screen.getByTestId("cats").textContent).toBe("");
    expect(screen.getByTestId("status").textContent).toBe("ACTIVE");
  });

  it("clearAll() empties BOTH", () => {
    renderProbe();
    fireEvent.click(screen.getByText("toggleERROR"));
    fireEvent.click(screen.getByText("setActive"));
    fireEvent.click(screen.getByText("clearAll"));
    expect(screen.getByTestId("cats").textContent).toBe("");
    expect(screen.getByTestId("status").textContent).toBe("null");
  });
});

describe("CategoryFilterContext — URL hydration regression scenario", () => {
  // Reproduces the exact failure mode the v0.0.26 setStatus split
  // was designed to prevent: the URL effect calls `setStatus(...)`
  // every time `searchParams` changes; if that setter toggled,
  // the value would flip-flop on every re-render.
  it("repeated setStatus calls with the same value are stable", () => {
    renderProbe();
    act(() => {
      // Simulate the URL effect firing 5 times in a row with the
      // same intended state (it does that whenever React decides
      // to re-run the URL → state effect for any reason).
      for (let i = 0; i < 5; i++) {
        fireEvent.click(screen.getByText("setActive"));
      }
    });
    expect(screen.getByTestId("status").textContent).toBe("ACTIVE");
  });
});
