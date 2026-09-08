import { randomUUID } from 'node:crypto';
import { SseParser, type SseEvent } from './sse-parser.js';
import { formatSseBytes } from './sse-emitter.js';

type BlockType = 'text' | 'thinking' | 'tool_use';

interface ToolCallState {
  id: string;
  name: string;
  argumentsBuffer: string;
  contentIndex: number;
}

export class OpenAiToAnthropicState {
  private messageId: string;
  private model: string;
  private modelOverride?: string;
  private started = false;
  private finalized = false;
  private contentIndex = 0;
  private currentBlockType: BlockType | null = null;
  private stopReason: string = 'end_turn';
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private thoughtTokens = 0;
  private toolCalls = new Map<number, ToolCallState>();
  private responseToolCalls = new Map<string, ToolCallState>();

  constructor(modelOverride?: string) {
    this.messageId = `msg_${randomUUID()}`;
    this.model = modelOverride || '';
    this.modelOverride = modelOverride;
  }

  public processEvent(event: SseEvent): SseEvent[] {
    const data = event.data.trim();
    if (data === '[DONE]') {
      return this.finalize();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }

    const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;
    if (eventType && eventType.startsWith('response.')) {
      return this.processResponsesEvent(parsed, eventType);
    }

    return this.processChatCompletionsChunk(parsed);
  }

  private emitMessageStart(): SseEvent[] {
    if (this.started) return [];
    this.started = true;
    const effectiveModel = this.modelOverride || this.model || 'claude-3-5-sonnet-20241022';
    return [
      {
        event: 'message_start',
        data: JSON.stringify({
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            model: effectiveModel,
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
          index: this.contentIndex,
        }),
      },
    ];
    this.currentBlockType = null;
    this.contentIndex++;
    return events;
  }

