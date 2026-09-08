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

export function anthropicToCanonicalRequest(body: Record<string, unknown>): CanonicalRequest {
  const model = typeof body['model'] === 'string' ? body['model'] : 'claude-sonnet-4-20250514';
  const stream = Boolean(body['stream']);

  // Extract system prompt
  let system: string | undefined;
  if (typeof body['system'] === 'string') {
    system = body['system'];
  } else if (Array.isArray(body['system'])) {
    system = body['system']
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map((b) => (typeof b['text'] === 'string' ? b['text'] : ''))
      .filter((t) => t.length > 0)
      .join('\n');
  }

  // Extract messages
  const messages: CanonicalMessage[] = [];
  if (Array.isArray(body['messages'])) {
    for (const rawMsg of body['messages']) {
      if (!rawMsg || typeof rawMsg !== 'object') continue;
      const roleRaw = rawMsg['role'];
      const role: 'user' | 'assistant' | 'system' =
        roleRaw === 'assistant' ? 'assistant' : roleRaw === 'system' ? 'system' : 'user';

      const blocks: CanonicalContentBlock[] = [];
      const content = rawMsg['content'];
      if (typeof content === 'string') {
        blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const blockType = item['type'];
          if (blockType === 'text') {
            blocks.push({
              type: 'text',
              text: typeof item['text'] === 'string' ? item['text'] : '',
            });
          } else if (blockType === 'thinking') {
            blocks.push({
              type: 'thinking',
              thinking: typeof item['thinking'] === 'string' ? item['thinking'] : '',
              signature: typeof item['signature'] === 'string' ? item['signature'] : undefined,
            });
          } else if (blockType === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: typeof item['id'] === 'string' ? item['id'] : randomUUID(),
              name: typeof item['name'] === 'string' ? item['name'] : '',
              input:
                typeof item['input'] === 'object' && item['input'] !== null
                  ? (item['input'] as Record<string, unknown>)
                  : {},
            });
          } else if (blockType === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              toolUseId: typeof item['tool_use_id'] === 'string' ? item['tool_use_id'] : '',
              content: item['content'],
              isError: Boolean(item['is_error']),
            });
          } else if (blockType === 'image') {
            blocks.push({
              type: 'image',
              source:
                typeof item['source'] === 'object' && item['source'] !== null
                  ? (item['source'] as Record<string, unknown>)
                  : {},
            });
          } else {
            blocks.push({
              type: 'custom',
              raw: item as Record<string, unknown>,
            });
          }
        }
      }

      messages.push({ role, content: blocks });
    }
  }

  // Extract tools
  let tools: CanonicalTool[] | undefined;
  if (Array.isArray(body['tools'])) {
    tools = body['tools']
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => ({
        name: typeof t['name'] === 'string' ? t['name'] : '',
        description: typeof t['description'] === 'string' ? t['description'] : undefined,
        inputSchema:
          typeof t['input_schema'] === 'object' && t['input_schema'] !== null
            ? (t['input_schema'] as Record<string, unknown>)
            : { type: 'object' },
      }));
  }

  // Extract toolChoice
  let toolChoice: CanonicalToolChoice | undefined;
  const rawTc = body['tool_choice'];
  if (rawTc && typeof rawTc === 'object') {
    const tcType = (rawTc as Record<string, unknown>)['type'];
    if (tcType === 'any') toolChoice = { type: 'any' };
    else if (tcType === 'auto') toolChoice = { type: 'auto' };
    else if (tcType === 'tool') {
      const name = (rawTc as Record<string, unknown>)['name'];
      toolChoice = { type: 'tool', name: typeof name === 'string' ? name : '' };
    }
  }

  // Extract thinking
  let thinking: CanonicalRequest['thinking'] | undefined;
  const rawThinking = body['thinking'];
  if (rawThinking && typeof rawThinking === 'object') {
    const tType = (rawThinking as Record<string, unknown>)['type'];
    if (tType === 'enabled' || tType === 'adaptive') {
      const budget = (rawThinking as Record<string, unknown>)['budget_tokens'];
      thinking = {
        type: tType,
        budgetTokens: typeof budget === 'number' ? budget : undefined,
      };
    }
  }
  const KNOWN_ANTHROPIC_FIELDS: Record<string, true> = {
    model: true,
    messages: true,
    system: true,
    max_tokens: true,
    temperature: true,
    top_p: true,
    stop_sequences: true,
    tools: true,
    tool_choice: true,
    stream: true,
    thinking: true,
  };

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!KNOWN_ANTHROPIC_FIELDS[k]) {
      extra[k] = v;
    }
  }

  return {
    model,
    messages,
    system,
    maxTokens: typeof body['max_tokens'] === 'number' ? body['max_tokens'] : undefined,
    temperature: typeof body['temperature'] === 'number' ? body['temperature'] : undefined,
    topP: typeof body['top_p'] === 'number' ? body['top_p'] : undefined,
    stopSequences: Array.isArray(body['stop_sequences'])
      ? (body['stop_sequences'] as string[])
      : undefined,
    tools,
    toolChoice,
    stream,
    thinking,
    extra,
  };
}

