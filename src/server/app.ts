import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ConfigWatcher } from '../config/watcher.js';
import type { GatewayDatabase } from '../storage/db.js';
import type { RingBuffer } from '../storage/ring-buffer.js';
import type { CircuitBreaker } from '../proxy/circuit-breaker.js';
import type { LaneManager } from '../proxy/lane-manager.js';
import { resolveProviderPool } from '../proxy/router.js';
import { executeProviderLoop, type ClientWireFormat } from '../proxy/executor.js';
import { anthropicToCanonicalRequest } from '../transform/anthropic/index.js';
import { openaiChatToCanonicalRequest } from '../transform/openai-chat/index.js';
import { openaiResponsesToCanonicalRequest } from '../transform/openai-responses/index.js';
import { gatewayEvents, EVENTS } from '../events.js';
import { createSSEResponse } from './sse.js';
import { saveConfig } from '../config/loader.js';
import { rawJsonToAppConfig, appConfigToRawJson } from '../config/types.js';
import type { AppConfig } from '../config/types.js';

/**
 * Deep-merge a raw JSON patch (from the dashboard) over the current config's
 * raw JSON representation. Arrays are replaced wholesale; objects merge
 * shallow-deep recursively. Returns the patched AppConfig.
 */
function mergeConfigPatch(base: AppConfig, patch: Record<string, unknown>): AppConfig {
  const rawBase = appConfigToRawJson(base);
  const merged = deepMergeRecord(rawBase as unknown as Record<string, unknown>, patch);
  return rawJsonToAppConfig(merged);
}

/** Recursive deep merge: primitives/arrays replaced, plain objects merged. */
function deepMergeRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMergeRecord(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Structural sanity for a config patch: must be an object, and any providers
 *  value must be an object (not an array). */
function validateConfigPatch(patch: unknown): void {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Config patch must be a JSON object');
  }
  const p = patch as Record<string, unknown>;
  if (p.providers !== undefined && (typeof p.providers !== 'object' || Array.isArray(p.providers))) {
    throw new Error('providers must be an object');
  }
}

/**
 * CSRF guard for the control plane. Mutation endpoints accept requests with no
 * Origin header (curl, the Vite dev proxy same-origin) or a localhost origin.
 * Non-localhost origins (a random website POSTing cross-origin) are rejected.
 */
function isTrustedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const lower = origin.toLowerCase();
  return (
    lower.includes('localhost') ||
    lower.includes('127.0.0.1') ||
    lower.includes('[::1]') ||
    lower.startsWith('file://')
  );
}

export interface AppContext {
  configWatcher: ConfigWatcher;
  db: GatewayDatabase;
  ringBuffer: RingBuffer<Record<string, unknown>>;
  circuitBreaker: CircuitBreaker;
  pinnedProviderName?: string;
  laneManager?: LaneManager;
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

