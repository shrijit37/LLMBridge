import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startGateway, type GatewayInstance } from '../src/index.js';
import {
  createDefaultConfig,
  createDefaultProvider,
  saveConfig,
} from '../src/config/index.js';

describe('End-to-End Integration Tests', () => {
  let tmpDir: string;
  let configPath: string;
  let dbPath: string;
  let mockServer: http.Server;
  let gatewayHandle: GatewayInstance;

  const MOCK_PORT = 19850;
  const GATEWAY_PORT = 19851;
  const PINNED_PORT = 19852;

  let mockCallCounts = {
    primary: 0,
    fallback: 0,
    pinned: 0,
  };

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-e2e-'));
    configPath = path.join(tmpDir, 'config.json');
    dbPath = path.join(tmpDir, 'gateway.db');

    // 1. Mock Upstream HTTP Server
    const { promise: mockReady, resolve: resolveMockReady } = Promise.withResolvers<void>();
    mockServer = http.createServer((req, res) => {
      const auth = req.headers['authorization'] || '';
      const mockBehavior = req.headers['x-mock-behavior'];

      if (auth.includes('sk-mock-primary')) {
        mockCallCounts.primary++;
      } else if (auth.includes('sk-mock-fallback')) {
        mockCallCounts.fallback++;
      } else if (auth.includes('sk-mock-pinned')) {
        mockCallCounts.pinned++;
      }

      // Simulate 500 on primary or 400 client error
      if (mockBehavior === '500-primary' && auth.includes('sk-mock-primary')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal Server Error' } }));
        return;
      }

      if (mockBehavior === '400') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid model requested' } }));
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // ignore
        }

        const isStream = Boolean(parsed['stream']);

        if (isStream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              model: 'gpt-4o',
              choices: [{ index: 0, delta: { content: 'Pong stream' } }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              choices: [{ index: 0, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 8 },
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: 1700000000,
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Pong buffered' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 15,
              completion_tokens: 10,
              total_tokens: 25,
            },
          })
        );
      });
    });

    mockServer.listen(MOCK_PORT, '127.0.0.1', () => {
      resolveMockReady();
    });
    await mockReady;

    // 2. Setup Configuration
    const config = createDefaultConfig();
    config.current = 'mock-primary';
    config.listen = `127.0.0.1:${GATEWAY_PORT}`;

    config.providers['mock-primary'] = {
      ...createDefaultProvider('p-primary'),
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'sk-mock-primary',
      apiFormat: 'openai',
      apiVersion: 'chat_completions',
      routes: [{ id: 'r1', pattern: 'claude-3-7-*', target: 'gpt-4o', enabled: true }],
      enabled: true,
      fallback: false,
    };

    config.providers['mock-fallback'] = {
      ...createDefaultProvider('p-fallback'),
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'sk-mock-fallback',
      apiFormat: 'openai',
      apiVersion: 'chat_completions',
      routes: [{ id: 'r2', pattern: '*', target: 'gpt-4o', enabled: true }],
      enabled: true,
      fallback: true,
    };

    config.providers['mock-pinned'] = {
      ...createDefaultProvider('p-pinned'),
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      apiKey: 'sk-mock-pinned',
      apiFormat: 'openai',
      apiVersion: 'chat_completions',
      port: PINNED_PORT,
      enabled: true,
      fallback: false,
    };

    saveConfig(config, configPath);

    // 3. Launch Gateway
    gatewayHandle = await startGateway({
      configPath,
      port: GATEWAY_PORT,
      dbPath,
    });
  });

  afterAll(() => {
    gatewayHandle.close();
    mockServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Anthropic Ingress -> OpenAI Upstream (Buffered)', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json['type']).toBe('message');
    expect(json['role']).toBe('assistant');
    expect(json['model']).toBe('claude-3-7-sonnet');
    const content = json['content'] as Record<string, unknown>[];
    expect(content[0]?.['text']).toBe('Pong buffered');
    expect(json['usage']).toEqual({
      input_tokens: 15,
      output_tokens: 10,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it('2. Anthropic Ingress -> OpenAI Upstream (Streaming)', async () => {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"model":"claude-3-7-sonnet"');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('event: message_stop');

    // Verify token tracking in database
    const logs = gatewayHandle.db.getRequestLogs(10);
    expect(logs.length).toBeGreaterThan(0);
    const lastStreamLog = logs.find((l) => l.is_stream === 1);
    expect(lastStreamLog).toBeDefined();
    expect(lastStreamLog?.input_tokens).toBe(12);
    expect(lastStreamLog?.output_tokens).toBe(8);
  });

  it('3. Fallback Rotation on Transient Failure (500)', async () => {
    const priorFallbackCalls = mockCallCounts.fallback;

    // Send request with behavior header that makes primary fail with 500
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-behavior': '500-primary',
        'x-api-key': 'test-key',
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }),
    });

    // Gateway cycled past mock-primary (which returned 500) and succeeded on mock-fallback!
    expect(res.status).toBe(200);
    expect(mockCallCounts.fallback).toBeGreaterThan(priorFallbackCalls);

    // Verify Provider 1 failure was recorded in SQLite database
    const stats = gatewayHandle.db.getProviderStats();
    const primaryStats = stats.find((s) => s.provider_id === 'p-primary');
    expect(primaryStats).toBeDefined();
    expect(primaryStats?.failures).toBeGreaterThan(0);
  });

  it('4. Client Error Non-Cycling (400 Bad Request)', async () => {
    const priorFallbackCalls = mockCallCounts.fallback;

    // Send request with behavior header that triggers 400 client error
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mock-behavior': '400',
        'x-api-key': 'test-key',
      },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }),
    });

    // 400 Bad Request returned immediately to client without cycling
    expect(res.status).toBe(400);
    const errJson = (await res.json()) as Record<string, unknown>;
    expect(errJson['error']).toBeDefined();

    // Verify fallback provider was NOT called
    expect(mockCallCounts.fallback).toBe(priorFallbackCalls);
  });

  it('5. Pinned Port Routing', async () => {
    const priorPinnedCalls = mockCallCounts.pinned;

    // Direct request to dedicated pinned port 19852
    const res = await fetch(`http://127.0.0.1:${PINNED_PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        model: 'claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 10,
      }),
    });

    expect(res.status).toBe(200);
    expect(mockCallCounts.pinned).toBeGreaterThan(priorPinnedCalls);
  });
});
