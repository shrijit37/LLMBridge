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

export function cleanSchema(schema: Record<string, unknown>): void {
  if (schema['format'] === 'uri') {
    delete schema['format'];
  }
  if (typeof schema['properties'] === 'object' && schema['properties'] !== null) {
    for (const prop of Object.values(schema['properties'] as Record<string, unknown>)) {
      if (typeof prop === 'object' && prop !== null) {
        cleanSchema(prop as Record<string, unknown>);
      }
    }
  }
  if (typeof schema['items'] === 'object' && schema['items'] !== null) {
    cleanSchema(schema['items'] as Record<string, unknown>);
  }
}

export function openaiChatToCanonicalRequest(body: Record<string, unknown>): CanonicalRequest {
  const model = typeof body['model'] === 'string' ? body['model'] : 'gpt-4o';
  const stream = Boolean(body['stream']);

  let systemPrompt: string | undefined;
  const messages: CanonicalMessage[] = [];

  if (Array.isArray(body['messages'])) {
    for (const rawMsg of body['messages']) {
      if (!rawMsg || typeof rawMsg !== 'object') continue;
      const role = rawMsg['role'];

      if (role === 'system') {
        const text = typeof rawMsg['content'] === 'string' ? rawMsg['content'] : '';
        systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
        continue;
      }

      if (role === 'tool') {
        const toolUseId =
          typeof rawMsg['tool_call_id'] === 'string' ? rawMsg['tool_call_id'] : '';
        const content = rawMsg['content'];
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId,
              content,
            },
          ],
        });
        continue;
      }

      if (role === 'assistant') {
        const blocks: CanonicalContentBlock[] = [];

        // Reasoning content (DeepSeek / o1 / OpenAI reasoning)
        if (
          typeof rawMsg['reasoning_content'] === 'string' &&
          rawMsg['reasoning_content'].length > 0
        ) {
          blocks.push({
            type: 'thinking',
            thinking: rawMsg['reasoning_content'],
          });
        }

        // Text content
        if (typeof rawMsg['content'] === 'string' && rawMsg['content'].length > 0) {
          blocks.push({
            type: 'text',
            text: rawMsg['content'],
          });
        }

        // Tool calls
        if (Array.isArray(rawMsg['tool_calls'])) {
          for (const tc of rawMsg['tool_calls']) {
            if (!tc || typeof tc !== 'object') continue;
            const id = typeof tc['id'] === 'string' ? tc['id'] : randomUUID();
            const fn = (tc['function'] as Record<string, unknown>) || {};
            const name = typeof fn['name'] === 'string' ? fn['name'] : '';
            let input: Record<string, unknown> = {};
            if (typeof fn['arguments'] === 'string') {
              try {
                input = JSON.parse(fn['arguments']);
              } catch {
                input = {};
              }
            } else if (typeof fn['arguments'] === 'object' && fn['arguments'] !== null) {
              input = fn['arguments'] as Record<string, unknown>;
            }

            blocks.push({
              type: 'tool_use',
              id,
              name,
              input,
            });
          }
        }

        if (blocks.length === 0) {
          blocks.push({ type: 'text', text: '' });
        }

        messages.push({ role: 'assistant', content: blocks });
        continue;
      }

      // User message
      const blocks: CanonicalContentBlock[] = [];
      const content = rawMsg['content'];
      if (typeof content === 'string') {
        blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          if (part['type'] === 'text') {
            blocks.push({
              type: 'text',
              text: typeof part['text'] === 'string' ? part['text'] : '',
            });
          } else if (part['type'] === 'image_url') {
            blocks.push({
              type: 'image',
              source: (part['image_url'] as Record<string, unknown>) || {},
            });
          }
        }
      }

      messages.push({ role: 'user', content: blocks });
    }
  }

  // Tools
  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body['tools'])) {
    tools = [];
    for (const t of body['tools']) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t['function'] as Record<string, unknown>) || t;
      const name = typeof fn['name'] === 'string' ? fn['name'] : '';
      if (name.length === 0) continue;
      tools.push({
        name,
        description: typeof fn['description'] === 'string' ? fn['description'] : undefined,
        inputSchema:
          typeof fn['parameters'] === 'object' && fn['parameters'] !== null
            ? (fn['parameters'] as Record<string, unknown>)
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
    const fn = (rawTc as Record<string, unknown>)['function'];
    if (fn && typeof fn === 'object') {
      const name = (fn as Record<string, unknown>)['name'];
      if (typeof name === 'string') {
        toolChoice = { type: 'tool', name };
      }
    }
  }

  // Reasoning effort
  let thinking: CanonicalRequest['thinking'] | undefined;
  if (body['reasoning_effort']) {
    thinking = { type: 'enabled' };
  }

  const maxTokens =
    typeof body['max_completion_tokens'] === 'number'
      ? body['max_completion_tokens']
      : typeof body['max_tokens'] === 'number'
        ? body['max_tokens']
        : undefined;

  return {
    model,
    messages,
    system: systemPrompt,
    maxTokens,
    temperature: typeof body['temperature'] === 'number' ? body['temperature'] : undefined,
    topP: typeof body['top_p'] === 'number' ? body['top_p'] : undefined,
    stopSequences: Array.isArray(body['stop'])
      ? (body['stop'] as string[])
      : typeof body['stop'] === 'string'
        ? [body['stop']]
        : undefined,
    tools,
    toolChoice,
    stream,
    thinking,
    extra: {},
  };
}