  // Uniform fleet health contract (standards/platform.md#health):
  // exactly GET /health -> { status, service, version, checks }.
  // The SQLite store is the critical dependency (down => 503); having no
  // providers configured means the gateway is up but cannot serve
  // traffic (degraded => 200). No /ready alias.
  app.get('/health', (c) => {
    const config = ctx.configWatcher.config;
    const providers = Object.keys(config.providers ?? {});

    let database: 'up' | 'down' = 'up';
    try {
      // Cheapest real query: force the connection open and read a row.
      ctx.db.getProviderStats();
    } catch {
      database = 'down';
    }

    const providersCheck: 'up' | 'down' =
      providers.length > 0 && config.current ? 'up' : 'down';
    const status =
      database === 'down' ? 'down' : providersCheck === 'down' ? 'degraded' : 'ok';

    return c.json(
      {
        status,
        service: 'llmbridge-api',
        version: process.env.APP_VERSION || 'unknown',
        checks: { database, providers: providersCheck },
      },
      status === 'down' ? 503 : 200,
    );
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

  // Live egress lane health & status
  app.get('/api/lanes', async (c) => {
    if (!ctx.laneManager || !ctx.laneManager.isEnabled()) {
      return c.json({ enabled: false, message: 'Lanes are disabled' });
    }
    const status = await ctx.laneManager.getStatus();
    return c.json({ enabled: true, status });
  });

  // Lane configuration (ports, proxy_base, ctl_url) — editable by dashboard.
  app.get('/api/lanes/config', (c) => {
    const config = ctx.configWatcher.config;
    const lanes = config.lanes;
    if (!lanes) return c.json({ data: null });
    return c.json({
      data: {
        enabled: lanes.enabled,
        proxy_base: lanes.proxyBase,
        ctl_url: lanes.ctlUrl,
        token: lanes.token ?? '',
        ports: lanes.ports,
        endpoint_name: lanes.endpointName ?? null,
        max_rotations_per_window: lanes.maxRotationsPerWindow ?? null,
        window_secs: lanes.windowSecs ?? null,
      },
    });
  });

  // Snapshot for the dashboard's initial paint (health + stats + logs + lanes + config).
  app.get('/api/status', async (c) => {
    const config = ctx.configWatcher.config;
    const lanesEnabled = Boolean(ctx.laneManager?.isEnabled());
    const lanesStatus = lanesEnabled ? await ctx.laneManager?.getStatus() : null;
    const providerNames = Object.keys(config.providers);
    return c.json({
      health: {
        status: 'ok',
        active_provider: config.current,
        providers_count: providerNames.length,
        version: '0.1.0',
        uptime: Math.floor(process.uptime()),
      },
      stats: ctx.db.getProviderStats(),
      logs: ctx.ringBuffer.getRecent(100),
      lanes: { enabled: lanesEnabled, status: lanesStatus },
      config: {
        listen: config.listen,
        current: config.current,
        requestLogLimit: config.requestLogLimit,
        providers: providerNames,
      },
    });
  });

  // Server-Sent Events feed for live value updates.

  // Model usage stats (all providers or filtered by provider id).
  app.get('/api/models', (c) => {
    const providerId = c.req.query('providerId');
    return c.json({ data: ctx.db.getModelStats(providerId || undefined) });
  });

  // Provider configuration overview (sanitized — no API keys). Includes disabled
// providers so the dashboard can render accurate enable/disable toggles.
  app.get('/api/providers', (c) => {
    const config = ctx.configWatcher.config;
    const providers = Object.entries(config.providers)
      .map(([name, p]) => ({
        name,
        id: p.id,
        enabled: p.enabled,
        base_url: p.baseUrl,
        api_format: p.apiFormat,
        api_version: p.apiVersion ?? null,
        port: p.port ?? null,
        fallback: p.fallback,
        test_model: p.testModel ?? null,
        max_tokens_cap: p.maxTokensCap ?? null,
        inject_thinking_history: p.injectThinkingHistory,
        strict_thinking_history: p.strictThinkingHistory,
        quota_command: p.quotaCommand ?? null,
        model_map: p.modelMap,
        extra_headers: p.extraHeaders,
        routes: p.routes.map((r) => ({
          pattern: r.pattern,
          target: r.target,
          enabled: r.enabled,
        })),
        model_map_keys: Object.keys(p.modelMap),
      }));
    return c.json({ data: providers });
  });

  // Circuit breaker state per provider id.
  app.get('/api/breakers', (c) => {
    const config = ctx.configWatcher.config;
    const rows = Object.entries(config.providers)
      .filter(([, p]) => p.enabled)
      .map(([name, p]) => ({
        provider_name: name,
        provider_id: p.id,
        state: ctx.circuitBreaker.getState(p.id),
      }));
    return c.json({ data: rows });
  });
  // Named events (incumbent-compatible): log, stats.
  app.get('/events', (c) => {
    const events = [EVENTS.log, EVENTS.stats] as const;
    return createSSEResponse(c, [...events], (event) => {
      if (event === 'stats') {
        return { stats: ctx.db.getProviderStats() };
      }
      return null;
    });
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
      laneManager: ctx.laneManager,
      onRecordStats: (providerId, providerName, delta) => {
        ctx.db.recordStats(providerId, providerName, canonical.model, delta);
        gatewayEvents.emit(EVENTS.stats, {
          providerId,
          providerName,
          delta,
        });
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
        gatewayEvents.emit(EVENTS.log, logRecord);
      },
    });
  }

  // Anthropic Ingress
  app.post('/v1/messages', (c) => handleDispatch(c, 'anthropic'));

  // OpenAI Chat Ingress
  app.post('/v1/chat/completions', (c) => handleDispatch(c, 'openai_chat'));

  // OpenAI Responses Ingress
  app.post('/v1/responses', (c) => handleDispatch(c, 'openai_responses'));

  // ─────────────────────────────────────────────────────────────
  // CONTROL PLANE
  // ─────────────────────────────────────────────────────────────

  // CSRF guard: mutations with a non-localhost Origin are rejected.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST' && !isTrustedOrigin(c.req.header('origin'))) {
      return c.json({ ok: false, error: 'Cross-origin mutations are not allowed' }, { status: 403 });
    }
    return next();
  });

  // Write the full config (atomic; the config watcher hot-reloads on save).
  app.post('/api/config', async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>();
      validateConfigPatch(body);
      const merged = mergeConfigPatch(ctx.configWatcher.config, body);
      saveConfig(merged, ctx.configWatcher.configPath);
      return c.json({ ok: true, message: 'Configuration saved' });
    } catch (err) {
      return c.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 }
      );
    }
  });

  // Disable/enable a provider.
  app.post('/api/providers/:id/toggle', async (c) => {
    const id = c.req.param('id');
    const config = ctx.configWatcher.config;
    const provider = config.providers[id];
    if (!provider) {
      return c.json({ ok: false, error: `Provider not found: ${id}` }, { status: 404 });
    }
    provider.enabled = !provider.enabled;
    saveConfig(config, ctx.configWatcher.configPath);
    return c.json({
      ok: true,
      provider: id,
      enabled: provider.enabled,
      message: `${id} ${provider.enabled ? 'enabled' : 'disabled'}`,
    });
  });

  // Reset a circuit breaker for a provider.
  app.post('/api/breakers/:id/reset', (c) => {
    const id = c.req.param('id');
    ctx.circuitBreaker.reset(id);
    return c.json({ ok: true, provider: id, state: ctx.circuitBreaker.getState(id) });
  });

  // Clear the request log ring buffer + DB request logs.
  app.post('/api/logs/clear', (c) => {
    ctx.ringBuffer.clear();
    ctx.db.clearRequestLogs();
    return c.json({ ok: true, message: 'Request logs cleared' });
  });

  // Manually trigger a lane rotation for an egress port.
  app.post('/api/lanes/rotate', async (c) => {
    if (!ctx.laneManager || !ctx.laneManager.isEnabled()) {
      return c.json({ ok: false, error: 'Lanes are disabled' }, { status: 409 });
    }
    const body = await c.req.json().catch(() => ({}));
    const port = Number(body.port) || 0;
    if (!port) {
      return c.json({ ok: false, error: 'Missing port' }, { status: 400 });
    }
    ctx.laneManager.triggerRotation(port);
    return c.json({ ok: true, port, message: `Rotation requested for port ${port}` });
  });

  // Toggle lanes enabled state in config.
  app.post('/api/lanes/toggle', async (c) => {
    const config = ctx.configWatcher.config;
    if (!config.lanes) {
      return c.json({ ok: false, error: 'No lanes section in config' }, { status: 409 });
    }
    config.lanes.enabled = !config.lanes.enabled;
    saveConfig(config, ctx.configWatcher.configPath);
    return c.json({ ok: true, enabled: config.lanes.enabled });
  });

  // ─────────────────────────────────────────────────────────────
  // Static dashboard bundle (built Vite app in dashboard/dist).
  const dashboardDist = path.resolve(process.cwd(), 'dashboard', 'dist');
  if (fs.existsSync(dashboardDist)) {
    const indexHtml = fs.readFileSync(path.join(dashboardDist, 'index.html'), 'utf8');
    app.get('/dashboard', (c) => c.html(indexHtml));
    const MIME_TYPES: Record<string, string> = {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
      '.json': 'application/json',
    };
    app.get('/dashboard/*', async (c) => {
      // Strip the /dashboard prefix, then serve real files or fall back to SPA index.
      const urlPath = c.req.path.replace(/^\/dashboard\/?/, '');
      const candidates = urlPath
        ? [path.join(dashboardDist, urlPath), path.join(dashboardDist, urlPath, 'index.html')]
        : [path.join(dashboardDist, 'index.html')];
      for (const candidate of candidates) {
        // Enforce directory boundary after normalization to block path traversal.
        const resolved = path.resolve(candidate);
        if (resolved !== dashboardDist && !resolved.startsWith(dashboardDist + path.sep)) continue;
        try {
          const st = await fsp.stat(resolved);
          if (!st.isFile()) continue;
          const ext = path.extname(resolved);
          const mime = MIME_TYPES[ext] || 'application/octet-stream';
          return c.body(await fsp.readFile(resolved), 200, {
            'content-type': mime,
            'cache-control': ext ? 'public, max-age=31536000, immutable' : 'no-cache',
          });
        } catch {
          continue;
        }
      }
      return c.html(indexHtml);
    });
  }

  return app;
}
