// Vitest global setup. Imported once per worker.
//
// We do `@testing-library/jest-dom`'s matcher extension here so
// every component spec gets `expect(...).toBeInTheDocument()` etc.
// without each file having to import it manually.
//
// `jest-dom` itself can run safely under node — it only attaches
// matchers when the DOM types are available. Files using the node
// env simply never call any DOM matcher and pay no cost.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL v14 normally auto-cleans, but only when it detects the
// Jest / Mocha globals. With vitest the detection misses, so we
// register cleanup explicitly. Without this, DOM from one test
// leaks into the next and `getByText` / `getAllByRole` match
// elements rendered by previous specs.
afterEach(() => {
  cleanup();
});
