// 0.0.217 — Replacement for the Strato `<SegmentSelector />`.
//
// Why we own this code: in the Bradesco tenant the native Strato
// component opens its dropdown but never surfaces anything beyond
// the "Recently used" slice. We list the full catalog with
// `useFilterSegments` (proven to work — already in production for
// the optional Segments-grouped view) and push the user's pick
// into the global Strato segment state via `useSegments().addSegment()`
// so every existing `useDql` consumer keeps reading from the same
// source of truth.
//
// Parameterised segments (variables): when the user clicks one,
// we fetch the detailed segment, parse its DQL `includes[].filter`
// strings for `$variableName` tokens, and surface one input per
// variable. The default value falls back to `lean.variables.value`
// (the value the user most recently used, surfaced by the lean
// API). On submit we addSegment with `variables: [{ name, values }]`.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { filterSegmentsClient } from "@dynatrace-sdk/client-filter-segment-management";
import type { DetailedFilterSegment } from "@dynatrace-sdk/client-filter-segment-management";
import { useFilterSegments } from "../hooks/useFilterSegments";

interface SegmentBrowserDropdownProps {
  triggerLabel?: string;
}

/** Extract `$variableName` tokens from a DQL filter expression.
 *  Variable names start with `$` and are followed by `[A-Za-z_][A-Za-z0-9_]*`. */
function extractVariableNames(filter: string): string[] {
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(filter)) !== null) names.add(m[1]);
  return Array.from(names);
}

