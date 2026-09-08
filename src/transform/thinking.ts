/**
 * Check whether a message has any thinking block in its content.
 */
export function messageHasThinkingBlock(msg: Record<string, unknown>): boolean {
  const content = msg['content'];
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => typeof b === 'object' && b !== null && (b as Record<string, unknown>)['type'] === 'thinking'
  );
}

/**
 * Counts how many signed thinking blocks exist in an assistant message.
 */
export function messageSignedThinkingCount(msg: Record<string, unknown>): number {
  const content = msg['content'];
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (b) =>
      typeof b === 'object' &&
      b !== null &&
      (b as Record<string, unknown>)['type'] === 'thinking' &&
      typeof (b as Record<string, unknown>)['signature'] === 'string' &&
      ((b as Record<string, unknown>)['signature'] as string).length > 0
  ).length;
}

/**
 * When more than one signed thinking block is present in a single message,
 * keep only the first signature and strip signatures from subsequent blocks.
 */
export function stripDuplicateSignatures(msg: Record<string, unknown>): void {
  const content = msg['content'];
  if (!Array.isArray(content)) return;

  let seenSignature = false;
  for (const b of content) {
    if (
      typeof b === 'object' &&
      b !== null &&
      (b as Record<string, unknown>)['type'] === 'thinking'
    ) {
      const block = b as Record<string, unknown>;
      if (typeof block['signature'] === 'string' && block['signature'].length > 0) {
        if (seenSignature) {
          delete block['signature'];
        } else {
          seenSignature = true;
        }
      }
    }
  }
}

/**
 * DeepSeek / Anthropic compatibility quirk:
 * Injects empty thinking blocks into intermediate assistant turns that lack them,
 * and strips duplicate thinking block signatures.
 */
export function patchThinkingHistory(
  req: Record<string, unknown>,
  strictHistory: boolean
): { patched: boolean; result: Record<string, unknown> } {
  const rawThinking = req['thinking'];
  const thinkingType =
    typeof rawThinking === 'object' && rawThinking !== null
      ? (rawThinking as Record<string, unknown>)['type']
      : undefined;

  const thinkingEnabled = thinkingType === 'enabled' || thinkingType === 'adaptive';

  const messages = req['messages'];
  if (!Array.isArray(messages)) {
    return { patched: false, result: req };
  }

  if (
    !thinkingEnabled &&
    (!strictHistory ||
      !messages.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as Record<string, unknown>)['role'] === 'assistant' &&
          messageHasThinkingBlock(m as Record<string, unknown>)
      ))
  ) {
    return { patched: false, result: req };
  }

  const lastIdx = Math.max(0, messages.length - 1);
  const needsPatch = messages.some((m, idx) => {
    if (typeof m !== 'object' || m === null) return false;
    const msg = m as Record<string, unknown>;
    if (msg['role'] !== 'assistant') return false;

    const missingThinking = idx < lastIdx && !messageHasThinkingBlock(msg);
    const multiSigned = messageSignedThinkingCount(msg) > 1;
    return missingThinking || multiSigned;
  });

  if (!needsPatch) {
    return { patched: false, result: req };
  }

  // Deep clone to ensure immutability
  const cloned: Record<string, unknown> = JSON.parse(JSON.stringify(req));
  const msgs = cloned['messages'] as Record<string, unknown>[];

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg || msg['role'] !== 'assistant') continue;

    stripDuplicateSignatures(msg);

    // Skip trailing turn (prefill exemption)
    if (i === msgs.length - 1) {
      continue;
    }

    if (messageHasThinkingBlock(msg)) {
      continue;
    }

    // Prepend empty thinking block
    const newBlock = { type: 'thinking', thinking: '' };
    const content = msg['content'];
    if (typeof content === 'string') {
      msg['content'] = [newBlock, { type: 'text', text: content }];
    } else if (Array.isArray(content)) {
      msg['content'] = [newBlock, ...content];
    } else {
      msg['content'] = [newBlock];
    }
  }

  return { patched: true, result: cloned };
}

/**
 * DeepSeek-family upstreams reject assistant `tool_calls` carrying no `reasoning_content`;
 * an empty string satisfies the check.
 */
export function injectMissingReasoningContent(msgs: Record<string, unknown>[]): void {
  for (const msg of msgs) {
    if (msg['role'] !== 'assistant' || msg['reasoning_content'] !== undefined) {
      continue;
    }
    const toolCalls = msg['tool_calls'];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      msg['reasoning_content'] = '';
    }
  }
}