export function canonicalToOpenAiChatRequest(
  canonical: CanonicalRequest,
  provider?: Provider
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: canonical.model,
    stream: canonical.stream,
  };

  if (canonical.stream) {
    result['stream_options'] = { include_usage: true };
  }

  const outMessages: Record<string, unknown>[] = [];

  // Prepend system message if present
  if (canonical.system && canonical.system.length > 0) {
    outMessages.push({ role: 'system', content: canonical.system });
  }

  for (const msg of canonical.messages) {
    if (msg.role === 'user') {
      const contentParts: Record<string, unknown>[] = [];
      const toolResults: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          contentParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          const source = block.source;
          const mediaType =
            typeof source['media_type'] === 'string' ? source['media_type'] : 'image/png';
          const data = typeof source['data'] === 'string' ? source['data'] : '';
          const url =
            typeof source['url'] === 'string' ? source['url'] : `data:${mediaType};base64,${data}`;
          contentParts.push({
            type: 'image_url',
            image_url: { url },
          });
        } else if (block.type === 'tool_result') {
          const contentStr =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
          toolResults.push({
            role: 'tool',
            tool_call_id: block.toolUseId,
            content: contentStr,
          });
        }
      }

      if (contentParts.length === 1 && contentParts[0]?.['type'] === 'text') {
        outMessages.push({
          role: 'user',
          content: contentParts[0]['text'],
        });
      } else if (contentParts.length > 0) {
        outMessages.push({
          role: 'user',
          content: contentParts,
        });
      }

      for (const tr of toolResults) {
        outMessages.push(tr);
      }
    } else if (msg.role === 'assistant') {
      let textContent = '';
      let reasoningContent = '';
      const toolCalls: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textContent += block.text;
        } else if (block.type === 'thinking') {
          reasoningContent += block.thinking;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: canonicalJsonString(block.input),
            },
          });
        }
      }

      const assistantMsg: Record<string, unknown> = { role: 'assistant' };
      assistantMsg['content'] = textContent.length > 0 ? textContent : null;

      if (reasoningContent.length > 0) {
        assistantMsg['reasoning_content'] = reasoningContent;
      }
      if (toolCalls.length > 0) {
        assistantMsg['tool_calls'] = toolCalls;
      }

      outMessages.push(assistantMsg);
    }
  }

  // Compat quirk: inject reasoning_content = "" into assistant tool_calls turns if injectThinkingHistory
  if (provider?.injectThinkingHistory) {
    for (const m of outMessages) {
      if (
        m['role'] === 'assistant' &&
        m['reasoning_content'] === undefined &&
        Array.isArray(m['tool_calls']) &&
        m['tool_calls'].length > 0
      ) {
        m['reasoning_content'] = '';
      }
    }
  }

  result['messages'] = outMessages;

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    result['tools'] = canonical.tools.map((t) => {
      const schemaCopy = JSON.parse(JSON.stringify(t.inputSchema));
      cleanSchema(schemaCopy);
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: schemaCopy,
        },
      };
    });
  }

  // Tool choice
  if (canonical.toolChoice) {
    switch (canonical.toolChoice.type) {
      case 'any':
        result['tool_choice'] = 'required';
        break;
      case 'tool':
        result['tool_choice'] = {
          type: 'function',
          function: { name: canonical.toolChoice.name },
        };
        break;
      // Note: 'auto' is intentionally omitted for compatibility with vLLM
    }
  }

  // Thinking
  if (canonical.thinking) {
    result['reasoning_effort'] = 'high';
    if (canonical.thinking.budgetTokens !== undefined) {
      result['max_completion_tokens'] = canonical.thinking.budgetTokens;
    }
  }

  // Token limits and cap
  let maxTokens = canonical.maxTokens;
  if (provider?.maxTokensCap !== undefined) {
    maxTokens = maxTokens !== undefined ? Math.min(maxTokens, provider.maxTokensCap) : provider.maxTokensCap;
    if (result['max_completion_tokens'] !== undefined) {
      result['max_completion_tokens'] = Math.min(
        result['max_completion_tokens'] as number,
        provider.maxTokensCap
      );
    }
  }
  if (maxTokens !== undefined && result['max_completion_tokens'] === undefined) {
    result['max_tokens'] = maxTokens;
  }

  if (canonical.temperature !== undefined) {
    result['temperature'] = canonical.temperature;
  }
  if (canonical.topP !== undefined) {
    result['top_p'] = canonical.topP;
  }
  if (canonical.stopSequences && canonical.stopSequences.length > 0) {
    result['stop'] = canonical.stopSequences;
  }

  return result;
}

