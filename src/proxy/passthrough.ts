import type { Provider } from '../config/types.js';

/**
 * Checks if an incoming request has assistant tool calls that lack reasoning_content,
 * which requires normalisation to inject empty reasoning_content for DeepSeek compatibility.
 */
export function needsReasoningInjection(body: Record<string, unknown>): boolean {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return false;

  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const msg = m as Record<string, unknown>;
    if (msg['role'] === 'assistant') {
      const toolCalls = msg['tool_calls'];
      if (Array.isArray(toolCalls) && toolCalls.length > 0 && msg['reasoning_content'] === undefined) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determines whether an OpenAI Chat Completions client request can bypass
 * Canonical AST translation and be proxied directly byte-for-byte to the upstream provider.
 */
export function canPassthrough(
  clientFormat: 'openai_chat' | 'openai_responses' | 'anthropic',
  provider: Provider,
  body: Record<string, unknown>
): boolean {
  if (clientFormat !== 'openai_chat') {
    return false;
  }

  if (provider.apiFormat !== 'openai') {
    return false;
  }

  const effectiveVersion = provider.apiVersion || 'responses';
  if (effectiveVersion !== 'chat_completions') {
    return false;
  }

  const isTransparent =
    provider.routes.length === 0 &&
    Object.keys(provider.modelMap).length === 0 &&
    provider.maxTokensCap === undefined;

  if (!isTransparent) {
    return false;
  }

  if (provider.injectThinkingHistory && needsReasoningInjection(body)) {
    return false;
  }

  return true;
}

/**
 * Injects `stream_options.include_usage: true` into streaming requests
 * so token usage metrics can be captured from the stream.
 */
export function patchStreamUsage(body: Record<string, unknown>): Record<string, unknown> {
  if (!body['stream']) {
    return body;
  }

  const copy = { ...body };
  const existingOptions =
    typeof copy['stream_options'] === 'object' && copy['stream_options'] !== null
      ? (copy['stream_options'] as Record<string, unknown>)
      : {};

  if (!existingOptions['include_usage']) {
    copy['stream_options'] = { ...existingOptions, include_usage: true };
  }

  return copy;
}
