import type { RequestLogRecord } from "@/hooks/types";

/** Timeline request: ccs-ts request log + lane grouping key. */
export interface TimelineRequest extends RequestLogRecord {
  laneKey: string;
}

export interface LaneGroup {
  laneKey: string;
  label: string;
  requests: TimelineRequest[];
}

export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** Convert a timestamp (ms) to an x coordinate within the plot area. */
export function timeToX(ts: number, window: TimeWindow, plotWidth: number): number {
  if (window.endMs === window.startMs) return 0;
  return ((ts - window.startMs) / (window.endMs - window.startMs)) * plotWidth;
}

/** Convert a duration (ms) to a width in pixels. */
export function durationToWidth(durationMs: number, window: TimeWindow, plotWidth: number): number {
  return (durationMs / (window.endMs - window.startMs)) * plotWidth;
}

/** Bar geometry from request timestamp + latency (width = latency, min 4px). */
export function computeBarGeometry(
  req: TimelineRequest,
  window: TimeWindow,
  plotWidth: number,
): { x: number; width: number } {
  const x = timeToX(req.timestamp_ms, window, plotWidth);
  if (req.latency_ms > 0) {
    return { x, width: Math.max(4, durationToWidth(req.latency_ms, window, plotWidth)) };
  }
  // No latency recorded: extend to NOW.
  const now = Date.now();
  return { x, width: Math.max(4, timeToX(now, window, plotWidth) - x) };
}

/** Status color for a request bar: success / warning (4xx) / danger (5xx+err) / muted (0). */
export function statusColor(status: number): string {
  if (status === 0) return "var(--ink-disabled)";
  if (status >= 500) return "var(--destructive)";
  if (status >= 400) return "var(--warning)";
  return "var(--success)";
}

/** Group requests by provider lane, sorted by name (Direct = no provider → "direct"). */
export function groupByLane(requests: TimelineRequest[]): LaneGroup[] {
  const map = new Map<string, TimelineRequest[]>();
  for (const req of requests) {
    const laneKey = req.provider_name || "direct";
    const existing = map.get(laneKey);
    if (existing) existing.push(req);
    else map.set(laneKey, [req]);
  }
  const groups: LaneGroup[] = [];
  for (const [laneKey, items] of map) {
    groups.push({ laneKey, label: laneKey, requests: items });
  }
  groups.sort((a, b) => {
    if (a.laneKey === "direct") return -1;
    if (b.laneKey === "direct") return 1;
    return a.laneKey.localeCompare(b.laneKey);
  });
  return groups;
}

/** Compute the time window from a preset; all anchored to "now". */
export function computeTimeWindow(preset: "5m" | "15m" | "1h" | "today"): TimeWindow {
  const now = Date.now();
  switch (preset) {
    case "5m":
      return { startMs: now - 5 * 60_000, endMs: now };
    case "15m":
      return { startMs: now - 15 * 60_000, endMs: now };
    case "1h":
      return { startMs: now - 60 * 60_000, endMs: now };
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { startMs: d.getTime(), endMs: now };
    }
  }
}

export interface TimelineFiltersState {
  providerFilter: string | null;
  modelFilter: string;
  statusFilter: "all" | "success" | "error";
}

/** Filter requests by provider, model substring, and status. */
export function filterRequests(
  requests: TimelineRequest[],
  filters: TimelineFiltersState,
): TimelineRequest[] {
  return requests.filter((req) => {
    if (filters.providerFilter && req.provider_name !== filters.providerFilter) return false;
    if (filters.modelFilter) {
      const q = filters.modelFilter.toLowerCase();
      if (!(req.model ?? "").toLowerCase().includes(q)) return false;
    }
    if (filters.statusFilter === "success" && (req.status >= 400 || req.status === 0)) return false;
    if (filters.statusFilter === "error" && req.status < 400) return false;
    return true;
  });
}

/** Format time for axis ticks based on window span. */
export function formatTickTime(ts: number, windowMs: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  if (windowMs <= 15 * 60_000) {
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}