export function SegmentBrowserDropdown({ triggerLabel = "Browse segments" }: SegmentBrowserDropdownProps) {
  const { segments: catalog, loading, error, refetch } = useFilterSegments();
  const { segments: selected, addSegment, removeSegment } = useSegments();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, DetailedFilterSegment>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape — keeps the dropdown behaviour
  // aligned with native Strato selectors so users don't have to
  // learn a new dismiss pattern.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedUid(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (expandedUid) setExpandedUid(null);
        else setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, expandedUid]);

  const selectedIds = useMemo(
    () => new Set(selected.map((s) => s.id)),
    [selected],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // 0.0.219 — Sort alphabetically (case-insensitive). Matches
    // the native Davis Problems segment selector. User: "deve ser
    // exatamente como no app nativo".
    const list = catalog
      .filter((s) => s.allowedOperations?.includes("READ") ?? true)
      .slice()
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    if (!q) return list;
    return list.filter((s) => s.name.toLowerCase().includes(q));
  }, [catalog, search]);

  /** Pull the detailed segment definition (+ INCLUDES + VARIABLES)
   *  on demand, cache it, and pre-populate the variable inputs with
   *  the lean default. Triggered when the user expands a row. */
  const loadDetail = useCallback(async (uid: string, leanDefault?: string) => {
    if (detailCache[uid]) {
      // Pre-fill from cache.
      const det = detailCache[uid];
      const names = new Set<string>();
      for (const inc of det.includes || []) {
        for (const n of extractVariableNames(inc.filter)) names.add(n);
      }
      const prefill: Record<string, string> = {};
      for (const n of names) prefill[n] = varValues[n] ?? leanDefault ?? "";
      setVarValues(prefill);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const det = await filterSegmentsClient.getFilterSegment({
        filterSegmentUid: uid,
        addFields: ["INCLUDES", "VARIABLES"],
      });
      setDetailCache((prev) => ({ ...prev, [uid]: det }));
      const names = new Set<string>();
      for (const inc of det.includes || []) {
        for (const n of extractVariableNames(inc.filter)) names.add(n);
      }
      const prefill: Record<string, string> = {};
      for (const n of names) prefill[n] = leanDefault ?? "";
      setVarValues(prefill);
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, [detailCache, varValues]);

  const handleSegmentClick = useCallback(
    async (uid: string, name: string, isVariable: boolean, leanDefault?: string) => {
      setFeedback(null);
      if (selectedIds.has(uid)) {
        removeSegment(uid);
        setFeedback({ kind: "ok", msg: `Removed "${name}"` });
        return;
      }
      if (!isVariable) {
        try {
          const result = await addSegment({ id: uid });
          if (result === false) {
            setFeedback({ kind: "err", msg: `"${name}" rejected by the platform.` });
          } else {
            setFeedback({ kind: "ok", msg: `Added "${name}"` });
            setOpen(false);
          }
        } catch {
          setFeedback({ kind: "err", msg: `Failed to add "${name}".` });
        }
        return;
      }
      // Parameterised — expand inline, fetch details.
      if (expandedUid === uid) {
        setExpandedUid(null);
        return;
      }
      setExpandedUid(uid);
      loadDetail(uid, leanDefault);
    },
    [addSegment, removeSegment, selectedIds, expandedUid, loadDetail],
  );

  /** Submit the variable form for `uid`. Collects values from
   *  `varValues`, packs them into `addSegment`'s required shape
   *  (`[{ name, values: [v] }]`). */
  const submitWithVariables = useCallback(async (uid: string, name: string) => {
    setFeedback(null);
    const det = detailCache[uid];
    if (!det) return;
    const varNames = new Set<string>();
    for (const inc of det.includes || []) {
      for (const n of extractVariableNames(inc.filter)) varNames.add(n);
    }
    const variables = Array.from(varNames).map((n) => ({
      name: n,
      values: [varValues[n] || ""].filter((v) => v.length > 0),
    })).filter((v) => v.values.length > 0);
    if (variables.length === 0) {
      setFeedback({ kind: "err", msg: "Please enter a value for each variable." });
      return;
    }
    try {
      const result = await addSegment({ id: uid, variables });
      if (result === false) {
        setFeedback({ kind: "err", msg: `"${name}" rejected — check the variable value.` });
      } else {
        setFeedback({ kind: "ok", msg: `Added "${name}" with variables.` });
        setOpen(false);
        setExpandedUid(null);
      }
    } catch (e) {
      setFeedback({ kind: "err", msg: `Failed: ${(e as Error).message}` });
    }
  }, [detailCache, varValues, addSegment]);

  // 0.0.219 — Trigger label matches the native Davis Problems chip:
  // no selection shows "Select segment"; with selection, show the
  // segment id(s) (the catalog name lookup gracefully falls back
  // to the id so we never break when a stale id sits in state).
  const triggerText = useMemo(() => {
    if (selected.length === 0) return triggerLabel;
    if (selected.length === 1) {
      const match = catalog.find((s) => s.uid === selected[0].id);
      return match?.name ?? selected[0].id;
    }
    return `${selected.length} segments`;
  }, [selected, catalog, triggerLabel]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="neo-toggle-btn"
        title={loading ? "Loading segments…" : `${catalog.length} segments available`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          fontFamily: "var(--neo-mono)",
          fontSize: "12px",
          minHeight: 32,
        }}
      >
        <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {triggerText}
        </span>
        <span style={{ opacity: 0.6, fontSize: "10px" }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Browse segments"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 99999,
            width: 360,
            maxHeight: 460,
            display: "flex",
            flexDirection: "column",
            background: "var(--neo-surface-2)",
            border: "1px solid var(--neo-border)",
            borderRadius: "var(--neo-radius)",
            boxShadow: "0 12px 36px rgba(0,0,0,0.45)",
            padding: 10,
            gap: 8,
          }}
        >
          {/* 0.0.219 — Header label + search-with-icon to mirror
              the native Davis Problems segment selector layout
              ("deve ser exatamente como no app nativo"). */}
          <div style={{ fontSize: 11, color: "var(--neo-text-3)", paddingLeft: 4 }}>
            Filter by segments
          </div>
          <div style={{ position: "relative" }}>
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--neo-text-3)",
                fontSize: 13,
              }}
            >
              ⌕
            </span>
            <input
              type="text"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              style={{
                padding: "6px 10px 6px 28px",
                width: "100%",
                boxSizing: "border-box",
                borderRadius: 6,
                border: "1px solid var(--neo-border)",
                background: "var(--neo-surface)",
                color: "var(--neo-text)",
                fontFamily: "var(--neo-mono)",
                fontSize: 12,
              }}
            />
          </div>

          {loading && (
            <div style={{ fontSize: 12, color: "var(--neo-text-3)", padding: "6px 4px" }}>
              Loading segments…
            </div>
          )}
          {error && (
            <div style={{ fontSize: 12, color: "#ff6b8a", padding: "6px 4px" }}>
              Failed to load: {error.message}.{" "}
              <button
                type="button"
                onClick={() => refetch()}
                style={{
                  background: "transparent",
                  color: "#7aa2ff",
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  fontSize: 12,
                  textDecoration: "underline",
                }}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--neo-text-3)", padding: "6px 4px" }}>
              {catalog.length === 0
                ? "No segments configured in this tenant."
                : "No matches."}
            </div>
          )}

          <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.map((s) => {
              const isSelected = selectedIds.has(s.uid);
              const hasVariable = !!s.variables;
              const isExpanded = expandedUid === s.uid;
              const leanDefault = s.variables?.value ?? "";
              const det = detailCache[s.uid];
              const varNames = det
                ? Array.from(new Set((det.includes || []).flatMap((inc) => extractVariableNames(inc.filter))))
                : [];
              return (
                <div
                  key={s.uid}
                  style={{
                    border: "1px solid " + (isExpanded ? "rgba(122,162,255,0.3)" : "transparent"),
                    borderRadius: 6,
                    background: isSelected ? "rgba(122,162,255,0.16)" : "transparent",
                  }}
                >
                  {/* 0.0.219 — Item simplified to match native: name
                      only. Visibility / owner / var badges removed.
                      Selected state is conveyed by the row's tinted
                      background already (see parent <div>). */}
                  <button
                    type="button"
                    onClick={() => handleSegmentClick(s.uid, s.name, hasVariable, leanDefault)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      padding: "8px 10px",
                      border: 0,
                      background: "transparent",
                      color: "var(--neo-text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "var(--neo-mono)",
                      fontSize: 12,
                      width: "100%",
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{s.name}</span>
                  </button>
                  {isExpanded && hasVariable && (
                    <div
                      style={{
                        padding: "0 10px 10px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        fontSize: 11,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {detailLoading && (
                        <div style={{ color: "var(--neo-text-3)" }}>Loading variable definitions…</div>
                      )}
                      {detailError && (
                        <div style={{ color: "#ff6b8a" }}>Failed: {detailError}</div>
                      )}
                      {!detailLoading && !detailError && det && varNames.length === 0 && (
                        <div style={{ color: "var(--neo-text-3)" }}>
                          Variables present but no `$name` tokens found in the includes.
                          Try the native selector.
                        </div>
                      )}
                      {!detailLoading && !detailError && varNames.map((n) => (
                        <label key={n} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <span style={{ color: "var(--neo-text-3)" }}>${n}</span>
                          <input
                            type="text"
                            value={varValues[n] ?? ""}
                            onChange={(e) => setVarValues((prev) => ({ ...prev, [n]: e.target.value }))}
                            placeholder={leanDefault || "Value"}
                            style={{
                              padding: "4px 8px",
                              borderRadius: 4,
                              border: "1px solid var(--neo-border)",
                              background: "var(--neo-surface)",
                              color: "var(--neo-text)",
                              fontFamily: "var(--neo-mono)",
                              fontSize: 12,
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") submitWithVariables(s.uid, s.name);
                            }}
                          />
                        </label>
                      ))}
                      {varNames.length > 0 && (
                        <button
                          type="button"
                          onClick={() => submitWithVariables(s.uid, s.name)}
                          style={{
                            marginTop: 4,
                            padding: "6px 10px",
                            borderRadius: 6,
                            border: "1px solid #7aa2ff",
                            background: "rgba(122,162,255,0.16)",
                            color: "var(--neo-text)",
                            fontFamily: "var(--neo-mono)",
                            fontSize: 12,
                            cursor: "pointer",
                          }}
                        >
                          Apply
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {feedback && (
            <div
              role="status"
              style={{
                marginTop: 4,
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: 11,
                background: feedback.kind === "ok" ? "rgba(34,211,160,0.12)" : "rgba(255,107,138,0.12)",
                color: feedback.kind === "ok" ? "#22d3a0" : "#ff6b8a",
              }}
            >
              {feedback.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
