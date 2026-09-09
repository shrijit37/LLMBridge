import type { Context } from 'hono';
import { gatewayEvents } from '../events.js';

/**
 * Server-Sent Events wiring for the gateway dashboard.
 * Frames: `event: <name>\ndata: <json>\n\n`, keep-alive `: ping\n\n` every 15s.
 *
 * Mirrors the incumbent ccMesh dashboard wire: one EventSource, named events
 * consumed via addEventListener(name). Data payloads are fed by `dataFor`.
 */
export function createSSEResponse(
  c: Context,
  events: string[],
  dataFor: (event: string, payload?: unknown) => unknown
): Response {
  const encoder = new TextEncoder();
  const cleanupFns: Array<() => void> = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* stream torn down */
        }
      };

      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(ping);
        }
      }, 15000);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        for (const [name, handler] of handlers) {
          gatewayEvents.removeListener(name, handler);
        }
        handlers.clear();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const handlers = new Map<string, (...args: unknown[]) => void>();
      for (const name of events) {
        const handler = (...args: unknown[]) => enqueue(name, dataFor(name, args[0]) ?? args[0]);
        handlers.set(name, handler);
        gatewayEvents.on(name, handler);
      }

      cleanupFns.push(close);

      // Let the connection die cleanly when the client disconnects.
      c.req.raw.signal?.addEventListener('abort', close, { once: true });
      c.req.raw.signal?.addEventListener('close', close, { once: true });
    },
    cancel() {
      cleanupFns.forEach((fn) => fn());
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}