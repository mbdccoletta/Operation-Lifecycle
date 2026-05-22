// App-level error boundary. Catches:
//   • Render errors in any descendant component.
//   • Hook errors that surface during render.
// Does NOT catch (per React docs, by design):
//   • Async errors (Promises) — wired separately via
//     `installGlobalErrorHandlers()` below.
//   • Event-handler errors — same.
//   • Errors thrown inside this component itself.
//
// Every captured render-time crash is forwarded to the structured
// logger so future RUM / beacon integration only needs to swap
// `logger.emit()`.

import React from "react";
import { logger } from "../utils/logger";

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Single observability hook. The componentStack is the
    // actionable bit for triage — production builds strip line
    // numbers, but the stack tells you WHICH component blew up.
    logger.error("React render boundary caught error", {
      category: "error-boundary",
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  reset = () => {
    // Try-again resets state in place — only refresh as a last
    // resort (the Reload button) because the user's URL state
    // (filters, drilldowns) is the cheapest path back to where
    // they were.
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: 24, minHeight: "100vh",
          background: "#080E1A", color: "#e8eaf6",
          fontFamily: "system-ui, sans-serif",
          display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", gap: 16,
        }}>
          <div style={{ fontSize: 32 }}>⚠</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Something went wrong</div>
          <div style={{
            fontSize: 12, color: "#E5484D",
            fontFamily: "monospace", maxWidth: 400,
            textAlign: "center", lineHeight: 1.5,
          }}>
            {this.state.error?.message}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              onClick={this.reset}
              style={{
                padding: "8px 20px", borderRadius: 8,
                background: "rgba(99,102,241,0.15)", color: "#6366F1",
                border: "1px solid rgba(99,102,241,0.4)", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 20px", borderRadius: 8,
                background: "transparent", color: "rgba(232,234,246,0.78)",
                border: "1px solid rgba(180,210,255,0.30)", cursor: "pointer",
                fontSize: 13, fontWeight: 600,
              }}
            >
              Reload App
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: "rgba(232,234,246,0.45)" }}>
            session: <code>{logger.sessionId}</code>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Global async / event-handler error capture ───────────────────
// React error boundaries miss Promise rejections and DOM event
// handler errors. These listeners route the residue through the
// same logger so we have one log stream regardless of origin.
// Idempotent — safe to call from React strict-mode's double-
// invocation phase.
let installed = false;
export function installGlobalErrorHandlers(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const message =
      reason instanceof Error ? reason.message :
      typeof reason === "string" ? reason :
      "Unhandled promise rejection";
    logger.error("Unhandled promise rejection", {
      category: "unhandled-rejection",
      message,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  window.addEventListener("error", (event) => {
    // `event.error` is null for cross-origin script errors. Use
    // whatever signal the browser gives — at minimum filename +
    // line number help triage.
    const message =
      event.error instanceof Error ? event.error.message :
      event.message || "Window error";
    logger.error("Window error event", {
      category: "window-error",
      message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
}
