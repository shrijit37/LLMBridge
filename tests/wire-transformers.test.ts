import { describe, it, expect } from 'vitest';
import {
  anthropicToCanonicalRequest,
  canonicalToAnthropicRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicResponse,
  openaiChatToCanonicalRequest,
  canonicalToOpenAiChatRequest,
  openaiChatToCanonicalResponse,
  canonicalToOpenAiChatResponse,
  openaiResponsesToCanonicalRequest,
  canonicalToOpenAiResponsesRequest,
  openaiResponsesToCanonicalResponse,
  canonicalToOpenAiResponsesResponse,
  geminiToCanonicalRequest,
  canonicalToGeminiRequest,
  geminiToCanonicalResponse,
  patchThinkingHistory,
  anthropicToOpenAiModels,
  openaiToAnthropicModels,
  geminiToAnthropicModels,
} from '../src/transform/index.js';

describe('Wire Transformers', () => {
  describe('Anthropic Transformer', () => {
    it('round-trips standard request with system and tools', () => {
      const anthropicReq = {
        model: 'claude-3-5-sonnet-20241022',
        system: 'You are a helpful coding assistant.',
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: 'It is 4.' },
          { role: 'user', content: [{ type: 'text', text: 'Thanks!' }] },
        ],
        max_tokens: 1024,
        temperature: 0.7,
        tools: [
          {
            name: 'calc',
            description: 'Calculator',
            input_schema: { type: 'object', properties: { expr: { type: 'string' } } },
          },
        ],
        tool_choice: { type: 'auto' },
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 2048 },
      };

      const canonical = anthropicToCanonicalRequest(anthropicReq);
      expect(canonical.model).toBe('claude-3-5-sonnet-20241022');
      expect(canonical.system).toBe('You are a helpful coding assistant.');
      expect(canonical.messages.length).toBe(3);
      expect(canonical.maxTokens).toBe(1024);
      expect(canonical.stream).toBe(true);
      expect(canonical.thinking?.budgetTokens).toBe(2048);

      const convertedBack = canonicalToAnthropicRequest(canonical);
      expect(convertedBack['model']).toBe('claude-3-5-sonnet-20241022');
      expect(convertedBack['system']).toBe('You are a helpful coding assistant.');
      expect(convertedBack['max_tokens']).toBe(1024);
      expect((convertedBack['messages'] as unknown[]).length).toBe(3);
      expect(convertedBack['stream']).toBe(true);
      expect(convertedBack['thinking']).toEqual({ type: 'enabled', budget_tokens: 2048 });
    });

    it('round-trips standard response with token usage', () => {
      const anthropicResp = {
        id: 'msg_12345',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-5-sonnet-20241022',
        content: [
          { type: 'thinking', thinking: 'Let me calculate...' },
          { type: 'text', text: 'The answer is 4.' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 20,
          output_tokens: 30,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 10,
        },
      };

      const canonical = anthropicToCanonicalResponse(anthropicResp);
      expect(canonical.id).toBe('msg_12345');
      expect(canonical.content.length).toBe(2);
      expect(canonical.usage.inputTokens).toBe(20);
      expect(canonical.usage.outputTokens).toBe(30);
      expect(canonical.usage.cacheReadTokens).toBe(5);

      const back = canonicalToAnthropicResponse(canonical);
      expect(back['id']).toBe('msg_12345');
      expect(back['content']).toEqual(anthropicResp.content);
      expect(back['usage']).toEqual(anthropicResp.usage);
    });
  });

  describe('OpenAI Chat Transformer', () => {
    it('translates Anthropic request to OpenAI Chat format', () => {
      const canonical = anthropicToCanonicalRequest({
        model: 'claude-3-5-sonnet-20241022',
        system: 'System instructions',
        messages: [
          { role: 'user', content: 'Run tool' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I need to run the tool' },
              {
                type: 'tool_use',
                id: 'call_99',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_99',
                content: '{"temp":22}',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 1000 },
      });

      const openAiChat = canonicalToOpenAiChatRequest(canonical);
      expect(openAiChat['stream_options']).toEqual({ include_usage: true });
      expect(openAiChat['reasoning_effort']).toBe('high');
      expect(openAiChat['max_completion_tokens']).toBe(1000);

      const msgs = openAiChat['messages'] as Record<string, unknown>[];
      expect(msgs[0]).toEqual({ role: 'system', content: 'System instructions' });
      expect(msgs[1]).toEqual({ role: 'user', content: 'Run tool' });

      // Assistant with thinking + tool_call
      expect(msgs[2]?.['role']).toBe('assistant');
      expect(msgs[2]?.['reasoning_content']).toBe('I need to run the tool');
      const toolCalls = msgs[2]?.['tool_calls'] as Record<string, unknown>[];
      expect(toolCalls[0]?.['id']).toBe('call_99');
      expect((toolCalls[0]?.['function'] as Record<string, unknown>)?.['name']).toBe('get_weather');

      // Tool result
      expect(msgs[3]).toEqual({
        role: 'tool',
        tool_call_id: 'call_99',
        content: '{"temp":22}',
      });
    });

    it('translates OpenAI Chat response with reasoning_content to Anthropic format', () => {
      const openAiResp = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1700000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: 'Step 1: thinking...',
              content: 'Final response text',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 10 },
          completion_tokens_details: { reasoning_tokens: 15 },
        },
      };

      const canonical = openaiChatToCanonicalResponse(openAiResp);
      expect(canonical.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Step 1: thinking...',
      });
      expect(canonical.content[1]).toEqual({
        type: 'text',
        text: 'Final response text',
      });
      expect(canonical.usage.inputTokens).toBe(40); // 50 - 10
      expect(canonical.usage.outputTokens).toBe(15); // 30 - 15
      expect(canonical.usage.cacheReadTokens).toBe(10);
      expect(canonical.usage.thoughtTokens).toBe(15);

      const anthropic = canonicalToAnthropicResponse(canonical);
      expect(anthropic['stop_reason']).toBe('end_turn');
      expect((anthropic['content'] as unknown[]).length).toBe(2);
      expect((anthropic['usage'] as Record<string, unknown>)['input_tokens']).toBe(40);
      expect((anthropic['usage'] as Record<string, unknown>)['output_tokens']).toBe(30); // output + thought
    });
  });

  describe('OpenAI Responses Transformer', () => {
    it('translates Anthropic request to OpenAI Responses format', () => {
      const canonical = anthropicToCanonicalRequest({
        model: 'claude-3-7-sonnet',
        system: 'Instruction prompt',
        messages: [{ role: 'user', content: 'Ping' }],
        stream: true,
      });

      const responsesReq = canonicalToOpenAiResponsesRequest(canonical);
      expect(responsesReq['instructions']).toBe('Instruction prompt');
      expect(responsesReq['input']).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Ping' }],
        },
      ]);
    });

    it('translates OpenAI Responses response to Anthropic format', () => {
      const rawResponsesResp = {
        id: 'resp_456',
        object: 'response',
        created: 1700000000,
        model: 'gpt-4o',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Thought process' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Pong' }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 25,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 15 },
        },
      };

      const canonical = openaiResponsesToCanonicalResponse(rawResponsesResp);
      expect(canonical.content[0]).toEqual({ type: 'thinking', thinking: 'Thought process' });
      expect(canonical.content[1]).toEqual({ type: 'text', text: 'Pong' });

      const anthropic = canonicalToAnthropicResponse(canonical);
      expect(anthropic['content']).toEqual([
        { type: 'thinking', thinking: 'Thought process' },
        { type: 'text', text: 'Pong' },
      ]);
    });
  });

  describe('Gemini Transformer', () => {
    it('translates Anthropic request to Gemini stateless interactions format', () => {
      const canonical = anthropicToCanonicalRequest({
        model: 'gemini-2.5-pro',
        system: 'Gemini system prompt',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      const geminiReq = canonicalToGeminiRequest(canonical);
      expect(geminiReq['store']).toBe(false);
      expect(geminiReq['system_instruction']).toBe('Gemini system prompt');
      const input = geminiReq['input'] as Record<string, unknown>[];
      expect(input[0]?.['type']).toBe('user_input');
    });

    it('translates Gemini response to Anthropic format', () => {
      const geminiResp = {
        id: 'gemini_789',
        model: 'gemini-2.5-pro',
        steps: [
          {
            type: 'thought',
            text: 'Deep thinking',
            signature: 'sig_abc',
          },
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'Hello from Gemini!' }],
          },
        ],
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 20,
          total_thought_tokens: 8,
          total_cached_tokens: 2,
        },
      };

      const canonical = geminiToCanonicalResponse(geminiResp);
      expect(canonical.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Deep thinking',
        signature: 'sig_abc',
      });
      expect(canonical.content[1]).toEqual({
        type: 'text',
        text: 'Hello from Gemini!',
      });
      expect(canonical.usage.inputTokens).toBe(12);
      expect(canonical.usage.thoughtTokens).toBe(8);
    });
  });

  describe('Thinking History Rectifier', () => {
    it('injects empty thinking block into intermediate assistant turns', () => {
      const req = {
        model: 'claude-3-7-sonnet',
        thinking: { type: 'enabled', budget_tokens: 1000 },
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: 'Turn 1 response' }, // missing thinking
          { role: 'user', content: 'Turn 2' },
        ],
      };

      const { patched, result } = patchThinkingHistory(req, true);
      expect(patched).toBe(true);

      const msgs = result['messages'] as Record<string, unknown>[];
      const assistantContent = msgs[1]?.['content'] as Record<string, unknown>[];
      expect(assistantContent[0]).toEqual({ type: 'thinking', thinking: '' });
      expect(assistantContent[1]).toEqual({ type: 'text', text: 'Turn 1 response' });
    });
    it('does not patch trailing assistant prefill turn', () => {
      const req = {
        model: 'claude-3-7-sonnet',
        thinking: { type: 'enabled', budget_tokens: 1000 },
        messages: [
          { role: 'user', content: 'Turn 1' },
          { role: 'assistant', content: '{"status":' }, // trailing prefill
        ],
      };

      const { patched } = patchThinkingHistory(req, true);
      expect(patched).toBe(false);
    });

    it('translates OpenAI models to Anthropic format', () => {
      const openAi = {
        data: [{ id: 'gpt-4o' }, { id: 'o3-mini' }],
      };
      const anthropic = openaiToAnthropicModels(openAi);
      const data = anthropic['data'] as Record<string, unknown>[];
      expect(data.length).toBe(2);
      expect(data[0]?.['id']).toBe('gpt-4o');
      expect(data[0]?.['type']).toBe('model');
      expect(anthropic['first_id']).toBe('gpt-4o');
      expect(anthropic['last_id']).toBe('o3-mini');
    });

    it('round-trips Canonical to OpenAI Chat response and back', () => {
      const canonical = {
        id: 'can_resp_1',
        model: 'gpt-4o',
        content: [{ type: 'text' as const, text: 'Hello world' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thoughtTokens: 0,
        },
        extra: {},
      };
      const chatResp = canonicalToOpenAiChatResponse(canonical);
      expect(chatResp['object']).toBe('chat.completion');
      const parsedCanonical = openaiChatToCanonicalResponse(chatResp);
      expect(parsedCanonical.content[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('round-trips Canonical to OpenAI Responses response and back', () => {
      const canonical = {
        id: 'can_resp_2',
        model: 'gpt-4o',
        content: [{ type: 'text' as const, text: 'Responses hello' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          thoughtTokens: 0,
        },
        extra: {},
      };
      const responsesResp = canonicalToOpenAiResponsesResponse(canonical);
      expect(responsesResp['object']).toBe('response');
      const parsedCanonical = openaiResponsesToCanonicalResponse(responsesResp);
      expect(parsedCanonical.content[0]).toEqual({ type: 'text', text: 'Responses hello' });
    });

    it('parses Gemini request to Canonical AST', () => {
      const geminiReq = {
        model: 'gemini-2.5-pro',
        system_instruction: 'Be concise',
        input: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'Hello Gemini' }],
          },
        ],
      };
      const canonical = geminiToCanonicalRequest(geminiReq);
      expect(canonical.model).toBe('gemini-2.5-pro');
      expect(canonical.system).toBe('Be concise');
      expect(canonical.messages[0]?.content[0]).toEqual({
        type: 'text',
        text: 'Hello Gemini',
      });
    });

    it('parses OpenAI Responses request to Canonical AST', () => {
      const respReq = {
        model: 'gpt-4o',
        instructions: 'Responses instructions',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Ping' }],
          },
        ],
      };
      const canonical = openaiResponsesToCanonicalRequest(respReq);
      expect(canonical.model).toBe('gpt-4o');
      expect(canonical.system).toBe('Responses instructions');
      expect(canonical.messages[0]?.content[0]).toEqual({
        type: 'text',
        text: 'Ping',
      });
    });

  describe('Model Catalog Transformer', () => {
    it('translates Anthropic models to OpenAI list format', () => {
      const anthropic = {
        data: [{ id: 'claude-3-5-sonnet' }, { id: 'claude-3-7-sonnet' }],
      };
      const openAi = anthropicToOpenAiModels(anthropic);
      expect(openAi['object']).toBe('list');
      const data = openAi['data'] as Record<string, unknown>[];
      expect(data.length).toBe(2);
      expect(data[0]?.['id']).toBe('claude-3-5-sonnet');
      expect(data[0]?.['owned_by']).toBe('anthropic');
    });

    it('translates Gemini models stripping models/ prefix', () => {
      const gemini = {
        models: [
          { name: 'models/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro' },
          { name: 'models/gemini-2.5-flash', display_name: 'Gemini 2.5 Flash' },
        ],
      };
      const anthropic = geminiToAnthropicModels(gemini);
      const data = anthropic['data'] as Record<string, unknown>[];
      expect(data.length).toBe(2);
      expect(data[0]?.['id']).toBe('gemini-2.5-pro');
      expect(data[0]?.['display_name']).toBe('Gemini 2.5 Pro');
    });
  });
});
});
