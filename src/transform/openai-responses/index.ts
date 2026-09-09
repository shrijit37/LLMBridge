import { randomUUID } from 'node:crypto';
import type { Provider } from '../../config/types.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentBlock,
  CanonicalTool,
  CanonicalToolChoice,
  CanonicalUsage,
} from '../canonical/types.js';
import { canonicalJsonString } from '../canonical/json.js';
import { cleanSchema } from '../openai-chat/index.js';

export function closeObjectSchemas(schema: Record<string, unknown>): void {
  if (schema['type'] === 'object' && schema['additionalProperties'] === undefined) {
    schema['additionalProperties'] = false;
  }
  if (typeof schema['properties'] === 'object' && schema['properties'] !== null) {
    for (const prop of Object.values(schema['properties'] as Record<string, unknown>)) {
      if (typeof prop === 'object' && prop !== null) {
        closeObjectSchemas(prop as Record<string, unknown>);
      }
    }
  }
  if (typeof schema['items'] === 'object' && schema['items'] !== null) {
    closeObjectSchemas(schema['items'] as Record<string, unknown>);
  }
}

export function openaiResponsesToCanonicalRequest(body: Record<string, unknown>): CanonicalRequest {
  const model = typeof body['model'] === 'string' ? body['model'] : 'gpt-4o';
  const stream = Boolean(body['stream']);
  const systemPrompt = typeof body['instructions'] === 'string' ? body['instructions'] : undefined;

  const messages: CanonicalMessage[] = [];

  if (Array.isArray(body['input'])) {
    for (const item of body['input']) {
      if (!item || typeof item !== 'object') continue;
      const itemType = item['type'];

      if (itemType === 'message') {
        const roleRaw = item['role'];
        const role: 'user' | 'assistant' = roleRaw === 'assistant' ? 'assistant' : 'user';
        const blocks: CanonicalContentBlock[] = [];

        if (typeof item['content'] === 'string') {
          blocks.push({ type: 'text', text: item['content'] });
        } else if (Array.isArray(item['content'])) {
          for (const part of item['content']) {
            if (!part || typeof part !== 'object') continue;
            if (part['type'] === 'input_text' || part['type'] === 'output_text' || part['type'] === 'text') {
              blocks.push({
                type: 'text',
                text: typeof part['text'] === 'string' ? part['text'] : '',
              });
            } else if (part['type'] === 'input_image' || part['type'] === 'image_url') {
              blocks.push({
                type: 'image',
                source: (part['image_url'] as Record<string, unknown>) || {},
              });
            }
          }
        }

        messages.push({ role, content: blocks });
      } else if (itemType === 'reasoning') {
        let text = '';
        if (Array.isArray(item['summary'])) {
          text = item['summary']
            .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
            .map((s) => (typeof s['text'] === 'string' ? s['text'] : ''))
            .join('');
        }
        messages.push({
          role: 'assistant',
          content: [{ type: 'thinking', thinking: text }],
        });
      } else if (itemType === 'function_call') {
        const id = typeof item['call_id'] === 'string' ? item['call_id'] : randomUUID();
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        let input: Record<string, unknown> = {};
        if (typeof item['arguments'] === 'string') {
          try {
            input = JSON.parse(item['arguments']);
          } catch {
            input = {};
          }
        }
        messages.push({
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input }],
        });
      } else if (itemType === 'function_call_output') {
        const toolUseId = typeof item['call_id'] === 'string' ? item['call_id'] : '';
        const content = item['output'];
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', toolUseId, content }],
        });
      }
    }
  }

  // Tools
  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body['tools'])) {
    tools = [];
    for (const t of body['tools']) {
      if (!t || typeof t !== 'object') continue;
      const name = typeof t['name'] === 'string' ? t['name'] : '';
      if (name.length === 0) continue;
      tools.push({
        name,
        description: typeof t['description'] === 'string' ? t['description'] : undefined,
        inputSchema:
          typeof t['parameters'] === 'object' && t['parameters'] !== null
            ? (t['parameters'] as Record<string, unknown>)
            : { type: 'object' },
      });
    }
  }

  // Tool choice
  let toolChoice: CanonicalToolChoice | undefined;
  const rawTc = body['tool_choice'];
  if (typeof rawTc === 'string') {
    if (rawTc === 'required') toolChoice = { type: 'any' };
    else if (rawTc === 'auto') toolChoice = { type: 'auto' };
    else if (rawTc === 'none') toolChoice = { type: 'none' };
  } else if (rawTc && typeof rawTc === 'object') {
    const name = (rawTc as Record<string, unknown>)['name'];
    if (typeof name === 'string') {
      toolChoice = { type: 'tool', name };
    }
  }

  let thinking: CanonicalRequest['thinking'] | undefined;
  if (body['reasoning'] && typeof body['reasoning'] === 'object') {
    thinking = { type: 'enabled' };
  }

  const maxTokens =
    typeof body['max_output_tokens'] === 'number' ? body['max_output_tokens'] : undefined;

  return {
    model,
    messages,
    system: systemPrompt,
    maxTokens,
    temperature: typeof body['temperature'] === 'number' ? body['temperature'] : undefined,
    topP: typeof body['top_p'] === 'number' ? body['top_p'] : undefined,
    tools,
    toolChoice,
    stream,
    thinking,
    extra: {},
  };
}

