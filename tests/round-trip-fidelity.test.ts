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
  canonicalToGeminiResponse,
} from '../src/transform/index.js';

describe('Round-Trip Fidelity Suite (Checklist Section 28)', () => {
  describe('Claude → IR → Claude', () => {
    it('preserves request structure, tools, thinking, and message blocks', () => {
      const original = {
        model: 'claude-3-7-sonnet',
        system: 'You are an expert systems programmer.',
        messages: [
          { role: 'user', content: 'Inspect the kernel' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Checking uname...', signature: 'sig_abc123' },
              { type: 'tool_use', id: 'call_uname_1', name: 'sh', input: { cmd: 'uname -a' } },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_uname_1',
                content: 'Linux arch 6.12.0',
                is_error: false,
              },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0.2,
        top_p: 0.95,
        stop_sequences: ['\n\nHuman:'],
        tools: [
          {
            name: 'sh',
            description: 'Run shell command',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
            },
          },
        ],
        tool_choice: { type: 'auto' },
        thinking: { type: 'enabled', budget_tokens: 2000 },
        stream: true,
      };

      const ir = anthropicToCanonicalRequest(original);
      const back = canonicalToAnthropicRequest(ir);

      expect(back['model']).toBe(original.model);
      expect(back['system']).toBe(original.system);
      expect(back['max_tokens']).toBe(original.max_tokens);
      expect(back['temperature']).toBe(original.temperature);
      expect(back['top_p']).toBe(original.top_p);
      expect(back['stop_sequences']).toEqual(original.stop_sequences);
      expect(back['stream']).toBe(original.stream);
      expect(back['thinking']).toEqual(original.thinking);
      expect(back['tool_choice']).toEqual(original.tool_choice);
      expect(back['tools']).toEqual(original.tools);

      const msgs = back['messages'] as Array<{ role: string; content: unknown[] }>;
      expect(msgs.length).toBe(3);
      expect(msgs[0]?.role).toBe('user');
      expect(msgs[0]?.content).toEqual([{ type: 'text', text: 'Inspect the kernel' }]);
      expect(msgs[1]?.role).toBe('assistant');
      expect(msgs[1]?.content[0]).toEqual({
        type: 'thinking',
        thinking: 'Checking uname...',
        signature: 'sig_abc123',
      });
      expect(msgs[1]?.content[1]).toEqual({
        type: 'tool_use',
        id: 'call_uname_1',
        name: 'sh',
        input: { cmd: 'uname -a' },
      });
      expect(msgs[2]?.role).toBe('user');
      expect(msgs[2]?.content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'call_uname_1',
        content: 'Linux arch 6.12.0',
      });
    });

    it('preserves response content, thinking, and usage tokens', () => {
      const original = {
        id: 'msg_test_roundtrip',
        type: 'message',
        role: 'assistant',
        model: 'claude-3-7-sonnet',
        content: [
          { type: 'thinking', thinking: 'Analyzing trace...' },
          { type: 'text', text: 'Everything looks healthy.' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 150,
          output_tokens: 80,
          cache_read_input_tokens: 45,
          cache_creation_input_tokens: 12,
        },
      };

      const ir = anthropicToCanonicalResponse(original);
      const back = canonicalToAnthropicResponse(ir);

      expect(back['id']).toBe(original.id);
      expect(back['model']).toBe(original.model);
      expect(back['content']).toEqual(original.content);
      expect(back['stop_reason']).toBe(original.stop_reason);
      expect(back['usage']).toEqual(original.usage);
    });
  });

  describe('OpenAI Chat → IR → OpenAI Chat', () => {
    it('preserves chat messages, tool calls, and parameters', () => {
      const original = {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are a test assistant.' },
          { role: 'user', content: 'Calculate 15 * 4' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'Let me do the multiplication...',
            tool_calls: [
              {
                id: 'call_calc_42',
                type: 'function',
                function: {
                  name: 'calculator',
                  arguments: JSON.stringify({ a: 15, b: 4, op: '*' }),
                },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'call_calc_42',
            content: '60',
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Math operations',
              parameters: {
                type: 'object',
                properties: {
                  a: { type: 'number' },
                  b: { type: 'number' },
                  op: { type: 'string' },
                },
                required: ['a', 'b', 'op'],
              },
            },
          },
        ],
        tool_choice: 'auto',
        stream: false,
      };

      const ir = openaiChatToCanonicalRequest(original);
      const back = canonicalToOpenAiChatRequest(ir);

      expect(back['model']).toBe('gpt-4o');
      const msgs = back['messages'] as Array<Record<string, unknown>>;
      expect(msgs.length).toBe(4);
      expect(msgs[0]).toEqual({ role: 'system', content: 'You are a test assistant.' });
      expect(msgs[1]).toEqual({ role: 'user', content: 'Calculate 15 * 4' });
      expect(msgs[2]?.['role']).toBe('assistant');
      expect(msgs[2]?.['reasoning_content']).toBe('Let me do the multiplication...');
      const toolCalls = msgs[2]?.['tool_calls'] as Array<Record<string, unknown>>;
      expect(toolCalls[0]?.['id']).toBe('call_calc_42');
      expect((toolCalls[0]?.['function'] as Record<string, unknown>)?.['name']).toBe('calculator');
      expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_calc_42', content: '60' });
    });

    it('preserves response reasoning content and token accounting', () => {
      const original = {
        id: 'chatcmpl-rt-test',
        object: 'chat.completion',
        created: 1710000000,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              reasoning_content: 'Thought trace here',
              content: 'Final answer',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 25 },
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      };

      const ir = openaiChatToCanonicalResponse(original);
      const back = canonicalToOpenAiChatResponse(ir);

      expect(back['id']).toBe(original.id);
      const choices = back['choices'] as Array<Record<string, unknown>>;
      const msg = choices[0]?.['message'] as Record<string, unknown>;
      expect(msg['content']).toBe('Final answer');
      expect(msg['reasoning_content']).toBe('Thought trace here');
    });
  });

  describe('OpenAI Responses → IR → OpenAI Responses', () => {
    it('preserves instructions, input messages, and output items', () => {
      const original = {
        model: 'gpt-4o',
        instructions: 'Follow user instructions strictly.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello Responses API' }],
          },
        ],
        stream: false,
      };

      const ir = openaiResponsesToCanonicalRequest(original);
      const back = canonicalToOpenAiResponsesRequest(ir);

      expect(back['model']).toBe('gpt-4o');
      expect(back['instructions']).toBe('Follow user instructions strictly.');
      expect(back['input']).toEqual(original.input);
    });

    it('preserves responses output items and reasoning summary', () => {
      const original = {
        id: 'resp_test_rt',
        object: 'response',
        created: 1710000000,
        model: 'gpt-4o',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Thinking step' }],
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello from Responses' }],
          },
        ],
        usage: {
          input_tokens: 30,
          output_tokens: 40,
        },
      };

      const ir = openaiResponsesToCanonicalResponse(original);
      const back = canonicalToOpenAiResponsesResponse(ir);

      expect(back['id']).toBe(original.id);
      expect(back['output']).toEqual(original.output);
    });
  });

  describe('Gemini → IR → Gemini', () => {
    it('preserves system instructions and input interactions', () => {
      const original = {
        model: 'gemini-2.5-pro',
        system_instruction: 'You are Gemini.',
        input: [
          {
            type: 'user_input',
            content: [{ type: 'text', text: 'Hello Gemini model' }],
          },
        ],
        store: false,
      };

      const ir = geminiToCanonicalRequest(original);
      const back = canonicalToGeminiRequest(ir);

      expect(back['model']).toBe('gemini-2.5-pro');
      expect(back['system_instruction']).toBe('You are Gemini.');
      expect(back['store']).toBe(false);
      expect(back['input']).toEqual(original.input);
    });

    it('preserves steps, thoughts with signature, and output text', () => {
      const original = {
        id: 'gemini_rt_test',
        model: 'gemini-2.5-pro',
        steps: [
          {
            type: 'thought',
            text: 'Let me reason carefully',
            signature: 'sig_gemini_xyz',
          },
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'Gemini completed answer' }],
          },
        ],
        usage: {
          total_input_tokens: 50,
          total_output_tokens: 60,
          total_thought_tokens: 25,
          total_cached_tokens: 10,
          total_tokens: 145,
        },
      };

      const ir = geminiToCanonicalResponse(original);
      const back = canonicalToGeminiResponse(ir);

      expect(back['id']).toBe(original.id);
      expect(back['steps']).toEqual(original.steps);
      expect(back['usage']).toEqual(original.usage);
    });
  });

  describe('Cross-Format Fidelity: Claude → IR → OpenAI Chat → IR', () => {
    it('maintains semantic equivalence across representations', () => {
      const claudeReq = {
        model: 'claude-3-7-sonnet',
        system: 'Act as a calculator.',
        messages: [
          { role: 'user', content: 'What is 10 + 20?' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Calculating 10 + 20' },
              { type: 'text', text: 'It is 30.' },
            ],
          },
        ],
      };

      const ir1 = anthropicToCanonicalRequest(claudeReq);
      const openAiChat = canonicalToOpenAiChatRequest(ir1);
      const ir2 = openaiChatToCanonicalRequest(openAiChat);

      expect(ir2.system).toBe(ir1.system);
      expect(ir2.messages.length).toBe(ir1.messages.length);
      expect(ir2.messages[0]?.role).toBe(ir1.messages[0]?.role);
      const firstBlock = ir2.messages[0]?.content[0];
      expect(firstBlock?.type).toBe('text');
      if (firstBlock && firstBlock.type === 'text') {
        expect(firstBlock.text).toBe('What is 10 + 20?');
      }

      // Assistant message: thinking + text
      const asstBlocks = ir2.messages[1]?.content || [];
      expect(asstBlocks.some((b) => b.type === 'thinking' && b.thinking === 'Calculating 10 + 20')).toBe(true);
      expect(asstBlocks.some((b) => b.type === 'text' && b.text === 'It is 30.')).toBe(true);
    });
  });

  describe('Cross-Format Fidelity: OpenAI Chat → IR → Claude → IR', () => {
    it('maintains semantic equivalence across representations', () => {
      const openAiReq = {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Coding tutor system prompt' },
          { role: 'user', content: 'Write hello world in C' },
          {
            role: 'assistant',
            reasoning_content: 'C code generation thinking',
            content: '#include <stdio.h>\nint main() { printf("Hello\\n"); return 0; }',
          },
        ],
      };

      const ir1 = openaiChatToCanonicalRequest(openAiReq);
      const claudeReq = canonicalToAnthropicRequest(ir1);
      const ir2 = anthropicToCanonicalRequest(claudeReq);

      expect(ir2.system).toBe(ir1.system);
      expect(ir2.messages.length).toBe(ir1.messages.length);
      expect(ir2.messages[0]?.role).toBe('user');
      expect(ir2.messages[1]?.role).toBe('assistant');

      const asstBlocks = ir2.messages[1]?.content || [];
      expect(asstBlocks.some((b) => b.type === 'thinking' && b.thinking === 'C code generation thinking')).toBe(true);
      expect(asstBlocks.some((b) => b.type === 'text' && b.text.includes('#include <stdio.h>'))).toBe(true);
    });
  });
});
