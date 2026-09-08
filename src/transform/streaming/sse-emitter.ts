import type { SseEvent } from './sse-parser.js';

const encoder = new TextEncoder();

/**
 * Serializes an event name and data into a standard SSE wire format string:
 * event: ...\ndata: ...\n\n
 */
export function formatSseString(event: string | undefined, data: string | object): string {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
  if (event && event.length > 0) {
    return `event: ${event}\ndata: ${dataStr}\n\n`;
  }
  return `data: ${dataStr}\n\n`;
}

/**
 * Serializes an SseEvent into Uint8Array wire bytes.
 */
export function formatSseBytes(event: string | undefined, data: string | object): Uint8Array {
  return encoder.encode(formatSseString(event, data));
}

/**
 * Creates a standard Web Streams TransformStream that transforms
 * SseEvent objects into binary Uint8Array chunks.
 */
export function createSseEmitStream(): TransformStream<SseEvent, Uint8Array> {
  return new TransformStream<SseEvent, Uint8Array>({
    transform(ev, controller) {
      controller.enqueue(formatSseBytes(ev.event, ev.data));
    },
  });
}
