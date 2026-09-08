import { randomUUID } from 'node:crypto';
import type { OpenAiApiVersion } from '../../config/types.js';
import { SseParser, type SseEvent } from './sse-parser.js';
import { formatSseBytes } from './sse-emitter.js';

export class AnthropicToOpenAiState {
  private target: OpenAiApiVersion;
  private id: string;
  private model: string;
  private created: number;
  private roleEmitted = false;
  private finalized = false;
  private nextToolCallIndex = 0;
  private currentToolCallIndex: number | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private stopReason = 'stop';
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private currentItemId: string | null = null;
  private outputIndex = 0;

  constructor(target: OpenAiApiVersion = 'chat_completions') {
    this.target = target;
    this.id = `chatcmpl-${randomUUID()}`;
    this.model = '';
    this.created = Math.floor(Date.now() / 1000);
  }

  private isChat(): boolean {
    return this.target === 'chat_completions';
  }

  public processEvent(event: SseEvent): SseEvent[] {
    const data = event.data.trim();
    if (data.length === 0 || data === '[DONE]') {
      return [];
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }

    const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : event.event;

    switch (eventType) {
      case 'message_start':
        return this.onMessageStart(parsed);
      case 'content_block_start':
        return this.onContentBlockStart(parsed);
      case 'content_block_delta':
        return this.onContentBlockDelta(parsed);
      case 'content_block_stop':
        return this.onContentBlockStop();
      case 'message_delta':
        return this.onMessageDelta(parsed);
      case 'message_stop':
        return this.finalize();
      default:
        return [];
    }
  }