export function canonicalToOpenAiResponsesRequest(
  canonical: CanonicalRequest,
  provider?: Provider
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: canonical.model,
    stream: canonical.stream,
  };

  if (canonical.system && canonical.system.length > 0) {
    result['instructions'] = canonical.system;
  }

  const input: Record<string, unknown>[] = [];

  for (const msg of canonical.messages) {
    if (msg.role === 'user') {
      const contentParts: Record<string, unknown>[] = [];
      const toolOutputs: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          contentParts.push({ type: 'input_text', text: block.text });
        } else if (block.type === 'image') {
          const source = block.source;
          const mediaType =
            typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png';
          const data = typeof source['data'] === 'string' ? source['data'] : '';
          const url =
            typeof source['url'] === 'string' ? source['url'] : `data:${mediaType};base64,${data}`;
          contentParts.push({
            type: 'input_image',
            image_url: url,
          });
        } else if (block.type === 'tool_result') {
          const contentStr =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          toolOutputs.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: contentStr,
          });
        }
      }

      if (contentParts.length > 0) {
        input.push({
          type: 'message',
          role: 'user',
          content: contentParts,
        });
      }
      for (const to of toolOutputs) {
        input.push(to);
      }
    } else if (msg.role === 'assistant') {
      let textContent = '';
      let reasoningContent = '';
      const functionCalls: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'thinking') {
          reasoningContent += block.thinking;
        } else if (block.type === 'tool_use') {
          functionCalls.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: canonicalJsonString(block.input),
          });
        }
      }

      if (textContent.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: textContent }],
        });
      }
      if (reasoningContent.length > 0) {
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: reasoningContent }],
        });
      }
      for (const fc of functionCalls) {
        input.push(fc);
      }
    }
  }

  result['input'] = input;

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    result['tools'] = canonical.tools.map((t) => {
      const schemaCopy = JSON.parse(JSON.stringify(t.inputSchema));
      cleanSchema(schemaCopy);
      closeObjectSchemas(schemaCopy);
      return {
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: schemaCopy,
        strict: false,
      };
    });
  }

  // Tool Choice
  if (canonical.toolChoice) {
    switch (canonical.toolChoice.type) {
      case 'any':
        result['tool_choice'] = 'required';
        break;
      case 'tool':
        result['tool_choice'] = {
          type: 'function',
          name: canonical.toolChoice.name,
        };
        break;
    }
  }

  // Thinking
  if (canonical.thinking) {
    result['reasoning'] = { effort: 'high' };
    if (canonical.thinking.budgetTokens !== undefined) {
      result['max_output_tokens'] = canonical.thinking.budgetTokens;
    }
  }

  // Limits
  let maxTokens = canonical.maxTokens;
  if (provider?.maxTokensCap !== undefined) {
    maxTokens = maxTokens !== undefined ? Math.min(maxTokens, provider.maxTokensCap) : provider.maxTokensCap;
  }
  if (maxTokens !== undefined && result['max_output_tokens'] === undefined) {
    result['max_output_tokens'] = maxTokens;
  }

  if (canonical.temperature !== undefined) {
    result['temperature'] = canonical.temperature;
  }
  if (canonical.topP !== undefined) {
    result['top_p'] = canonical.topP;
  }

  return result;
}

