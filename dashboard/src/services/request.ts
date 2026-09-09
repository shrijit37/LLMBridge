/**
 * API + SSE client for the CCS TypeScript gateway.
 * Wire format mirrors ccMesh/web: named events over a single EventSource,
 * REST via plain fetch.
 */
export async function request<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ---- SSE events (incumbent-compatible envelope: event: X / data: {...}) ----
type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();
let es: EventSource | null = null;
let esReady = false;

function ensureES() {
  if (esReady) return;
  esReady = true;
  es = new EventSource("/events");
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

export function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  ensureES();
  const wrapped = (e: MessageEvent) => {
    let data: unknown = e.data;
    try {
      data = JSON.parse(e.data);
    } catch { /* keep raw */ }
    (handler as (payload: unknown) => void)(data);
  };
  es!.addEventListener(event, wrapped as EventListener);
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  const envelopeHandler = (d: unknown) => handler(d as T);
  set.add(envelopeHandler);

  return () => {
    es?.removeEventListener(event, wrapped as EventListener);
    set!.delete(envelopeHandler);
    if (set!.size === 0) listeners.delete(event);
  };
}

export const Events = {
  log: "log",
  stats: "stats",
} as const;