export function canonicalToAnthropicRequest(
  canonical: CanonicalRequest,
  provider?: Provider
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    model: canonical.model,
    stream: canonical.stream,
  };

  let maxTokens = canonical.maxTokens;
  if (provider?.maxTokensCap !== undefined) {
    maxTokens = maxTokens !== undefined ? Math.min(maxTokens, provider.maxTokensCap) : provider.maxTokensCap;
  }
  if (maxTokens !== undefined) {
    result['max_tokens'] = maxTokens;
  }

  if (canonical.system) {
    result['system'] = canonical.system;
  }
  if (canonical.temperature !== undefined) {
    result['temperature'] = canonical.temperature;
  }
  if (canonical.topP !== undefined) {
    result['top_p'] = canonical.topP;
  }
  if (canonical.stopSequences && canonical.stopSequences.length > 0) {
    result['stop_sequences'] = canonical.stopSequences;
  }

  // Messages
  result['messages'] = canonical.messages.map((m) => {
    const content = m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text, ...b.extra };
        case 'thinking':
          return {
            type: 'thinking',
            thinking: b.thinking,
            ...(b.signature ? { signature: b.signature } : {}),
            ...b.extra,
          };
        case 'tool_use':
          return {
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input,
            ...b.extra,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError ? { is_error: true } : {}),
            ...b.extra,
          };
        case 'image':
          return {
            type: 'image',
            source: b.source,
            ...b.extra,
          };
        case 'custom':
          return { ...b.raw };
      }
    });
    return { role: m.role, content };
  });

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    result['tools'] = canonical.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...t.extra,
    }));
  }

  // Tool Choice
  if (canonical.toolChoice) {
    switch (canonical.toolChoice.type) {
      case 'any':
        result['tool_choice'] = { type: 'any' };
        break;
      case 'auto':
        result['tool_choice'] = { type: 'auto' };
        break;
      case 'tool':
        result['tool_choice'] = { type: 'tool', name: canonical.toolChoice.name };
        break;
    }
  }

  // Thinking
  if (canonical.thinking) {
    result['thinking'] = {
      type: canonical.thinking.type,
      ...(canonical.thinking.budgetTokens !== undefined
        ? { budget_tokens: canonical.thinking.budgetTokens }
        : {}),
    };
  }

  // Re-attach extra fields
  for (const [k, v] of Object.entries(canonical.extra)) {
    if (result[k] === undefined) {
      result[k] = v;
    }
  }

  return result;
}

export function anthropicToCanonicalResponse(body: Record<string, unknown>): CanonicalResponse {
  const id = typeof body['id'] === 'string' ? body['id'] : `msg_${randomUUID()}`;
  const model = typeof body['model'] === 'string' ? body['model'] : 'unknown';
  const stopReason = typeof body['stop_reason'] === 'string' ? body['stop_reason'] : undefined;

  const content: CanonicalContentBlock[] = [];
  if (Array.isArray(body['content'])) {
    for (const item of body['content']) {
      if (!item || typeof item !== 'object') continue;
      const type = item['type'];
      if (type === 'text') {
        content.push({
          type: 'text',
          text: typeof item['text'] === 'string' ? item['text'] : '',
        });
      } else if (type === 'thinking') {
        content.push({
          type: 'thinking',
          thinking: typeof item['thinking'] === 'string' ? item['thinking'] : '',
          signature: typeof item['signature'] === 'string' ? item['signature'] : undefined,
        });
      } else if (type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: typeof item['id'] === 'string' ? item['id'] : randomUUID(),
          name: typeof item['name'] === 'string' ? item['name'] : '',
          input:
            typeof item['input'] === 'object' && item['input'] !== null
              ? (item['input'] as Record<string, unknown>)
              : {},
        });
      }
    }
  }

  const rawUsage = (body['usage'] as Record<string, unknown>) || {};
  const usage: CanonicalUsage = {
    inputTokens: typeof rawUsage['input_tokens'] === 'number' ? rawUsage['input_tokens'] : 0,
    outputTokens: typeof rawUsage['output_tokens'] === 'number' ? rawUsage['output_tokens'] : 0,
    cacheReadTokens:
      typeof rawUsage['cache_read_input_tokens'] === 'number'
        ? rawUsage['cache_read_input_tokens']
        : 0,
    cacheWriteTokens:
      typeof rawUsage['cache_creation_input_tokens'] === 'number'
        ? rawUsage['cache_creation_input_tokens']
        : 0,
    thoughtTokens: 0,
  };

  return {
    id,
    model,
    content,
    stopReason,
    usage,
    extra: {},
  };
}

export function canonicalToAnthropicResponse(canonical: CanonicalResponse): Record<string, unknown> {
  const content = canonical.content.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'thinking':
        return {
          type: 'thinking',
          thinking: b.thinking,
          ...(b.signature ? { signature: b.signature } : {}),
        };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input,
        };
      default:
        return { type: 'text', text: '' };
    }
  });

  return {
    id: canonical.id,
    type: 'message',
    role: 'assistant',
    model: canonical.model,
    content,
    stop_reason: canonical.stopReason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: canonical.usage.inputTokens,
      output_tokens: canonical.usage.outputTokens + canonical.usage.thoughtTokens,
      cache_read_input_tokens: canonical.usage.cacheReadTokens,
      cache_creation_input_tokens: canonical.usage.cacheWriteTokens,
    },
  };
}