  private processChatCompletionsChunk(chunk: Record<string, unknown>): SseEvent[] {
    const events: SseEvent[] = [];

    if (typeof chunk['model'] === 'string' && !this.model) {
      this.model = chunk['model'];
    }

    // Capture usage if present
    if (chunk['usage'] && typeof chunk['usage'] === 'object') {
      const u = chunk['usage'] as Record<string, unknown>;
      let rawCompletion = 0;
      if (typeof u['prompt_tokens'] === 'number') this.inputTokens = u['prompt_tokens'];
      if (typeof u['completion_tokens'] === 'number') rawCompletion = u['completion_tokens'];
      if (typeof u['prompt_tokens_details'] === 'object' && u['prompt_tokens_details'] !== null) {
        const pd = u['prompt_tokens_details'] as Record<string, unknown>;
        if (typeof pd['cached_tokens'] === 'number') this.cacheReadTokens = pd['cached_tokens'];
      }
      if (
        typeof u['completion_tokens_details'] === 'object' &&
        u['completion_tokens_details'] !== null
      ) {
        const cd = u['completion_tokens_details'] as Record<string, unknown>;
        if (typeof cd['reasoning_tokens'] === 'number') this.thoughtTokens = cd['reasoning_tokens'];
      }
      this.outputTokens = Math.max(0, rawCompletion - this.thoughtTokens);
    }

    events.push(...this.emitMessageStart());

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    if (choices.length === 0) {
      return events;
    }

    const firstChoice = choices[0] as Record<string, unknown>;
    const delta = (firstChoice['delta'] as Record<string, unknown>) || {};

    if (typeof firstChoice['finish_reason'] === 'string') {
      const fr = firstChoice['finish_reason'];
      if (fr === 'tool_calls') this.stopReason = 'tool_use';
      else if (fr === 'length') this.stopReason = 'max_tokens';
      else this.stopReason = 'end_turn';
    }

    // Reasoning content (Thinking)
    const reasoning = delta['reasoning_content'];
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (this.currentBlockType !== 'thinking') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'thinking';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.contentIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
            },
          }),
        });
      }
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.contentIndex,
          delta: {
            type: 'thinking_delta',
            thinking: reasoning,
          },
        }),
      });
    }

    // Normal text content
    const content = delta['content'];
    if (typeof content === 'string' && content.length > 0) {
      if (this.currentBlockType !== 'text') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'text';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.contentIndex,
            content_block: {
              type: 'text',
              text: '',
            },
          }),
        });
      }
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index: this.contentIndex,
          delta: {
            type: 'text_delta',
            text: content,
          },
        }),
      });
    }

    // Tool calls
    const toolCalls = delta['tool_calls'];
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const index = typeof tc['index'] === 'number' ? tc['index'] : 0;
        const fn = (tc['function'] as Record<string, unknown>) || {};
        const name = typeof fn['name'] === 'string' ? fn['name'] : '';
        const argsDelta = typeof fn['arguments'] === 'string' ? fn['arguments'] : '';

        let tcState = this.toolCalls.get(index);
        if (!tcState && name.length > 0) {
          events.push(...this.closeCurrentBlock());
          this.currentBlockType = 'tool_use';
          const callId = typeof tc['id'] === 'string' ? tc['id'] : `call_${randomUUID()}`;
          tcState = {
            id: callId,
            name,
            argumentsBuffer: '',
            contentIndex: this.contentIndex,
          };
          this.toolCalls.set(index, tcState);

          events.push({
            event: 'content_block_start',
            data: JSON.stringify({
              type: 'content_block_start',
              index: tcState.contentIndex,
              content_block: {
                type: 'tool_use',
                id: callId,
                name,
                input: {},
              },
            }),
          });
        }

        if (tcState && argsDelta.length > 0) {
          tcState.argumentsBuffer += argsDelta;
          events.push({
            event: 'content_block_delta',
            data: JSON.stringify({
              type: 'content_block_delta',
              index: tcState.contentIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: argsDelta,
              },
            }),
          });
        }
      }
    }

    return events;
  }

  private processResponsesEvent(event: Record<string, unknown>, eventType: string): SseEvent[] {
    const events: SseEvent[] = [];

    if (eventType === 'response.created') {
      const resp = (event['response'] as Record<string, unknown>) || {};
      if (typeof resp['model'] === 'string' && !this.model) {
        this.model = resp['model'];
      }
      events.push(...this.emitMessageStart());
      return events;
    }

    events.push(...this.emitMessageStart());

    if (eventType === 'response.output_item.added') {
      const item = (event['item'] as Record<string, unknown>) || {};
      const itemType = item['type'];
      const itemId = typeof item['id'] === 'string' ? item['id'] : randomUUID();

      if (itemType === 'function_call') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'tool_use';
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : itemId;
        const tcState: ToolCallState = {
          id: callId,
          name,
          argumentsBuffer: '',
          contentIndex: this.contentIndex,
        };
        this.responseToolCalls.set(itemId, tcState);

        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.contentIndex,
            content_block: {
              type: 'tool_use',
              id: callId,
              name,
              input: {},
            },
          }),
        });
      } else if (itemType === 'reasoning') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'thinking';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.contentIndex,
            content_block: {
              type: 'thinking',
              thinking: '',
            },
          }),
        });
      } else if (itemType === 'message') {
        events.push(...this.closeCurrentBlock());
        this.currentBlockType = 'text';
        events.push({
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: this.contentIndex,
            content_block: {
              type: 'text',
              text: '',
            },
          }),
        });
      }
    } else if (
      eventType === 'response.output_text.delta' ||
      eventType === 'response.text.delta'
    ) {
      const text = typeof event['delta'] === 'string' ? event['delta'] : '';
      if (text.length > 0) {
        if (this.currentBlockType !== 'text') {
          events.push(...this.closeCurrentBlock());
          this.currentBlockType = 'text';
          events.push({
            event: 'content_block_start',
            data: JSON.stringify({
              type: 'content_block_start',
              index: this.contentIndex,
              content_block: { type: 'text', text: '' },
            }),
          });
        }
        events.push({
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: this.contentIndex,
            delta: { type: 'text_delta', text },
          }),
        });
      }
    } else if (eventType === 'response.reasoning.delta') {
      const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
      if (delta.length > 0) {
        events.push({
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: this.contentIndex,
            delta: { type: 'thinking_delta', thinking: delta },
          }),
        });
      }
    } else if (eventType === 'response.function_call_arguments.delta') {
      const delta = typeof event['delta'] === 'string' ? event['delta'] : '';
      const itemId = typeof event['item_id'] === 'string' ? event['item_id'] : '';
      const tcState = this.responseToolCalls.get(itemId);
      const index = tcState ? tcState.contentIndex : this.contentIndex;
      events.push({
        event: 'content_block_delta',
        data: JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: delta },
        }),
      });
    } else if (eventType === 'response.output_item.done') {
      events.push(...this.closeCurrentBlock());
    } else if (eventType === 'response.completed' || eventType === 'response.done') {
      const resp = (event['response'] as Record<string, unknown>) || {};
      const usage = (resp['usage'] as Record<string, unknown>) || {};
      if (typeof usage['input_tokens'] === 'number') this.inputTokens = usage['input_tokens'];
      if (typeof usage['output_tokens'] === 'number') this.outputTokens = usage['output_tokens'];
      return this.finalize();
    }

    return events;
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
 * Transforms an OpenAI SSE byte stream into Anthropic SSE byte stream.
 */
export function openAiStreamToAnthropic(
  stream: ReadableStream<Uint8Array>,
  modelOverride?: string
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const state = new OpenAiToAnthropicState(modelOverride);

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