export function openaiResponsesToCanonicalResponse(
  body: Record<string, unknown>
): CanonicalResponse {
  const content: CanonicalContentBlock[] = [];

  if (Array.isArray(body['output'])) {
    for (const item of body['output']) {
      if (!item || typeof item !== 'object') continue;
      const type = item['type'];

      if (type === 'message') {
        if (Array.isArray(item['content'])) {
          for (const part of item['content']) {
            if (!part || typeof part !== 'object') continue;
            if (part['type'] === 'output_text' || part['type'] === 'text') {
              content.push({
                type: 'text',
                text: typeof part['text'] === 'string' ? part['text'] : '',
              });
            }
          }
        }
      } else if (type === 'reasoning') {
        let text = '';
        if (Array.isArray(item['summary'])) {
          text = item['summary']
            .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
            .map((s) => (typeof s['text'] === 'string' ? s['text'] : ''))
            .join('');
        }
        if (text.length > 0) {
          content.push({ type: 'thinking', thinking: text });
        }
      } else if (type === 'function_call') {
        const id = typeof item['call_id'] === 'string' ? item['call_id'] : randomUUID();
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        let input: Record<string, unknown> = {};
        if (typeof item['arguments'] === 'string') {
          try {
            input = JSON.parse(item['arguments']);
          } catch {
            input = {};
          }
        }
        content.push({ type: 'tool_use', id, name, input });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  // Usage
  const rawUsage = (body['usage'] as Record<string, unknown>) || {};
  const inputTokens = typeof rawUsage['input_tokens'] === 'number' ? rawUsage['input_tokens'] : 0;
  const outputTokens =
    typeof rawUsage['output_tokens'] === 'number' ? rawUsage['output_tokens'] : 0;

  const inputDetails = (rawUsage['input_tokens_details'] as Record<string, unknown>) || {};
  const cachedTokens =
    typeof inputDetails['cached_tokens'] === 'number' ? inputDetails['cached_tokens'] : 0;

  const outputDetails = (rawUsage['output_tokens_details'] as Record<string, unknown>) || {};
  const reasoningTokens =
    typeof outputDetails['reasoning_tokens'] === 'number'
      ? outputDetails['reasoning_tokens']
      : 0;

  const usage: CanonicalUsage = {
    inputTokens: Math.max(0, inputTokens - cachedTokens),
    outputTokens: Math.max(0, outputTokens - reasoningTokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
    thoughtTokens: reasoningTokens,
  };

  const id = typeof body['id'] === 'string' ? body['id'] : `resp_${randomUUID()}`;
  const model = typeof body['model'] === 'string' ? body['model'] : 'unknown';

  return {
    id,
    model,
    content,
    stopReason: 'end_turn',
    usage,
    extra: {},
  };
}

export function canonicalToOpenAiResponsesResponse(
  canonical: CanonicalResponse
): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];

  let text = '';
  let thinking = '';
  const functionCalls: Record<string, unknown>[] = [];

  for (const block of canonical.content) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'thinking') {
      thinking += block.thinking;
    } else if (block.type === 'tool_use') {
      functionCalls.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: canonicalJsonString(block.input),
      });
    }
  }

  if (thinking.length > 0) {
    output.push({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: thinking }],
    });
  }

  if (text.length > 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }

  for (const fc of functionCalls) {
    output.push(fc);
  }

  const inputTokens = canonical.usage.inputTokens + canonical.usage.cacheReadTokens;
  const outputTokens = canonical.usage.outputTokens + canonical.usage.thoughtTokens;

  return {
    id: canonical.id,
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model: canonical.model,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