export function openaiChatToCanonicalResponse(body: Record<string, unknown>): CanonicalResponse {
  const choices = Array.isArray(body['choices']) ? body['choices'] : [];
  const firstChoice = (choices[0] as Record<string, unknown>) || {};
  const message = (firstChoice['message'] as Record<string, unknown>) || {};

  const content: CanonicalContentBlock[] = [];

  // Thinking / Reasoning
  if (typeof message['reasoning_content'] === 'string' && message['reasoning_content'].length > 0) {
    content.push({
      type: 'thinking',
      thinking: message['reasoning_content'],
    });
  }

  // Text content
  if (typeof message['content'] === 'string' && message['content'].length > 0) {
    content.push({
      type: 'text',
      text: message['content'],
    });
  }

  // Tool calls
  if (Array.isArray(message['tool_calls'])) {
    for (const tc of message['tool_calls']) {
      if (!tc || typeof tc !== 'object') continue;
      const id = typeof tc['id'] === 'string' ? tc['id'] : randomUUID();
      const fn = (tc['function'] as Record<string, unknown>) || {};
      const name = typeof fn['name'] === 'string' ? fn['name'] : '';
      let input: Record<string, unknown> = {};
      if (typeof fn['arguments'] === 'string') {
        try {
          input = JSON.parse(fn['arguments']);
        } catch {
          input = {};
        }
      } else if (typeof fn['arguments'] === 'object' && fn['arguments'] !== null) {
        input = fn['arguments'] as Record<string, unknown>;
      }

      content.push({
        type: 'tool_use',
        id,
        name,
        input,
      });
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const finishReason =
    typeof firstChoice['finish_reason'] === 'string' ? firstChoice['finish_reason'] : 'stop';
  let stopReason: string = 'end_turn';
  if (finishReason === 'tool_calls') stopReason = 'tool_use';
  else if (finishReason === 'length') stopReason = 'max_tokens';
  else if (finishReason !== 'stop') stopReason = finishReason;

  // Usage
  const rawUsage = (body['usage'] as Record<string, unknown>) || {};
  const promptTokens =
    typeof rawUsage['prompt_tokens'] === 'number' ? rawUsage['prompt_tokens'] : 0;
  const completionTokens =
    typeof rawUsage['completion_tokens'] === 'number' ? rawUsage['completion_tokens'] : 0;

  const promptDetails = (rawUsage['prompt_tokens_details'] as Record<string, unknown>) || {};
  const cachedTokens =
    typeof promptDetails['cached_tokens'] === 'number' ? promptDetails['cached_tokens'] : 0;

  const completionDetails =
    (rawUsage['completion_tokens_details'] as Record<string, unknown>) || {};
  const reasoningTokens =
    typeof completionDetails['reasoning_tokens'] === 'number'
      ? completionDetails['reasoning_tokens']
      : 0;

  const usage: CanonicalUsage = {
    inputTokens: Math.max(0, promptTokens - cachedTokens),
    outputTokens: Math.max(0, completionTokens - reasoningTokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
    thoughtTokens: reasoningTokens,
  };

  const id = typeof body['id'] === 'string' ? body['id'] : `chatcmpl-${randomUUID()}`;
  const model = typeof body['model'] === 'string' ? body['model'] : 'unknown';

  return {
    id,
    model,
    content,
    stopReason,
    usage,
    extra: {},
  };
}

export function canonicalToOpenAiChatResponse(
  canonical: CanonicalResponse
): Record<string, unknown> {
  let textContent = '';
  let reasoningContent = '';
  const toolCalls: Record<string, unknown>[] = [];

  for (const block of canonical.content) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'thinking') {
      reasoningContent += block.thinking;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: canonicalJsonString(block.input),
        },
      });
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textContent.length > 0 ? textContent : null,
  };
  if (reasoningContent.length > 0) {
    message['reasoning_content'] = reasoningContent;
  }
  if (toolCalls.length > 0) {
    message['tool_calls'] = toolCalls;
  }

  let finishReason = 'stop';
  if (canonical.stopReason === 'tool_use') finishReason = 'tool_calls';
  else if (canonical.stopReason === 'max_tokens') finishReason = 'length';
  else if (canonical.stopReason && canonical.stopReason !== 'end_turn') {
    finishReason = canonical.stopReason;
  }

  const promptTokens = canonical.usage.inputTokens + canonical.usage.cacheReadTokens;
  const completionTokens = canonical.usage.outputTokens + canonical.usage.thoughtTokens;

  return {
    id: canonical.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: canonical.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}