  private onMessageStart(payload: Record<string, unknown>): SseEvent[] {
    const msg = (payload['message'] as Record<string, unknown>) || {};
    if (typeof msg['id'] === 'string') {
      this.id = msg['id'].startsWith('msg_')
        ? `chatcmpl-${msg['id'].slice(4)}`
        : msg['id'];
    }
    if (typeof msg['model'] === 'string') {
      this.model = msg['model'];
    }
    const usage = (msg['usage'] as Record<string, unknown>) || {};
    if (typeof usage['input_tokens'] === 'number') {
      this.inputTokens = usage['input_tokens'];
    }

    if (!this.isChat()) {
      return [
        {
          event: 'response.created',
          data: JSON.stringify({
            type: 'response.created',
            response: {
              id: this.id,
              model: this.model,
              status: 'in_progress',
            },
          }),
        },
      ];
    }

    if (!this.roleEmitted) {
      this.roleEmitted = true;
      return [
        {
          data: JSON.stringify({
            id: this.id,
            object: 'chat.completion.chunk',
            created: this.created,
            model: this.model,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '' },
                finish_reason: null,
              },
            ],
          }),
        },
      ];
    }

    return [];
  }

  private onContentBlockStart(payload: Record<string, unknown>): SseEvent[] {
    const block = (payload['content_block'] as Record<string, unknown>) || {};
    const type = block['type'];

    if (type === 'tool_use') {
      this.currentBlockType = 'tool_use';
      this.currentToolCallIndex = this.nextToolCallIndex++;
      const callId = typeof block['id'] === 'string' ? block['id'] : `call_${randomUUID()}`;
      const name = typeof block['name'] === 'string' ? block['name'] : '';

      if (this.isChat()) {
        return [
          {
            data: JSON.stringify({
              id: this.id,
              object: 'chat.completion.chunk',
              created: this.created,
              model: this.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: this.currentToolCallIndex,
                        id: callId,
                        type: 'function',
                        function: { name, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          },
        ];
      }

      this.currentItemId = `item_${randomUUID()}`;
      return [
        {
          event: 'response.output_item.added',
          data: JSON.stringify({
            type: 'response.output_item.added',
            output_index: this.outputIndex++,
            item: {
              id: this.currentItemId,
              type: 'function_call',
              call_id: callId,
              name,
              arguments: '',
            },
          }),
        },
      ];
    }

    if (type === 'thinking') {
      this.currentBlockType = 'thinking';
      if (!this.isChat()) {
        this.currentItemId = `item_${randomUUID()}`;
        return [
          {
            event: 'response.output_item.added',
            data: JSON.stringify({
              type: 'response.output_item.added',
              output_index: this.outputIndex++,
              item: {
                id: this.currentItemId,
                type: 'reasoning',
                summary: [],
              },
            }),
          },
        ];
      }
      return [];
    }

    // Text block
    this.currentBlockType = 'text';
    if (!this.isChat()) {
      this.currentItemId = `item_${randomUUID()}`;
      return [
        {
          event: 'response.output_item.added',
          data: JSON.stringify({
            type: 'response.output_item.added',
            output_index: this.outputIndex++,
            item: {
              id: this.currentItemId,
              type: 'message',
              role: 'assistant',
              content: [],
            },
          }),
        },
      ];
    }

    return [];
  }

  private onContentBlockDelta(payload: Record<string, unknown>): SseEvent[] {
    const delta = (payload['delta'] as Record<string, unknown>) || {};
    const deltaType = delta['type'];

    if (deltaType === 'text_delta') {
      const text = typeof delta['text'] === 'string' ? delta['text'] : '';
      if (this.isChat()) {
        return [
          {
            data: JSON.stringify({
              id: this.id,
              object: 'chat.completion.chunk',
              created: this.created,
              model: this.model,
              choices: [
                {
                  index: 0,
                  delta: { content: text },
                  finish_reason: null,
                },
              ],
            }),
          },
        ];
      }
      return [
        {
          event: 'response.output_text.delta',
          data: JSON.stringify({
            type: 'response.output_text.delta',
            delta: text,
          }),
        },
      ];
    }

    if (deltaType === 'thinking_delta') {
      const thinking = typeof delta['thinking'] === 'string' ? delta['thinking'] : '';
      if (this.isChat()) {
        return [
          {
            data: JSON.stringify({
              id: this.id,
              object: 'chat.completion.chunk',
              created: this.created,
              model: this.model,
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: thinking },
                  finish_reason: null,
                },
              ],
            }),
          },
        ];
      }
      return [
        {
          event: 'response.reasoning.delta',
          data: JSON.stringify({
            type: 'response.reasoning.delta',
            delta: thinking,
          }),
        },
      ];
    }

    if (deltaType === 'input_json_delta') {
      const partialJson = typeof delta['partial_json'] === 'string' ? delta['partial_json'] : '';
      if (this.isChat()) {
        return [
          {
            data: JSON.stringify({
              id: this.id,
              object: 'chat.completion.chunk',
              created: this.created,
              model: this.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: this.currentToolCallIndex ?? 0,
                        function: { arguments: partialJson },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            }),
          },
        ];
      }
      return [
        {
          event: 'response.function_call_arguments.delta',
          data: JSON.stringify({
            type: 'response.function_call_arguments.delta',
            item_id: this.currentItemId,
            delta: partialJson,
          }),
        },
      ];
    }

    return [];
  }

  private onContentBlockStop(): SseEvent[] {
    if (!this.isChat() && this.currentItemId) {
      const ev = [
        {
          event: 'response.output_item.done',
          data: JSON.stringify({
            type: 'response.output_item.done',
            item: { id: this.currentItemId },
          }),
        },
      ];
      this.currentItemId = null;
      if (this.currentBlockType !== null) {
        this.currentBlockType = null;
      }
      return ev;
    }
    if (this.currentBlockType !== null) {
      this.currentBlockType = null;
    }
    return [];
  }

  private onMessageDelta(payload: Record<string, unknown>): SseEvent[] {
    const delta = (payload['delta'] as Record<string, unknown>) || {};
    const stopReason = delta['stop_reason'];
    if (stopReason === 'tool_use') this.stopReason = 'tool_calls';
    else if (stopReason === 'max_tokens') this.stopReason = 'length';
    else this.stopReason = 'stop';

    const usage = (payload['usage'] as Record<string, unknown>) || {};
    if (typeof usage['output_tokens'] === 'number') {
      this.outputTokens = usage['output_tokens'];
    }

    return [];
  }

  public finalize(): SseEvent[] {
    if (this.finalized) return [];
    this.finalized = true;

    const events: SseEvent[] = [];

    if (this.isChat()) {
      // Chunk with finish_reason
      events.push({
        data: JSON.stringify({
          id: this.id,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: this.stopReason,
            },
          ],
        }),
      });

      // Usage chunk
      events.push({
        data: JSON.stringify({
          id: this.id,
          object: 'chat.completion.chunk',
          created: this.created,
          model: this.model,
          choices: [],
          usage: {
            prompt_tokens: this.inputTokens,
            completion_tokens: this.outputTokens,
            total_tokens: this.inputTokens + this.outputTokens,
          },
        }),
      });

      events.push({ data: '[DONE]' });
    } else {
      events.push({
        event: 'response.completed',
        data: JSON.stringify({
          type: 'response.completed',
          response: {
            id: this.id,
            model: this.model,
            status: 'completed',
            usage: {
              input_tokens: this.inputTokens,
              output_tokens: this.outputTokens,
              total_tokens: this.inputTokens + this.outputTokens,
            },
          },
        }),
      });

      events.push({ data: '[DONE]' });
    }

    return events;
  }
}

/**
 * Transforms an Anthropic SSE byte stream into OpenAI SSE byte stream.
 */
export function anthropicStreamToOpenAi(
  stream: ReadableStream<Uint8Array>,
  target: OpenAiApiVersion = 'chat_completions'
): ReadableStream<Uint8Array> {
  const parser = new SseParser();
  const state = new AnthropicToOpenAiState(target);

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
