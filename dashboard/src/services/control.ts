/**
 * Control-plane mutation client. Every action posts to a gateway endpoint
 * that writes server state; use with a confirmation in the UI for
 * destructive actions.
 */
async function post<T = { ok: boolean }>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Control failed (${res.status})`);
  }
  return data;
}

export interface ControlResult {
  ok: boolean;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

export const controlApi = {
  /** Disable/enable a provider by config name. */
  toggleProvider: (id: string) => post<ControlResult>(`/api/providers/${encodeURIComponent(id)}/toggle`),
  /** Reset a tripped circuit breaker by provider id. */
  resetBreaker: (id: string) => post<ControlResult>(`/api/breakers/${encodeURIComponent(id)}/reset`),
  /** Clear the in-memory ring buffer + DB request log. */
  clearLogs: () => post<ControlResult>("/api/logs/clear"),
  /** Ask lane-ctl to rotate an egress port. */
  rotateLane: (port: number) => post<ControlResult>("/api/lanes/rotate", { port }),
  /** Flip the lanes.enabled flag in config. */
  toggleLanes: () => post<ControlResult>("/api/lanes/toggle"),
  /** Deep-merge a raw JSON config patch and persist it. */
  saveConfig: (patch: Record<string, unknown>) => post<ControlResult>("/api/config", patch),
};