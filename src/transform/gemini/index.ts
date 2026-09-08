import { randomUUID } from 'node:crypto';
import type { Provider } from '../../config/types.js';
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalContentBlock,
  CanonicalTool,
  CanonicalUsage,
} from '../canonical/types.js';

export function geminiToCanonicalRequest(body: Record<string, unknown>): CanonicalRequest {
  const model = typeof body['model'] === 'string' ? body['model'] : 'gemini-2.5-pro';
  const stream = Boolean(body['stream']);
  const systemPrompt =
    typeof body['system_instruction'] === 'string' ? body['system_instruction'] : undefined;

  const contentBlocks: CanonicalContentBlock[] = [];

  if (Array.isArray(body['input'])) {
    for (const step of body['input']) {
      if (!step || typeof step !== 'object') continue;
      const type = step['type'];

      if (type === 'user_input' && Array.isArray(step['content'])) {
        for (const part of step['content']) {
          if (!part || typeof part !== 'object') continue;
          if (part['type'] === 'text') {
            contentBlocks.push({
              type: 'text',
              text: typeof part['text'] === 'string' ? part['text'] : '',
            });
          }
        }
      } else if (type === 'thought') {
        contentBlocks.push({
          type: 'thinking',
          thinking: typeof step['text'] === 'string' ? step['text'] : '',
          signature: typeof step['signature'] === 'string' ? step['signature'] : undefined,
        });
      } else if (type === 'function_call') {
        const id = typeof step['id'] === 'string' ? step['id'] : randomUUID();
        const name = typeof step['name'] === 'string' ? step['name'] : '';
        const input =
          typeof step['arguments'] === 'object' && step['arguments'] !== null
            ? (step['arguments'] as Record<string, unknown>)
            : {};
        contentBlocks.push({
          type: 'tool_use',
          id,
          name,
          input,
        });
      } else if (type === 'function_result') {
        const toolUseId = typeof step['call_id'] === 'string' ? step['call_id'] : '';
        contentBlocks.push({
          type: 'tool_result',
          toolUseId,
          content: step['output'],
        });
      }
    }
  }

  return {
    model,
    messages: [{ role: 'user', content: contentBlocks }],
    system: systemPrompt,
    stream,
    extra: {},
  };
}

export function canonicalToGeminiRequest(
  canonical: CanonicalRequest,
  _provider?: Provider
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  const idToName = new Map<string, string>();

  // Map tool_use ids to names for function_result pairing
  for (const msg of canonical.messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        idToName.set(block.id, block.name);
      }
    }
  }

  for (const msg of canonical.messages) {
    if (msg.role === 'assistant') {
      const textParts: Record<string, unknown>[] = [];
      let hadSignedThought = false;

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking') {
          if (textParts.length > 0) {
            input.push({ type: 'model_output', content: [...textParts] });
            textParts.length = 0;
          }
          if (block.signature && block.signature.length > 0) {
            hadSignedThought = true;
            input.push({ type: 'thought', signature: block.signature });
          }
        } else if (block.type === 'tool_use') {
          if (textParts.length > 0) {
            input.push({ type: 'model_output', content: [...textParts] });
            textParts.length = 0;
          }
          if (hadSignedThought) {
            input.push({
              type: 'function_call',
              id: block.id,
              name: block.name,
              arguments: block.input,
            });
          }
        }
      }

      if (textParts.length > 0) {
        input.push({ type: 'model_output', content: textParts });
      }
    } else {
      // User message
      const userParts: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          userParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          userParts.push({ type: 'image', ...block.source });
        } else if (block.type === 'tool_result') {
          if (userParts.length > 0) {
            input.push({ type: 'user_input', content: [...userParts] });
            userParts.length = 0;
          }
          const fnName = idToName.get(block.toolUseId) || 'unknown_function';
          const outputObj =
            typeof block.content === 'object' && block.content !== null
              ? block.content
              : { result: block.content };
          input.push({
            type: 'function_result',
            call_id: block.toolUseId,
            name: fnName,
            output: outputObj,
          });
        }
      }

      if (userParts.length > 0) {
        input.push({ type: 'user_input', content: userParts });
      }
    }
  }

  if (input.length === 0) {
    input.push({ type: 'user_input', content: [{ type: 'text', text: '' }] });
  }

  const result: Record<string, unknown> = {
    model: canonical.model,
    input,
    store: false,
  };

  if (canonical.system && canonical.system.length > 0) {
    result['system_instruction'] = canonical.system;
  }

  // Tools
  if (canonical.tools && canonical.tools.length > 0) {
    result['tools'] = canonical.tools.map((t: CanonicalTool) => ({
      type: 'function',
      name: t.name,
      description: t.description || '',
      parameters: t.inputSchema,
    }));
  }

  // Generation config
  const genConfig: Record<string, unknown> = {};
  if (canonical.temperature !== undefined) {
    genConfig['temperature'] = canonical.temperature;
  }
  if (canonical.thinking) {
    genConfig['thinking_level'] = 'high';
    genConfig['thinking_summaries'] = 'auto';
  }
  if (Object.keys(genConfig).length > 0) {
    result['generation_config'] = genConfig;
  }

  if (canonical.stream) {
    result['stream'] = true;
  }

  return result;
}

