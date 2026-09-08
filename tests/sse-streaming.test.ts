import { describe, it, expect } from 'vitest';
import {
  SseParser,
  formatSseString,
  openAiStreamToAnthropic,
  anthropicStreamToOpenAi,
  geminiStreamToAnthropic,
  rewriteModelInStream,
  trackTokensInStream,
} from '../src/transform/streaming/index.js';

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function stringToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe('Streaming Engine', () => {
  describe('SSE Parser & Emitter', () => {
    it('parses standard SSE events and multiline data', () => {
      const parser = new SseParser();
      const raw = 'event: test\ndata: line 1\ndata: line 2\n\n:comment\ndata: standalone\n\n';
      const events = parser.push(raw);
      expect(events.length).toBe(2);
      expect(events[0]).toEqual({ event: 'test', data: 'line 1\nline 2' });
      expect(events[1]).toEqual({ event: undefined, data: 'standalone' });
    });

    it('handles chunks split across lines and byte boundaries', () => {
      const parser = new SseParser();
      expect(parser.push('event: m')).toEqual([]);
      expect(parser.push('sg\ndata: hello\n')).toEqual([]);
      const ev = parser.push('\n');
      expect(ev.length).toBe(1);
      expect(ev[0]).toEqual({ event: 'msg', data: 'hello' });
    });

    it('formats SSE strings correctly', () => {
      expect(formatSseString('ping', { ok: true })).toBe('event: ping\ndata: {"ok":true}\n\n');
      expect(formatSseString(undefined, 'raw text')).toBe('data: raw text\n\n');
    });
  });

  describe('OpenAI to Anthropic Stream Translator', () => {
    it('translates OpenAI chunks with reasoning and text into Anthropic SSE stream', async () => {
      const openAiSse =
        'data: {"id":"chatcmpl-1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"reasoning_content":"Thinking deeply..."}}]}\n\n' +
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"Hello world!"}}]}\n\n' +
        'data: {"id":"chatcmpl-1","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":25,"completion_tokens_details":{"reasoning_tokens":15}}}\n\n' +
        'data: [DONE]\n\n';

      const inStream = stringToStream(openAiSse);
      const outStream = openAiStreamToAnthropic(inStream, 'claude-3-5-sonnet');
      const outputText = await streamToString(outStream);

      expect(outputText).toContain('event: message_start');
      expect(outputText).toContain('"model":"claude-3-5-sonnet"');
      expect(outputText).toContain('event: content_block_start');
      expect(outputText).toContain('"type":"thinking"');
      expect(outputText).toContain('Thinking deeply...');
      expect(outputText).toContain('"type":"text"');
      expect(outputText).toContain('Hello world!');
      expect(outputText).toContain('event: message_delta');
      expect(outputText).toContain('"stop_reason":"end_turn"');
      expect(outputText).toContain('"input_tokens":10');
      expect(outputText).toContain('"output_tokens":25');
      expect(outputText).toContain('event: message_stop');
    });

    it('translates OpenAI tool call stream into Anthropic tool_use SSE', async () => {
      const openAiSse =
        'data: {"id":"chatcmpl-2","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"search","arguments":""}}]}}]}\n\n' +
        'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\": \\"test\\"}"}}]}}]}\n\n' +
        'data: {"id":"chatcmpl-2","choices":[{"index":0,"finish_reason":"tool_calls"}]}\n\n' +
        'data: [DONE]\n\n';

      const inStream = stringToStream(openAiSse);
      const outStream = openAiStreamToAnthropic(inStream);
      const outputText = await streamToString(outStream);

      expect(outputText).toContain('"type":"tool_use"');
      expect(outputText).toContain('"name":"search"');
      expect(outputText).toContain('"type":"input_json_delta"');
      expect(outputText).toContain('{\\"query\\": \\"test\\"}');
      expect(outputText).toContain('"stop_reason":"tool_use"');
    });
  });

  describe('Anthropic to OpenAI Stream Translator', () => {
    it('translates Anthropic SSE events into OpenAI Chat Completion chunks', async () => {
      const anthropicSse =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-3-5-sonnet","role":"assistant","usage":{"input_tokens":12}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';

      const inStream = stringToStream(anthropicSse);
      const outStream = anthropicStreamToOpenAi(inStream, 'chat_completions');
      const outputText = await streamToString(outStream);

      expect(outputText).toContain('chat.completion.chunk');
      expect(outputText).toContain('"role":"assistant"');
      expect(outputText).toContain('"content":"Hi there"');
      expect(outputText).toContain('"finish_reason":"stop"');
      expect(outputText).toContain('"prompt_tokens":12');
      expect(outputText).toContain('"completion_tokens":8');
      expect(outputText).toContain('data: [DONE]');
    });
  });

  describe('Gemini to Anthropic Stream Translator', () => {
    it('translates Gemini interaction SSE events into Anthropic SSE stream', async () => {
      const geminiSse =
        'event: interaction.created\ndata: {"event_type":"interaction.created","interaction":{"model":"gemini-2.5-pro"}}\n\n' +
        'event: step.start\ndata: {"event_type":"step.start","step":{"type":"model_output"}}\n\n' +
        'event: step.delta\ndata: {"event_type":"step.delta","delta":{"text":"Gemini streaming text"}}\n\n' +
        'event: step.stop\ndata: {"event_type":"step.stop"}\n\n' +
        'event: interaction.completed\ndata: {"event_type":"interaction.completed","usage":{"total_input_tokens":5,"total_output_tokens":10}}\n\n';

      const inStream = stringToStream(geminiSse);
      const outStream = geminiStreamToAnthropic(inStream);
      const outputText = await streamToString(outStream);

      expect(outputText).toContain('event: message_start');
      expect(outputText).toContain('"model":"gemini-2.5-pro"');
      expect(outputText).toContain('Gemini streaming text');
      expect(outputText).toContain('"input_tokens":5');
      expect(outputText).toContain('"output_tokens":10');
      expect(outputText).toContain('event: message_stop');
    });
  });

  describe('Stream Interceptors', () => {
    it('rewrites model name in the first message_start event without altering rest of stream', async () => {
      const sse =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"deepseek-r1"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n';

      const inStream = stringToStream(sse);
      const outStream = rewriteModelInStream(inStream, 'claude-3-7-sonnet');
      const outputText = await streamToString(outStream);

      expect(outputText).toContain('"model":"claude-3-7-sonnet"');
      expect(outputText).not.toContain('"model":"deepseek-r1"');
      expect(outputText).toContain('Hello');
    });

    it('tracks token usage from stream completion callback', async () => {
      const sse =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":15}}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":35}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n';

      let capturedUsage: { inputTokens: number; outputTokens: number } | null = null;
      const inStream = stringToStream(sse);
      const outStream = trackTokensInStream(inStream, (u) => {
        capturedUsage = u;
      });

      await streamToString(outStream);

      expect(capturedUsage).toEqual({
        inputTokens: 15,
        outputTokens: 35,
      });
    });
  });
});
