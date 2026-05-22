// @vitest-environment jsdom
//
// Sentinel test that proves the jsdom + RTL + jest-dom pipeline is
// wired correctly. Lives in `components/` so future component
// specs sit alongside it as `<Name>.test.tsx`.
//
// We render an intentionally trivial inline component (instead of
// pulling something from the app) so this test catches setup
// regressions independently of any app-code change.

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const Counter: React.FC<{ initial?: number }> = ({ initial = 0 }) => {
  const [n, setN] = React.useState(initial);
  return (
    <div>
      <span data-testid="count">{n}</span>
      <button onClick={() => setN((v) => v + 1)}>increment</button>
    </div>
  );
};

describe("DOM smoke", () => {
  it("renders + reacts to a click", () => {
    render(<Counter initial={3} />);
    expect(screen.getByTestId("count")).toHaveTextContent("3");
    fireEvent.click(screen.getByText("increment"));
    expect(screen.getByTestId("count")).toHaveTextContent("4");
  });
});