export function geminiToCanonicalResponse(body: Record<string, unknown>): CanonicalResponse {
  const content: CanonicalContentBlock[] = [];

  if (Array.isArray(body['steps'])) {
    for (const step of body['steps']) {
      if (!step || typeof step !== 'object') continue;
      const type = step['type'];

      if (type === 'model_output' && Array.isArray(step['content'])) {
        for (const part of step['content']) {
          if (!part || typeof part !== 'object') continue;
          if (part['type'] === 'text') {
            content.push({
              type: 'text',
              text: typeof part['text'] === 'string' ? part['text'] : '',
            });
          }
        }
      } else if (type === 'thought') {
        const text = typeof step['text'] === 'string' ? step['text'] : '';
        const sig = typeof step['signature'] === 'string' ? step['signature'] : undefined;
        content.push({
          type: 'thinking',
          thinking: text,
          signature: sig,
        });
      } else if (type === 'function_call') {
        const id = typeof step['id'] === 'string' ? step['id'] : randomUUID();
        const name = typeof step['name'] === 'string' ? step['name'] : '';
        const input =
          typeof step['arguments'] === 'object' && step['arguments'] !== null
            ? (step['arguments'] as Record<string, unknown>)
            : {};
        content.push({
          type: 'tool_use',
          id,
          name,
          input,
        });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const rawUsage = (body['usage'] as Record<string, unknown>) || {};
  const inputTokens =
    typeof rawUsage['total_input_tokens'] === 'number'
      ? rawUsage['total_input_tokens']
      : typeof rawUsage['total_tokens'] === 'number'
        ? rawUsage['total_tokens']
        : 0;
  const outputTokens =
    typeof rawUsage['total_output_tokens'] === 'number' ? rawUsage['total_output_tokens'] : 0;
  const thoughtTokens =
    typeof rawUsage['total_thought_tokens'] === 'number' ? rawUsage['total_thought_tokens'] : 0;
  const cachedTokens =
    typeof rawUsage['total_cached_tokens'] === 'number' ? rawUsage['total_cached_tokens'] : 0;

  const usage: CanonicalUsage = {
    inputTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
    thoughtTokens,
  };

  const id = typeof body['id'] === 'string' ? body['id'] : `gemini_${randomUUID()}`;
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

export function canonicalToGeminiResponse(
  canonical: CanonicalResponse
): Record<string, unknown> {
  const steps: Record<string, unknown>[] = [];

  for (const block of canonical.content) {
    if (block.type === 'text') {
      steps.push({
        type: 'model_output',
        content: [{ type: 'text', text: block.text }],
      });
    } else if (block.type === 'thinking') {
      steps.push({
        type: 'thought',
        text: block.thinking,
        signature: block.signature,
      });
    } else if (block.type === 'tool_use') {
      steps.push({
        type: 'function_call',
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  return {
    id: canonical.id,
    model: canonical.model,
    steps,
    usage: {
      total_input_tokens: canonical.usage.inputTokens,
      total_output_tokens: canonical.usage.outputTokens,
      total_thought_tokens: canonical.usage.thoughtTokens,
      total_cached_tokens: canonical.usage.cacheReadTokens,
      total_tokens:
        canonical.usage.inputTokens +
        canonical.usage.outputTokens +
        canonical.usage.thoughtTokens +
        canonical.usage.cacheReadTokens,
    },
  };
}
