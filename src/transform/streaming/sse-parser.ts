export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Robust byte-level SSE parser supporting CRLF/LF line endings,
 * multi-byte UTF-8 chunks across boundaries, and standard field parsing.
 */
export class SseParser {
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private currentEvent?: string;
  private currentData: string[] = [];

  /**
   * Feed a chunk of bytes or string and return all fully parsed SSE events.
   */
  public push(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;

    const events: SseEvent[] = [];

    while (true) {
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx === -1) {
        break;
      }

      let line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      // Empty line marks the end of an SSE event dispatch
      if (line.length === 0) {
        if (this.currentData.length > 0 || this.currentEvent !== undefined) {
          events.push({
            event: this.currentEvent,
            data: this.currentData.join('\n'),
          });
          this.currentEvent = undefined;
          this.currentData = [];
        }
        continue;
      }

      // Comment line
      if (line.startsWith(':')) {
        continue;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) {
        // Field name only, empty value
        if (line === 'data') {
          this.currentData.push('');
        }
        continue;
      }

      const field = line.slice(0, colonIdx);
      let value = line.slice(colonIdx + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }

      if (field === 'event') {
        this.currentEvent = value;
      } else if (field === 'data') {
        this.currentData.push(value);
      }
    }

    return events;
  }

  /**
   * Flush remaining buffer on stream termination.
   */
  public flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.currentData.length > 0 || this.currentEvent !== undefined) {
      events.push({
        event: this.currentEvent,
        data: this.currentData.join('\n'),
      });
      this.currentEvent = undefined;
      this.currentData = [];
    }
    this.buffer = '';
    return events;
  }
}

/**
 * Creates a standard Web Streams TransformStream that transforms
 * binary Uint8Array chunks into parsed SseEvent objects.
 */
export function createSseParseStream(): TransformStream<Uint8Array, SseEvent> {
  const parser = new SseParser();
  return new TransformStream<Uint8Array, SseEvent>({
    transform(chunk, controller) {
      const events = parser.push(chunk);
      for (const ev of events) {
        controller.enqueue(ev);
      }
    },
    flush(controller) {
      const events = parser.flush();
      for (const ev of events) {
        controller.enqueue(ev);
      }
    },
  });
}
