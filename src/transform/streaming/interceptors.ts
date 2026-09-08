import { SseParser } from './sse-parser.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Rewrites the model field in the first SSE event of a stream
 * (e.g. Anthropic `message_start` or OpenAI chunk) to match the requested alias.
 */
export function rewriteModelInStream(
  stream: ReadableStream<Uint8Array>,
  targetModel: string
): ReadableStream<Uint8Array> {
  let patched = false;
  let buffer = '';

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (patched) {
        controller.enqueue(chunk);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });
      const doubleNewlineIdx = buffer.indexOf('\n\n');
      if (doubleNewlineIdx === -1) {
        return;
      }

      const firstEventStr = buffer.slice(0, doubleNewlineIdx + 2);
      const remainderStr = buffer.slice(doubleNewlineIdx + 2);

      const patchedEventStr = patchFirstEventModel(firstEventStr, targetModel);
      controller.enqueue(encoder.encode(patchedEventStr));

      if (remainderStr.length > 0) {
        controller.enqueue(encoder.encode(remainderStr));
      }

      buffer = '';
      patched = true;
    },
    flush(controller) {
      if (!patched && buffer.length > 0) {
        controller.enqueue(encoder.encode(patchFirstEventModel(buffer, targetModel)));
        buffer = '';
      }
    },
  });

  return stream.pipeThrough(transform);
}

function patchFirstEventModel(eventStr: string, targetModel: string): string {
  const lines = eventStr.split('\n');
  let eventType: string | undefined;
  let dataLineIdx = -1;
  let dataStr = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataLineIdx = i;
      dataStr = line.slice(6).trim();
    }
  }

  if (dataLineIdx === -1 || dataStr.length === 0 || dataStr === '[DONE]') {
    return eventStr;
  }

  try {
    const parsed = JSON.parse(dataStr);
    let modified = false;

    // Anthropic message_start
    if (eventType === 'message_start' || parsed.type === 'message_start') {
      if (parsed.message && typeof parsed.message === 'object') {
        parsed.message.model = targetModel;
        modified = true;
      }
    } else if (parsed.model !== undefined) {
      // OpenAI chat.completion.chunk or responses
      parsed.model = targetModel;
      modified = true;
    }

    if (modified) {
      lines[dataLineIdx] = `data: ${JSON.stringify(parsed)}`;
      return lines.join('\n');
    }
  } catch {
    // Ignore JSON parse failure on partial data
  }

  return eventStr;
}

export interface StreamUsageTracker {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Non-intrusively tracks token usage in a stream, invoking onComplete
 * with the captured input/output token counts upon stream completion.
 */
export function trackTokensInStream(
  stream: ReadableStream<Uint8Array>,
  onComplete: (usage: StreamUsageTracker) => void
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  let inputTokens = 0;
  let outputTokens = 0;

  function inspectData(dataStr: string) {
    if (dataStr === '[DONE]') return;
    try {
      const parsed = JSON.parse(dataStr);

      // Anthropic message_start usage
      if (parsed.message?.usage) {
        if (typeof parsed.message.usage.input_tokens === 'number') {
          inputTokens = parsed.message.usage.input_tokens;
        }
      }

      // Anthropic message_delta usage
      if (parsed.usage) {
        if (typeof parsed.usage.input_tokens === 'number') {
          inputTokens = parsed.usage.input_tokens;
        }
        if (typeof parsed.usage.output_tokens === 'number') {
          outputTokens = parsed.usage.output_tokens;
        }
      }

      // OpenAI chunk usage
      if (parsed.usage) {
        if (typeof parsed.usage.prompt_tokens === 'number') {
          inputTokens = parsed.usage.prompt_tokens;
        }
        if (typeof parsed.usage.completion_tokens === 'number') {
          outputTokens = parsed.usage.completion_tokens;
        }
      }

      // Gemini usage
      if (typeof parsed.usage?.total_input_tokens === 'number') {
        inputTokens = parsed.usage.total_input_tokens;
      }
      if (typeof parsed.usage?.total_output_tokens === 'number') {
        const thought =
          typeof parsed.usage.total_thought_tokens === 'number'
            ? parsed.usage.total_thought_tokens
            : 0;
        outputTokens = parsed.usage.total_output_tokens + thought;
      }
    } catch {
      // Ignore unparseable data
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const events = parser.push(chunk);
      for (const ev of events) {
        inspectData(ev.data);
      }
      controller.enqueue(chunk);
    },
    flush() {
      const remaining = parser.flush();
      for (const ev of remaining) {
        inspectData(ev.data);
      }
      onComplete({ inputTokens, outputTokens });
    },
  });

  return stream.pipeThrough(transform);
}
