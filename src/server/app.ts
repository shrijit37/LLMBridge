import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { ConfigWatcher } from '../config/watcher.js';
import type { GatewayDatabase } from '../storage/db.js';
import type { RingBuffer } from '../storage/ring-buffer.js';
import type { CircuitBreaker } from '../proxy/circuit-breaker.js';
import { resolveProviderPool } from '../proxy/router.js';
import { executeProviderLoop, type ClientWireFormat } from '../proxy/executor.js';
import { anthropicToCanonicalRequest } from '../transform/anthropic/index.js';
import { openaiChatToCanonicalRequest } from '../transform/openai-chat/index.js';
import { openaiResponsesToCanonicalRequest } from '../transform/openai-responses/index.js';

export interface AppContext {
  configWatcher: ConfigWatcher;
  db: GatewayDatabase;
  ringBuffer: RingBuffer<Record<string, unknown>>;
  circuitBreaker: CircuitBreaker;
  pinnedProviderName?: string;
}

export function createGatewayApp(ctx: AppContext): Hono {
  const app = new Hono();

  // CORS middleware allowing localhost, 127.0.0.1, and web clients
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return '*';
        if (
          origin.includes('localhost') ||
          origin.includes('127.0.0.1') ||
          origin.includes('[::1]')
        ) {
          return origin;
        }
        return '*';
      },
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'x-api-key',
        'anthropic-version',
        'x-goog-api-key',
      ],
    })
  );

  // Health check
  app.get('/health', (c) => {
    const config = ctx.configWatcher.config;
    return c.json({
      status: 'ok',
      active_provider: config.current,
      providers_count: Object.keys(config.providers).length,
      version: '0.1.0',
      uptime: Math.floor(process.uptime()),
    });
  });

  // Aggregated Stats
  app.get('/stats', (c) => {
    const stats = ctx.db.getProviderStats();
    return c.json({ data: stats });
  });

  // Recent request logs
  app.get('/api/logs', (c) => {
    const limitParam = c.req.query('limit');
    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const logs = ctx.ringBuffer.getRecent(Number.isNaN(limit) ? 100 : limit);
    return c.json({ logs });
  });

  // Model catalog
  app.get('/v1/models', (c) => {
    const config = ctx.configWatcher.config;
    const authHeader = c.req.header('authorization') || '';
    const isOpenAiAuth = authHeader.toLowerCase().startsWith('bearer ');

    const modelsSet = new Set<string>();
    for (const p of Object.values(config.providers)) {
      if (p.testModel) modelsSet.add(p.testModel);
      for (const m of Object.keys(p.modelMap)) {
        modelsSet.add(m);
      }
      for (const r of p.routes) {
        if (r.target) modelsSet.add(r.target);
      }
    }

    if (modelsSet.size === 0) {
      modelsSet.add('claude-3-5-sonnet-20241022');
      modelsSet.add('claude-3-7-sonnet');
      modelsSet.add('gpt-4o');
    }

    const modelList = Array.from(modelsSet);

    if (isOpenAiAuth) {
      return c.json({
        object: 'list',
        data: modelList.map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'gateway',
        })),
      });
    }

    return c.json({
      data: modelList.map((id) => ({
        type: 'model',
        id,
        display_name: id,
        created_at: '1970-01-01T00:00:00Z',
      })),
      has_more: false,
      first_id: modelList[0] || '',
      last_id: modelList[modelList.length - 1] || '',
    });
  });

  async function handleDispatch(
    c: Context,
    clientFormat: ClientWireFormat
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return new Response(JSON.stringify({ error: { message: 'Invalid JSON body' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    let canonical;
    if (clientFormat === 'anthropic') {
      canonical = anthropicToCanonicalRequest(body);
    } else if (clientFormat === 'openai_chat') {
      canonical = openaiChatToCanonicalRequest(body);
    } else {
      canonical = openaiResponsesToCanonicalRequest(body);
    }

    const config = ctx.configWatcher.config;
    let poolRes;
    try {
      poolRes = resolveProviderPool(config, ctx.pinnedProviderName);
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: { message: err instanceof Error ? err.message : String(err) },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      );
    }

    const clientHeaders = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (typeof v === 'string') {
        clientHeaders.set(k, v);
      }
    }

    return executeProviderLoop({
      pool: poolRes.pool,
      doCycle: poolRes.doCycle,
      canonicalRequest: canonical,
      clientFormat,
      rawClientBody: body,
      clientHeaders,
      circuitBreaker: ctx.circuitBreaker,
      onRecordStats: (providerId, providerName, delta) => {
        ctx.db.recordStats(providerId, providerName, canonical.model, delta);
      },
      onLogRequest: (entry) => {
        const logRecord = {
          timestamp_ms: Date.now(),
          provider_name: entry.providerName,
          model: entry.model,
          status: entry.status,
          latency_ms: entry.latencyMs,
          input_tokens: entry.inputTokens,
          output_tokens: entry.outputTokens,
          is_stream: entry.isStream ? 1 : 0,
          error: entry.error,
          request_body: entry.requestBody,
          response_body: entry.responseBody,
        };
        ctx.db.recordRequestLog(logRecord, config.requestLogLimit);
        ctx.ringBuffer.push(logRecord);
      },
    });
  }

  // Anthropic Ingress
  app.post('/v1/messages', (c) => handleDispatch(c, 'anthropic'));

  // OpenAI Chat Ingress
  app.post('/v1/chat/completions', (c) => handleDispatch(c, 'openai_chat'));

  // OpenAI Responses Ingress
  app.post('/v1/responses', (c) => handleDispatch(c, 'openai_responses'));

  return app;
}
