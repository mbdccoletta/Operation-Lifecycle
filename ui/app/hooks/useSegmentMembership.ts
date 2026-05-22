// Map each problem to the set of filter-segments that contain it.
//
// Used by the Segments-grouped Overview: with a chosen list of segment
// UIDs (typically the top-N by active count), we run one parallel
// problems query per segment with that segment applied as a filter, then
// collect each problem's `display_id` into a `Map<displayId, Set<uid>>`.
//
// The global filter-bar selection (from Strato's `useSegments`) is
// composed onto every query so the membership view stays in lockstep
// with the rest of the app's filtering.
//
// Results are cached per `(segmentUid + filterKey)` for 60 s so the user
// can toggle modes / re-render without re-querying every segment.
import { useEffect, useMemo, useState } from "react";
import { queryExecutionClient } from "@dynatrace-sdk/client-query";
import type { FilterSegment } from "@dynatrace-sdk/client-query";
import { useSegments } from "@dynatrace/strato-components-preview/filters";
import { buildFilteredQuery } from "../utils/dql-queries";
import { logger } from "../utils/logger";
import type { ProblemFilters } from "./useProblems";

export interface SegmentMembershipState {
  /** display_id → set of segment UIDs the problem belongs to. */
  membership: Map<string, Set<string>>;
  /** True while any per-segment query is still in-flight. */
  loading: boolean;
  /** segmentUid → error, if that segment's query failed. Other segments
   *  may still have succeeded — the membership map carries whatever data
   *  did come back. */
  errors: Map<string, Error>;
}

interface CacheEntry {
  displayIds: Set<string>;
  ts: number;
}

const TTL_MS = 60_000;
/** LRU cap on the module-level cache (M7 in the perf audit). Without
 *  this, every unique (segmentUid, filterKey) combination accumulates
 *  forever — a user that browses segments across many timeframe /
 *  status filter combinations over a long session bloats the cache
 *  with stale entries. 200 covers typical exploration patterns
 *  (worst case = ~20 segments × 10 timeframe/status combos) while
 *  keeping resident memory bounded. */
const CACHE_MAX_ENTRIES = 200;

/** JS `Map` is insertion-ordered. We exploit that by re-inserting
 *  on read to make the entry "freshest", and dropping the oldest
 *  entry (first key in iteration order) when the cap is reached. */
const cache  = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Re-insert to mark as recently used.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  if (cache.size > CACHE_MAX_ENTRIES) {
    // Drop the oldest (first-inserted) entry. One drop per insert
    // amortises to O(1) maintenance.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Clears the in-memory cache. Useful for tests or after explicit
 *  refresh actions. Not normally needed — TTL handles staleness. */
export function clearSegmentMembershipCache(): void {
  cache.clear();
}

export function useSegmentMembership(
  segmentUids: string[],
  filters: ProblemFilters = {},
): SegmentMembershipState {
  const { segments: globalSegments } = useSegments();

  // Stable join keys for dep arrays — avoid re-running on every render
  // when the caller passes a fresh array reference of the same UIDs.
  const sortedUids = useMemo(
    () => [...segmentUids].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [segmentUids.join("|")],
  );
  const segKey    = sortedUids.join("|");
  const globalKey = useMemo(
    () => (globalSegments || []).map((s) => s.id).sort().join("|"),
    [globalSegments],
  );
  const filterKey = JSON.stringify({ ...filters, globalKey });

  const [loading, setLoading] = useState(false);
  const [errors, setErrors]   = useState<Map<string, Error>>(new Map());
  const [tick, setTick]       = useState(0);

  useEffect(() => {
    if (sortedUids.length === 0) {
      setLoading(false);
      setErrors(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrors(new Map());

    // Forwarded into the SDK so an in-flight `queryExecute` /
    // `queryPoll` can be aborted as soon as the effect tears down
    // (filter change, unmount). Without this, the polling loop
    // below would keep firing queryPoll for up to 30 seconds
    // after the component is gone — see H3 in the perf audit.
    const ac = new AbortController();

    const fetchOne = async (uid: string): Promise<void> => {
      const cacheKey = `${uid}|${filterKey}`;
      const hit = cacheGet(cacheKey);
      if (hit && Date.now() - hit.ts < TTL_MS) return;
      const segs: FilterSegment[] = [
        ...((globalSegments || []) as FilterSegment[]),
        { id: uid },
      ];
      const body = {
        query: buildFilteredQuery(filters),
        requestTimeoutMilliseconds: 30_000,
        maxResultRecords: 10_000,
        filterSegments: segs,
      } as Record<string, unknown>;

      let state = await queryExecutionClient.queryExecute({
        body: body as any,
        abortSignal: ac.signal,
      });
      let attempts = 0;
      while (state.state !== "SUCCEEDED") {
        // Check cancellation BEFORE waiting / polling — without
        // this the loop would keep running long after unmount.
        if (cancelled || ac.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        if (state.state === "FAILED") throw new Error("Query failed");
        if (++attempts > 30) throw new Error("Query timeout");
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled || ac.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        state = await queryExecutionClient.queryPoll({
          requestToken: state.requestToken!,
          abortSignal: ac.signal,
        });
      }
      const ids = new Set<string>();
      for (const rec of (state.result?.records || []) as Array<{ display_id?: string }>) {
        if (rec?.display_id) ids.add(rec.display_id);
      }
      cacheSet(cacheKey, { displayIds: ids, ts: Date.now() });
    };

    Promise.all(
      sortedUids.map((uid) =>
        fetchOne(uid).catch((err) => {
          if (cancelled) return;
          // AbortError is expected — don't surface it as a real
          // failure to the user; the effect tore down on purpose.
          const name = (err as { name?: string })?.name;
          if (name === "AbortError") return;
          // FILTER_SEGMENT_REQUIRES_VARIABLE is benign — it means
          // the segment requires bindings (e.g. `$lambda`,
          // `$dt.host_group.id`) the auto-membership probe doesn't
          // supply. Skip it silently from the visible error map
          // (so it doesn't show as a hard failure) but log via the
          // structured logger so anyone debugging coverage gaps
          // can see which segment dropped out.
          const msg = (err as Error)?.message ?? "";
          if (msg.includes("FILTER_SEGMENT_REQUIRES_VARIABLE")) {
            logger.info("Skipping parameterised segment in membership probe", {
              category: "segment-membership",
              segmentUid: uid,
              detail: msg,
            });
            return;
          }
          setErrors((m) => {
            const n = new Map(m);
            n.set(uid, err as Error);
            return n;
          });
        }),
      ),
    ).finally(() => {
      if (cancelled) return;
      setLoading(false);
      setTick((t) => t + 1);
    });

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segKey, filterKey]);

  const membership = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const uid of sortedUids) {
      const entry = cacheGet(`${uid}|${filterKey}`);
      if (!entry) continue;
      for (const id of entry.displayIds) {
        const set = m.get(id) || new Set<string>();
        set.add(uid);
        m.set(id, set);
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segKey, filterKey, tick]);

  return { membership, loading, errors };
}
