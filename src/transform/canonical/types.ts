export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export type CanonicalToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
  | { type: 'none' };

export type CanonicalContentBlock =
  | { type: 'text'; text: string; extra?: Record<string, unknown> }
  | { type: 'thinking'; thinking: string; signature?: string; extra?: Record<string, unknown> }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; extra?: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean; extra?: Record<string, unknown> }
  | { type: 'image'; source: Record<string, unknown>; extra?: Record<string, unknown> }
  | { type: 'custom'; raw: Record<string, unknown> };

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'system';
  content: CanonicalContentBlock[];
  extra?: Record<string, unknown>;
}

export interface CanonicalThinking {
  type: 'enabled' | 'adaptive';
  budgetTokens?: number;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  stream: boolean;
  thinking?: CanonicalThinking;
  extra: Record<string, unknown>;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thoughtTokens: number;
}

export function createEmptyUsage(): CanonicalUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thoughtTokens: 0,
  };
}

export function calculateTotalTokens(usage: CanonicalUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens +
    usage.thoughtTokens
  );
}

export interface CanonicalResponse {
  id: string;
  model: string;
  content: CanonicalContentBlock[];
  stopReason?: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string;
  usage: CanonicalUsage;
  extra: Record<string, unknown>;
}
