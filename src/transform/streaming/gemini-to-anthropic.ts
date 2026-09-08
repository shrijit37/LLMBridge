import { randomUUID } from 'node:crypto';
import { SseParser, type SseEvent } from './sse-parser.js';
import { formatSseBytes } from './sse-emitter.js';

export class GeminiToAnthropicState {
  private messageId: string;
  private model: string;
  private started = false;
  private finalized = false;
  private blockIndex = 0;
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private stopReason = 'end_turn';
  private inputTokens = 0;
  private outputTokens = 0;
  private thoughtTokens = 0;
  private cacheReadTokens = 0;

  constructor() {
    this.messageId = `msg_${randomUUID()}`;
    this.model = 'gemini-2.5-pro';
  }

  public processEvent(event: SseEvent): SseEvent[] {
    const data = event.data.trim();
    if (data.length === 0 || data === '[DONE]' || data === 'done') {
      return this.finalize();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }

    const eventType =
      typeof parsed['event_type'] === 'string'
        ? parsed['event_type']
        : event.event || (typeof parsed['type'] === 'string' ? parsed['type'] : undefined);

    switch (eventType) {
      case 'interaction.created':
        return this.onInteractionCreated(parsed);
      case 'step.start':
        return this.onStepStart(parsed);
      case 'step.delta':
        return this.onStepDelta(parsed);
      case 'step.stop':
        return this.onStepStop(parsed);
      case 'interaction.completed':
        return this.onInteractionCompleted(parsed);
      default:
        return [];
    }
  }

  private emitMessageStart(): SseEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: this.inputTokens,
              output_tokens: 1,
            },
          },
        }),
      },
    ];
  }

  private closeCurrentBlock(): SseEvent[] {
    if (this.currentBlockType === null) return [];
    const events: SseEvent[] = [
      {
        event: 'content_block_stop',
        data: JSON.stringify({
          type: 'content_block_stop',
          index: this.blockIndex,
        }),
      },
    ];
    this.currentBlockType = null;
    this.blockIndex++;
    return events;
  }

  private onInteractionCreated(payload: Record<string, unknown>): SseEvent[] {
    const interaction = (payload['interaction'] as Record<string, unknown>) || {};
    if (typeof interaction['model'] === 'string') {
      this.model = interaction['model'];
    }
    return this.emitMessageStart();
  }

  private onStepStart(payload: Record<string, unknown>): SseEvent[] {
    const events: SseEvent[] = [];
    events.push(...this.emitMessageStart());

    const step = (payload['step'] as Record<string, unknown>) || payload;
    const type = step['type'];

    if (type === 'thought') {
      events.push(...this.closeCurrentBlock());
      this.currentBlockType = 'thinking';
      events.push({
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'thinking',
            thinking: '',
          },
        }),
      });

      // If signature is already known on start
      if (typeof step['signature'] === 'string' && step['signature'].length > 0) {
        events.push({
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: {
              type: 'signature_delta',
              signature: step['signature'],
            },
          }),
        });
      }
    } else if (type === 'model_output') {
      events.push(...this.closeCurrentBlock());
      this.currentBlockType = 'text';
      events.push({
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'text',
            text: '',
          },
        }),
      });
    } else if (type === 'function_call') {
      events.push(...this.closeCurrentBlock());
      this.currentBlockType = 'tool_use';
      this.stopReason = 'tool_use';
      const id = typeof step['id'] === 'string' ? step['id'] : `call_${randomUUID()}`;
      const name = typeof step['name'] === 'string' ? step['name'] : '';
      events.push({
        event: 'content_block_start',
        data: JSON.stringify({
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'tool_use',
            id,
            name,
            input: {},
          },
        }),
      });

      if (step['arguments'] && typeof step['arguments'] === 'object') {
        const argsStr = JSON.stringify(step['arguments']);
        events.push({
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: argsStr,
            },
          }),
        });
      }
    }

    return events;
  }

  private onStepDelta(payload: Record<string, unknown>): SseEvent[] {
    const events: SseEvent[] = [];
    const delta = (payload['delta'] as Record<string, unknown>) || payload;

    // Text delta
    if (typeof delta['text'] === 'string') {
      if (this.currentBlockType !== 'text') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'text';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'text', text: '' },
          }),
        });
      }
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: {
            type: 'text_delta',
            text: delta['text'],
          },
        }),
      });
    }

    // Thinking delta
    if (typeof delta['thought'] === 'string' || typeof delta['thinking'] === 'string') {
      const thinkingText = (delta['thought'] || delta['thinking']) as string;
      if (this.currentBlockType !== 'thinking') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'thinking';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          }),
        });
      }
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: {
            type: 'thinking_delta',
            thinking: thinkingText,
          },
        }),
      });
    }

    // Function arguments delta
    if (
      typeof delta['arguments_delta'] === 'string' ||
      typeof delta['partial_json'] === 'string'
    ) {
      const args = (delta['arguments_delta'] || delta['partial_json']) as string;
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: args,
          },
        }),
      });
    }

    return events;
  }

  private onStepStop(payload: Record<string, unknown>): SseEvent[] {
    const events: SseEvent[] = [];
    const step = (payload['step'] as Record<string, unknown>) || payload;

    if (
      this.currentBlockType === 'thinking' &&
      typeof step['signature'] === 'string' &&
      step['signature'].length > 0
    ) {
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: {
            type: 'signature_delta',
            signature: step['signature'],
          },
        }),
      });
    }

    events.push(...this.closeCurrentBlock());
    return events;
  }

  private onInteractionCompleted(payload: Record<string, unknown>): SseEvent[] {
    const usage = (payload['usage'] as Record<string, unknown>) || {};
    if (typeof usage['total_input_tokens'] === 'number') {
      this.inputTokens = usage['total_input_tokens'];
    }
    if (typeof usage['total_output_tokens'] === 'number') {
      this.outputTokens = usage['total_output_tokens'];
    }
    if (typeof usage['total_thought_tokens'] === 'number') {
      this.thoughtTokens = usage['total_thought_tokens'];
    }
    if (typeof usage['total_cached_tokens'] === 'number') {
      this.cacheReadTokens = usage['total_cached_tokens'];
    }

    return this.finalize();
  }

  public finalize(): SseEvent[] {
    if (this.finalized) return [];
    this.finalized = true;

    const events: SseEvent[] = [];
    events.push(...this.emitMessageStart());
    events.push(...this.closeCurrentBlock());

    events.push({
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: this.stopReason,
          stop_sequence: null,
        },
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: this.outputTokens + this.thoughtTokens,
          cache_read_input_tokens: this.cacheReadTokens,
        },
      }),
    });

    events.push({
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    });

    return events;
  }
}

/**
 * Transforms a Gemini Interactions SSE byte stream into Anthropic SSE byte stream.
 */
export function geminiStreamToAnthropic(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const state = new GeminiToAnthropicState();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const parsedEvents = parser.push(chunk);
      for (const ev of parsedEvents) {
        const outEvents = state.processEvent(ev);
        for (const outEv of outEvents) {
          controller.enqueue(formatSseBytes(outEv.event, outEv.data));
        }
      }
    },
    flush(controller) {
      const remaining = parser.flush();
      for (const ev of remaining) {
        const outEvents = state.processEvent(ev);
        for (const outEv of outEvents) {
          controller.enqueue(formatSseBytes(outEv.event, outEv.data));
        }
      }
      const finalEvents = state.finalize();
      for (const outEv of finalEvents) {
        controller.enqueue(formatSseBytes(outEv.event, outEv.data));
      }
    },
  });

  return stream.pipeThrough(transform);
}
