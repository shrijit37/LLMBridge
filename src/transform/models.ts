/**
 * Converts an Anthropic GET /v1/models response into OpenAI format:
 * { object: "list", data: [{ id, object: "model", created: 0, owned_by: "anthropic" }] }
 */
export function anthropicToOpenAiModels(
  anthropic: Record<string, unknown>
): Record<string, unknown> {
  const models = Array.isArray(anthropic['data']) ? anthropic['data'] : [];
  const data = models.map((m) => {
    const item = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
    const id = typeof item['id'] === 'string' ? item['id'] : 'unknown';
    return {
      id,
      object: 'model',
      created: 0,
      owned_by: 'anthropic',
    };
  });

  return {
    object: 'list',
    data,
  };
}

/**
 * Converts an OpenAI GET /v1/models response into Anthropic format:
 * { data: [{ type: "model", id, display_name, created_at }], has_more: false, first_id, last_id }
 */
export function openaiToAnthropicModels(
  openai: Record<string, unknown>
): Record<string, unknown> {
  const models = Array.isArray(openai['data']) ? openai['data'] : [];
  const data = models.map((m) => {
    const item = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
    const id = typeof item['id'] === 'string' ? item['id'] : 'unknown';
    return {
      type: 'model',
      id,
      display_name: id,
      created_at: '1970-01-01T00:00:00Z',
    };
  });

  const firstId = data.length > 0 && data[0] ? data[0].id : '';
  const lastId = data.length > 0 && data[data.length - 1] ? data[data.length - 1]!.id : '';

  return {
    data,
    has_more: false,
    first_id: firstId,
    last_id: lastId,
  };
}

/**
 * Converts a Gemini GET /v1beta/models response into Anthropic format.
 * Gemini entries use `models/<id>` style names with no `id` field,
 * so the `models/` prefix is stripped to expose the bare model id.
 */
export function geminiToAnthropicModels(
  gemini: Record<string, unknown>
): Record<string, unknown> {
  const models = Array.isArray(gemini['models']) ? gemini['models'] : [];
  const data = models.map((m) => {
    const item = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
    const rawName = typeof item['name'] === 'string' ? item['name'] : '';
    const id = rawName.startsWith('models/') ? rawName.slice('models/'.length) : rawName;
    const displayName =
      typeof item['display_name'] === 'string' ? item['display_name'] : id;

    return {
      type: 'model',
      id,
      display_name: displayName,
      created_at: '1970-01-01T00:00:00Z',
    };
  });

  const firstId = data.length > 0 && data[0] ? data[0].id : '';
  const lastId = data.length > 0 && data[data.length - 1] ? data[data.length - 1]!.id : '';

  return {
    data,
    has_more: false,
    first_id: firstId,
    last_id: lastId,
  };
}
